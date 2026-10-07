import { afterEach, expect, it } from 'vitest';
import type { PersistenceDatabase, PreparedSql } from '../../src/persistence/db';
import { createRoom } from '../../src/persistence/rooms';
import { joinRoom } from '../../src/persistence/participants';
import { applyV2Operations } from '../../src/persistence/v2-operations';
import { collectV2Room, maybeFinalizeV2Room } from '../../src/persistence/v2-results';
import { prepareV2Room, markV2Ready, cancelV2Preparation } from '../../src/persistence/v2-manifest';
import { classRoomInput, joinInput, QUESTION } from '../persistence/helpers';
import type { V2Operation } from '../../src/competition-core/v2-operations';
import { createD1TestDatabase } from './helpers';
import type { InternalQuestion } from '../../src/games/ionic-formula/shared/types';

const resources: Array<Awaited<ReturnType<typeof createD1TestDatabase>>> = [];
afterEach(async () => { await Promise.all(resources.splice(0).map(test => test.close())); });
async function database() { const test = await createD1TestDatabase(); resources.push(test); return test; }
async function room(test: Awaited<ReturnType<typeof database>>, count = 1, mode: 'immediate' | 'deferred' = 'immediate', questions: readonly InternalQuestion[] = [QUESTION]) {
  const now = Date.now();
  await createRoom(test.db, classRoomInput({ nowMs: now, expiresAtMs: now + 86400000,
    settings: { questionCount: questions.length, timeLimitMinutes: 3, gradingMode: mode } }));
  for (let i=0;i<count;i++) await joinRoom(test.db, joinInput(i, { nowMs: now }));
  await prepareV2Room(test.db, { roomId: 'room-1', requestId: 'prepare', bodyHash: 'prepare',
    expectedRoomRevision: count, nowMs: now, manifestId: 'manifest', evaluatorVersion: '1', gradingMode: mode, questions });
  for (let i=0;i<count;i++) await markV2Ready(test.db, { roomId: 'room-1', participantId: `p-${i}`,
    manifestId: 'manifest', preparationGeneration: 1, evaluatorVersion: '1', nowMs: now });
  const row = await test.binding.prepare("SELECT start_at_ms FROM rooms WHERE id='room-1'").first<{ start_at_ms: number }>();
  return row!.start_at_ms;
}
function input(nowMs: number, operations: V2Operation[]) {
  return { roomId: 'room-1', participantId: 'p-0', requestId: 'batch', writerEpoch: 1,
    manifestId: 'manifest', evaluatorVersion: '1', nowMs, operations };
}
function wrongAnswers(n: number): V2Operation[] {
  return Array.from({ length:n }, (_,i) => ({ seq:i+1, operationId:`op-${i}`, type:'answer',
    questionId:QUESTION.id, fieldId:'formula', value:'wrong', elapsedMs:i+1 }));
}

it('accepts the 49th and 50th join, rejects the 51st, and replays a full-room join', async () => {
  const test = await database(); const nowMs = Date.now();
  await createRoom(test.db, classRoomInput({ nowMs, expiresAtMs: nowMs+86400000 }));
  for(let i=0;i<48;i++) await joinRoom(test.db, joinInput(i,{ nowMs }));
  const attempts = await Promise.allSettled([48,49,50].map(i=>joinRoom(test.db,joinInput(i,{ nowMs }))));
  expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(2);
  expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1);
  expect((attempts.find(x=>x.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'capacity'});
  expect(await test.binding.prepare("SELECT COUNT(*) n FROM participants WHERE room_id='room-1'").first('n')).toBe(50);
  await expect(joinRoom(test.db, joinInput(0,{ nowMs }))).resolves.toMatchObject({participantId:'p-0'});
});

it('stores 128 operations atomically within a 50-query invocation budget', async () => {
  const test = await database(); const start = await room(test);
  let queryCount=0;
  const db: PersistenceDatabase = {
    prepare(sql) { queryCount++; return test.db.prepare(sql); },
    batch(statements) { return test.db.batch(statements); },
  };
  const request = input(start+1000, wrongAnswers(128));
  const ack = await applyV2Operations(db,request);
  expect(ack.ackSeq).toBe(128);
  expect(queryCount).toBeLessThan(50);
  expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_operations').first('n')).toBe(128);
  await expect(applyV2Operations(test.db,request)).resolves.toEqual(ack);
  expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_batch_receipts').first('n')).toBe(1);
});

it.each(['interrupt','remove','manifest'] as const)('rejects a stale submit when %s races its commit', async kind => {
  const test=await database(); const start=await room(test);
  let intercepted=false;
  const db: PersistenceDatabase = {
    prepare: sql=>test.db.prepare(sql),
    async batch(statements: PreparedSql[]) {
      if(!intercepted) {
        intercepted=true;
        if(kind==='interrupt') await collectV2Room(test.db,{roomId:'room-1',nowMs:start+50,interrupted:true});
        if(kind==='remove') await test.binding.prepare("UPDATE participants SET status='REMOVED' WHERE id='p-0'").run();
        if(kind==='manifest') await test.binding.prepare("UPDATE v2_room_manifests SET manifest_id='different'").run();
      }
      return test.db.batch(statements);
    },
  };
  await expect(applyV2Operations(db,input(start+1000,wrongAnswers(1)))).rejects.toMatchObject({code:'stale_participant_revision'});
  expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_operations').first('n')).toBe(0);
  expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_batch_receipts').first('n')).toBe(0);
  expect(await test.binding.prepare('SELECT ack_seq FROM v2_participant_progress').first('ack_seq')).toBe(0);
});

it('does not replay a receipt after participant removal or room expiry', async () => {
  const test=await database(); const start=await room(test);
  const request=input(start+1000,wrongAnswers(1));
  await applyV2Operations(test.db,request);
  await test.binding.prepare("UPDATE participants SET status='REMOVED' WHERE id='p-0'").run();
  await expect(applyV2Operations(test.db,request)).rejects.toMatchObject({code:'not_authorized'});
  await test.binding.prepare("UPDATE participants SET status='ACTIVE' WHERE id='p-0'").run();
  await test.binding.prepare("UPDATE rooms SET expires_at_ms=created_at_ms WHERE id='room-1'").run();
  await expect(applyV2Operations(test.db,{...request,nowMs:start+2000})).rejects.toMatchObject({code:'expired'});
});

it('rolls back progress and receipts when duplicate operation IDs fail the bulk insert',async()=>{
 const test=await database();const start=await room(test);const operations=wrongAnswers(2);
 operations[1]={...operations[1],operationId:operations[0].operationId};
 await expect(applyV2Operations(test.db,input(start+1000,operations))).rejects.toThrow();
 expect(await test.binding.prepare('SELECT ack_seq FROM v2_participant_progress').first('ack_seq')).toBe(0);
 expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_operations').first('n')).toBe(0);
 expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_batch_receipts').first('n')).toBe(0);
});

it('finalizes 50 participants with identical score and time at rank 1',async()=>{
 const test=await database();const start=await room(test,50);
 const operations:V2Operation[]=[{seq:1,operationId:'answer',type:'answer',questionId:QUESTION.id,fieldId:'formula',value:'Na+',elapsedMs:100},
 {seq:2,operationId:'finish',type:'finish',reason:'completed',elapsedMs:200}];
 await Promise.all(Array.from({length:50},(_,i)=>applyV2Operations(test.db,{...input(start+1000,operations),participantId:`p-${i}`,requestId:`batch-${i}`})));
 expect(await maybeFinalizeV2Room(test.db,{roomId:'room-1',nowMs:start+1000})).toMatchObject({participantCount:50});
 const result=await test.binding.prepare('SELECT COUNT(*) n,SUM(correct_count) score,MIN(rank) low,MAX(rank) high FROM final_results').first();
 expect(result).toEqual({n:50,score:50,low:1,high:1});
});

it('bounds expiry cleanup to a constant number of queries with 60 rooms',async()=>{
 const test=await database();const now=Date.now();
 await createRoom(test.db,classRoomInput({nowMs:now,expiresAtMs:now+1000}));
 const { cleanupExpired }=await import('../../src/persistence/cleanup');
 const row=await test.binding.prepare("SELECT * FROM rooms WHERE id='room-1'").first<Record<string,unknown>>();
 const columns=Object.keys(row!);const rows=Array.from({length:59},(_,i)=>({...row,id:`expired-${i}`,public_id:`public-expired-${i}`,join_code:`EXP${i}`}));
 await test.binding.batch(rows.map(row=>test.binding.prepare(`INSERT INTO rooms (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).bind(...columns.map(key=>row[key]))));
 let queries=0;const db:PersistenceDatabase={prepare(sql){if(++queries>50)throw new Error('invocation query budget exceeded');return test.db.prepare(sql);},batch:s=>test.db.batch(s)};
 expect(await cleanupExpired(db,{nowMs:now+1001,limit:100})).toMatchObject({deletedRooms:60});
 expect(queries).toBeLessThan(10);
});


it('admits only 50 of 51 simultaneous D1 joins and rejects changed retry payload',async()=>{
 const test=await database();const nowMs=Date.now();
 await createRoom(test.db,classRoomInput({nowMs,expiresAtMs:nowMs+86400000}));
 const attempts=await Promise.allSettled(Array.from({length:51},(_,i)=>joinRoom(test.db,joinInput(i,{nowMs}))));
 expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(50);
 expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1);
 const admitted=attempts.findIndex(x=>x.status==='fulfilled');
 await expect(joinRoom(test.db,joinInput(admitted,{nowMs,bodyHash:'changed'}))).rejects.toMatchObject({code:'request_id_reused'});
});

it.each(['immediate','deferred'] as const)('%s: finalizes 50 × 15 × 2 fields with bounded SQL',async mode=>{
 const test=await database();
 const questions:InternalQuestion[]=Array.from({length:15},(_,i)=>({...QUESTION,id:`q-${i}`,ordinal:i,maxScore:2,
 fields:[{id:'formula',type:'formula'},{id:'name',type:'name'}],
 answer:{type:'both',formula:{type:'formula',canonical:'NaCl',accepted:[]},name:{type:'name',canonical:'塩化ナトリウム',accepted:[]}}}));
 const start=await room(test,50,mode,questions);
 const operations:V2Operation[]=questions.flatMap((q,i)=>['formula','name'].map((field,j)=>({seq:i*2+j+1,operationId:`op-${i}-${field}`,
 type:mode==='immediate'?'answer':'draft',questionId:q.id,fieldId:field as 'formula'|'name',value:field==='formula'?'NaCl':'塩化ナトリウム',elapsedMs:i*2+j+1,
 ...(mode==='deferred'?{editedElapsedMs:i*2+j+1}:{})}))) as V2Operation[];
 operations.push({seq:31,operationId:'finish',type:'finish',reason:mode==='immediate'?'completed':'submitted',elapsedMs:100});
 await Promise.all(Array.from({length:50},(_,i)=>applyV2Operations(test.db,{...input(start+1000,operations),participantId:`p-${i}`,requestId:`multi-${i}`})));
 let queries=0;const db:PersistenceDatabase={prepare(sql){queries++;return test.db.prepare(sql)},batch:s=>test.db.batch(s)};
 expect(await maybeFinalizeV2Room(db,{roomId:'room-1',nowMs:start+1000})).toMatchObject({participantCount:50});
 expect(queries).toBeLessThan(50);
 expect(await test.binding.prepare('SELECT COUNT(*) n,SUM(correct_count) score,MIN(rank) low,MAX(rank) high FROM final_results').first()).toEqual({n:50,score:1500,low:1,high:1});
 expect(await test.binding.prepare('SELECT COUNT(*) n FROM v2_final_fields').first('n')).toBe(1500);
 await expect(maybeFinalizeV2Room(test.db,{roomId:'room-1',nowMs:start+1001})).resolves.toMatchObject({state:'FINISHED',participantCount:50});
});


it('does not regress a newer readiness generation when stale ready races cancellation',async()=>{
 const test=await database();const nowMs=Date.now();
 await createRoom(test.db,classRoomInput({nowMs,expiresAtMs:nowMs+86400000,settings:{questionCount:1,timeLimitMinutes:3,gradingMode:'immediate'}}));
 for(let i=0;i<2;i++)await joinRoom(test.db,joinInput(i,{nowMs}));
 const prepared=await prepareV2Room(test.db,{roomId:'room-1',requestId:'prep1',bodyHash:'prep1',expectedRoomRevision:2,nowMs,manifestId:'manifest',evaluatorVersion:'1',gradingMode:'immediate',questions:[QUESTION]});
 const ready={roomId:'room-1',participantId:'p-0',manifestId:'manifest',preparationGeneration:1,evaluatorVersion:'1',nowMs};
 let intercepted=false;
 function wrap(statement:PreparedSql,sql:string):PreparedSql{return {
   bind:(...values)=>wrap(statement.bind(...values),sql),first:()=>statement.first(),all:()=>statement.all(),
   async run(){
     if(!intercepted&&sql.includes('UPDATE v2_participant_progress SET ready_generation')){
       intercepted=true;
       await cancelV2Preparation(test.db,{roomId:'room-1',expectedRoomRevision:prepared.roomRevision,nowMs});
       await prepareV2Room(test.db,{roomId:'room-1',requestId:'prep2',bodyHash:'prep2',expectedRoomRevision:prepared.roomRevision+1,nowMs,manifestId:'unused',evaluatorVersion:'1',gradingMode:'immediate',questions:[QUESTION]});
       await markV2Ready(test.db,{...ready,preparationGeneration:2});
     }
     return statement.run();
   }
 };}
 const db:PersistenceDatabase={prepare:sql=>wrap(test.db.prepare(sql),sql),batch:s=>test.db.batch(s)};
 await expect(markV2Ready(db,ready)).rejects.toMatchObject({code:'invalid_state'});
 expect(await test.binding.prepare("SELECT ready_generation FROM v2_participant_progress WHERE participant_id='p-0'").first('ready_generation')).toBe(2);
 await expect(markV2Ready(test.db,{...ready,participantId:'p-1',preparationGeneration:2})).resolves.toMatchObject({state:'COUNTDOWN',readyCount:2});
});
