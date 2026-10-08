import {afterAll,beforeAll,expect,it} from 'vitest';
import {createWorkerFixture} from './helpers';
import {createSession} from '../../worker/auth/session';
import {SETTINGS} from '../api/helpers';
import {createParticipantToken} from '../../src/platform/participant-auth';
let f:Awaited<ReturnType<typeof createWorkerFixture>>,cookie:string,csrf:string;
const bindings={MASTER_TEACHER_EMAIL:'master@example.com',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',APP_ORIGIN:'https://test'};
beforeAll(async()=>{f=await createWorkerFixture('worker/index.ts',{bindings,durableObjects:{ROOMS:'RoomCoordinator'}});const s=await createSession({...bindings,DB:f.db as any},{id:'master-sub',email:'master@example.com'});cookie=s.cookie.split(';')[0];csrf=s.csrfToken;});
afterAll(async()=>f?.close());
async function room(){const r=await f.fetch('/api/class-rooms',{method:'POST',headers:{origin:'https://test',cookie,'content-type':'application/json','x-competition-csrf':csrf},body:JSON.stringify({requestId:crypto.randomUUID(),settings:{...SETTINGS,gradingMode:'immediate'}})});expect(r.status).toBe(201);return (await r.json() as any).room.id as string;}
async function join(id:string,token:string){return f.fetch(`/api/rooms/${id}/join`,{method:'POST',headers:{origin:'https://test',authorization:'Bearer '+token,'content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),nickname:'生徒'+crypto.randomUUID().slice(0,6)})});}
async function socket(id:string,teacher=false){const r=await f.fetch(`/api/rooms/${id}/realtime`,{headers:{origin:'https://test',upgrade:'websocket',...(teacher?{cookie}:{})}});expect(r.status).toBe(101);const ws=r.webSocket!;const frames:any[]=[];ws.addEventListener('message',e=>{if(e.data!=='pong')frames.push(JSON.parse(String(e.data)));});ws.accept();ws.send(teacher?JSON.stringify({type:'authenticate'}):'ping');return {ws,frames};}
const until=async(check:()=>boolean)=>{for(let n=0;n<180&&!check();n++)await new Promise(r=>setTimeout(r,20));expect(check()).toBe(true);};
it('upgrades only same-origin, authenticates the first frame, and separates host progress',async()=>{
 const id=await room(),token=createParticipantToken();await join(id,token);
 expect((await f.fetch(`/api/rooms/${id}/realtime`,{headers:{origin:'https://evil.test',upgrade:'websocket'}})).status).toBe(403);
 const student=await socket(id),host=await socket(id,true);expect(student.frames).toEqual([]);await until(()=>host.frames.some(x=>x.type==='authenticated'));
 student.ws.send(JSON.stringify({type:'authenticate',token}));await until(()=>student.frames.some(x=>x.type==='authenticated'));
 await join(id,createParticipantToken());await until(()=>host.frames.some(x=>x.kind==='host'));
 expect(student.frames.some(x=>x.kind==='host')).toBe(false);
 expect(JSON.stringify(host.frames)).not.toContain(token);
 student.ws.close();host.ws.close();
});
it('revokes an existing student socket after removal',async()=>{
 const id=await room(),token=createParticipantToken();const joined=await (await join(id,token)).json() as any;const s=await socket(id);s.ws.send(JSON.stringify({type:'authenticate',token}));await until(()=>s.frames.length>0);
 let closed=false;s.ws.addEventListener('close',()=>closed=true);
 const response=await f.fetch(`/api/rooms/${id}/remove`,{method:'POST',headers:{origin:'https://test',cookie,'content-type':'application/json','x-competition-csrf':csrf},body:JSON.stringify({requestId:crypto.randomUUID(),participantId:joined.participant.id,expectedRoomRevision:1,expectedParticipantRevision:0})});expect(response.status,await response.clone().text()).toBe(200);await until(()=>closed);
});
it('closes unauthenticated sockets on the durable five-second alarm',async()=>{
 const id=await room(),s=await socket(id);let closed=false;s.ws.addEventListener('close',()=>closed=true);await new Promise(r=>setTimeout(r,7000));expect(closed).toBe(true);expect(s.frames).toEqual([]);
});
it('rechecks persisted teacher sessions before private notifications',async()=>{
 const id=await room(),s=await socket(id,true);let closed=false;s.ws.addEventListener('close',()=>closed=true);await f.db.prepare('UPDATE cf_sessions SET expires_at_ms=0').run();const joined=await join(id,createParticipantToken());expect(joined.status,await joined.clone().text()).toBe(201);await until(()=>closed);
 const fresh=await createSession({...bindings,DB:f.db as any},{id:'master-sub',email:'master@example.com'});cookie=fresh.cookie.split(';')[0];csrf=fresh.csrfToken;
});
it('an alarm finalizes an overdue room without a participant HTTP poll',async()=>{
 const id=await room(),token=createParticipantToken();await join(id,token);
 const headers={origin:'https://test',cookie,'content-type':'application/json','x-competition-csrf':csrf};
 expect((await f.fetch(`/api/rooms/${id}/start`,{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:1})})).status).toBe(200);
 const manifest=await (await f.fetch(`/api/rooms/${id}/manifest`,{headers:{authorization:'Bearer '+token}})).json() as any;
 expect((await f.fetch(`/api/rooms/${id}/ready`,{method:'POST',headers:{origin:'https://test',authorization:'Bearer '+token,'content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration})})).status).toBe(200);
 // Isolated fixture advances stored timestamps, then lets the real alarm own collection/finalization.
 await f.db.prepare('UPDATE rooms SET start_at_ms=?,deadline_at_ms=? WHERE public_id=?').bind(Date.now()-11000,Date.now()+100,id).run();await f.fetch(`/api/rooms/${id}/state`,{headers:{authorization:'Bearer '+token}});
 await new Promise(r=>setTimeout(r,10600));const row=await f.db.prepare('SELECT r.state,m.state AS phase FROM rooms r JOIN v2_room_manifests m ON m.room_id=r.id WHERE r.public_id=?').bind(id).first();expect(row).toMatchObject({state:'FINISHED',phase:'FINISHED'});
});
it('restores role attachments after hibernation and recovers dirty D1 notifications',async()=>{
 const id=await room(),token=createParticipantToken();await join(id,token);const s=await socket(id);s.ws.send(JSON.stringify({type:'authenticate',token}));await until(()=>s.frames.some(e=>e.type==='authenticated'));
 await f.runtime.unsafeEvictDurableObject('','RoomCoordinator',{name:id,webSockets:'hibernate'});
 await f.db.prepare('UPDATE cf_room_notifications SET control_sent=0 WHERE room_id=(SELECT id FROM rooms WHERE public_id=?)').bind(id).run();
 const r=await f.fetch(`/api/rooms/${id}/state`,{headers:{authorization:'Bearer '+token}});expect(r.status,await r.clone().text()).toBe(200);await until(()=>s.frames.some(e=>e.kind==='control'));expect(s.frames.some(e=>e.kind==='host')).toBe(false);s.ws.close();
});
