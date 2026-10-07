// Diagnostic only: auto_explain nested plans on isolated local test data.
import postgres from 'postgres';
import {readFileSync,writeFileSync} from 'node:fs';
import {PostgresDatabase} from '../../src/platform/postgres-database';
import {createSupabaseGateway} from '../../src/platform/supabase-gateway';
import {createParticipantToken} from '../../src/platform/participant-auth';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/ionic_timeout_validation_control')throw new Error('Requires local control DB');
const log=process.env.POSTGRES_LOG_PATH;if(!log)throw new Error('Requires explicit local log path');
const sql=postgres(url,{ssl:false,max:1,prepare:false});await sql.unsafe("LOAD 'auto_explain'; SET auto_explain.log_min_duration=-1; SET auto_explain.log_nested_statements=on; SET auto_explain.log_format=json");
const pid=Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);let queryCount=0;let applicationSql:string[]=[];let currentUser:any;
const master={id:'11111111-1111-4111-8111-111111111111',email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};currentUser=master;
const gateway=createSupabaseGateway({transact:async(_scope,run)=>sql.begin(async tx=>run(new PostgresDatabase(async(q,v)=>{queryCount++;applicationSql.push(q.trim());return {rows:Array.from(await tx.unsafe(q,v as any[]))};}))),nativeJoin:true,nativeReady:true,verifyUser:async()=>currentUser,masterEmail:master.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{}});
async function call(path:string,body?:unknown,token?:string){const r=await gateway(new Request('https://local/api/'+path,{method:body?'POST':'GET',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1',...(token?{'x-participant-authorization':'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined}));if(!r.ok)throw new Error(await r.text());return r.json();}
const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
const {room}=await call('class-rooms',{requestId:crypto.randomUUID(),settings});const student={id:crypto.randomUUID(),is_anonymous:true};const token=createParticipantToken();currentUser=student;
const evidence:any={engine:'PostgreSQL17',diagnostic:'auto_explain nested query plans; expression assignments and transaction controls are not plans',pid};
async function trace(kind:string,run:()=>Promise<unknown>){await sql.unsafe('SET auto_explain.log_min_duration=0');const offset=readFileSync(log!).length;queryCount=0;applicationSql=[];await run();await sql.unsafe('SET auto_explain.log_min_duration=-1');const text=readFileSync(log!).subarray(offset).toString();let ownerPid:number|undefined;const plans:string[]=[];for(const line of text.split('\n')){const match=/\[(\d+)\] LOG:/.exec(line);if(match)ownerPid=Number(match[1]);const query=/"Query Text": (".*"),?$/.exec(line.trim());if(ownerPid===pid&&query)plans.push(JSON.parse(query[1]));}evidence[kind]={applicationDbCalls:queryCount,totalPlannedStatements:plans.length,nestedPlannedStatements:plans.filter(q=>!applicationSql.includes(q.trim())).length,statementTypes:plans.reduce((a:Record<string,number>,q)=>{const type=q.trim().split(/\s/)[0];a[type]=(a[type]??0)+1;return a;},{})};}
await trace('join',()=>call(`rooms/${room.id}/join`,{requestId:crypto.randomUUID(),nickname:'内部SQL試験'},token));
currentUser=master;const state=await call(`rooms/${room.id}/state`);await call(`rooms/${room.id}/start`,{requestId:crypto.randomUUID(),expectedRevision:state.room.revision});currentUser=student;const manifest=await call(`rooms/${room.id}/manifest`,undefined,token);
await trace('readyLast',()=>call(`rooms/${room.id}/ready`,{manifestId:manifest.manifestId,evaluatorVersion:manifest.evaluatorVersion,preparationGeneration:manifest.preparationGeneration},token));
if(evidence.join.applicationDbCalls!==2||evidence.readyLast.applicationDbCalls!==2||evidence.join.nestedPlannedStatements<5)throw new Error('Trace did not observe nested SQL');
writeFileSync('/private/tmp/ionic-native-statement-trace.json',JSON.stringify(evidence,null,2));console.log(evidence);await sql.end();process.exit(0);
