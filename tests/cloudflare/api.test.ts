import {afterAll,beforeAll,expect,it} from 'vitest';
import {createWorkerFixture} from './helpers';
import {createSession} from '../../worker/auth/session';
import {SETTINGS} from '../api/helpers';
import {createParticipantToken} from '../../src/platform/participant-auth';
let fixture:Awaited<ReturnType<typeof createWorkerFixture>>,cookie:string,csrf:string;
const bindings={MASTER_TEACHER_EMAIL:'master@example.com',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',APP_ORIGIN:'https://test'};
beforeAll(async()=>{fixture=await createWorkerFixture('worker/index.ts',{bindings,durableObjects:{ROOMS:'RoomCoordinator'}});const session=await createSession({...bindings,DB:fixture.db as any},{id:'master-sub',email:'master@example.com'});cookie=session.cookie.split(';')[0];csrf=session.csrfToken;});
afterAll(async()=>{await fixture?.close();});
function call(path:string,method='GET',body?:unknown,token?:string,teacher=false){return fixture.fetch(path,{method,headers:{origin:'https://test','content-type':'application/json','x-competition-csrf':teacher?csrf:'1',...(token?{authorization:'Bearer '+token}:{}),...(teacher?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});}
it('uses same-origin public/native teacher API and enforces cookie csrf',async()=>{
 expect((await call('/api/public-config')).status).toBe(200);
 expect((await call('/api/class-rooms','POST',{requestId:crypto.randomUUID(),settings:SETTINGS})).status).toBe(401);
 const bad=await fixture.fetch('/api/class-rooms',{method:'POST',headers:{origin:'https://test',cookie,'content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings:SETTINGS})});expect(bad.status).toBe(403);
 expect((await call('/api/teacher/session','GET',undefined,undefined,true)).status).toBe(200);
 expect((await call('/api/unknown')).status).toBe(404);expect((await call('/api/public-config','POST',{})).status).toBe(405);
});
it('supports native class join replay and rejects foreign participant/teacher actions',async()=>{
 const createId=crypto.randomUUID();const created=await call('/api/class-rooms','POST',{requestId:createId,settings:{...SETTINGS,gradingMode:'immediate'}},undefined,true);expect(created.status).toBe(201);const body=await created.json() as any;const room=body.room.id;
 const replay=await call('/api/class-rooms','POST',{requestId:createId,settings:{...SETTINGS,gradingMode:'immediate'}},undefined,true);expect((await replay.json() as any).room.id).toBe(room);
 const token=createParticipantToken(),id=crypto.randomUUID();const joined=await call('/api/rooms/'+room+'/join','POST',{requestId:id,nickname:'生徒'},token);expect(joined.status).toBe(201);
 const again=await call('/api/rooms/'+room+'/join','POST',{requestId:id,nickname:'生徒'},token);expect((await again.json() as any).participant.id).toBe((await joined.json() as any).participant.id);
 expect((await call('/api/rooms/'+room+'/state','GET',undefined,token)).status).toBe(200);
 expect((await call('/api/rooms/'+room+'/state','GET',undefined,createParticipantToken())).status).toBe(403);
 expect((await call('/api/rooms/'+room+'/start','POST',{requestId:crypto.randomUUID(),expectedRevision:1},token)).status).toBe(403);
 const state=await call('/api/rooms/'+room+'/state','GET',undefined,undefined,true);expect(state.status).toBe(200);expect((await (await call('/api/public-config')).json() as any).participantLimits.classCompetition).toBe(50);
});

it.each(['immediate','deferred'] as const)('runs %s grading through native HTTP and persists server results',async gradingMode=>{
 const created=await call('/api/class-rooms','POST',{requestId:crypto.randomUUID(),settings:{...SETTINGS,ionAnswer:'name',gradingMode}},undefined,true);expect(created.status).toBe(201);const room=(await created.json() as any).room.id;const token=createParticipantToken();
 expect((await call('/api/rooms/'+room+'/join','POST',{requestId:crypto.randomUUID(),nickname:'採点'},token)).status).toBe(201);
 expect((await call('/api/rooms/'+room+'/start','POST',{requestId:crypto.randomUUID(),expectedRevision:1},undefined,true)).status).toBe(200);
 const manifest=await (await call('/api/rooms/'+room+'/manifest','GET',undefined,token)).json() as any;
 const ready=await call('/api/rooms/'+room+'/ready','POST',{manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration},token);expect(ready.status).toBe(200);
 // Isolated storage shifts countdown only; requests and grading execute in real workerd/DO.
 await fixture.db.prepare('UPDATE rooms SET start_at_ms=? WHERE public_id=?').bind(Date.now()-2000,room).run();
 const batch={requestId:crypto.randomUUID(),writerEpoch:1,manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,operations:[{seq:1,operationId:crypto.randomUUID(),type:'finish',reason:'submitted',elapsedMs:900}]};
 const saved=await call('/api/rooms/'+room+'/operations','POST',batch,token);expect(saved.status,await saved.clone().text()).toBe(200);
 expect((await call('/api/rooms/'+room+'/operations','POST',batch,token)).status).toBe(200);
 const result=await call('/api/rooms/'+room+'/results','GET',undefined,token);expect(result.status,await result.clone().text()).toBe(200);expect((await result.json() as any).own).toMatchObject({correctCount:0,finishReason:'submitted'});
});
