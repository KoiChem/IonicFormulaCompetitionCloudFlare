import { afterEach, describe, expect, it } from "vitest";

import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach((context) => context.close()));

function context() {
  const value = createApiTestContext();
  contexts.push(value);
  return value;
}

describe("authorized room API flow", () => {
  it("connects class creation, join, start, state, and action to the repository", async () => {
    const test = context();
    const created = await createClassRoom(test);
    expect(created.response.status).toBe(201);
    expect(created.body.room).toMatchObject({ state: "WAITING", revision: 0 });

    const joined = await joinClassRoom(test, created.body.room.id, "  Ａlice  ");
    expect(joined.response.status).toBe(201);
    expect(joined.body).not.toHaveProperty("token");

    const start = await test.handlers.startRoom(
      apiRequest(`/api/rooms/${created.body.room.id}/start`, {
        method: "POST",
        json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
      }),
      { id: created.body.room.id },
    );
    expect(start.status).toBe(200);
    const started = await start.json() as { roomRevision: number; startAtMs: number; deadlineAtMs: number };
    expect(started).toMatchObject({ roomRevision: 2, startAtMs: 6_000, deadlineAtMs: 186_000 });
    expect(started).not.toHaveProperty("questionIds");

    test.setNow(6_001);
    const state = await test.handlers.state(
      apiRequest(`/api/rooms/${created.body.room.id}/state`, { token: joined.token }),
      { id: created.body.room.id },
    );
    expect(state.status).toBe(200);
    const current = await state.json() as { room: { state: string }; participant: { revision: number }; question: { id: string } };
    expect(current.room.state).toBe("RUNNING");
    expect(current.question.id).toEqual(expect.any(String));

    const action = await test.handlers.actions(
      apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST",
        token: joined.token,
        json: {
          requestId: crypto.randomUUID(),
          questionId: current.question.id,
          expectedParticipantRevision: current.participant.revision,
          clientElapsedMs: 1,
          action: { type: "pass", fieldId: "formula" },
        },
      }),
      { id: created.body.room.id },
    );
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({ code: "accepted", participantRevision: 1 });
  });

  it("returns 410 after a waiting room expires", async () => {
    const test = context();
    const created = await createClassRoom(test);
    test.setNow(1_000 + 2 * 60 * 60 * 1_000);
    const response = await test.handlers.state(
      apiRequest(`/api/rooms/${created.body.room.id}/state`),
      { id: created.body.room.id },
    );
    expect(response.status).toBe(410);
  });

  it("rejects client-owned score fields and invalid answer lengths", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    const forbidden = await test.handlers.actions(
      apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST",
        token: joined.token,
        json: {
          requestId: crypto.randomUUID(), questionId: "q", expectedParticipantRevision: 0,
          clientElapsedMs: 0, score: 999, action: { type: "pass", fieldId: "formula" },
        },
      }),
      { id: created.body.room.id },
    );
    expect(forbidden.status).toBe(400);

    const longAnswer = await test.handlers.actions(
      apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST",
        token: joined.token,
        json: {
          requestId: crypto.randomUUID(), questionId: "q", expectedParticipantRevision: 0,
          clientElapsedMs: 0, action: { type: "answer", fieldId: "formula", value: "x".repeat(129) },
        },
      }),
      { id: created.body.room.id },
    );
    expect(longAnswer.status).toBe(400);
  });

  it("maps an NFKC-equivalent duplicate nickname to a stable conflict", async () => {
    const test = context();
    const created = await createClassRoom(test);
    expect((await joinClassRoom(test, created.body.room.id, "Ａlice")).response.status).toBe(201);
    const duplicate = await joinClassRoom(test, created.body.room.id, "Alice");
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: { code: "conflict", message: "同じ内容がすでに使用されています" },
    });
  });
});
