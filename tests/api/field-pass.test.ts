import { afterEach, describe, expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom, SETTINGS } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(context => context.close()));

describe("field pass", () => {
  it("keeps the name field pending after passing only the formula", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const settings = { ...SETTINGS, mode: "compound" as const, compoundPrompts: { formula: true, name: true }, compoundAnswer: "both" as const };
    const room = (await createClassRoom(ctx, "create-both", settings)).body.room.id;
    const joined = await joinClassRoom(ctx, room, "参加者");
    await ctx.handlers.startRoom(apiRequest(`/api/rooms/${room}/start`, { method: "POST", json: { requestId: "start-both", expectedRevision: 1 } }), { id: room });
    ctx.setNow(6_000);
    const before = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    const data = await before.json() as { participant: { revision: number }; question: { id: string; progress: { fieldStates: Record<string, string> } } };
    expect(data.question.progress.fieldStates).toMatchObject({ formula: "pending", name: "pending" });
    const pass = await ctx.handlers.actions(apiRequest(`/api/rooms/${room}/actions`, { method: "POST", token: joined.token, json: { requestId: "pass-formula", questionId: data.question.id, expectedParticipantRevision: 0, clientElapsedMs: 0, action: { type: "pass", fieldId: "formula" } } }), { id: room });
    expect(pass.status).toBe(200);
    const after = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    const changed = await after.json() as typeof data;
    expect(changed.question.id).toBe(data.question.id);
    expect(changed.question.progress.fieldStates).toMatchObject({ formula: "passed", name: "pending" });
    expect(changed.participant.revision).toBe(1);
    const answerRow = await ctx.database.prepare(`
      SELECT q.answer_snapshot_json FROM room_questions q JOIN rooms r ON r.id = q.room_id
      WHERE r.public_id = ? AND q.ordinal = 0
    `).bind(room).first<{ answer_snapshot_json: string }>();
    const answerSnapshot = JSON.parse(answerRow!.answer_snapshot_json) as { answer: { name: { canonical: string } } };
    ctx.setNow(7_000);
    const answerName = await ctx.handlers.actions(apiRequest(`/api/rooms/${room}/actions`, { method: "POST", token: joined.token, json: { requestId: "answer-name", questionId: data.question.id, expectedParticipantRevision: 1, clientElapsedMs: 1_000, action: { type: "answer", fieldId: "name", value: answerSnapshot.answer.name.canonical } } }), { id: room });
    expect(answerName.status).toBe(200);
    expect(await answerName.json()).toMatchObject({ correctCount: 1, currentOrdinal: 1, resolvedQuestionCount: 1 });
  });

  it("requires a field for a new pass request", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const room = (await createClassRoom(ctx)).body.room.id;
    const joined = await joinClassRoom(ctx, room);
    await ctx.handlers.startRoom(apiRequest(`/api/rooms/${room}/start`, { method: "POST", json: { requestId: "start", expectedRevision: 1 } }), { id: room });
    ctx.setNow(6_000);
    const state = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    const questionId = ((await state.json()) as { question: { id: string } }).question.id;
    const pass = await ctx.handlers.actions(apiRequest(`/api/rooms/${room}/actions`, { method: "POST", token: joined.token, json: { requestId: "old-client-pass", questionId, expectedParticipantRevision: 0, clientElapsedMs: 0, action: { type: "pass" } } }), { id: room });
    expect(pass.status).toBe(400);
  });

  it("accepts a valid action without granting malformed wait credit", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const room = (await createClassRoom(ctx)).body.room.id;
    const joined = await joinClassRoom(ctx, room);
    await ctx.handlers.startRoom(apiRequest(`/api/rooms/${room}/start`, { method: "POST", json: { requestId: "start-credit", expectedRevision: 1 } }), { id: room });
    ctx.setNow(6_000);
    const state = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    const questionId = ((await state.json()) as { question: { id: string } }).question.id;
    const pass = await ctx.handlers.actions(apiRequest(`/api/rooms/${room}/actions`, { method: "POST", token: joined.token, json: {
      requestId: "pass-invalid-credit", questionId, expectedParticipantRevision: 0, clientElapsedMs: 0,
      waitCredit: { sourceRequestId: "bad$id", waitMs: -1 }, action: { type: "pass", fieldId: "formula" },
    } }), { id: room });
    expect(pass.status).toBe(200);
    expect(await pass.json()).toMatchObject({ waitCreditMs: 0, participantRevision: 1 });
  });
});
