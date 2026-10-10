import { afterEach, beforeEach, expect, test } from 'vitest';
import { fixture, credentials, settings } from './helpers';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { await f?.runtime.dispose(); });

test('creates a fresh Lite room without binding an existing DB', async () => {
  const {response, data} = await f.create();
  expect(response.status).toBe(201); expect(data.code).toMatch(/^[A-Z2-9]{6}$/);
  expect(data.token).toMatch(/^[a-f0-9]{64}$/);
  const host = await f.connect(data.code);
  const hello = await host.request({type:'hello',role:'teacher',token:data.token});
  expect(hello.state.room.state).toBe('WAITING'); expect(hello.state.participants).toEqual([]);
  expect((await (await f.fetch('/api/health')).json()) as any).toMatchObject({backend:'lite',d1:false});
});
test('rejects cross-origin creation and sockets and invalid settings', async () => {
  expect((await f.fetch('/api/rooms',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'})).status).toBe(403);
  expect((await f.create({...settings,questionCount:100})).response.status).toBe(400);
  const {data} = await f.create();
  expect((await f.fetch(`/api/rooms/${data.code}/socket`,{headers:{upgrade:'websocket',origin:'https://evil.test'}})).status).toBe(403);
});
test('accepts 50 simultaneous participants, rejects the 51st, and allows a full-room reconnect', async () => {
  const {data} = await f.create(); const ids = Array.from({length:51},(_,i)=>credentials(`生徒${i+1}`));
  const students = await Promise.all(ids.map(()=>f.connect(data.code)));
  const replies = await Promise.all(students.map((s,i)=>s.request(ids[i])));
  expect(replies.filter(r=>r.type==='ack')).toHaveLength(50);
  expect(replies.filter(r=>r.code==='room_full')).toHaveLength(1);
  const accepted = replies.findIndex(r=>r.type==='ack');
  const reconnect = await f.connect(data.code);
  expect((await reconnect.request(ids[accepted])).state.room.participantCount).toBe(50);
});
test('checks capability tokens and never sends classmates or answers to a student', async () => {
  const {data} = await f.create(); const a = await f.connect(data.code); const b = await f.connect(data.code);
  const ca = credentials('A'); const cb = credentials('B');
  await a.request(ca); const reply = await b.request(cb);
  expect(reply.state.participants).toBeUndefined(); expect(JSON.stringify(reply)).not.toContain('"nickname":"A"');
  expect((await a.request({type:'start'})).code).toBe('forbidden');
  const stolen = await f.connect(data.code);
  expect((await stolen.request({...ca,token:cb.token})).code).toBe('unauthorized');
  const host = await f.connect(data.code); await host.request({type:'hello',role:'teacher',token:data.token});
  await host.request({type:'start'});
  const store = await f.storage(data.code);
  await store.exec('UPDATE room SET start_at=?, deadline_at=?',Date.now()-1000,Date.now()+60000);
  const snapshot = await b.request({type:'sync'});
  expect(snapshot.state.question.answer).toBeUndefined();
  expect(snapshot.state.question.itemId).toBeUndefined();
});
test('saves a verdict and next question in one reply; duplicates and stale questions cannot double-score', async () => {
  const {data} = await f.create(); const host = await f.connect(data.code);
  await host.request({type:'hello',role:'teacher',token:data.token});
  const student = await f.connect(data.code); await student.request(credentials());
  await host.request({type:'start'}); const store = await f.storage(data.code);
  await store.exec('UPDATE room SET start_at=?, deadline_at=?',Date.now()-1000,Date.now()+60000);
  const internal = JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
  const command = {type:'answer',seq:1,questionId:internal[0].id,fieldId:'name',value:internal[0].answer.canonical};
  const answer = await student.request(command);
  expect(answer.verdict.correct).toBe(true); expect(answer.state.own.correctCount).toBe(1);
  expect(answer.state.question.ordinal).toBe(1);
  expect((await student.request(command)).state.own.correctCount).toBe(1);
  expect((await student.request({...command,seq:2})).code).toBe('stale_question');
  expect((await student.request({type:'sync'})).state.own.correctCount).toBe(1);
});
test('wrong answers have no penalty and allow retry; pass advances without awarding points', async () => {
  const {data} = await f.create(); const host = await f.connect(data.code);
  await host.request({type:'hello',role:'teacher',token:data.token});
  const student = await f.connect(data.code); await student.request(credentials()); await host.request({type:'start'});
  const store = await f.storage(data.code); await store.exec('UPDATE room SET start_at=?, deadline_at=?',Date.now()-1000,Date.now()+60000);
  const internal = JSON.parse((await store.exec('SELECT questions FROM room')).rows[0].questions as string);
  let r = await student.request({type:'answer',seq:1,questionId:internal[0].id,fieldId:'name',value:'間違い'});
  expect(r.verdict.correct).toBe(false); expect(r.state.own.correctCount).toBe(0); expect(r.state.question.ordinal).toBe(0);
  r = await student.request({type:'answer',seq:2,questionId:internal[0].id,fieldId:'name',value:internal[0].answer.canonical});
  expect(r.state.own.correctCount).toBe(1);
  r = await student.request({type:'pass',seq:3,questionId:internal[1].id,fieldId:'name'});
  expect(r.state.own.correctCount).toBe(1); expect(r.state.question.ordinal).toBe(2);
  await host.request({type:'finish'});
  r = await student.request({type:'sync'});
  expect(r.state.results.questions[1].fields[0].state).toBe('passed');
});
test('finishes on the server deadline and exposes top rankings plus only own answer review to students', async () => {
  const {data} = await f.create(); const host = await f.connect(data.code);
  await host.request({type:'hello',role:'teacher',token:data.token});
  const student = await f.connect(data.code); await student.request(credentials()); await host.request({type:'start'});
  const store = await f.storage(data.code); await store.exec('UPDATE room SET start_at=?, deadline_at=?',Date.now()-60000,Date.now()-1);
  const snapshot = await student.request({type:'sync'});
  expect(snapshot.state.room.state).toBe('FINISHED'); expect(snapshot.state.results.ranking).toHaveLength(1);
  expect(snapshot.state.results.questions).toHaveLength(5);
  expect((await host.request({type:'sync'})).state.results.ranking).toHaveLength(1);
  expect((await student.request({type:'pass',seq:1,questionId:'x',fieldId:'name'})).code).toBe('not_running');
});
test('restores SQLite state and participant identity after Durable Object eviction', async () => {
  const {data} = await f.create(); const c = credentials(); const student = await f.connect(data.code);
  await student.request(c); student.socket.close();
  await f.runtime.unsafeEvictDurableObject('lite-test','LiteRoom',{name:data.code});
  const reconnected = await f.connect(data.code); const reply = await reconnected.request(c);
  expect(reply.state.own.id).toBe(c.participantId); expect(reply.state.room.participantCount).toBe(1);
});
test('ranks by correct count then elapsed time, ties share rank without join-order advantage', async () => {
  const {data} = await f.create(); const host = await f.connect(data.code);
  await host.request({type:'hello',role:'teacher',token:data.token});
  const ids = Array.from({length:4},(_,i)=>credentials(`P${i}`));
  for(const c of ids) { const s=await f.connect(data.code); await s.request(c); }
  const store=await f.storage(data.code);
  for(const [i,c] of ids.entries()) await store.exec('UPDATE participants SET correct_count=?, finished_at=? WHERE id=?',i===3?1:2,i===2?3000:2000,c.participantId);
  await store.exec('UPDATE room SET state=?,start_at=?,deadline_at=?','RUNNING',1000,9999999999999);
  const r=await host.request({type:'finish'});
  expect(r.state.results.ranking.map((x:any)=>x.rank)).toEqual([1,1,3,4]);
});
