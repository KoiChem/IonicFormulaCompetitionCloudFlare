import { afterEach, describe, expect, it } from "vitest";

import { createApiHandlers } from "../../src/platform/http";
import { createParticipantToken } from "../../src/platform/participant-auth";
import {
  apiRequest,
  createApiTestContext,
  createClassRoom,
  createMateRoom,
  joinClassRoom,
  ORIGIN,
  SETTINGS,
  startAndFinishByPassing,
} from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach((context) => context.close()));

function context() {
  const value = createApiTestContext();
  contexts.push(value);
  return value;
}

async function startClass(test: ReturnType<typeof context>, roomId: string, revision = 1) {
  const response = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
    method: "POST",
    json: { requestId: crypto.randomUUID(), expectedRevision: revision },
  }), { id: roomId });
  const body = await response.json() as { startAtMs: number };
  expect(response.status).toBe(200);
  test.setNow(body.startAtMs + 1);
}

describe("review: answer payload validation", () => {
  it("accepts a strict FormulaEntry for ion formulas but a canonical string cannot spoof the charge control", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    await startClass(test, created.body.room.id);
    const stateResponse = await test.handlers.state(apiRequest(`/api/rooms/${created.body.room.id}/state`, { token: joined.token }), { id: created.body.room.id });
    const state = await stateResponse.json() as { participant: { revision: number }; question: { id: string } };
    const internal = test.database.sqlite.prepare(`
      SELECT answer_snapshot_json FROM room_questions WHERE question_id = ?
    `).get(state.question.id) as { answer_snapshot_json: string };
    const question = JSON.parse(internal.answer_snapshot_json) as {
      answer: { canonical: string };
      ionFormula: string;
      ionCharge: number;
    };

    const spoof = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST",
      token: joined.token,
      json: {
        requestId: crypto.randomUUID(), questionId: state.question.id,
        expectedParticipantRevision: state.participant.revision, clientElapsedMs: 1,
        action: { type: "answer", fieldId: "formula", value: question.answer.canonical },
      },
    }), { id: created.body.room.id });
    expect(await spoof.json()).toMatchObject({ correct: false, participantRevision: 1, correctCount: 0 });

    const tokens = question.ionFormula.match(/[A-Z][a-z]?|\d+|[()]/gu);
    expect(tokens).not.toBeNull();
    const valid = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST",
      token: joined.token,
      json: {
        requestId: crypto.randomUUID(), questionId: state.question.id,
        expectedParticipantRevision: 1, clientElapsedMs: 2,
        action: {
          type: "answer",
          fieldId: "formula",
          value: {
            tokens,
            cursor: tokens!.length,
            charge: {
              magnitude: Math.abs(question.ionCharge),
              sign: question.ionCharge > 0 ? "+" : "-",
              source: "chargeButton",
            },
          },
        },
      },
    }), { id: created.body.room.id });
    expect(await valid.json()).toMatchObject({ correct: true, participantRevision: 2, correctCount: 1 });
  });

  it.each([
    { tokens: ["Na"], cursor: 2, charge: null },
    { tokens: ["<script>"], cursor: 1, charge: null },
    { tokens: ["Na"], cursor: 1, charge: { magnitude: 0, sign: "+", source: "chargeButton" } },
    { tokens: ["Na"], cursor: 1, charge: { magnitude: 1, sign: "+", source: "forged" } },
    { tokens: ["Na"], cursor: 1, charge: null, canonical: "Na+" },
  ])("rejects malformed structured formula entry %#", async (value) => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    const response = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST",
      token: joined.token,
      json: {
        requestId: crypto.randomUUID(), questionId: "not-started",
        expectedParticipantRevision: 0, clientElapsedMs: 0,
        action: { type: "answer", fieldId: "formula", value },
      },
    }), { id: created.body.room.id });
    expect(response.status).toBe(400);
  });

  it("preserves string answers for name fields", async () => {
    const test = context();
    const settings = { ...SETTINGS, ionAnswer: "name" as const };
    const created = await createClassRoom(test, crypto.randomUUID(), settings);
    const joined = await joinClassRoom(test, created.body.room.id);
    await startClass(test, created.body.room.id);
    const stateResponse = await test.handlers.state(apiRequest(`/api/rooms/${created.body.room.id}/state`, { token: joined.token }), { id: created.body.room.id });
    const state = await stateResponse.json() as { participant: { revision: number }; question: { id: string } };
    const row = test.database.sqlite.prepare("SELECT answer_snapshot_json FROM room_questions WHERE question_id = ?")
      .get(state.question.id) as { answer_snapshot_json: string };
    const question = JSON.parse(row.answer_snapshot_json) as { answer: { canonical: string } };
    const response = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
      method: "POST",
      token: joined.token,
      json: {
        requestId: crypto.randomUUID(), questionId: state.question.id,
        expectedParticipantRevision: 0, clientElapsedMs: 1,
        action: { type: "answer", fieldId: "name", value: question.answer.canonical },
      },
    }), { id: created.body.room.id });
    expect(await response.json()).toMatchObject({ correct: true, correctCount: 1 });
  });
});

describe("review: durable idempotency and creation limits", () => {
  it("returns the persisted mate host on an exact create retry and never echoes its bearer", async () => {
    const test = context();
    const requestId = crypto.randomUUID();
    const creationKey = createParticipantToken();
    const token = createParticipantToken();
    const first = await createMateRoom(test, { requestId, creationKey, token });
    const retry = await createMateRoom(test, { requestId, creationKey, token });
    expect(first.response.status).toBe(201);
    expect(retry.response.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(first.body).not.toHaveProperty("token");
    const persisted = test.database.sqlite.prepare("SELECT mate_host_id FROM rooms WHERE public_id = ?")
      .get(first.body.room.id) as { mate_host_id: string };
    expect(first.body.participant.id).toBe(persisted.mate_host_id);
    expect(test.database.sqlite.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 1 });

    test.database.sqlite.prepare(`
      INSERT INTO site_settings (id, mate_match_enabled, revision, updated_at_ms)
      VALUES (1, 0, 1, ?) ON CONFLICT(id) DO UPDATE SET mate_match_enabled = 0, revision = revision + 1
    `).run(test.dependencies.now());
    const retryAfterDisable = await createMateRoom(test, { requestId, creationKey, token });
    expect(retryAfterDisable.response.status).toBe(201);
    expect(retryAfterDisable.body).toEqual(first.body);
  });

  it("rejects a mate create retry when the bearer token differs", async () => {
    const test = context();
    const requestId = crypto.randomUUID();
    const creationKey = createParticipantToken();
    const first = await createMateRoom(test, { requestId, creationKey });
    expect(first.response.status).toBe(201);
    const changedToken = await createMateRoom(test, {
      requestId,
      creationKey,
      token: createParticipantToken(),
    });
    expect(changedToken.response.status).toBe(409);
    expect(changedToken.body).toMatchObject({ error: { code: "request_id_reused" } });
  });

  it("rechecks the mate-enabled gate inside the creation transaction", async () => {
    const test = context();
    const paused = test.database.pauseNextBatch();
    const creating = createMateRoom(test);
    await paused.reached;
    test.database.sqlite.prepare(`
      INSERT INTO site_settings (id, mate_match_enabled, revision, updated_at_ms)
      VALUES (1, 0, 1, ?) ON CONFLICT(id) DO UPDATE SET mate_match_enabled = 0, revision = revision + 1
    `).run(test.dependencies.now());
    paused.release();
    const result = await creating;
    expect(result.response.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "mate_disabled" } });
    expect(test.database.sqlite.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 0 });
  });

  it("makes room settings exactly idempotent and rejects changed-body request reuse", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const requestId = crypto.randomUUID();
    const body = { requestId, expectedRevision: 0, settings: { ...SETTINGS, timeLimitMinutes: 4 } };
    const first = await test.handlers.updateRoomSettings(apiRequest(`/api/rooms/${created.body.room.id}/settings`, { method: "PATCH", json: body }), { id: created.body.room.id });
    const retry = await test.handlers.updateRoomSettings(apiRequest(`/api/rooms/${created.body.room.id}/settings`, { method: "PATCH", json: body }), { id: created.body.room.id });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(test.database.sqlite.prepare("SELECT revision FROM rooms").get()).toEqual({ revision: 1 });

    const changed = await test.handlers.updateRoomSettings(apiRequest(`/api/rooms/${created.body.room.id}/settings`, {
      method: "PATCH",
      json: { ...body, settings: { ...SETTINGS, timeLimitMinutes: 5 } },
    }), { id: created.body.room.id });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "request_id_reused" } });
  });

  it("gives one winner for competing site-settings CAS and replays only that request", async () => {
    const test = context();
    const handlers = createApiHandlers({ ...test.dependencies, serverConfig: { teacherAllowedEmails: ["teacher@example.com"], masterTeacherEmail: "teacher@example.com" } });
    const firstRequestId = crypto.randomUUID();
    const secondRequestId = crypto.randomUUID();
    const mutate = (requestId: string, enabled: boolean) => handlers.teacherSiteSettings(apiRequest("/api/teacher/site-settings", {
      method: "PATCH",
      json: { requestId, expectedRevision: 0, enabled },
    }));
    const [first, second] = await Promise.all([mutate(firstRequestId, false), mutate(secondRequestId, true)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winnerId = first.status === 200 ? firstRequestId : secondRequestId;
    const winnerEnabled = first.status === 200 ? false : true;
    const replay = await mutate(winnerId, winnerEnabled);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ enabled: winnerEnabled, revision: 1 });
  });

  it("expires and lazily removes old site-settings receipts", async () => {
    const test = context();
    const handlers = createApiHandlers({ ...test.dependencies, serverConfig: { teacherAllowedEmails: ["teacher@example.com"], masterTeacherEmail: "teacher@example.com" } });
    const mutate = (requestId: string, expectedRevision: number, enabled: boolean) =>
      handlers.teacherSiteSettings(apiRequest("/api/teacher/site-settings", {
        method: "PATCH",
        json: { requestId, expectedRevision, enabled },
      }));
    const first = await mutate(crypto.randomUUID(), 0, false);
    expect(first.status).toBe(200);
    const stored = test.database.sqlite.prepare(
      "SELECT expires_at_ms FROM site_setting_receipts",
    ).get() as { expires_at_ms: number };
    expect(stored.expires_at_ms).toBeGreaterThan(test.dependencies.now());
    test.setNow(stored.expires_at_ms);
    const second = await mutate(crypto.randomUUID(), 1, true);
    expect(second.status).toBe(200);
    expect(test.database.sqlite.prepare(
      "SELECT COUNT(*) AS count, MIN(expires_at_ms) AS minimum FROM site_setting_receipts",
    ).get()).toMatchObject({ count: 1 });
  });

  it("rejects a second unfinished mate room atomically for the same creation credential", async () => {
    const test = context();
    const creationKey = createParticipantToken();
    const [first, second] = await Promise.all([
      createMateRoom(test, { creationKey, nickname: "ホスト1" }),
      createMateRoom(test, { creationKey, nickname: "ホスト2" }),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([201, 409]);
    expect(test.database.sqlite.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 1 });
  });

  it("rate-limits repeated anonymous creation durably with Retry-After", async () => {
    const test = context();
    const creationKey = createParticipantToken();
    for (let index = 0; index < 3; index += 1) {
      const created = await createMateRoom(test, { creationKey, nickname: `ホスト${index}` });
      expect(created.response.status).toBe(201);
      test.database.sqlite.prepare("UPDATE rooms SET state = 'FINISHED' WHERE public_id = ?").run(created.body.room.id);
    }
    const limited = await createMateRoom(test, { creationKey, nickname: "ホスト4" });
    expect(limited.response.status).toBe(429);
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("review: streaming and result exposure", () => {
  it("cancels an oversized streaming body as soon as it crosses 4 KiB", async () => {
    const test = context();
    const chunks = [new Uint8Array(3_000), new Uint8Array(1_200), new Uint8Array(1_000)];
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}/api/class-rooms`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-competition-csrf": "1",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await test.handlers.createClassRoom(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });

  it("returns post-finish self details without internal IDs and teacher-only aggregates", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id, "生徒A");
    await startAndFinishByPassing(test, created.body.room.id, joined.token);

    const participantResponse = await test.handlers.results(apiRequest(`/api/rooms/${created.body.room.id}/results`, { token: joined.token }), { id: created.body.room.id });
    expect(participantResponse.status).toBe(200);
    const participant = await participantResponse.json() as Record<string, unknown>;
    expect(participant).toHaveProperty("questions.0.fields.0.state", "passed");
    expect(participant).toHaveProperty("questions.0.fields.0.correctAnswer");
    expect(participant).not.toHaveProperty("aggregate");
    expect(JSON.stringify((participant as { ranking: unknown }).ranking)).not.toContain((joined.body.participant.id));

    const teacherResponse = await test.handlers.results(apiRequest(`/api/rooms/${created.body.room.id}/results`), { id: created.body.room.id });
    expect(teacherResponse.status).toBe(200);
    const teacher = await teacherResponse.json() as Record<string, unknown>;
    expect(teacher).toMatchObject({
      aggregate: {
        participantCount: 1,
        averageCorrectCount: 0,
        perfectCount: 0,
        completedCount: 1,
      },
    });
    expect(teacher).toHaveProperty("aggregate.questions.0.fields.0.correctRate", 0);
    expect(teacher).not.toHaveProperty("questions");
  });

  it("does not echo a caller-supplied bearer in join JSON", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    expect(joined.body).not.toHaveProperty("token");
    expect(JSON.stringify(joined.body)).not.toContain(joined.token);
  });
});
