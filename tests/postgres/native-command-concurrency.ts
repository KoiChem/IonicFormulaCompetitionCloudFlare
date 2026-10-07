// Independent real PostgreSQL command/notification races; no production data.
import postgres from 'postgres';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {postgresTransactions} from '../../src/platform/postgres-runtime';
import {createSupabaseGateway} from '../../src/platform/supabase-gateway';
import {createParticipantToken} from '../../src/platform/participant-auth';
import {flushRoomEvents} from '../../src/platform/realtime-outbox';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/ionic_timeout_validation_control')throw new Error('Requires local control DB');
const sql=postgres(url,{ssl:false,max:3,prepare:false});
if((await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)[0].n)throw new Error('Control DB must be empty');
await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; END $$;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE SCHEMA realtime;CREATE TABLE realtime.messages(extension text);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;`);
for(const file of readdirSync('supabase/migrations').sort())await sql.unsafe(readFileSync('supabase/migrations/'+file,'utf8'));
const master={id:'11111111-1111-4111-8111-111111111111',email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};
const users=new Map<string,any>([['master',master]]);
function runtime(native:boolean){const command=postgresTransactions(url!,{ssl:false});return {command,gateway:createSupabaseGateway({transact:command,inspect:postgresTransactions(url!,{ssl:false}),read:postgresTransactions(url!,{ssl:false}),nativeJoin:native,nativeReady:native,verifyUser:async r=>users.get(r.headers.get('authorization')?.slice(7)??''),masterEmail:master.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{}})};}
const native=runtime(true),legacy=runtime(false);
const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
async function call(rt:typeof native,user:string,path:string,body?:unknown,token?:string){const response=await rt.gateway(new Request('https://local/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io',authorization:'Bearer '+user,'content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined}));return {status:response.status,data:await response.json()};}
function check(condition:unknown,message:string){if(!condition)throw new Error(message);}
async function create(){const response=await call(native,'master','class-rooms',{requestId:crypto.randomUUID(),settings});check(response.status===201,'Create failed');return response.data.room.id as string;}
async function join(id:string,name:string,rt=native){const uid=crypto.randomUUID();users.set(uid,{id:uid,is_anonymous:true});const token=createParticipantToken();const body={requestId:crypto.randomUUID(),nickname:name};const r=await call(rt,uid,`rooms/${id}/join`,body,token);check(r.status===201,'Join failed');return {uid,token,body,participant:r.data.participant};}
async function start(id:string){const state=await call(native,'master',`rooms/${id}/state`);const body={requestId:crypto.randomUUID(),expectedRevision:state.data.room.revision};const r=await call(legacy,'master',`rooms/${id}/start`,body);check(r.status===200,'Start failed');return r.data;}
async function readyBody(id:string,s:Awaited<ReturnType<typeof join>>){const m=await call(native,s.uid,`rooms/${id}/manifest`,undefined,s.token);return {manifestId:m.data.manifestId,evaluatorVersion:m.data.evaluatorVersion,preparationGeneration:m.data.preparationGeneration};}
async function lock(id:string){let release!:()=>void,acquired!:()=>void;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>acquired=r);const promise=sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`room:${id}`},0))`;acquired();await held;});await entered;return {release,promise};}
async function waiters(n:number){for(let i=0;i<100;i++){const rows=await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`;if(rows[0].n>=n)return;await new Promise(r=>setTimeout(r,10));}throw new Error('Waiter not observed');}
const evidence:any={engine:'PostgreSQL17',mixedWorkers:true,cancelReady:[],joinStart:[]};
for(const readyFirst of [false,true]){
 const id=await create(),s=await join(id,'競合');await start(id);const body=await readyBody(id,s);const state=await call(native,'master',`rooms/${id}/state`);const hold=await lock(id);
 const ready=()=>call(native,s.uid,`rooms/${id}/ready`,body,s.token),cancel=()=>call(legacy,'master',`rooms/${id}/cancel-preparation`,{expectedRevision:state.data.room.revision});
 const first=readyFirst?ready():cancel();await waiters(1);const second=readyFirst?cancel():ready();await waiters(2);await new Promise(r=>setTimeout(r,1500));const released=Date.now();hold.release();await hold.promise;const a=await first,b=await second;
 check(a.status===200&&b.status===409,'Cancel/ready ordering incorrect');const snapshot=await call(native,'master',`rooms/${id}/state`);check(snapshot.data.room.state===(readyFirst?'COUNTDOWN':'WAITING'),'Mixed phase');if(readyFirst)check(a.data.startAtMs>=released+5000,'Countdown used pre-lock clock');
 evidence.cancelReady.push({readyFirst,statuses:[a.status,b.status],state:snapshot.data.room.state,countdownAfterReleaseMs:readyFirst?a.data.startAtMs-released:null});
}
for(const joinFirst of [false,true]){
 const id=await create();await join(id,'先着');const uid=crypto.randomUUID();users.set(uid,{id:uid,is_anonymous:true});const token=createParticipantToken();const hold=await lock(id);
 const joinNext=()=>call(native,uid,`rooms/${id}/join`,{requestId:crypto.randomUUID(),nickname:'後着'},token),startNext=()=>call(legacy,'master',`rooms/${id}/start`,{requestId:crypto.randomUUID(),expectedRevision:1});
 const first=joinFirst?joinNext():startNext();await waiters(1);const second=joinFirst?startNext():joinNext();await waiters(2);hold.release();await hold.promise;const a=await first,b=await second;check(a.status===(joinFirst?201:200)&&b.status===409,'Join/start ordering incorrect');const state=await call(native,'master',`rooms/${id}/state`);check(state.data.participants.length===(joinFirst?2:1),'Join/start roster corrupted');evidence.joinStart.push({joinFirst,statuses:[a.status,b.status],count:state.data.participants.length,state:state.data.room.state});
}
{
 const id=await create(),a=await join(id,'一'),b=await join(id,'二',legacy);await start(id);const body=await readyBody(id,a);const both=await Promise.all([call(native,a.uid,`rooms/${id}/ready`,body,a.token),call(legacy,b.uid,`rooms/${id}/ready`,body,b.token)]);check(both.every(r=>r.status===200),'Simultaneous ready failed');const state=await call(native,'master',`rooms/${id}/state`);check(state.data.room.state==='COUNTDOWN'&&state.data.room.revision===4,'Multiple countdown transitions');evidence.simultaneousReady={revision:state.data.room.revision,state:state.data.room.state};
}
{
 const id=await create();await join(id,'通知一');let entered!:()=>void,release!:()=>void;const sendStarted=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let oldEvent='';
 const flush=flushRoomEvents(legacy.command,id,async(_topic,event,payload:any)=>{if(event==='host.progress'){oldEvent=payload.eventId;entered();await gate;}});await sendStarted;await join(id,'通知二');const row=(await sql`SELECT o.event_id,o.lease_id FROM app_outbox o JOIN rooms r ON r.id=o.room_id WHERE r.public_id=${id} AND o.kind='host'`)[0];check(row.event_id!==oldEvent&&row.lease_id===null,'Native upsert did not reset lease');release();await flush;
 const pending=(await sql`SELECT event_id FROM app_outbox o JOIN rooms r ON r.id=o.room_id WHERE r.public_id=${id} AND o.kind='host'`)[0];check(pending?.event_id===row.event_id,'Old ack deleted newer event');let resent=0;await flushRoomEvents(native.command,id,async()=>{resent++},Date.now()+1100);check(resent>0,'New event was not delivered');evidence.outboxReplacement={oldAckPreservedNew:true,resent};
}
{
 const id=await create();
 const entrants=Array.from({length:43},(_,i)=>{const uid=crypto.randomUUID();users.set(uid,{id:uid,is_anonymous:true});return {uid,token:createParticipantToken(),body:{requestId:crypto.randomUUID(),nickname:'同時'+i}};});
 const results=await Promise.all(entrants.map((s,i)=>call(i%2?legacy:native,s.uid,`rooms/${id}/join`,s.body,s.token)));
 check(results.filter(r=>r.status===201).length===42&&results.filter(r=>r.status===409).length===1,'Concurrent capacity exceeded');
 const rows=await sql`SELECT p.joined_order FROM participants p JOIN rooms r ON r.id=p.room_id WHERE r.public_id=${id}`;
 check(rows.length===42&&new Set(rows.map(r=>r.joined_order)).size===42,'Duplicate joined order');
 const index=results.findIndex(r=>r.status===201),s=entrants[index];
 const replay=await Promise.all([call(native,s.uid,`rooms/${id}/join`,s.body,s.token),call(legacy,s.uid,`rooms/${id}/join`,s.body,s.token)]);
 check(replay.every(r=>r.status===201&&r.data.participant.id===results[index].data.participant.id),'Concurrent receipt replay differs');
 evidence.concurrentCapacity={attempts:43,accepted:42,rejected:1,uniqueJoinedOrders:42,parallelReplaySameParticipant:true};
}
writeFileSync('/private/tmp/ionic-native-concurrency-result.json',JSON.stringify(evidence,null,2));console.log(evidence);await sql.end();process.exit(0);
