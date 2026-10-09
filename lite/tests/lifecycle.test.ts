import {afterEach,beforeEach,expect,test} from 'vitest';
import {fixture,credentials,settings} from './helpers';
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});afterEach(async()=>{await f?.runtime.dispose();});
test('a late answer cannot roll back the automatic deadline finish',async()=>{
  const {data}=await f.create();const h=await f.connect(data.code);await h.request({type:'hello',role:'teacher',token:data.token});
  const s=await f.connect(data.code);await s.request(credentials());await h.request({type:'start'});
  const store=await f.storage(data.code);await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-60000,Date.now()-1);
  const r=await s.request({type:'pass',seq:1,questionId:'late',fieldId:'name'});
  expect(r.state.room.state).toBe('FINISHED');expect(r.code).toBe('not_running');
  expect((await store.exec('SELECT state FROM room')).rows[0].state).toBe('FINISHED');
});
test('scores two-field compound answers separately and advances only after both are resolved',async()=>{
  const {data}=await f.create({...settings,mode:'compound',compoundAnswer:'both'});
  const h=await f.connect(data.code);await h.request({type:'hello',role:'teacher',token:data.token});
  const s=await f.connect(data.code);await s.request(credentials());await h.request({type:'start'});
  const store=await f.storage(data.code);await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-1000,Date.now()+60000);
  const qs=JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
  const r=await s.request({type:'answer',seq:1,questionId:qs[0].id,fieldId:'formula',value:qs[0].answer.formula.canonical});
  expect(r.state.own.correctCount).toBe(1);expect(r.state.question.ordinal).toBe(0);expect(r.state.question.progress.fieldStates.formula).toBe('correct');
  const passed=await s.request({type:'pass',seq:2,questionId:qs[0].id,fieldId:'name'});
  expect(passed.state.question.ordinal).toBe(1);expect(passed.state.own.correctCount).toBe(1);
});
test('an unknown room returns an explicit terminal error instead of endless socket retries',async()=>{
  const s=await f.connect('ZZZZZZ');const r=await s.request(credentials());
  expect(r.code).toBe('not_found');
});
test('server alarm finishes with no teacher connection and survives hibernation',async()=>{
  const {data}=await f.create();const h=await f.connect(data.code);await h.request({type:'hello',role:'teacher',token:data.token});
  const c=credentials();const s=await f.connect(data.code);await s.request(c);await h.request({type:'start'});h.socket.close();
  const store=await f.storage(data.code);await store.exec('UPDATE room SET start_at=?,deadline_at=?',Date.now()-60000,Date.now()+500);
  await s.request({type:'hello',role:'participant',token:c.token,participantId:c.participantId}); // Already authenticated; no mutation.
  await f.runtime.unsafeEvictDurableObject('lite-test','LiteRoom',{name:data.code,webSockets:'hibernate'});
  // Reconnect schedules the stored deadline, not a new timer from the client.
  const resumed=await f.connect(data.code);await resumed.request(c);
  await new Promise(resolve=>setTimeout(resolve,650));
  expect(resumed.messages.some(m=>m.type==='state'&&m.state.room.state==='FINISHED')).toBe(true);
});
