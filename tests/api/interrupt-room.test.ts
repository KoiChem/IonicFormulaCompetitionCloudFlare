import { afterEach, describe, expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, createMateRoom, joinClassRoom } from "./helpers";
import { createApiHandlers } from "../../src/platform/http";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(value => value.close()));
function context() { const value = createApiTestContext(); contexts.push(value); return value; }

describe("interrupt active class room", () => {
  it("requires the creator and the active interval", async () => {
    const test = context();
    const room = await createClassRoom(test);
    const id = room.body.room.id;
    const joined = await joinClassRoom(test, id);
    const body = { requestId: crypto.randomUUID(), expectedRevision: 2 };
    const call = (handlers = test.handlers, token?: string) => handlers.interruptRoom(apiRequest(`/api/rooms/${id}/interrupt`, { method: "POST", token, json: body }), { id });
    expect((await call()).status).toBe(409);
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${id}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id });
    const schedule = await start.json() as { startAtMs: number };
    expect((await call()).status).toBe(409);
    test.setNow(schedule.startAtMs + 12_340);
    expect((await call(test.handlers, joined.token)).status).toBe(403);
    const other = createApiHandlers({ ...test.dependencies, teacherIdentity: { getVerifiedIdentity: async () => ({ id: "teacher-2", email: "teacher@example.com" }) } });
    expect((await call(other)).status).toBe(403);
    expect((await call()).status).toBe(200);
  });

  it("freezes accepted scores and unfinished time once, including retries", async () => {
    const test = context();
    const room = await createClassRoom(test);
    const id = room.body.room.id;
    const a = await joinClassRoom(test, id, "A");
    const b = await joinClassRoom(test, id, "B");
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${id}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 2 } }), { id });
    const schedule = await start.json() as { startAtMs: number };
    test.setNow(schedule.startAtMs + 12_340);
    test.database.sqlite.prepare("UPDATE participants SET correct_count = 2 WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?) AND nickname = 'A'").run(id);
    const body = { requestId: crypto.randomUUID(), expectedRevision: 3 };
    const call = () => test.handlers.interruptRoom(apiRequest(`/api/rooms/${id}/interrupt`, { method: "POST", json: body }), { id });
    const first = await call();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(await (await call()).json()).toEqual(firstBody);
    const result = await test.handlers.results(apiRequest(`/api/rooms/${id}/results`, { token: a.token }), { id });
    expect(result.status).toBe(200);
    const data = await result.json() as { room: { endReason: string; endedAtMs: number }; ranking: { nickname: string; elapsedCs: number; finishReason: string; rank: number }[] };
    expect(data.room).toMatchObject({ endReason: "interrupted", endedAtMs: schedule.startAtMs + 12_340 });
    expect(data.ranking).toMatchObject([{ nickname: "A", elapsedCs: 1234, finishReason: "interrupted", rank: 1 }, { nickname: "B", elapsedCs: 1234, finishReason: "interrupted", rank: 2 }]);
    expect((await test.handlers.results(apiRequest(`/api/rooms/${id}/results`, { token: b.token }), { id })).status).toBe(200);
    const stored = test.database.sqlite.prepare("SELECT COUNT(*) AS n FROM final_results WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?)").get(id) as { n: number };
    expect(stored.n).toBe(2);
  });

  it("does not interrupt a mate room", async () => {
    const test = context();
    const room = await createMateRoom(test);
    const id = room.body.room.id;
    const response = await test.handlers.interruptRoom(apiRequest(`/api/rooms/${id}/interrupt`, { method: "POST", token: room.token, json: { requestId: crypto.randomUUID(), expectedRevision: 0 } }), { id });
    expect(response.status).toBe(403);
  });

  it("recovers a committed interruption when its response is lost", async () => {
    const test = context();
    const room = await createClassRoom(test);
    const id = room.body.room.id;
    await joinClassRoom(test, id);
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${id}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id });
    const schedule = await start.json() as { startAtMs: number };
    test.setNow(schedule.startAtMs + 100);
    test.database.throwAfterNextBatchCommit();
    const body = { requestId: crypto.randomUUID(), expectedRevision: 2 };
    const call = () => test.handlers.interruptRoom(apiRequest(`/api/rooms/${id}/interrupt`, { method: "POST", json: body }), { id });
    const first = await call();
    expect(first.status).toBe(200);
    expect(await (await call()).json()).toEqual(await first.json());
  });

  it("keeps the normal result when the deadline was reached first", async () => {
    const test = context();
    const room = await createClassRoom(test);
    const id = room.body.room.id;
    await joinClassRoom(test, id);
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${id}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id });
    const schedule = await start.json() as { deadlineAtMs: number };
    test.setNow(schedule.deadlineAtMs + 1);
    const attempt = await test.handlers.interruptRoom(apiRequest(`/api/rooms/${id}/interrupt`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 2 } }), { id });
    expect(attempt.status).toBe(409);
    const result = await test.handlers.results(apiRequest(`/api/rooms/${id}/results`), { id });
    expect((await result.json() as { room: { endReason: string } }).room.endReason).toBe("normal");
  });
});
