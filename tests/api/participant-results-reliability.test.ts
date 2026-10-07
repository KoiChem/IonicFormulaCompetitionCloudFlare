import { it, expect, vi } from 'vitest';
import { createApiTestContext, createClassRoom, joinClassRoom, apiRequest, SETTINGS } from './helpers';
it.each(['name', 'formula'] as const)('returns participant results after blank pass for %s', async ionAnswer => {
 const t=createApiTestContext();
 try {
  const c=await createClassRoom(t, crypto.randomUUID(), {...SETTINGS,gradingMode:'immediate',ionAnswer}); const id=c.body.room.id;
  const p=await joinClassRoom(t,id);
  await t.handlers.startRoom(apiRequest(`/api/rooms/${id}/start`,{method:'POST',json:{requestId:crypto.randomUUID(),expectedRevision:1}}),{id});
  const m=await (await t.handlers.manifest(apiRequest(`/api/rooms/${id}/manifest`,{token:p.token}),{id})).json() as any;
  const s=await (await t.handlers.ready(apiRequest(`/api/rooms/${id}/ready`,{method:'POST',token:p.token,json:{manifestId:m.manifestId,evaluatorVersion:m.evaluatorVersion,preparationGeneration:m.preparationGeneration}}),{id})).json() as any;
  t.setNow(s.startAtMs+1000);
  const q=m.questions[0];
  const saved=await t.handlers.operations(apiRequest(`/api/rooms/${id}/operations`,{method:'POST',token:p.token,json:{requestId:crypto.randomUUID(),writerEpoch:1,manifestId:m.manifestId,evaluatorVersion:m.evaluatorVersion,operations:[{seq:1,operationId:crypto.randomUUID(),type:'pass',questionId:q.id,fieldId:ionAnswer,elapsedMs:1000}]}}),{id});
  expect(saved.status).toBe(200);
  t.setNow(s.deadlineAtMs+10001);
  const state=await t.handlers.state(apiRequest(`/api/rooms/${id}/state`,{token:p.token}),{id}); expect((await state.json() as any).room.state).toBe('FINISHED');
  const own=await t.handlers.results(apiRequest(`/api/rooms/${id}/results`,{token:p.token}),{id});
  const summary=await t.handlers.resultSummary(apiRequest(`/api/rooms/${id}/result-summary`,{token:p.token}),{id});
  const teacher=await t.handlers.results(apiRequest(`/api/rooms/${id}/results`),{id});
  const row=await t.database.prepare('SELECT state, answer_json FROM v2_final_fields WHERE question_id = ?').bind(q.id).first();
  expect(row).toMatchObject({state: 'passed', answer_json: null});
  const body=await own.json() as any;
  expect(own.status, JSON.stringify(body)).toBe(200);
  expect(body.questions[0].fields.some((field: any) => field.state === 'passed' && field.lastAnswer === null)).toBe(true);
  expect(summary.status).toBe(200); expect(teacher.status).toBe(200);
  await t.database.prepare("UPDATE v2_final_fields SET answer_json = 'null' WHERE state = 'passed' AND answer_json IS NULL").run();
  const legacy=await t.handlers.results(apiRequest(`/api/rooms/${id}/results`,{token:p.token}),{id});
  expect(legacy.status, JSON.stringify(await legacy.clone().json())).toBe(200);
  expect((await legacy.json() as any).questions[0].fields.some((field: any) => field.state === 'passed' && field.lastAnswer === null)).toBe(true);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
   await t.database.prepare("UPDATE v2_final_fields SET answer_json = '42' WHERE state = 'passed'").run();
   const damaged=await t.handlers.results(apiRequest(`/api/rooms/${id}/results`,{token:p.token}),{id});
   expect(damaged.status).toBe(200);
   expect((await damaged.json() as any).questions[0].fields.some((field: any) => field.answerDisplayUnavailable)).toBe(true);
   expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
 } finally {t.close();}
});

it('classifies an internal results failure as 500 with a matching diagnostic id', async () => {
 const t=createApiTestContext();
 try {
  const { createApiHandlers } = await import('../../src/platform/http');
  const failingDb={...t.database,prepare(query: string) { if (query.includes('FROM final_results f JOIN participants')) throw new TypeError('internal-secret-answer'); return t.database.prepare(query); },batch: t.database.batch.bind(t.database) };
  const handlers=createApiHandlers({...t.dependencies,database:failingDb});
  const created=await createClassRoom(t); const id=created.body.room.id;
  await t.database.prepare("UPDATE rooms SET state = 'FINISHED' WHERE public_id = ?").bind(id).run();
  const response=await handlers.results(apiRequest(`/api/rooms/${id}/results`),{id});
  const body=await response.json() as any;
  expect(response.status).toBe(500);
  expect(body.error.code).toBe('result_build_failed');
  expect(body.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
  expect(JSON.stringify(body)).not.toContain('internal-secret-answer');
 } finally {t.close();}
});
