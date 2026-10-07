import { afterEach, expect, it } from "vitest";
import { generateQuestionSet } from "../../src/games/ionic-formula/server/question-generator";
import { createApiHandlers } from "../../src/platform/http";
import type { InternalQuestion } from "../../src/games/ionic-formula/shared/types";
import { apiRequest, createApiTestContext, createClassRoom, createMateRoom, joinClassRoom, SETTINGS } from "./helpers";

type Manifest = { manifestId: string; evaluatorVersion: string; preparationGeneration: number; questions: InternalQuestion[] };
type Schedule = { startAtMs: number; deadlineAtMs: number };
const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(context => context.close()));
function seeded(seed: number) {
  let value = seed;
  return () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

for (const kind of ["class", "mate"] as const) for (const mode of ["ion", "compound"] as const) for (const gradingMode of ["immediate", "deferred"] as const) {
  it(`persists, prepares, grades and reviews complex ${mode} questions in ${kind}/${gradingMode}`, async () => {
    const context = createApiTestContext(); contexts.push(context);
    const settings = { ...SETTINGS, questionCount: 15 as const, mode, gradingMode, complexEnabled: true };
    const created = kind === "class" ? await createClassRoom(context, crypto.randomUUID(), settings) : await createMateRoom(context, { settings });
    expect(created.response.status).toBe(201);
    const roomId = created.body.room.id;
    const joined = kind === "class" ? await joinClassRoom(context, roomId) : created as Awaited<ReturnType<typeof createMateRoom>>;
    // State returns the settings read from persisted JSON, not the creation request.
    const state = await (await context.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: joined.token }), { id: roomId })).json() as { room: { settings: unknown } };
    expect(state.room.settings).toMatchObject({ complexEnabled: true, chemistryContentVersion: "complex-ions-2026-10-02" });
    const stored = await context.database.prepare("SELECT dataset_version FROM rooms WHERE public_id = ?").bind(roomId).first<{ dataset_version: string }>();
    expect(stored?.dataset_version).toBe("complex-ions-2026-10-02");
    const target = mode === "ion" ? "complex_fe_cn_6_ii" : "salt_k4_fe_cn_6";
    let seed = 1;
    while (!generateQuestionSet(settings, seeded(seed)).some(q => q.itemId === target)) seed++;
    context.handlers = createApiHandlers({ ...context.dependencies, random: seeded(seed) });
    const guest = kind === "mate" ? await joinClassRoom(context, roomId, "ゲスト") : null;
    const start = await context.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST", token: kind === "mate" ? joined.token : undefined,
      json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id: roomId });
    expect(start.status, JSON.stringify(await start.clone().json())).toBe(200);
    const manifest = await (await context.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: joined.token }), { id: roomId })).json() as Manifest;
    expect(Boolean(manifest.questions[0].answer)).toBe(gradingMode === "immediate");
    const rows = await context.database.prepare("SELECT answer_snapshot_json FROM room_questions ORDER BY ordinal").all<{ answer_snapshot_json: string }>();
    const questions = rows.results.map(row => JSON.parse(row.answer_snapshot_json) as InternalQuestion);
    const complex = questions.find(q => q.itemId === target)!;
    expect(complex.answer).toMatchObject({ canonical: mode === "ion" ? "[Fe(CN)6]4-" : "K4[Fe(CN)6]" });
    const ready = await context.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: joined.token,
      json: { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration } }), { id: roomId });
    const hostSchedule = await ready.json() as Schedule;
    const schedule = guest ? await (await context.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: guest.token,
      json: { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration } }), { id: roomId })).json() as Schedule : hostSchedule;
    context.setNow(schedule.startAtMs + 2000);
    const operations = questions.map((q, index) => ({ seq: index + 1, operationId: crypto.randomUUID(), type: gradingMode === "immediate" ? "answer" : "draft",
      questionId: q.id, fieldId: "formula", elapsedMs: 1000 + index, ...(gradingMode === "deferred" ? { editedElapsedMs: 1000 + index } : {}),
      value: { tokens: [...(q.ionFormula ?? (q.answer as { canonical: string }).canonical)], cursor: 0,
        charge: q.ionCharge !== undefined ? { magnitude: Math.abs(q.ionCharge), sign: q.ionCharge > 0 ? "+" : "-", source: "chargeButton" } : null } }));
    operations.push({ seq: 16, operationId: crypto.randomUUID(), type: "finish", reason: "submitted", elapsedMs: 1500 } as unknown as typeof operations[number]);
    const saved = await context.handlers.operations(apiRequest(`/api/rooms/${roomId}/operations`, { method: "POST", token: joined.token,
      json: { requestId: crypto.randomUUID(), writerEpoch: 1, manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, operations } }), { id: roomId });
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    context.setNow(schedule.deadlineAtMs + 10001);
    await context.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: joined.token }), { id: roomId });
    const result = await context.handlers.results(apiRequest(`/api/rooms/${roomId}/results`, { token: joined.token }), { id: roomId });
    expect(result.status).toBe(200);
    const body = await result.json() as { own: { correctCount: number }; questions: { fields: { correctAnswer: string }[] }[] };
    expect(body.own.correctCount).toBe(15);
    expect(body.questions.flatMap((q: { fields: { correctAnswer: string }[] }) => q.fields.map(f => f.correctAnswer))).toContain(mode === "ion" ? "[Fe(CN)6]4-" : "K4[Fe(CN)6]");
  });
}

it.each(["yes", 1, null, {}])("rejects non-boolean complex setting %j", async complexEnabled => {
  const context = createApiTestContext(); contexts.push(context);
  const created = await createClassRoom(context, crypto.randomUUID(), { ...SETTINGS, complexEnabled } as never);
  expect(created.response.status).toBe(400);
});

it("pins the chemistry version when an old waiting room enables complex questions", async () => {
  const context = createApiTestContext(); contexts.push(context);
  const created = await createClassRoom(context);
  const roomId = created.body.room.id;
  await context.database.prepare("UPDATE rooms SET dataset_version = '4' WHERE public_id = ?").bind(roomId).run();
  const changed = await context.handlers.updateRoomSettings(apiRequest(`/api/rooms/${roomId}/settings`, { method: "PATCH",
    json: { requestId: crypto.randomUUID(), expectedRevision: 0, settings: { ...SETTINGS, complexEnabled: true } } }), { id: roomId });
  expect(changed.status).toBe(200);
  const row = await context.database.prepare("SELECT settings_json, dataset_version FROM rooms WHERE public_id = ?").bind(roomId).first<{ settings_json: string; dataset_version: string }>();
  expect(row?.dataset_version).toBe("complex-ions-2026-10-02");
  expect(JSON.parse(row!.settings_json)).toMatchObject({ complexEnabled: true, chemistryContentVersion: "complex-ions-2026-10-02" });
});

it.each(["outdated", null])("rejects unknown chemistry version %j", async chemistryContentVersion => {
  const context = createApiTestContext(); contexts.push(context);
  const created = await createClassRoom(context, crypto.randomUUID(), { ...SETTINGS, complexEnabled: true, chemistryContentVersion } as never);
  expect(created.response.status).toBe(400);
});
