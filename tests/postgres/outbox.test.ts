import { beforeAll, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { PostgresDatabase } from '../../src/platform/postgres-database';
import { createSupabaseGateway } from '../../src/platform/supabase-gateway';
import { createParticipantToken } from '../../src/platform/participant-auth';
import { flushRoomEvents } from '../../src/platform/realtime-outbox';
let pg:PGlite;let now=Date.now();
const user={id:'11111111-1111-4111-8111-111111111111',email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};
const transact=async<T>(_scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>pg.transaction(tx=>run(new PostgresDatabase((q,v)=>tx.query(q,v))));
const gateway=createSupabaseGateway({transact,verifyUser:async()=>user,masterEmail:user.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{},now:()=>now});
beforeAll(async()=>{
 pg=new PGlite();await pg.exec(readFileSync('supabase/migrations/202610010001_core.sql','utf8'));
 await pg.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE SCHEMA realtime;CREATE TABLE realtime.messages(extension text);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.topic',true) $$;`);
 await pg.exec(readFileSync('supabase/migrations/202610010002_auth_realtime.sql','utf8'));
 await pg.exec(readFileSync('supabase/migrations/202610010003_permissions_maintenance.sql','utf8')); await pg.exec(readFileSync('supabase/migrations/202610020001_question_profiles.sql','utf8')); await pg.exec(readFileSync('supabase/migrations/202610050001_maintenance.sql','utf8'));
});
afterAll(async()=>pg.close());
it('commits minimal events and removes each successfully delivered outbox record',async()=>{
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const response=await gateway(new Request('https://p.supabase.co/functions/v1/competition/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));
 expect(response.status).toBe(201);const {room}=await response.json();
 const delivered:any[]=[];
 await flushRoomEvents(transact,room.id,async(topic,event,payload)=>{delivered.push({topic,event,payload})},now);
 expect(delivered.map(x=>x.event)).toEqual(['room.changed','host.progress']);
 expect(delivered[0].payload).not.toHaveProperty('participants');
 expect(JSON.stringify(delivered)).not.toContain('token');
 expect((await pg.query('SELECT count(*)::int AS count FROM app_outbox')).rows).toEqual([{count:0}]);
});
it('preserves immutable join order in state and realtime progress payloads',async()=>{
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const call=(path:string,body?:unknown,token?:string)=>gateway(new Request('https://p.supabase.co/functions/v1/competition/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined}));
 const created=await call('class-rooms',{requestId:crypto.randomUUID(),settings});expect(created.status).toBe(201);const {room}=await created.json();
 for(const nickname of ['Color A','Color B'])expect((await call(`rooms/${room.id}/join`,{nickname,requestId:crypto.randomUUID()},createParticipantToken())).status).toBe(201);
 const state=await call(`rooms/${room.id}/state`);expect(state.status).toBe(200);
 expect((await state.json()).participants.map((p:any)=>p.joinedOrder)).toEqual([1,2]);
 const delivered:any[]=[];await flushRoomEvents(transact,room.id,async(_topic,event,payload)=>{delivered.push({event,payload})},now+2000);
 expect(delivered.find(x=>x.event==='host.progress').payload).not.toHaveProperty('participants');
});
it('does not fan out roster changes to every student during a 20-person join burst',async()=>{
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const call=(path:string,body?:unknown,token?:string)=>gateway(new Request('https://p.supabase.co/functions/v1/competition/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined}));
 const created=await call('class-rooms',{requestId:crypto.randomUUID(),settings});
 expect(created.status).toBe(201);const {room}=await created.json();
 await flushRoomEvents(transact,room.id,async()=>{},now+4000);
 const responses=await Promise.all(Array.from({length:20},(_,i)=>call(`rooms/${room.id}/join`,{nickname:`生徒${i+1}`,requestId:crypto.randomUUID()},createParticipantToken())));
 expect(responses.map(r=>r.status)).toEqual(Array(20).fill(201));
 const delivered:any[]=[];
 await flushRoomEvents(transact,room.id,async(_topic,event,payload)=>{delivered.push({event,payload})},now+6000);
 expect(delivered.map(x=>x.event)).toEqual(['host.progress']);
 expect(delivered[0].payload).not.toHaveProperty('participants');
 const snapshot=await (await call(`rooms/${room.id}/state`)).json();
 const start=await call(`rooms/${room.id}/start`,{requestId:crypto.randomUUID(),expectedRevision:snapshot.room.revision});
 expect(start.status,await start.clone().text()).toBe(200);
 const started:any[]=[];
 await flushRoomEvents(transact,room.id,async(_topic,event,payload)=>{started.push({event,payload})},now+8000);
 expect(started.find(x=>x.event==='room.changed').payload.roomRevision).toBe(snapshot.room.revision+1);
},15000);
it('delivers only invalidation metadata with no database transaction held across network I/O',async()=>{
 let active=0;
 const measured=async<T>(scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>transact(scope,async db=>{active++;try{return await run(db)}finally{active--}});
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const created=await gateway(new Request('https://p.supabase.co/functions/v1/competition/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));
 const {room}=await created.json();
 const observations:any[]=[];
 await flushRoomEvents(measured,room.id,async(_topic,_event,payload)=>{observations.push({active,keys:Object.keys(payload as object).sort()});},now+12000);
 expect(observations).toHaveLength(2);
 for(const observation of observations){expect(observation.active).toBe(0);expect(observation.keys).toEqual(['epoch','eventId','revision','roomId','roomRevision']);}
});
it('does not acknowledge a newer event replaced during delivery and strips legacy payloads',async()=>{
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const created=await gateway(new Request('https://p.supabase.co/functions/v1/competition/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));
 const {room}=await created.json();const internal=(await pg.query<{id:string}>('SELECT id FROM rooms WHERE public_id=$1',[room.id])).rows[0].id;
 await pg.query(`UPDATE app_outbox SET payload_json=jsonb_set(payload_json::jsonb,'{participants}','[{"nickname":"private","token":"secret"}]'::jsonb)::text WHERE room_id=$1`,[internal]);
 const deliveries:any[]=[];const newer=crypto.randomUUID();
 await flushRoomEvents(transact,room.id,async(_topic,event,payload)=>{
  deliveries.push(payload);
  if(event==='host.progress')await pg.query('UPDATE app_outbox SET event_id=$1,revision=revision+1 WHERE room_id=$2 AND kind=\'host\'',[newer,internal]);
 },now+14000);
 expect(JSON.stringify(deliveries)).not.toContain('private');expect(JSON.stringify(deliveries)).not.toContain('secret');
 const pending=(await pg.query('SELECT event_id FROM app_outbox WHERE room_id=$1',[internal])).rows;
 expect(pending).toEqual([{event_id:newer}]);
 expect((await pg.query<{sent_progress_ms:string}>('SELECT sent_progress_ms FROM app_room_topics WHERE room_id=$1',[internal])).rows[0].sent_progress_ms).toBe(0);
});
it('returns a failed delivery to the queue without recording success',async()=>{
 const row=(await pg.query<any>('SELECT o.room_id,r.public_id FROM app_outbox o JOIN rooms r ON r.id=o.room_id LIMIT 1')).rows[0];
 await flushRoomEvents(transact,row.public_id,async()=>{throw new Error('network down')},now+30000);
 expect((await pg.query('SELECT lease_until_ms FROM app_outbox WHERE room_id=$1',[row.room_id])).rows).toEqual([{lease_until_ms:0}]);
});
it('does not lease a replacement written between candidate read and conditional claim',async()=>{
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const created=await gateway(new Request('https://p.supabase.co/functions/v1/competition/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));
 const {room}=await created.json();const replacement=crypto.randomUUID();let interleaved=false;
 const raced=async<T>(_scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>pg.transaction(tx=>run(new PostgresDatabase(async(q,v)=>{
  const result=await tx.query(q,v);
  if(!interleaved&&q.includes('SELECT * FROM app_outbox')){interleaved=true;await tx.query(`UPDATE app_outbox SET event_id=$1 WHERE room_id=(SELECT id FROM rooms WHERE public_id=$2) AND kind='control'`,[replacement,room.id]);}
  return result;
 })));
 const delivered:string[]=[];await flushRoomEvents(raced,room.id,async(_topic,event)=>{delivered.push(event)},now+40000);
 expect(delivered).toEqual(['host.progress']);
 const row=(await pg.query('SELECT event_id,lease_until_ms FROM app_outbox WHERE event_id=$1',[replacement])).rows[0];
 expect(row).toEqual({event_id:replacement,lease_until_ms:0});
});
it('reports a deferred notification wake-up instead of relying on another API request',async()=>{
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 const created=await gateway(new Request('https://p.supabase.co/functions/v1/competition/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));
 const {room}=await created.json();const future=now+50000;
 await pg.query('UPDATE app_broadcast_budget SET window_ms=$1,used=90 WHERE id=1',[Math.floor(future/1000)*1000]);
 const delivered:string[]=[];const pending=await flushRoomEvents(transact,room.id,async(_topic,event)=>{delivered.push(event)},future);
 expect(delivered).toHaveLength(0);expect(pending?.nextEligibleAt).toBe(Math.floor(future/1000)*1000+1000);
 const completed=await flushRoomEvents(transact,room.id,async(_topic,event)=>{delivered.push(event)},Math.floor(future/1000)*1000+1001);
 expect(delivered).toHaveLength(2);expect(completed?.nextEligibleAt).toBeNull();
});
