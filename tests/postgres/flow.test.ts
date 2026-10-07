import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { PostgresDatabase } from '../../src/platform/postgres-database';
import { createApiHandlers } from '../../src/platform/http';
import { createParticipantToken } from '../../src/platform/participant-auth';
let pg: PGlite;
let now = Date.now();
const origin = 'https://competition.example';
const settings = { questionCount: 5, timeLimitMinutes: 3, mode: 'ion', difficulty: 'normal', ionAnswer: 'formula', compoundPrompts: { formula: true, name: false }, compoundAnswer: 'formula' };
function request(path: string, body?: unknown, token?: string) {
  return new Request(origin + path, { method: body ? 'POST' : 'GET', headers: { origin, 'x-competition-csrf': '1', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function call(name: keyof ReturnType<typeof createApiHandlers>, req: Request, id = '') {
  return pg.transaction(async tx => {
    const database = new PostgresDatabase(async (q,v) => { try { return await tx.query(q,v); } catch(error) { console.error(q, error); throw error; } });
    const handlers = createApiHandlers({ database, teacherIdentity: { getVerifiedIdentity: async () => ({ id: 'teacher-1', email: 'teacher@example.com' }) }, serverConfig: { teacherAllowedEmails: ['teacher@example.com'] }, now: () => now, random: Math.random, randomUUID: () => crypto.randomUUID() });
    const result = await (handlers[name] as (r: Request, p: {id:string}) => Promise<Response>)(req,{id});
    if (result.status >= 500) console.error(name, await result.clone().text());
    return result;
  });
}
beforeAll(async () => { pg = new PGlite(); await pg.exec(readFileSync('supabase/migrations/202610010001_core.sql','utf8')); await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated'); await pg.exec(readFileSync('supabase/migrations/202610020001_question_profiles.sql','utf8')); });
afterAll(async () => { await pg.close(); });
describe('real Postgres v2 competition', () => {
  it.each(['immediate','deferred'])('runs %s prepare, ready, immutable operation retry, and final result', async gradingMode => {
    now = Date.now();
    const create = await call('createClassRoom', request('/api/class-rooms', { requestId: crypto.randomUUID(), settings: {...settings, gradingMode} }));
    expect(create.status, await create.clone().text()).toBe(201);
    const created = await create.json(); const id = created.room.id;
    const token = createParticipantToken();
    const joined = await call('joinRoom', request(`/api/rooms/${id}/join`, {requestId: crypto.randomUUID(), nickname: 'テスト'}, token), id);
    expect(joined.status, await joined.clone().text()).toBe(201);
    const start = await call('startRoom',request(`/api/rooms/${id}/start`, {requestId:crypto.randomUUID(),expectedRevision:1}),id);
    expect(start.status,await start.clone().text()).toBe(200);
    const manifestResponse = await call('manifest', request(`/api/rooms/${id}/manifest`, undefined, token), id);
    expect(manifestResponse.status,await manifestResponse.clone().text()).toBe(200);
    const manifest = await manifestResponse.json();
    const ready = await call('ready', request(`/api/rooms/${id}/ready`, {manifestId: manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration},token),id);
    expect(ready.status,await ready.clone().text()).toBe(200);
    const schedule = await ready.json();now=schedule.startAtMs+1000;
    const operations = gradingMode === 'immediate' ? manifest.questions.flatMap((q:any,index:number)=>[{seq:index+1,operationId:crypto.randomUUID(),type:'pass',questionId:q.id,fieldId:'formula',elapsedMs:100+index}]) : [];
    operations.push({seq:operations.length+1,operationId:crypto.randomUUID(),type:'finish',reason:gradingMode==='immediate'?'completed':'submitted',elapsedMs:900});
    const body = {requestId:crypto.randomUUID(),writerEpoch:1,manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,operations};
    const save = await call('operations',request(`/api/rooms/${id}/operations`,body,token),id);
    expect(save.status,await save.clone().text()).toBe(200);
    const again = await call('operations',request(`/api/rooms/${id}/operations`,body,token),id);
    expect(again.status,await again.clone().text()).toBe(200);
    expect(await again.json()).toEqual(await save.json());
    const results = await call('results',request(`/api/rooms/${id}/results`,undefined,token),id);
    expect(results.status,await results.clone().text()).toBe(200);
    expect((await results.json()).own.correctCount).toBe(0);
  });
});
it('finalizes a deadline with unanswered fields', async () => {
 now = Date.now();
 const created = await call('createClassRoom', request('/api/class-rooms', {requestId:crypto.randomUUID(),settings:{...settings,gradingMode:'immediate'}}));
 const {room}=await created.json(); const id=room.id; const token=createParticipantToken();
 await call('joinRoom',request(`/api/rooms/${id}/join`,{requestId:crypto.randomUUID(),nickname:'Timeout'},token),id);
 await call('startRoom',request(`/api/rooms/${id}/start`,{requestId:crypto.randomUUID(),expectedRevision:1}),id);
 const manifest=await (await call('manifest',request(`/api/rooms/${id}/manifest`,undefined,token),id)).json();
 const scheduled=await (await call('ready',request(`/api/rooms/${id}/ready`,{manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration},token),id)).json();
 now=scheduled.startAtMs+settings.timeLimitMinutes*60000+11000;
 const state=await call('state',request(`/api/rooms/${id}/state`,undefined,token),id);
 expect(state.status,await state.clone().text()).toBe(200);
 expect((await state.json()).room.state).toBe('FINISHED');
 const results=await call('results',request(`/api/rooms/${id}/results`,undefined,token),id);
 expect(results.status,await results.clone().text()).toBe(200);
 expect((await results.json()).own.correctCount).toBe(0);
});
it('keeps the 42 participant limit on concurrent join requests in Postgres',async()=>{
 now=Date.now();
 const create=await call('createClassRoom',request('/api/class-rooms',{requestId:crypto.randomUUID(),settings:{...settings,gradingMode:'immediate'}}));
 const {room}=await create.json();
 const responses=await Promise.all(Array.from({length:43},(_,i)=>call('joinRoom',request(`/api/rooms/${room.id}/join`,{requestId:crypto.randomUUID(),nickname:`P${i}`},createParticipantToken()),room.id)));
 expect(responses.filter(r=>r.status===201)).toHaveLength(42);
 expect(responses.filter(r=>r.status===409)).toHaveLength(1);
},15000);

it('pins the actual PostgreSQL room profile across later master edits',async()=>{
 const saved=await call('teacherQuestionProfile',request('/api/teacher/question-profile'));
 // This test helper only supplies an ordinary teacher: master-only policy must hold.
 expect(saved.status).toBe(403);
 const profileModule=await import('../../src/games/ionic-formula/shared/question-profile');
 const first=structuredClone(profileModule.DEFAULT_QUESTION_PROFILE);first.rules.ion.normal.complexPercent=30;
 await pg.query('INSERT INTO question_profiles(id,profile_json,revision,updated_at_ms) VALUES(1,$1,1,$2) ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,revision=1',[JSON.stringify(first),Date.now()]);
 const created=await call('createClassRoom',request('/api/class-rooms',{requestId:crypto.randomUUID(),settings:{...settings,complexEnabled:true}}));expect(created.status).toBe(201);const {room}=await created.json();
 const next=structuredClone(first);next.rules.ion.normal.complexPercent=10;await pg.query('UPDATE question_profiles SET profile_json=$1,revision=2 WHERE id=1',[JSON.stringify(next)]);
 const token=createParticipantToken();expect((await call('joinRoom',request(`/api/rooms/${room.id}/join`,{requestId:crypto.randomUUID(),nickname:'固定確認'},token),room.id)).status).toBe(201);
 const started=await call('startRoom',request(`/api/rooms/${room.id}/start`,{requestId:crypto.randomUUID(),expectedRevision:1}),room.id);expect(started.status,await started.clone().text()).toBe(200);
 const rows=await pg.query('SELECT answer_snapshot_json FROM room_questions WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1)',[room.id]);
 expect(rows.rows.filter((q:any)=>JSON.parse(q.answer_snapshot_json).itemId.startsWith('complex_'))).toHaveLength(2);
 const snapshot=await pg.query('SELECT profile_revision FROM room_question_profiles WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1)',[room.id]);expect(Number((snapshot.rows[0] as any).profile_revision)).toBe(1);
});
