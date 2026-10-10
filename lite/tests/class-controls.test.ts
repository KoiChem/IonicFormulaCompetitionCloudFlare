import {afterEach,beforeEach,expect,test} from 'vitest';
import {fixture,credentials,settings} from './helpers';
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});afterEach(async()=>{await f?.runtime.dispose();});
async function room(value:any=settings){const {data}=await f.create(value);expect(data.code).toBeTruthy();const h=await f.connect(data.code);await h.request({type:'hello',role:'teacher',token:data.token});const c=credentials();const s=await f.connect(data.code);await s.request(c);return {data,h,s,c,store:await f.storage(data.code)};}
test('deferred drafts survive eviction, remain ungraded, are editable, and grade once at submission',async()=>{
 const {data,h,s,c,store}=await room({...settings,gradingMode:'deferred'});await h.request({type:'start'});await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-1000,Date.now()+60000);
 const qs=JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
 const command={type:'draft',seq:1,answers:[{questionId:qs[0].id,fieldId:'name',value:qs[0].answer.canonical}],advancedQuestionCount:1};
 let r=await s.request(command);expect(r.verdict).toBeUndefined();expect(r.state.own.correctCount).toBe(0);expect(r.state.own.answeredCount).toBe(1);expect(r.state.own.advancedQuestionCount).toBe(1);expect(JSON.stringify(r.state.deferred.questions)).not.toContain('canonical');
 expect((await s.request(command)).state.own.lastSeq).toBe(1);
 s.socket.close();await f.runtime.unsafeEvictDurableObject('lite-test','LiteRoom',{name:data.code});const resumed=await f.connect(data.code);r=await resumed.request(c);expect(r.state.deferred.drafts[`${qs[0].id}:name`]).toBe(qs[0].answer.canonical);
 await resumed.request({type:'draft',seq:2,answers:[{questionId:qs[0].id,fieldId:'name',value:'誤答'}]});await resumed.request({type:'draft',seq:3,answers:[{questionId:qs[0].id,fieldId:'name',value:qs[0].answer.canonical}]});
 r=await resumed.request({type:'submit',seq:4});expect(r.state.results.own.correctCount).toBe(1);expect(r.state.results.own.finishReason).toBe('submitted');expect((await resumed.request({type:'submit',seq:4})).state.results.own.correctCount).toBe(1);
});
test('deferred timeout and interruption grade stored drafts, including two-field compounds',async()=>{
 const {h,s,store}=await room({...settings,mode:'compound',compoundAnswer:'both',gradingMode:'deferred'});await h.request({type:'start'});await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-1000,Date.now()+60000);const qs=JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
 await s.request({type:'draft',seq:1,answers:[{questionId:qs[0].id,fieldId:'formula',value:qs[0].answer.formula.canonical},{questionId:qs[0].id,fieldId:'name',value:'誤答'}]});await h.request({type:'finish'});const r=await s.request({type:'submit',seq:2,final:true});expect(r.state.results.own.correctCount).toBe(1);expect(r.state.results.questions[0].fields.map((a:any)=>a.state)).toEqual(['correct','incorrect']);
});
test('waiting controls rename, reject duplicates, remove a participant, edit settings and cancel without results',async()=>{
 const {data,h,s}=await room();const other=await f.connect(data.code);await other.request(credentials('別名'));expect((await s.request({type:'nickname',nickname:'別名'})).code).toBe('conflict');const renamed=await s.request({type:'nickname',nickname:'変更後'});expect(renamed.state.own.nickname).toBe('変更後');
 expect((await s.request({type:'settings',settings:{...settings,questionCount:10}})).code).toBe('forbidden');let r=await h.request({type:'settings',settings:{...settings,questionCount:10,gradingMode:'deferred'}});expect(r.state.room.settings.gradingMode).toBe('deferred');expect(r.state.room.maxScore).toBe(10);
 await h.request({type:'remove',participantId:renamed.state.own.id});expect((await h.request({type:'sync'})).state.room.participantCount).toBe(1);r=await h.request({type:'cancel'});expect(r.state.room.state).toBe('CANCELLED');expect(r.state.results).toBeUndefined();expect((await (await f.fetch(`/api/rooms/${data.code}/info`)).json() as any).room.state).toBe('CANCELLED');
});
test('participant results include only top-three ties and own review, never classmates answers',async()=>{
 const {h,s,store}=await room();for(let i=0;i<4;i++){const p=await f.connect((await h.request({type:'sync'})).state.room.code);await p.request(credentials(`他${i}`));}await h.request({type:'start'});await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-1000,Date.now()+60000);await h.request({type:'finish'});const r=await s.request({type:'sync'});expect(r.state.results.ranking).toHaveLength(5);expect(r.state.results.ranking.every((p:any)=>p.rank<=3)).toBe(true);expect(r.state.results.ranking.every((p:any)=>!('id'in p)&&!('lastSeq'in p))).toBe(true);expect(r.state.results.questions).toHaveLength(5);
});
test('a deferred edit captured just before cutoff is collected once, but post-cutoff edits are rejected',async()=>{
 const {h,s,store}=await room({...settings,gradingMode:'deferred'});await h.request({type:'start'});const cutoff=Date.now()-100;await store.exec('UPDATE room SET start_at=?,deadline_at=?',cutoff-60000,cutoff);const qs=JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
 let r=await s.request({type:'draft',seq:1,capturedAtMs:cutoff-1,answers:[{questionId:qs[0].id,fieldId:'name',value:qs[0].answer.canonical}]});expect(r.state.room.state).toBe('COLLECTING');expect(r.state.own.correctCount).toBe(0);
 expect((await s.request({type:'draft',seq:2,capturedAtMs:cutoff+1,answers:[{questionId:qs[0].id,fieldId:'name',value:'締切後'}]})).code).toBe('not_running');
 r=await s.request({type:'submit',seq:2,final:true});expect(r.state.room.state).toBe('FINISHED');expect(r.state.results.own.correctCount).toBe(1);expect(r.state.results.own.elapsedCs).toBe(6000);expect(r.state.results.own.finishReason).toBe('timeout');expect((await s.request({type:'submit',seq:2,final:true})).state.results.own.correctCount).toBe(1);
});
test('deferred collection survives eviction and finishes without a final client submission',async()=>{
 const {data,h,s,c,store}=await room({...settings,gradingMode:'deferred'});await h.request({type:'start'});await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-60000,Date.now()+60000);const qs=JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
 await s.request({type:'draft',seq:1,answers:[{questionId:qs[0].id,fieldId:'name',value:qs[0].answer.canonical}]});expect((await h.request({type:'finish'})).state.room.state).toBe('COLLECTING');s.socket.close();h.socket.close();await store.exec('UPDATE room SET ended_at=?',Date.now()-4000);await f.runtime.unsafeEvictDurableObject('lite-test','LiteRoom',{name:data.code,webSockets:'hibernate'});
 const resumed=await f.connect(data.code);const r=await resumed.request(c);expect(r.state.room.state).toBe('FINISHED');expect(r.state.results.own.correctCount).toBe(1);expect(r.state.results.own.finalSyncUnconfirmed).toBe(true);expect(r.state.results.own.finishReason).toBe('interrupted');
});
test('a submission captured before the cutoff retains its time when delivered during collection',async()=>{
 const {h,s,store}=await room({...settings,gradingMode:'deferred'});await h.request({type:'start'});const cutoff=Date.now()-100;await store.exec('UPDATE room SET start_at=?,deadline_at=?',cutoff-60000,cutoff);const r=await s.request({type:'submit',seq:1,capturedAtMs:cutoff-500});expect(r.state.room.state).toBe('FINISHED');expect(r.state.results.own.elapsedCs).toBe(5950);expect(r.state.results.own.finishReason).toBe('submitted');expect(r.state.results.own.finalSyncUnconfirmed).toBe(false);
});
