import {expect,it} from 'vitest';
import {createWorkerFixture} from './helpers';
import {createSession} from '../../worker/auth/session';
import {SETTINGS} from '../api/helpers';
import {createParticipantToken} from '../../src/platform/participant-auth';
import type {InternalQuestion} from '../../src/games/ionic-formula/shared/types';
import type {V2Operation} from '../../src/competition-core/v2-operations';
it.each(['immediate','deferred'] as const)('%s: runs native HTTP/WS for 50 × 15 × 2 and rejects client51',async gradingMode=>{
 const bindings={MASTER_TEACHER_EMAIL:'master@example.com',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',APP_ORIGIN:'https://test'};
 const f=await createWorkerFixture('worker/index.ts',{bindings,durableObjects:{ROOMS:'RoomCoordinator'}});
 const sockets:WebSocket[]=[];try{
 const session=await createSession({...bindings,DB:f.db as any},{id:'master-sub',email:bindings.MASTER_TEACHER_EMAIL});
 const teacher={cookie:session.cookie.split(';')[0],'x-competition-csrf':session.csrfToken};
 const call=(path:string,method='GET',body?:unknown,token?:string,owner=false)=>f.fetch(path,{method,headers:{origin:'https://test','content-type':'application/json','x-competition-csrf':'1',...(owner?teacher:{}),...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const created=await call('/api/class-rooms','POST',{requestId:crypto.randomUUID(),settings:{...SETTINGS,questionCount:15,mode:'compound',compoundAnswer:'both',compoundPrompts:{formula:true,name:true},gradingMode}},undefined,true);expect(created.status,await created.clone().text()).toBe(201);const publicId=(await created.json() as any).room.id,base='/api/rooms/'+publicId;
 const tokens=Array.from({length:51},()=>createParticipantToken());
 const joined=await Promise.all(tokens.map((token,i)=>call(base+'/join','POST',{requestId:crypto.randomUUID(),nickname:'生徒'+i},token)));expect(joined.filter(r=>r.status===201)).toHaveLength(50);expect(joined[50].status).toBe(409);
 const active=tokens.filter((_,i)=>joined[i].status===201);
 const events:any[]=[];for(const token of active){const r=await f.fetch(base+'/realtime?mode=participant',{headers:{origin:'https://test',upgrade:'websocket'}});expect(r.status).toBe(101);const ws=r.webSocket!;ws.addEventListener('message',e=>events.push(JSON.parse(String(e.data))));ws.accept();ws.send(JSON.stringify({type:'authenticate',token}));sockets.push(ws as any);}
 expect((await call(base+'/start','POST',{requestId:crypto.randomUUID(),expectedRevision:50},undefined,true)).status).toBe(200);
 const manifests=await Promise.all(active.map(async token=>(await (await call(base+'/manifest','GET',undefined,token)).json() as any)));
 await Promise.all(active.map(async(token,i)=>{const m=manifests[i];const r=await call(base+'/ready','POST',{manifestId:m.manifestId,evaluatorVersion:m.evaluatorVersion,preparationGeneration:m.preparationGeneration},token);expect(r.status,await r.clone().text()).toBe(200);}));
 const internal=await f.db.prepare('SELECT id FROM rooms WHERE public_id=?').bind(publicId).first<{id:string}>();
 const questions=(await f.db.prepare('SELECT answer_snapshot_json FROM room_questions WHERE room_id=? ORDER BY ordinal').bind(internal!.id).all<{answer_snapshot_json:string}>()).results.map(r=>JSON.parse(r.answer_snapshot_json) as InternalQuestion);
 expect(questions).toHaveLength(15);expect(questions.reduce((n,q)=>n+q.fields.length,0)).toBe(30);
 // Only the countdown is advanced in isolated storage; submissions and final scoring cross HTTP/DO.
 await f.db.prepare('UPDATE rooms SET start_at_ms=? WHERE public_id=?').bind(Date.now()-2000,publicId).run();
 const operations:V2Operation[]=questions.flatMap(q=>q.fields.map(field=>({seq:0,operationId:crypto.randomUUID(),type:gradingMode==='immediate'?'answer':'draft',questionId:q.id,fieldId:field.id,value:q.answer.type==='both'?q.answer[field.id].canonical:q.answer.canonical,elapsedMs:100,editedElapsedMs:100} as V2Operation)));
 operations.forEach((op,i)=>(op as any).seq=i+1);operations.push({seq:31,operationId:crypto.randomUUID(),type:'finish',reason:gradingMode==='immediate'?'completed':'submitted',elapsedMs:100});
 await Promise.all(active.map(async(token,i)=>{const m=manifests[i],body={requestId:crypto.randomUUID(),writerEpoch:1,manifestId:m.manifestId,evaluatorVersion:m.evaluatorVersion,operations};const r=await call(base+'/operations','POST',body,token);expect(r.status,await r.clone().text()).toBe(200);if(i===0)expect((await call(base+'/operations','POST',body,token)).status).toBe(200);}));
 const result=await call(base+'/results','GET',undefined,active[0]);expect(result.status,await result.clone().text()).toBe(200);const data=await result.json() as any;expect(data.ranking).toHaveLength(50);expect(data.ranking.every((r:any)=>r.correctCount===30&&r.rank===1)).toBe(true);expect(events.some(e=>e.kind==='control')).toBe(true);expect(events.some(e=>e.kind==='host')).toBe(false);
 }finally{for(const ws of sockets)try{ws.close();}catch{}await f.close();}
});
