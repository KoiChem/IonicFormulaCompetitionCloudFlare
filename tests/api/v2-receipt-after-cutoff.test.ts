import { expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom, SETTINGS } from "./helpers";

it("recovers an accepted operation receipt after collection closes without accepting a new batch", async () => {
  const test = createApiTestContext();
  try {
    const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, ionAnswer: "name", gradingMode: "deferred" });
    const roomId = created.body.room.id;
    const joined = await joinClassRoom(test, roomId);
    await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id: roomId });
    const manifest = await (await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: joined.token }), { id: roomId })).json() as any;
    const ready = await test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, { method: "POST", token: joined.token,
      json: { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, preparationGeneration: manifest.preparationGeneration } }), { id: roomId });
    const started = await ready.json() as { startAtMs: number; deadlineAtMs: number };
    test.setNow(started.startAtMs + 1000);
    const body = { requestId: crypto.randomUUID(), writerEpoch: 1, manifestId: manifest.manifestId,
      evaluatorVersion: manifest.evaluatorVersion, operations: [{ seq: 1, operationId: crypto.randomUUID(), type: "draft", questionId: manifest.questions[0].id,
        fieldId: "name", value: "テスト", elapsedMs: 1000, editedElapsedMs: 1000 }] };
    const send = (payload: unknown) => test.handlers.operations(apiRequest(`/api/rooms/${roomId}/operations`, { method: "POST", token: joined.token, json: payload }), { id: roomId });
    const first = await send(body);
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    const accepted = await first.json();
    test.setNow(started.deadlineAtMs + 10_001);
    const state = await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: joined.token }), { id: roomId });
    expect((await state.json() as any).room.state).toBe("FINISHED");
    const replay = await send(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(accepted);
    const newBatch = await send({ ...body, requestId: crypto.randomUUID(), operations: [{ ...body.operations[0], seq: 2, operationId: crypto.randomUUID() }] });
    expect(newBatch.status).toBe(409);
    const row = await test.database.prepare("SELECT COUNT(*) AS count FROM v2_operations").first<{ count: number }>();
    expect(row?.count).toBe(1);
  } finally { test.close(); }
});
