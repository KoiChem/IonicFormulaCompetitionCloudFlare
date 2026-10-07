import { afterEach, describe, expect, it } from 'vitest';
import { createApiHandlers } from '../../src/platform/http';
import { DEFAULT_QUESTION_PROFILE } from '../../src/games/ionic-formula/shared/question-profile';
import { apiRequest, createApiTestContext, joinClassRoom, createMateRoom, SETTINGS } from './helpers';
const contexts: ReturnType<typeof createApiTestContext>[]=[];
afterEach(()=>contexts.splice(0).forEach(c=>c.close()));
function setup() { const c=createApiTestContext(); contexts.push(c); c.dependencies.serverConfig.masterTeacherEmail='teacher@example.com'; return {...c,handlers:createApiHandlers(c.dependencies)}; }
const nextProfile=()=>{const p=structuredClone(DEFAULT_QUESTION_PROFILE); p.rules.ion.normal.complexPercent=20; return p;};
const patch=(h:ReturnType<typeof createApiHandlers>,profile=nextProfile(),revision=0,id=crypto.randomUUID())=>h.teacherQuestionProfile(apiRequest('/api/teacher/question-profile',{method:'PATCH',json:{profile,expectedRevision:revision,requestId:id}}));
describe('master question profiles',()=>{
 it('denies profile GET and PATCH to ordinary and anonymous teachers',async()=>{for(const teacher of [undefined,null]) { const c=createApiTestContext({teacher}); contexts.push(c); for(const method of ['GET','PATCH']) { const r=await c.handlers.teacherQuestionProfile(apiRequest('/api/teacher/question-profile',{method,...(method==='PATCH'?{json:{}}:{})})); expect([401,403]).toContain(r.status); } }});
 it('stores a profile with revision checks, replay and body binding',async()=>{const c=setup(); const get=await c.handlers.teacherQuestionProfile(apiRequest('/api/teacher/question-profile')); const initial=await get.json() as any; expect(initial.profile).toEqual(DEFAULT_QUESTION_PROFILE); expect(initial.catalog.compounds.length).toBeGreaterThan(100); const id=crypto.randomUUID(); expect((await patch(c.handlers,nextProfile(),0,id)).status).toBe(200); expect((await patch(c.handlers,nextProfile(),0,id)).status).toBe(200); expect((await patch(c.handlers)).status).toBe(409); expect((await patch(c.handlers,DEFAULT_QUESTION_PROFILE,0,id)).status).toBe(409); expect((await patch(c.handlers,DEFAULT_QUESTION_PROFILE,1)).status).toBe(200); expect((await patch(c.handlers,nextProfile(),0,id)).status).toBe(200); });
 it('rejects unsafe ratios, candidate shortages and cross-origin saves',async()=>{const c=setup(); const p=nextProfile();p.rules.compound.hard.complexPercent=30; expect((await patch(c.handlers,p)).status).toBe(400); p.rules.compound.hard.complexPercent=10;expect((await patch(c.handlers,p)).status).toBe(400); expect((await c.handlers.teacherQuestionProfile(apiRequest('/api/teacher/question-profile',{method:'PATCH',headers:{origin:'https://evil.example'},json:{profile:nextProfile(),expectedRevision:0,requestId:crypto.randomUUID()}}))).status).toBe(403);});
 it('keeps per-room snapshots across saves, retries and settings edits',async()=>{const c=setup(); const key=crypto.randomUUID(); const create=()=>c.handlers.createClassRoom(apiRequest('/api/class-rooms',{method:'POST',json:{requestId:key,settings:{...SETTINGS,complexEnabled:true}}})); const first=await create(); expect(first.status).toBe(201); const body=await first.json() as any; const row=c.database.sqlite.prepare('SELECT * FROM room_question_profiles').get() as any; expect(row.profile_revision).toBe(0); expect(JSON.parse(row.profile_json).rules.ion.normal.complexPercent).toBe(10); expect((await patch(c.handlers)).status).toBe(200); expect(await (await create()).json()).toEqual(body); expect(c.database.sqlite.prepare('SELECT count(*) as n FROM room_question_profiles').get()?.n).toBe(1); const changed=await c.handlers.updateRoomSettings(apiRequest('/api/rooms/x/settings',{method:'PATCH',json:{requestId:crypto.randomUUID(),expectedRevision:0,settings:{...SETTINGS,questionCount:10,complexEnabled:true}}}),{id:body.room.id}); expect(changed.status).toBe(200); await joinClassRoom(c,body.room.id); const started=await c.handlers.startRoom(apiRequest('/api/rooms/x/start',{method:'POST',json:{requestId:crypto.randomUUID(),expectedRevision:2}}),{id:body.room.id});expect(started.status).toBe(200); const qs=c.database.sqlite.prepare('SELECT answer_snapshot_json FROM room_questions').all() as any[];expect(qs.filter(q=>JSON.parse(q.answer_snapshot_json).itemId.startsWith('complex_')).length).toBe(1); const second=await c.handlers.createClassRoom(apiRequest('/api/class-rooms',{method:'POST',json:{requestId:crypto.randomUUID(),settings:SETTINGS}}));expect(second.status).toBe(201); expect(c.database.sqlite.prepare('SELECT profile_revision FROM room_question_profiles ORDER BY rowid DESC LIMIT 1').get()?.profile_revision).toBe(1);});
 it('pins a compound/deferred mate snapshot and counts both fields as one question',async()=>{
  const c=setup();const created=await createMateRoom(c,{settings:{...SETTINGS,questionCount:15,mode:'compound',difficulty:'hard',complexEnabled:true,gradingMode:'deferred',compoundAnswer:'both'}});expect(created.response.status).toBe(201);
  await joinClassRoom(c,created.body.room.id);expect((await patch(c.handlers)).status).toBe(200);
  const started=await c.handlers.startRoom(apiRequest('/api/rooms/x/start',{method:'POST',token:created.token,json:{requestId:crypto.randomUUID(),expectedRevision:1}}),{id:created.body.room.id});expect(started.status).toBe(200);
  const qs=c.database.sqlite.prepare('SELECT answer_snapshot_json FROM room_questions').all() as any[];
  expect(qs).toHaveLength(15);expect(qs.filter(q=>JSON.parse(q.answer_snapshot_json).prompt.values.some((v:any)=>v.value.includes('['))).length).toBe(3);
  expect(qs.every(q=>JSON.parse(q.answer_snapshot_json).fields.length===2)).toBe(true);
 });
 it('allows old rooms without a profile snapshot to start unchanged',async()=>{
  const c=setup();const response=await c.handlers.createClassRoom(apiRequest('/api/class-rooms',{method:'POST',json:{requestId:crypto.randomUUID(),settings:{...SETTINGS,complexEnabled:true}}}));const body=await response.json() as any;
  c.database.sqlite.prepare('DELETE FROM room_question_profiles').run();await joinClassRoom(c,body.room.id);
  const started=await c.handlers.startRoom(apiRequest('/api/rooms/x/start',{method:'POST',json:{requestId:crypto.randomUUID(),expectedRevision:1}}),{id:body.room.id});expect(started.status).toBe(200);
  expect(c.database.sqlite.prepare('SELECT count(*) as n FROM room_questions').get()?.n).toBe(5);
 });
 it('serializes concurrent profile saves and recovers a lost commit response',async()=>{
  const c=setup();const replies=await Promise.all([patch(c.handlers),patch(c.handlers,DEFAULT_QUESTION_PROFILE)]);expect(replies.map(r=>r.status).sort()).toEqual([200,409]);
  c.database.throwAfterNextBatchCommit();expect((await patch(c.handlers,DEFAULT_QUESTION_PROFILE,1)).status).toBe(200);
  const current=await (await c.handlers.teacherQuestionProfile(apiRequest('/api/teacher/question-profile'))).json() as any;expect(current.revision).toBe(2);
 });
 it('captures one coherent policy when an admin saves during room creation',async()=>{
  const c=setup();const pause=c.database.pauseNextBatch();
  const creating=c.handlers.createClassRoom(apiRequest('/api/class-rooms',{method:'POST',json:{requestId:crypto.randomUUID(),settings:SETTINGS}}));await pause.reached;
  const saving=patch(c.handlers);pause.release();expect((await creating).status).toBe(201);expect((await saving).status).toBe(200);
  const row=c.database.sqlite.prepare('SELECT profile_revision, profile_json FROM room_question_profiles').get() as any;expect(row.profile_revision).toBe(0);expect(JSON.parse(row.profile_json).rules.ion.normal.complexPercent).toBe(10);
 });
});
