import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {PostgresDatabase} from '../../src/platform/postgres-database';
import {createSupabaseGateway} from '../../src/platform/supabase-gateway';
import {PUBLIC_CONFIG} from '../../src/config/public';
import {createParticipantToken} from '../../src/platform/participant-auth';
let pg:PGlite;let commandQueries=0;
const master={id:'teacher',email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};
const users=new Map<string,any>([['teacher',master]]);
const transact=async<T>(scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>pg.transaction(tx=>run(new PostgresDatabase(async(q,v)=>{if(scope.startsWith('room:'))commandQueries++;return tx.query(q,v);})));
const options={transact,verifyUser:async(r:Request)=>users.get(r.headers.get('authorization')?.slice(7)??''),masterEmail:master.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{},nativeJoin:true,nativeReady:true};
const gateway=createSupabaseGateway(options);
const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
async function call(path:string,body?:unknown,token?:string,user='student',extra:Record<string,string>={},legacy=false){users.set(user,user==='teacher'?master:{id:user,is_anonymous:true});return (legacy?createSupabaseGateway({...options,nativeJoin:false,nativeReady:false}):gateway)(new Request('https://p/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io',authorization:'Bearer '+user,'content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':'Bearer '+token}:{}),...extra},body:body?JSON.stringify(body):undefined}));}
async function room(){const response=await call('class-rooms',{requestId:crypto.randomUUID(),settings},undefined,'teacher');expect(response.status,await response.clone().text()).toBe(201);return (await response.json()).room.id as string;}
async function joined(id:string,nickname='生徒',token=createParticipantToken(),requestId=crypto.randomUUID(),user='student'){const body={requestId,nickname};const response=await call(`rooms/${id}/join`,body,token,user);expect(response.status,await response.clone().text()).toBe(201);return {body,token,user,participant:(await response.json()).participant};}
async function start(id:string){const state=await(await call(`rooms/${id}/state`,undefined,undefined,'teacher')).json();const response=await call(`rooms/${id}/start`,{requestId:crypto.randomUUID(),expectedRevision:state.room.revision},undefined,'teacher');expect(response.status,await response.clone().text()).toBe(200);return response.json();}
beforeAll(async()=>{pg=new PGlite();await pg.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;CREATE SCHEMA realtime;CREATE TABLE realtime.messages(extension text);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;`);for(const file of readdirSync('supabase/migrations').sort())try{await pg.exec(readFileSync('supabase/migrations/'+file,'utf8'));}catch(e){console.error(file,e);throw e;}},30000);
afterAll(async()=>pg.close());
it('executes native join with one command query and replays without revision or event changes',async()=>{const id=await room();commandQueries=0;const s=await joined(id,'　Ａlice　');expect(commandQueries).toBe(1);expect(s.participant.nickname).toBe('Ａlice');const before=await pg.query('SELECT * FROM app_outbox WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1)',[id]);commandQueries=0;const replay=await call(`rooms/${id}/join`,s.body,s.token);expect(await replay.json()).toEqual({participant:s.participant});expect(commandQueries).toBe(1);expect((await pg.query('SELECT * FROM app_outbox WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1)',[id])).rows).toEqual(before.rows);expect((await call(`rooms/${id}/join`,{...s.body,nickname:'別名'},s.token)).status).toBe(409);expect((await call(`rooms/${id}/join`,{...s.body,requestId:crypto.randomUUID()},s.token)).status).toBe(409);expect((await call(`rooms/${id}/join`,{requestId:crypto.randomUUID(),nickname:'alice'},createParticipantToken())).status).toBe(409);});
it('rebinds a replay, rotates epoch and emits both notifications; removed receipts cannot revive',async()=>{const id=await room();const s=await joined(id);await call(`rooms/${id}/join`,s.body,s.token,'recovered');const topics=(await pg.query<any>('SELECT * FROM app_room_topics WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1)',[id])).rows[0];expect(Number(topics.epoch)).toBe(2);expect((await pg.query('SELECT kind FROM app_outbox WHERE room_id=$1 ORDER BY kind',[topics.room_id])).rows).toEqual([{kind:'control'},{kind:'host'}]);expect((await pg.query('SELECT event FROM app_audit WHERE room_id=$1',[topics.room_id])).rows).toEqual([{event:'participant_rebound'}]);await pg.query("UPDATE participants SET status='REMOVED' WHERE room_id=$1",[topics.room_id]);expect((await call(`rooms/${id}/join`,s.body,s.token)).status).toBe(403);});
it('does not partially write on nickname conflict, and legacy workers see native receipts',async()=>{const id=await room();const s=await joined(id);const before=(await pg.query('SELECT revision FROM rooms WHERE public_id=$1',[id])).rows;expect((await call(`rooms/${id}/join`,{requestId:crypto.randomUUID(),nickname:'生徒'},createParticipantToken())).status).toBe(409);expect((await pg.query('SELECT revision FROM rooms WHERE public_id=$1',[id])).rows).toEqual(before);const replay=await call(`rooms/${id}/join`,s.body,s.token,s.user,{},true);expect(await replay.json()).toEqual({participant:s.participant});});
it('uses one ready query and starts only once with a fresh five second countdown',async()=>{const id=await room();const a=await joined(id,'一',undefined,undefined,'one');const b=await joined(id,'二',undefined,undefined,'two');const prep=await start(id);const ready={manifestId:prep.manifestId,preparationGeneration:prep.preparationGeneration,evaluatorVersion:(await(await call(`rooms/${id}/manifest`,undefined,a.token,a.user)).json()).evaluatorVersion};commandQueries=0;const first=await call(`rooms/${id}/ready`,ready,a.token,a.user);expect(first.status,await first.clone().text()).toBe(200);expect(commandQueries).toBe(1);expect((await first.json()).readyCount).toBe(1);const began=Date.now();const last=await call(`rooms/${id}/ready`,ready,b.token,b.user);const result=await last.json();expect(result.state).toBe('COUNTDOWN');expect(result.startAtMs).toBeGreaterThanOrEqual(began+PUBLIC_CONFIG.countdownSeconds*1000);expect(result.readyCount).toBe(2);expect(result.deadlineAtMs-result.startAtMs).toBe(settings.timeLimitMinutes*60000);const stored=(await pg.query<any>('SELECT expires_at_ms FROM rooms WHERE public_id=$1',[id])).rows[0];expect(Number(stored.expires_at_ms)).toBe(result.deadlineAtMs+PUBLIC_CONFIG.retentionMs.classCompetition);expect(await(await call(`rooms/${id}/ready`,ready,b.token,b.user)).json()).toEqual(result);expect((await call(`rooms/${id}/ready`,ready,b.token,b.user,{'x-participant-id':a.participant.id})).status).toBe(403);expect((await call(`rooms/${id}/ready`,{...ready,preparationGeneration:2},a.token,a.user)).status).toBe(409);});
it('denies anon and authenticated direct execution',async()=>{for(const role of ['anon','authenticated'])await expect(pg.transaction(async tx=>{await tx.exec('SET LOCAL ROLE '+role);await tx.query("SELECT competition_private.join_room_v1('x','u','hash','p','r','b','n','n')");})).rejects.toThrow(/permission denied/);});
it('propagates native serialization failures so the transaction runner can retry',async()=>{
 const {nativeRoomCommand}=await import('../../src/platform/postgres-room-commands');
 const db=new PostgresDatabase(async()=>{throw Object.assign(new Error('serialization'),{code:'40001'});});
 const request=new Request('https://competition.internal/api/rooms/test/join',{method:'POST',headers:{origin:'https://competition.internal','content-type':'application/json','x-competition-csrf':'1',authorization:'Bearer '+'A'.repeat(43)},body:JSON.stringify({requestId:'retry',nickname:'生徒'})});
 await expect(nativeRoomCommand(db,request,'test','uid','join')).rejects.toMatchObject({code:'40001'});
});
it('does not replay an expired receipt even while the room remains live',async()=>{const id=await room();const s=await joined(id);await pg.query('UPDATE command_receipts SET expires_at_ms=processed_at_ms WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1)',[id]);expect((await call(`rooms/${id}/join`,s.body,s.token)).status).toBe(409);});
it('enforces 42 slots and keeps joined order increasing after removal',async()=>{const id=await room();const students=[];for(let i=0;i<42 /* preserved Supabase native limit */;i++)students.push(await joined(id,'生徒'+i,undefined,undefined,'slot'+i));expect(students.at(-1)?.participant.joinedOrder).toBe(42 /* preserved Supabase native limit */);expect((await call(`rooms/${id}/join`,{requestId:crypto.randomUUID(),nickname:'43人目'},createParticipantToken())).status).toBe(409);await pg.query("UPDATE participants SET status='REMOVED' WHERE room_id=(SELECT id FROM rooms WHERE public_id=$1) AND id=$2",[id,students[0].participant.id]);expect((await joined(id,'43人目')).participant.joinedOrder).toBe(42 /* preserved Supabase native limit */+1);});
it('falls back for v1 before native writes and preserves Google participant bindings',async()=>{const id=await room();await pg.query("UPDATE rooms SET game_version='1' WHERE public_id=$1",[id]);const s=await joined(id,'旧版');expect(s.participant.joinedOrder).toBe(1);const v2=await room();const teacher=await joined(v2,'教員参加',undefined,undefined,'teacher');expect((await pg.query('SELECT uid FROM app_memberships WHERE participant_id=$1',[teacher.participant.id])).rows).toEqual([{uid:'teacher'}]);expect((await pg.query('SELECT active FROM app_teacher_bindings WHERE uid=$1',['teacher'])).rows).toEqual([{active:true}]);});
it('rejects canceled and old generation readiness, and reports the 30 second timeout',async()=>{const id=await room();const s=await joined(id);const prep=await start(id);const manifest=await(await call(`rooms/${id}/manifest`,undefined,s.token)).json();const ready={manifestId:manifest.manifestId,preparationGeneration:manifest.preparationGeneration,evaluatorVersion:manifest.evaluatorVersion};await pg.query('UPDATE v2_room_manifests SET prepared_at_ms=$1 WHERE manifest_id=$2',[Date.now()-30001,prep.manifestId]);const response=await(await call(`rooms/${id}/ready`,ready,s.token)).json();expect(response.state).toBe('PREPARING');expect(response.preparationTimedOut).toBe(true);expect(response.startAtMs).toBeNull();const state=await(await call(`rooms/${id}/state`,undefined,undefined,'teacher')).json();expect((await call(`rooms/${id}/cancel-preparation`,{expectedRevision:state.room.revision},undefined,'teacher')).status).toBe(200);expect((await call(`rooms/${id}/ready`,ready,s.token)).status).toBe(409);await start(id);expect((await call(`rooms/${id}/ready`,ready,s.token)).status).toBe(409);});
it('rolls back every join write fault while quota remains independently committed',async()=>{
 await pg.exec(`CREATE FUNCTION public.native_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END $$;`);
 for(const table of ['rooms','participants','command_receipts','app_room_topics','app_memberships','app_outbox']){
  const id=await room();const internal=(await pg.query<any>('SELECT id FROM rooms WHERE public_id=$1',[id])).rows[0].id;
  const tables=['rooms','participants','command_receipts','app_room_topics','app_memberships','app_outbox'];
  const snapshot=()=>Promise.all(tables.map(t=>pg.query(`SELECT row_to_json(x) AS row FROM ${t} x WHERE ${t==='rooms'?'id':'room_id'}=$1 ORDER BY row_to_json(x)::text`,[internal]).then(x=>x.rows)));
  const before=await snapshot();const uid=crypto.randomUUID();
  await pg.exec(`CREATE TRIGGER native_fault AFTER INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.native_test_fault()`);
  const result=await call(`rooms/${id}/join`,{requestId:crypto.randomUUID(),nickname:'障害試験'},createParticipantToken(),uid);
  await pg.exec(`DROP TRIGGER native_fault ON public.${table}`);
  expect(result.status).toBe(503);expect(await snapshot()).toEqual(before);
  expect((await pg.query<any>('SELECT count FROM app_request_limits WHERE bucket LIKE $1',[uid+':%'])).rows[0].count).toBe(1);
 }
});
it('rolls back ready/countdown writes on every affected table',async()=>{
 for(const table of ['v2_participant_progress','rooms','v2_room_manifests','creation_receipts','command_receipts','app_room_topics','app_outbox']){
  const id=await room();const s=await joined(id);await start(id);const manifest=await(await call(`rooms/${id}/manifest`,undefined,s.token)).json();
  const internal=(await pg.query<any>('SELECT id FROM rooms WHERE public_id=$1',[id])).rows[0].id;
  const tables=['rooms','v2_room_manifests','v2_participant_progress','creation_receipts','command_receipts','app_room_topics','app_memberships','app_outbox'];
  const snapshot=()=>Promise.all(tables.map(t=>pg.query(`SELECT row_to_json(x) AS row FROM ${t} x WHERE ${t==='rooms'?'id':'room_id'}=$1 ORDER BY row_to_json(x)::text`,[internal]).then(x=>x.rows)));
  const before=await snapshot();await pg.exec(`CREATE TRIGGER native_fault AFTER INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.native_test_fault()`);
  const result=await call(`rooms/${id}/ready`,{manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration},s.token);
  await pg.exec(`DROP TRIGGER native_fault ON public.${table}`);
  expect(result.status).toBe(503);expect(await snapshot()).toEqual(before);
 }
});
it('does not acknowledge readiness after the room has been canceled',async()=>{const id=await room();const s=await joined(id);await start(id);const manifest=await(await call(`rooms/${id}/manifest`,undefined,s.token)).json();await pg.query("UPDATE rooms SET state='CANCELLED' WHERE public_id=$1",[id]);expect((await call(`rooms/${id}/ready`,{manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration},s.token)).status).toBe(409);});
it('matches mate capacity and retention configuration',async()=>{
 const hostToken=createParticipantToken();
 const response=await call('mate-rooms',{requestId:crypto.randomUUID(),nickname:'ホスト',settings},hostToken,'mate-host',{'x-creation-key':'A'.repeat(43)});
 expect(response.status,await response.clone().text()).toBe(201);
 const {room:r}=await response.json();
 const players=[{token:hostToken,user:'mate-host'}];
 for(let i=1;i<PUBLIC_CONFIG.participantLimits.mateMatch;i++)players.push(await joined(r.id,'メイト'+i,undefined,undefined,'mate-'+i));
 expect((await call(`rooms/${r.id}/join`,{requestId:crypto.randomUUID(),nickname:'追加'},createParticipantToken())).status).toBe(409);
 const state=await(await call(`rooms/${r.id}/state`,undefined,hostToken,'mate-host')).json();
 const prepared=await call(`rooms/${r.id}/start`,{requestId:crypto.randomUUID(),expectedRevision:state.room.revision},hostToken,'mate-host');
 expect(prepared.status,await prepared.clone().text()).toBe(200);
 let result:any;
 for(const player of players){
  const manifest=await(await call(`rooms/${r.id}/manifest`,undefined,player.token,player.user)).json();
  const ready=await call(`rooms/${r.id}/ready`,{manifestId:manifest.manifestId,preparationGeneration:manifest.preparationGeneration,evaluatorVersion:manifest.evaluatorVersion},player.token,player.user);
  expect(ready.status,await ready.clone().text()).toBe(200);result=await ready.json();
 }
 expect(result.state).toBe('COUNTDOWN');
 const stored=(await pg.query<any>('SELECT expires_at_ms FROM rooms WHERE public_id=$1',[r.id])).rows[0];
 expect(Number(stored.expires_at_ms)).toBe(result.deadlineAtMs+PUBLIC_CONFIG.retentionMs.mateMatch);
});
