import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
const origin='https://ionicformulacompetition-phase1-test.koichem.workers.dev';
const tokens=Array.from({length:4},()=>randomBytes(32).toString('base64url'));
async function call(path,method='GET',body,token,extra={}){
 const response=await fetch(origin+path,{method,headers:{origin,'content-type':'application/json','x-competition-csrf':'1',...(token?{authorization:'Bearer '+token}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${data.error?.code??'failed'}`);return data;
}
const health=await fetch(origin+'/api/health').then(r=>r.json());if(health.competitionBackend!=='cloudflare')throw new Error('Dedicated worker is not independent');
const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'name',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'deferred'};
const requestId=randomUUID(),key=randomBytes(32).toString('base64url'),body={requestId,nickname:'remote-host',settings};
const created=await call('/api/mate-rooms','POST',body,tokens[0],{'x-creation-key':key});
const id=created.room.id,base='/api/rooms/'+id;
if((await call('/api/mate-rooms','POST',body,tokens[0],{'x-creation-key':key})).room.id!==id)throw new Error('Create replay changed room');
for(let n=1;n<4;n++)await call(base+'/join','POST',{requestId:randomUUID(),nickname:'remote-'+n},tokens[n]);
const state=await call(base+'/state','GET',undefined,tokens[0]);await call(base+'/start','POST',{requestId:randomUUID(),expectedRevision:state.room.revision},tokens[0]);
const manifests=[];for(const token of tokens){const m=await call(base+'/manifest','GET',undefined,token);manifests.push(m);await call(base+'/ready','POST',{manifestId:m.manifestId,evaluatorVersion:m.evaluatorVersion,preparationGeneration:m.preparationGeneration},token);}
const running=await call(base+'/state','GET',undefined,tokens[0]);await new Promise(r=>setTimeout(r,Math.max(0,running.room.startAtMs+1000-Date.now())));
for(let n=0;n<4;n++){const m=manifests[n];await call(base+'/operations','POST',{requestId:randomUUID(),writerEpoch:1,manifestId:m.manifestId,evaluatorVersion:m.evaluatorVersion,operations:[{seq:1,operationId:randomUUID(),type:'finish',reason:'submitted',elapsedMs:500}]},tokens[n]);}
const result=await call(base+'/results','GET',undefined,tokens[0]);if(result.ranking.length!==4||!result.ranking.every(r=>r.correctCount===0&&r.rank===1))throw new Error('Remote final result mismatch');
const dir='.superpowers/sdd/2026-10-08-cloudflare-independent';mkdirSync(dir,{recursive:true});writeFileSync(dir+'/remote-session.json',JSON.stringify({origin,roomId:id,tokens}),{mode:0o600});
console.log(JSON.stringify({origin,roomId:id,health,participants:4,grading:'deferred',rank:1,finish:'submitted',httpsHttp:'passed',websocket:'requires browser check',cleanup:'Own test room expires within the original Mate retention; no production data touched'},null,2));
