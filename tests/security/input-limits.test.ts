import { afterEach, describe, expect, it, vi } from "vitest";

import { createParticipantToken } from "../../src/platform/participant-auth";
import {
  ORIGIN,
  SETTINGS,
  apiRequest,
  createApiTestContext,
  createClassRoom,
  joinClassRoom,
} from "../api/helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => {
  contexts.splice(0).forEach((context) => context.close());
  vi.restoreAllMocks();
});

function context() {
  const value = createApiTestContext();
  contexts.push(value);
  return value;
}

describe("request, origin, authentication, and input limits", () => {
  it.each([
    ["missing Origin", { "content-type": "application/json", "x-competition-csrf": "1" }],
    ["foreign Origin", { origin: "https://evil.example", "content-type": "application/json", "x-competition-csrf": "1" }],
    ["cross-site fetch metadata", { origin: ORIGIN, "content-type": "application/json", "x-competition-csrf": "1", "sec-fetch-site": "cross-site" }],
  ])("rejects %s on mutations", async (_name, headers) => {
    const test = context();
    const response = await test.handlers.createClassRoom(new Request(`${ORIGIN}/api/class-rooms`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: crypto.randomUUID(), settings: SETTINGS }),
    }));
    expect(response.status).toBe(403);
  });

  it("rejects oversized bodies while streaming and never logs raw input or bearer credentials", async () => {
    const test = context();
    const secret = `secret-${"x".repeat(4_100)}`;
    const logged: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { logged.push(values); });
    }
    const token = createParticipantToken();
    const response = await test.handlers.createMateRoom(apiRequest("/api/mate-rooms", {
      method: "POST",
      token,
      headers: { "x-creation-key": createParticipantToken() },
      json: { requestId: crypto.randomUUID(), nickname: secret, settings: SETTINGS },
    }));

    expect(response.status).toBe(413);
    const output = JSON.stringify(logged);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it.each([
    ["requestId", { requestId: "r".repeat(129), settings: SETTINGS }],
    ["unknown key", { requestId: crypto.randomUUID(), settings: SETTINGS, score: 42 }],
  ])("rejects invalid %s", async (_name, body) => {
    const test = context();
    const response = await test.handlers.createClassRoom(apiRequest("/api/class-rooms", {
      method: "POST",
      json: body,
    }));
    expect(response.status).toBe(400);
  });

  it("rejects invalid public IDs, long nicknames, and malformed bearer credentials", async () => {
    const test = context();
    expect((await test.handlers.joinInfo(apiRequest(`/api/join-info?publicId=${"p".repeat(129)}`))).status).toBe(400);
    const created = await createClassRoom(test);
    const longNickname = await test.handlers.joinRoom(apiRequest(`/api/rooms/${created.body.room.id}/join`, {
      method: "POST",
      token: createParticipantToken(),
      json: { requestId: crypto.randomUUID(), nickname: "あ".repeat(17) },
    }), { id: created.body.room.id });
    expect(longNickname.status).toBe(400);
    const malformed = await test.handlers.state(apiRequest(`/api/rooms/${created.body.room.id}/state`, {
      headers: { authorization: "Bearer too-short" },
    }), { id: created.body.room.id });
    expect(malformed.status).toBe(403);
  });

  it("rate-limits one participant's excessive answer operations without partial writes", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${created.body.room.id}/start`, {
      method: "POST",
      json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
    }), { id: created.body.room.id });
    const schedule = await start.json() as { startAtMs: number };
    test.setNow(schedule.startAtMs + 1);
    const state = await test.handlers.state(apiRequest(`/api/rooms/${created.body.room.id}/state`, {
      token: joined.token,
    }), { id: created.body.room.id });
    const current = await state.json() as { question: { id: string } };

    for (let revision = 0; revision < 120; revision += 1) {
      const response = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST",
        token: joined.token,
        json: {
          requestId: `wrong-${revision}`,
          questionId: current.question.id,
          expectedParticipantRevision: revision,
          clientElapsedMs: 1,
          action: { type: "answer", fieldId: "formula", value: "K+" },
        },
      }), { id: created.body.room.id });
      expect(response.status, `revision ${revision}`).toBe(200);
    }
    const limited = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST",
      token: joined.token,
      json: {
        requestId: "wrong-limited",
        questionId: current.question.id,
        expectedParticipantRevision: 120,
        clientElapsedMs: 1,
        action: { type: "answer", fieldId: "formula", value: "K+" },
      },
    }), { id: created.body.room.id });

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(test.database.sqlite.prepare(
      "SELECT revision, correct_count FROM participants WHERE id = ?",
    ).get(joined.body.participant.id)).toEqual({ revision: 120, correct_count: 0 });
    expect(test.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM command_receipts WHERE actor_id = ?",
    ).get(joined.body.participant.id)).toEqual({ count: 120 });
  });

  it("counts rejected stale actions durably and replays their rejection without a second charge", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${created.body.room.id}/start`, {
      method: "POST",
      json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
    }), { id: created.body.room.id });
    const schedule = await start.json() as { startAtMs: number };
    test.setNow(schedule.startAtMs + 1);
    const state = await test.handlers.state(apiRequest(`/api/rooms/${created.body.room.id}/state`, {
      token: joined.token,
    }), { id: created.body.room.id });
    const current = await state.json() as { question: { id: string } };

    const staleBody = (requestId: string) => ({
      requestId,
      questionId: current.question.id,
      expectedParticipantRevision: 999,
      clientElapsedMs: 1,
      action: { type: "answer", fieldId: "formula", value: "K+" },
    });
    for (let index = 0; index < 120; index += 1) {
      const response = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST", token: joined.token, json: staleBody(`stale-${index}`),
      }), { id: created.body.room.id });
      expect(response.status, `stale ${index}`).toBe(409);
    }
    const replay = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST", token: joined.token, json: staleBody("stale-0"),
    }), { id: created.body.room.id });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "stale_participant_revision" } });

    const limited = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST", token: joined.token, json: staleBody("stale-120"),
    }), { id: created.body.room.id });
    expect(limited.status).toBe(429);
    expect(test.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM operation_attempts WHERE actor_id = ?",
    ).get(joined.body.participant.id)).toEqual({ count: 120 });
    expect(test.database.sqlite.prepare(
      "SELECT revision FROM participants WHERE id = ?",
    ).get(joined.body.participant.id)).toEqual({ revision: 0 });
  });
});
