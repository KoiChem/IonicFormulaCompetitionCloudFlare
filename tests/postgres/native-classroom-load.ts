// Explicit standalone test against an empty local disposable PostgreSQL cluster.
import postgres from 'postgres';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {postgresTransactions} from '../../src/platform/postgres-runtime';
import {priorityTransactions} from '../../src/platform/priority-transactions';
import {createSupabaseGateway} from '../../src/platform/supabase-gateway';
import {createParticipantToken} from '../../src/platform/participant-auth';
const phase=process.env.PHASE??'native';
const controlDelayMs=Number(process.env.CONTROL_DELAY_MS??0);
const queryDelayMs=Number(process.env.QUERY_DELAY_MS??10);
const requests:Array<Record<string,unknown>>=[];const printMetric=console.info.bind(console);console.info=(value:unknown)=>{try{const row=JSON.parse(String(value));if(row.event==='api_request')requests.push(row);}catch{}printMetric(value);};
const connection=process.env.TEST_DATABASE_URL;
if(!connection||new URL(connection).hostname!=='127.0.0.1'||new URL(connection).pathname!=='/ionic_timeout_validation')throw new Error('Requires disposable localhost validation database');
const sql=postgres(connection,{ssl:false,max:4,prepare:false});
const resumeLog=process.env.RESUME_LOG;
const tables=(await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)[0].n;
if(tables!==0&&!resumeLog)throw new Error('Validation database must be empty');
if(tables===0){
await sql.unsafe(readFileSync('supabase/migrations/202610010001_core.sql','utf8'));
await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; END $$;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;CREATE SCHEMA realtime;CREATE TABLE realtime.messages(extension text);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;`);
for(const file of readdirSync('supabase/migrations').sort().slice(1))await sql.unsafe(readFileSync('supabase/migrations/'+file,'utf8'));
}
const transact=postgresTransactions(connection,{ssl:false,queryDelayMs,controlDelayMs});
const inspect=priorityTransactions(postgresTransactions(connection,{ssl:false,queryDelayMs,controlDelayMs}));
const read=process.env.SHARED_READ_POOL==='1'?inspect:postgresTransactions(connection,{ssl:false,queryDelayMs,controlDelayMs});
const users=new Map<string,any>();
const master={id:'11111111-1111-4111-8111-111111111111',email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};users.set('master',master);
const gateway=createSupabaseGateway({transact,inspect,read,nativeJoin:phase==='native',nativeReady:phase==='native',metricSampleRate:1,verifyUser:async r=>{await new Promise(resolve=>setTimeout(resolve,200));return users.get(r.headers.get('authorization')?.slice(7)??'')??null;},masterEmail:master.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{}});
async function call(user:string,path:string,body?:unknown,token?:string){const started=Date.now();const response=await gateway(new Request('https://local/functions/v1/competition/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io',authorization:`Bearer ${user}`,'content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined}));const data=await response.json();if(!response.ok)throw new Error(JSON.stringify({path,status:response.status,data}));return {data,ms:Date.now()-started};}
const samples:Array<Record<string,unknown>>=[];const joinBySize:Record<string,number[]>={20:[],42:[]};const joinAllBySize:Record<string,number[]>={20:[],42:[]};const replayBySize:Record<string,number[]>={20:[],42:[]};const statusBySize:Record<string,number[]>={20:[],42:[]};let aborts=0;
const starts:number[]=[];const readyBySize:Record<string,number[]>={20:[],42:[]};const settings={questionCount:15,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
if(resumeLog)for(const line of readFileSync(resumeLog,'utf8').split('\n')){let row:any;try{row=JSON.parse(line);}catch{continue;}if(!row.size||!row.round||!Array.isArray(row.joinMs))continue;samples.push(row);joinBySize[row.size].push(...row.joinMs);joinAllBySize[row.size].push(row.joinAllMs);starts.push(row.startMs);readyBySize[row.size].push(row.readyMs);statusBySize[row.size].push(row.statusMs);replayBySize[row.size].push(row.replayMs);aborts+=row.joinMs.filter((x:number)=>x>=10000).length;}
for(const size of [20,42])for(let round=0;round<Number(process.env.ROUNDS??30);round++){
 if(samples.some(row=>row.size===size&&row.round===round+1))continue;
 const {data:{room}}=await call('master','class-rooms',{requestId:crypto.randomUUID(),settings});
 const students=Array.from({length:size},()=>{const id=crypto.randomUUID();users.set(id,{id,is_anonymous:true});return {id,token:createParticipantToken()};});
 const joinAt=Date.now();const joins=await Promise.all(students.map((s,i)=>call(s.id,`rooms/${room.id}/join`,{requestId:crypto.randomUUID(),nickname:`生徒${i+1}`},s.token)));
 const joinAllMs=Date.now()-joinAt;joinBySize[size].push(...joins.map(x=>x.ms));joinAllBySize[size].push(joinAllMs);aborts+=joins.filter(x=>x.ms>=10000).length;
 // 1 host and 1 state read per tab in flight when host presses Start.
 const baseline=await call('master',`rooms/${room.id}/state`);
 const polling=Promise.all([call('master',`rooms/${room.id}/state`),...students.map(s=>call(s.id,`rooms/${room.id}/state`,undefined,s.token))]);
 const startBody={requestId:crypto.randomUUID(),expectedRevision:baseline.data.room.revision};
 const started=await call('master',`rooms/${room.id}/start`,startBody);starts.push(started.ms);await polling;
 const receipt=await call('master',`rooms/${room.id}/start-status?requestId=${startBody.requestId}`);
 if(receipt.data.room.state!=='PREPARING'||receipt.data.receipt.preparationGeneration!==1)throw new Error('Start receipt mismatch');
 statusBySize[size].push(receipt.ms);
 const replay=await call('master',`rooms/${room.id}/start`,startBody);replayBySize[size].push(replay.ms);if(replay.data.preparationGeneration!==1)throw new Error('Replay generated a second manifest');
 const readyStarted=Date.now();
 await Promise.all(students.map(async s=>{const manifest=await call(s.id,`rooms/${room.id}/manifest`,undefined,s.token);await call(s.id,`rooms/${room.id}/ready`,{manifestId:manifest.data.manifestId,preparationGeneration:1,evaluatorVersion:manifest.data.evaluatorVersion},s.token);}));
 const readyMs=Date.now()-readyStarted;readyBySize[size].push(readyMs);
 const state=await call('master',`rooms/${room.id}/state`);if(!['COUNTDOWN','RUNNING'].includes(state.data.room.state))throw new Error('Not started');
 if(state.data.room.startAtMs<Date.now()+1500)throw new Error('Countdown was consumed while queued');
 await call('master',`rooms/${room.id}/interrupt`,{requestId:crypto.randomUUID(),expectedRevision:state.data.room.revision});
 const sample={size,round:round+1,joinMs:joins.map(x=>x.ms),joinAllMs,startMs:started.ms,statusMs:receipt.ms,replayMs:replay.ms,readyMs};samples.push(sample);console.log(JSON.stringify(sample));
}
const percentile=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
const rounds=Number(process.env.ROUNDS??30);
const stats=(v:number[])=>({p50:percentile(v,.5),p95:percentile(v,.95),max:Math.max(...v)});
const commandMetrics=requests.filter(row=>row.route==='join'||row.route==='ready').map(row=>({route:row.route,path:row.commandPath,applicationDbCalls:row.queryCount,transactionControlCalls:row.controlQueryCount}));
const result={phase,aborts,samples,controlDelayMs,commandMetrics,join20:stats(joinBySize[20]),join42:stats(joinBySize[42]),allJoin20:stats(joinAllBySize[20]),allJoin42:stats(joinAllBySize[42]),status20:stats(statusBySize[20]),status42:stats(statusBySize[42]),replay20:stats(replayBySize[20]),replay42:stats(replayBySize[42]),engine:'PostgreSQL 17',queryDelayMs,authDelayMs:200,roundsPerSize:rounds,pools:process.env.SHARED_READ_POOL==='1'?2:3,flush:false,start20:{p95:percentile(starts.slice(0,rounds),.95),max:Math.max(...starts.slice(0,rounds))},start42:{p95:percentile(starts.slice(rounds),.95),max:Math.max(...starts.slice(rounds))},ready20:{p95:percentile(readyBySize[20],.95),max:Math.max(...readyBySize[20])},ready42:{p95:percentile(readyBySize[42],.95),max:Math.max(...readyBySize[42])}};
writeFileSync(process.env.LOAD_RESULT_PATH??`/private/tmp/ionic-native-${phase}-result.json`,JSON.stringify(result,null,2));console.log(result);
if(phase==='native'&&controlDelayMs===0&&(aborts||result.allJoin20.p95>2000||result.allJoin42.p95>3000||result.start20.p95>850||result.start42.p95>1150||result.start20.max>=10000||result.start42.max>=10000||result.ready20.p95>2500||result.ready42.p95>4000))throw new Error('Phase 2 load acceptance exceeded');
await sql.end();process.exit(0);
