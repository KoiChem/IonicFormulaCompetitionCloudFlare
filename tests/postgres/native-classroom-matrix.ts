// Run after a completed load on the same guarded disposable database.
// Explicit standalone test against an empty local disposable PostgreSQL cluster.
import postgres from 'postgres';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {postgresTransactions} from '../../src/platform/postgres-runtime';
import {createSupabaseGateway} from '../../src/platform/supabase-gateway';
import {createParticipantToken} from '../../src/platform/participant-auth';
import {priorityTransactions} from '../../src/platform/priority-transactions';
import {coalescedRoomFlusher,flushRoomEvents,retryRoomDrain} from '../../src/platform/realtime-outbox';
import {createMaintenanceHandler} from '../../src/platform/maintenance';
const connection=process.env.TEST_DATABASE_URL;
if(!connection||new URL(connection).hostname!=='127.0.0.1'||new URL(connection).pathname!=='/ionic_timeout_validation')throw new Error('Requires disposable localhost validation database');
const sql=postgres(connection,{ssl:false,max:4,prepare:false});

const transact=postgresTransactions(connection,{ssl:false,queryDelayMs:0});
const inspect=postgresTransactions(connection,{ssl:false,queryDelayMs:0});
const users=new Map<string,any>();
const master={id:'11111111-1111-4111-8111-111111111111',email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};users.set('master',master);
const background=new Set<Promise<void>>();let sends=0,failures=0;const delivered=new Set<string>();
function runtime(native:boolean){
 const command=postgresTransactions(connection,{ssl:false});
 const critical=priorityTransactions(postgresTransactions(connection,{ssl:false}));
 const read=postgresTransactions(connection,{ssl:false});
 const flush=coalescedRoomFlusher(async id=>{await retryRoomDrain(()=>flushRoomEvents(command,id,async(_topic,_event,payload)=>{
  if(JSON.stringify(payload).includes('nickname'))throw new Error('Notification privacy leak');
  await new Promise(resolve=>setTimeout(resolve,30));
  if(failures===0){failures++;throw new Error('Injected temporary HTTP failure');}
  sends++;delivered.add(payload.eventId);
 }));});
 const gateway=createSupabaseGateway({transact:command,inspect:critical,read,nativeJoin:native,nativeReady:native,verifyUser:async r=>users.get(r.headers.get('authorization')?.slice(7)??'')??null,masterEmail:master.email,allowedOrigins:['https://koichem.github.io'],flush:async id=>{
  const task=flush(id);background.add(task);void task.finally(()=>background.delete(task));
 }});
 return {gateway,flush,command};
}
const runtimes=[runtime(true),runtime(false)];let invocation=0;
const gateway=(request:Request)=>runtimes[invocation++%2].gateway(request);
async function call(user:string,path:string,body?:unknown,token?:string){const started=Date.now();const response=await gateway(new Request('https://local/functions/v1/competition/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io',authorization:`Bearer ${user}`,'content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined}));const data=await response.json();if(!response.ok)throw new Error(JSON.stringify({path,status:response.status,data}));return {data,ms:Date.now()-started};}
const starts:number[]=[];const readyBySize:Record<string,number[]>={20:[],42:[]};const settings={questionCount:15,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
async function runCase(size:number,round:number){
 const {data:{room}}=await call('master','class-rooms',{requestId:crypto.randomUUID(),settings:{...settings,questionCount:round%2?15:5,gradingMode:round<2?'immediate':'deferred'}});
 const students=Array.from({length:size},()=>{const id=crypto.randomUUID();users.set(id,{id,is_anonymous:true});return {id,token:createParticipantToken()};});
 await Promise.all(students.map((s,i)=>call(s.id,`rooms/${room.id}/join`,{requestId:crypto.randomUUID(),nickname:`生徒${i+1}`},s.token)));
 // 1 host and 1 state read per tab in flight when host presses Start.
 const baseline=await call('master',`rooms/${room.id}/state`);
 const polling=Promise.all([call('master',`rooms/${room.id}/state`),...students.map(s=>call(s.id,`rooms/${room.id}/state`,undefined,s.token))]);
 const startBody={requestId:crypto.randomUUID(),expectedRevision:baseline.data.room.revision};
 const started=await call('master',`rooms/${room.id}/start`,startBody);starts.push(started.ms);await polling;
 const receipt=await call('master',`rooms/${room.id}/start-status?requestId=${startBody.requestId}`);
 if(receipt.data.room.state!=='PREPARING'||receipt.data.receipt.preparationGeneration!==1)throw new Error('Start receipt mismatch');
 const replay=await call('master',`rooms/${room.id}/start`,startBody);if(replay.data.preparationGeneration!==1)throw new Error('Replay generated a second manifest');
 const readyStarted=Date.now();
 await Promise.all(students.map(async s=>{const manifest=await call(s.id,`rooms/${room.id}/manifest`,undefined,s.token);await call(s.id,`rooms/${room.id}/ready`,{manifestId:manifest.data.manifestId,preparationGeneration:1,evaluatorVersion:manifest.data.evaluatorVersion},s.token);}));
 const readyMs=Date.now()-readyStarted;readyBySize[size].push(readyMs);
 const state=await call('master',`rooms/${room.id}/state`);if(!['COUNTDOWN','RUNNING'].includes(state.data.room.state))throw new Error('Not started');
 if(state.data.room.startAtMs<Date.now()+1500)throw new Error('Countdown was consumed while queued');
 await call('master',`rooms/${room.id}/interrupt`,{requestId:crypto.randomUUID(),expectedRevision:state.data.room.revision});
 console.log(JSON.stringify({size,questions:round%2?15:5,gradingMode:round<2?'immediate':'deferred',startMs:started.ms,readyMs}));
}
for(let round=0;round<4;round++)await Promise.all([runCase(20,round),runCase(42,round)]);
while(background.size)await Promise.all([...background]);
// Persist a room without any foreground drain, as if its worker ended after commit.
const orphan=createSupabaseGateway({transact,inspect,verifyUser:async()=>master,masterEmail:master.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{}});
const response=await orphan(new Request('https://local/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));
if(response.status!==201)throw new Error(await response.text());const orphanId=(await response.json()).room.id;
let clock=Date.now();
const maintenance=createMaintenanceHandler({transact:runtimes[0].command,flush:runtimes[0].flush,secret:'test-only',now:()=>clock});
for(let i=0;i<16;i++){
 const pending=await sql`SELECT count(*)::int AS n FROM app_outbox o JOIN rooms r ON r.id=o.room_id WHERE r.public_id=${orphanId}`;
 if(!pending[0].n)break;
 const recovered=await maintenance(new Request('https://local/maintenance',{method:'POST',headers:{authorization:'Bearer test-only'}}));
 if(recovered.status!==200)throw new Error(await recovered.text());clock+=60000;
}
if((await sql`SELECT count(*)::int AS n FROM app_outbox o JOIN rooms r ON r.id=o.room_id WHERE r.public_id=${orphanId}`)[0].n)throw new Error('Worker termination recovery failed');
if(!sends||failures!==1||!delivered.size)throw new Error('Notification test did not run');
const percentile=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
const result={mixedNativeLegacy:true,engine:'PostgreSQL 17',queryDelayMs:0,authDelayMs:0,roundsPerSize:4,runtimes:2,poolsPerRuntime:3,simultaneousRooms:2,flush:true,httpDelayMs:30,sends,injectedFailures:failures,workerRecovery:'verified',startAll:{p95:percentile(starts,.95),max:Math.max(...starts)},ready20:{p95:percentile(readyBySize[20],.95),max:Math.max(...readyBySize[20])},ready42:{p95:percentile(readyBySize[42],.95),max:Math.max(...readyBySize[42])}};
writeFileSync('/private/tmp/ionic-native-matrix-result.json',JSON.stringify(result,null,2));console.log(result);
if(result.startAll.max>=3000||result.ready20.max>=5000||result.ready42.max>=8000)throw new Error('Load acceptance exceeded');
await sql.end();process.exit(0);
