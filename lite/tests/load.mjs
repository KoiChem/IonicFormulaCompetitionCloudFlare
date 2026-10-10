import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {WebSocket}=require(require.resolve('undici',{paths:[require.resolve('wrangler')]}));
const origin=new URL(process.argv[2]??'http://localhost:8791').origin;
if(!['http://localhost:8791','http://127.0.0.1:8791','https://ionicformulacompetition-lite.koichem.workers.dev'].includes(origin))throw new Error('計測先はLite専用Workerまたはローカル8791に限定しています');
const teacherCookie=process.env.LITE_TEACHER_COOKIE;
if(!teacherCookie)throw new Error('LITE_TEACHER_COOKIEにログイン済みLite教員のcookieを設定してください。認証情報は出力・計測結果には保存しません');
const auth=await fetch(`${origin}/api/auth/session`,{headers:{cookie:teacherCookie}});
const session=await auth.json();
if(!auth.ok||!session.identity||!session.csrfToken)throw new Error('Lite教員のログインを再確認してください');
const ions=JSON.parse(readFileSync(new URL('../../src/games/ionic-formula/data/ions.json',import.meta.url),'utf8'));
const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'name',compoundPrompts:{formula:true,name:true},compoundAnswer:'formula',complexEnabled:false,gradingMode:process.argv.includes('--deferred')?'deferred':'immediate'};
function summary(values){const xs=[...values].sort((a,b)=>a-b);return {n:xs.length,medianMs:+xs[Math.floor(xs.length/2)].toFixed(1),p95Ms:+xs[Math.ceil(xs.length*.95)-1].toFixed(1),maxMs:+xs.at(-1).toFixed(1)};}
async function connect(code,credential){
  const since=performance.now();
  const ws=new WebSocket(`${origin.replace(/^http/,'ws')}/api/rooms/${code}/socket`,{headers:{origin}});
  let state,id=0,startReceived;const waiting=new Map();const updates=[];
  ws.addEventListener('message',event=>{
    if(event.data==='pong')return;
    const data=JSON.parse(String(event.data));
    if(data.state){state=data.state;updates.push(data.state);if(data.state.room.state!=='WAITING'&&!startReceived)startReceived=performance.now();}
    const item=waiting.get(data.requestId);if(item){waiting.delete(data.requestId);clearTimeout(item.timeout);item.resolve({data,ms:performance.now()-item.at});}
  });
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('WebSocket open timeout')),15000);ws.addEventListener('open',()=>{clearTimeout(timeout);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('WebSocket upgrade failed'));},{once:true});});
  const request=message=>new Promise((resolve,reject)=>{const requestId=String(++id);const timeout=setTimeout(()=>{waiting.delete(requestId);reject(new Error(`Response timeout: ${message.type}`));},15000);waiting.set(requestId,{resolve,timeout,at:performance.now()});ws.send(JSON.stringify({...message,requestId}));});
  const hello=await request({type:'hello',...credential});
  return {ws,request,hello,joinMs:performance.now()-since,get state(){return state;},get startReceived(){return startReceived;},updates};
}
async function run(count){
  const createAt=performance.now();const response=await fetch(`${origin}/api/rooms`,{method:'POST',headers:{origin,'content-type':'application/json',cookie:teacherCookie,'x-competition-csrf':session.csrfToken},body:JSON.stringify({settings})});
  const created=await response.json();if(response.status!==201)throw new Error(JSON.stringify(created));
  const createMs=performance.now()-createAt;const all=[];
  try{
    const host=await connect(created.code,{role:'teacher',token:created.token});all.push(host);
    const students=await Promise.all(Array.from({length:count},(_,i)=>connect(created.code,{role:'participant',participantId:randomUUID(),token:randomBytes(32).toString('hex'),nickname:`計測${count}-${String(i+1).padStart(2,'0')}`})));all.push(...students);
    if(students.some(s=>s.hello.data.type!=='ack'))throw new Error('Participant rejected');
    let rejected51=false;
    if(count===50){const extra=await connect(created.code,{role:'participant',participantId:randomUUID(),token:randomBytes(32).toString('hex'),nickname:'上限確認51'});all.push(extra);rejected51=extra.hello.data.code==='room_full';if(!rejected51)throw new Error('51st participant was accepted');extra.ws.close();}
    const startAt=performance.now();const start=await host.request({type:'start'});
    if(start.data.type!=='ack')throw new Error('Start rejected');
    // No polling: local wait through the fixed shared countdown.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,start.data.state.room.startAtMs-start.data.state.serverNow)+150));
    if(students.some(s=>!s.startReceived||!s.state.question))throw new Error('Start was not delivered');
    const arrival=students.map(s=>s.startReceived-startAt);const answers=[];let duplicatesSafe=true;
    for(let round=0;round<5;round++){
      const replies=await Promise.all(students.map(async s=>{
        const q=settings.gradingMode==='deferred'?s.state.deferred.questions[round]:s.state.question;const prompt=q.prompt.values.find(v=>v.type==='formula');
        const ion=ions.find(i=>i.formula===prompt.value&&i.charge===prompt.charge);
        if(!ion)throw new Error('Missing source answer');
        const command=settings.gradingMode==='deferred'?{type:'draft',seq:s.state.own.lastSeq+1,answers:[{questionId:q.id,fieldId:'name',value:ion.name}],advancedQuestionCount:round+1,capturedAtMs:Date.now()}:{type:'answer',seq:s.state.own.lastSeq+1,questionId:q.id,fieldId:'name',value:ion.name};
        const reply=await s.request(command);answers.push(reply.ms);
        if(reply.data.type!=='ack'||(settings.gradingMode==='deferred'?reply.data.verdict||reply.data.state.own.correctCount!==0:!reply.data.verdict.correct||reply.data.state.own.correctCount!==round+1)||(round<4&&reply.data.state.results?.ranking))throw new Error('Grading or privacy failed');
        return {s,command};
      }));
      if(round===0){await Promise.all(replies.map(async({s,command})=>{const duplicate=await s.request(command);if(duplicate.data.state.own.correctCount!==(settings.gradingMode==='deferred'?0:1))duplicatesSafe=false;}));}
    }
    if(settings.gradingMode==='deferred')await Promise.all(students.map(s=>s.request({type:'submit',seq:s.state.own.lastSeq+1,capturedAtMs:Date.now()})));
    const result=await host.request({type:'sync'});
    if(result.data.state.room.state!=='FINISHED'||result.data.state.results.ranking.length!==count||result.data.state.results.ranking.some(p=>p.correctCount!==5))throw new Error('Results failed');
    const item={count,gradingMode:settings.gradingMode,code:created.code,createMs:+createMs.toFixed(1),joinIncludingUpgrade:summary(students.map(s=>s.joinMs)),startAckMs:+start.ms.toFixed(1),startQuestionNotification:summary(arrival),fixedCountdownMs:5000,answerAckIncludingGradingAndSQLite:summary(answers),rejected51,duplicatesSafe,allCorrect:true,finished:true};
    console.log(JSON.stringify(item));return item;
  }finally{for(const client of all)client.ws.close(1000);}
}
const results=[];for(const n of [25,50])results.push(await run(n));
const report={at:new Date().toISOString(),origin,network:'One Node client on the development Mac; simulated participants, not physical school devices.',results};
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
