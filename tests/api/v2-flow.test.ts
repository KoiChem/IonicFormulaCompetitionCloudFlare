import { afterEach, describe, expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, createMateRoom, joinClassRoom, SETTINGS } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(context => context.close()));

describe("protocol v2 grading modes", () => {
  it("finalizes an immediate early submission as 提出 with only accepted correct answers", async () => {
    const test = createApiTestContext(); contexts.push(test);
    const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, ionAnswer: "name", gradingMode: "immediate" });
    const roomId = created.body.room.id;
    const joined = await joinClassRoom(test, roomId);
    await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id: roomId });
    const manifest = await (await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: joined.token }), { id: roomId })).json() as {
      manifestId: string; evaluatorVersion: string; preparationGeneration: number; questions: Array<{ id: string; answer: { canonical: string } }> };
    const ready = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: joined.token,
      json: { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration } }), { id: roomId });
    const started = await ready.json() as { startAtMs: number };
    test.setNow(started.startAtMs + 1000);
    const operations = [
      { seq: 1, operationId: crypto.randomUUID(), type: "answer", questionId: manifest.questions[0].id, fieldId: "name", value: manifest.questions[0].answer.canonical, elapsedMs: 500 },
      { seq: 2, operationId: crypto.randomUUID(), type: "finish", reason: "submitted", elapsedMs: 900 },
    ];
    const saved = await test.handlers.operations(apiRequest(`/api/rooms/${roomId}/operations`, { method: "POST", token: joined.token,
      json: { requestId: crypto.randomUUID(), writerEpoch: 1, manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, operations } }), { id: roomId });
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    const result = await test.handlers.results(apiRequest(`/api/rooms/${roomId}/results`, { token: joined.token }), { id: roomId });
    expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
    const body = await result.json() as { own: { correctCount: number; finishReason: string; elapsedCs: number } };
    expect(body.own).toMatchObject({ correctCount: 1, finishReason: "submitted", elapsedCs: 90 });
  });
  it("runs a mate match with the same deferred protocol", async () => {
    const test = createApiTestContext(); contexts.push(test);
    const host = await createMateRoom(test, { settings: { ...SETTINGS, gradingMode: "deferred" } });
    expect(host.response.status).toBe(201);
    const roomId = host.body.room.id;
    const guest = await joinClassRoom(test, roomId, "ゲスト");
    const started = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST", token: host.token,
      json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id: roomId });
    expect(started.status).toBe(200);
    const manifest = await (await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: host.token }), { id: roomId })).json() as
      { manifestId: string; evaluatorVersion: string; preparationGeneration: number };
    const readyBody = { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration };
    const hostReady = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: host.token, json: readyBody }), { id: roomId });
    expect((await hostReady.json() as { state: string }).state).toBe("PREPARING");
    const guestReady = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: guest.token, json: readyBody }), { id: roomId });
    const schedule = await guestReady.json() as { state: string; startAtMs: number };
    expect(schedule.state).toBe("COUNTDOWN");
    test.setNow(schedule.startAtMs + 1000);
    for (const token of [host.token, guest.token]) {
      const saved = await test.handlers.operations(apiRequest(`/api/rooms/${roomId}/operations`, { method: "POST", token,
        json: { requestId: crypto.randomUUID(), writerEpoch: 1, manifestId: manifest.manifestId,
          evaluatorVersion: manifest.evaluatorVersion,
          operations: [{ seq: 1, operationId: crypto.randomUUID(), type: "finish", reason: "submitted", elapsedMs: 1000 }] },
      }), { id: roomId });
      expect(saved.status, `${token === host.token ? "host" : "guest"}: ${JSON.stringify(await saved.clone().json())}`).toBe(200);
    }
    const result = await test.handlers.results(apiRequest(`/api/rooms/${roomId}/results`, { token: guest.token }), { id: roomId });
    expect(result.status).toBe(200);
    const body = await result.json() as { ranking: Array<{ nickname: string }> };
    expect(body.ranking).toHaveLength(2);
  });

  it("waits for every participant and blocks roster changes during preparation", async () => {
    const test = createApiTestContext(); contexts.push(test);
    const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, gradingMode: "immediate" });
    const roomId = created.body.room.id;
    const first = await joinClassRoom(test, roomId, "一人目");
    const second = await joinClassRoom(test, roomId, "二人目");
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
      method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 2 },
    }), { id: roomId });
    expect(start.status).toBe(200);
    const laterJoin = await joinClassRoom(test, roomId, "三人目");
    expect(laterJoin.response.status).toBe(409);
    const manifest = await (await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: first.token }), { id: roomId })).json() as
      { manifestId: string; evaluatorVersion: string; preparationGeneration: number };
    const readyBody = { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration };
    const readyFirst = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: first.token, json: readyBody }), { id: roomId });
    expect((await readyFirst.json() as { state: string }).state).toBe("PREPARING");
    const readySecond = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: second.token, json: readyBody }), { id: roomId });
    expect((await readySecond.json() as { state: string }).state).toBe("COUNTDOWN");
  });

  it("does not auto-start when the last ready notice arrives after 30 seconds", async () => {
    const test = createApiTestContext(); contexts.push(test);
    const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, gradingMode: "deferred" });
    const roomId = created.body.room.id;
    const first = await joinClassRoom(test, roomId, "一人目");
    const second = await joinClassRoom(test, roomId, "二人目");
    const started = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
      method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 2 },
    }), { id: roomId });
    expect(started.status).toBe(200);
    const manifest = await (await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: first.token }), { id: roomId })).json() as
      { manifestId: string; evaluatorVersion: string; preparationGeneration: number };
    const body = { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration };
    await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: first.token, json: body }), { id: roomId });
    test.setNow(31_001);
    const late = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: second.token, json: body }), { id: roomId });
    expect(await late.json()).toMatchObject({ state: "PREPARING", preparationTimedOut: true });
  });

  it("regenerates a manifest after preparation cancellation and settings change", async () => {
    const test = createApiTestContext(); contexts.push(test);
    const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, gradingMode: "immediate" });
    const roomId = created.body.room.id;
    await joinClassRoom(test, roomId);
    const started = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST",
      json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id: roomId });
    const firstId = (await started.json() as { manifestId: string }).manifestId;
    const cancelled = await test.handlers.cancelPreparation(apiRequest(`/api/rooms/${roomId}/cancel-preparation`, { method: "POST",
      json: { expectedRevision: 2 } }), { id: roomId });
    expect(cancelled.status).toBe(200);
    const changed = await test.handlers.updateRoomSettings(apiRequest(`/api/rooms/${roomId}/settings`, { method: "PATCH",
      json: { requestId: crypto.randomUUID(), expectedRevision: 3, settings: { ...SETTINGS, gradingMode: "deferred" } } }), { id: roomId });
    expect(changed.status).toBe(200);
    const restarted = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST",
      json: { requestId: crypto.randomUUID(), expectedRevision: 4 } }), { id: roomId });
    expect(restarted.status, JSON.stringify(await restarted.clone().json())).toBe(200);
    expect((await restarted.json() as { manifestId: string }).manifestId).not.toBe(firstId);
  });

  for (const gradingMode of ["immediate", "deferred"] as const) {
    it(`prepares, saves and finalizes ${gradingMode}`, async () => {
      const test = createApiTestContext(); contexts.push(test);
      const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, ionAnswer: "name", gradingMode });
      expect(created.response.status).toBe(201);
      const roomId = created.body.room.id;
      const joined = await joinClassRoom(test, roomId);
      expect(joined.response.status).toBe(201);
      const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
        method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
      }), { id: roomId });
      expect(start.status).toBe(200);
      const prepared = await start.json() as { state: string; manifestId: string; preparationGeneration: number };
      expect(prepared.state).toBe("PREPARING");
      const manifestResponse = await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: joined.token }), { id: roomId });
      expect(manifestResponse.status).toBe(200);
      const manifest = await manifestResponse.json() as { manifestId: string; evaluatorVersion: string; preparationGeneration: number; questions: Array<{ id: string; answer?: { canonical: string }; fields: Array<{ id: "formula" | "name" }> }> };
      expect(manifest.questions).toHaveLength(SETTINGS.questionCount);
      expect(Boolean(manifest.questions[0].answer)).toBe(gradingMode === "immediate");
      const ready = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: joined.token,
        json: { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration },
      }), { id: roomId });
      expect(ready.status).toBe(200);
      const started = await ready.json() as { startAtMs: number; deadlineAtMs: number };
      test.setNow(started.startAtMs + 1000);
      const question = manifest.questions[0];
      const operation = gradingMode === "immediate"
        ? { seq: 1, operationId: crypto.randomUUID(), type: "answer", questionId: question.id, fieldId: "name", value: question.answer!.canonical, elapsedMs: 1000 }
        : { seq: 1, operationId: crypto.randomUUID(), type: "draft", questionId: question.id, fieldId: "name", value: "テスト", elapsedMs: 1000, editedElapsedMs: 1000 };
      const saved = await test.handlers.operations(apiRequest(`/api/rooms/${roomId}/operations`, { method: "POST", token: joined.token,
        json: { requestId: crypto.randomUUID(), writerEpoch: 1, manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, operations: [operation] },
      }), { id: roomId });
      expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
      expect(await saved.json()).toMatchObject({ ackSeq: 1 });
      test.setNow(started.deadlineAtMs + 10_001);
      const state = await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: joined.token }), { id: roomId });
      expect(state.status, JSON.stringify(await state.clone().json())).toBe(200);
      expect((await state.json() as { room: { state: string } }).room.state).toBe("FINISHED");
      const result = await test.handlers.results(apiRequest(`/api/rooms/${roomId}/results`, { token: joined.token }), { id: roomId });
      expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
      const body = await result.json() as { own: { correctCount: number }; questions: Array<{ fields: Array<{ state: string }> }> };
      expect(body.own.correctCount).toBe(gradingMode === "immediate" ? 1 : 0);
      expect(body.questions[0].fields[0].state).toBe(gradingMode === "immediate" ? "correct" : "incorrect");
    });
  }
});
