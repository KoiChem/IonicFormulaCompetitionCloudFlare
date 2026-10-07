import { afterEach, describe, expect, it } from "vitest";

import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach((context) => context.close()));

function context() {
  const value = createApiTestContext();
  contexts.push(value);
  return value;
}

const forbidden = [
  "canonical", "acceptedAlternative", "answer_snapshot", "itemId", "teacherAllowedEmails",
  "teacher@example.com", "token_hash", "internal sql", "select ",
];

function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const secret of forbidden) expect(serialized).not.toContain(secret.toLowerCase());
}

describe("data exposure boundaries", () => {
  it("public config exposes only browser-safe settings", async () => {
    const test = context();
    const response = await test.handlers.publicConfig(apiRequest("/api/public-config"));
    expect(response.status).toBe(200);
    expectNoSecrets(await response.json());
  });

  it("does not expose any question before the shared start time", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    await test.handlers.startRoom(
      apiRequest(`/api/rooms/${created.body.room.id}/start`, {
        method: "POST",
        json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
      }),
      { id: created.body.room.id },
    );
    const response = await test.handlers.state(
      apiRequest(`/api/rooms/${created.body.room.id}/state?questionId=future`, { token: joined.token }),
      { id: created.body.room.id },
    );
    const body = await response.json();
    expect(body).toMatchObject({ question: null });
    expectNoSecrets(body);
  });

  it("returns only the current public question after start and never echoes tokens", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    await test.handlers.startRoom(
      apiRequest(`/api/rooms/${created.body.room.id}/start`, {
        method: "POST",
        json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
      }),
      { id: created.body.room.id },
    );
    test.setNow(6_001);
    const response = await test.handlers.state(
      apiRequest(`/api/rooms/${created.body.room.id}/state?questionId=future`, { token: joined.token }),
      { id: created.body.room.id },
    );
    const body = await response.json();
    expect(body).toHaveProperty("question.id");
    expect(JSON.stringify(body)).not.toContain(joined.token);
    expectNoSecrets(body);
  });

  it("maps repository state errors without exposing their internal message", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    const response = await test.handlers.actions(
      apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST",
        token: joined.token,
        json: {
          requestId: crypto.randomUUID(),
          questionId: "not-started",
          expectedParticipantRevision: 0,
          clientElapsedMs: 0,
          action: { type: "pass", fieldId: "formula" },
        },
      }),
      { id: created.body.room.id },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "invalid_state", message: "現在の状態では操作できません" } });
    expect(JSON.stringify(body)).not.toContain("competition has not started");
  });

  it("maps database failures to a generic 503 without SQL text", async () => {
    const test = context();
    test.database.sqlite.close();
    contexts.splice(contexts.indexOf(test), 1);
    const response = await test.handlers.joinInfo(apiRequest("/api/join-info?code=ABC234"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "service_unavailable", message: "サービスを利用できません" } });
    expectNoSecrets(body);
  });
});
