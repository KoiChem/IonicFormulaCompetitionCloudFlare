import { afterEach, describe, expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, createMateRoom, joinClassRoom } from "./helpers";
import { createParticipantToken } from "../../src/platform/participant-auth";
import { createApiHandlers } from "../../src/platform/http";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(value => value.close()));
function context() { const value = createApiTestContext(); contexts.push(value); return value; }

describe("cancel waiting room", () => {
  it("lets the creator end an empty class room", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const roomId = created.body.room.id;
    const response = await test.handlers.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 0 } }), { id: roomId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "CANCELLED", roomRevision: 1 });
  });
  it("requires the class creator, records cancellation once, and informs participants", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const roomId = created.body.room.id;
    const joined = await joinClassRoom(test, roomId);
    const body = { requestId: crypto.randomUUID(), expectedRevision: 1 };
    const participantAttempt = await test.handlers.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", token: joined.token, json: body }), { id: roomId });
    expect(participantAttempt.status).toBe(403);
    const cancel = () => test.handlers.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", json: body }), { id: roomId });
    const first = await cancel();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ state: "CANCELLED", roomRevision: 2 });
    expect(await (await cancel()).json()).toMatchObject({ state: "CANCELLED", roomRevision: 2 });
    const stored = test.database.sqlite.prepare("SELECT r.ended_at_ms AS ended, r.expires_at_ms AS expires, c.expires_at_ms AS creation_expires FROM rooms r JOIN creation_receipts c ON c.room_id = r.id WHERE r.public_id = ?").get(roomId) as { ended: number; expires: number; creation_expires: number };
    expect(stored).toMatchObject({ ended: test.dependencies.now(), creation_expires: stored.expires });
    expect(stored.expires - stored.ended).toBe(24 * 60 * 60 * 1_000);
    const state = await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: joined.token }), { id: roomId });
    expect((await state.json() as { room: { state: string } }).room.state).toBe("CANCELLED");
    expect((await joinClassRoom(test, roomId, "遅れて参加")).response.status).toBe(409);
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 2 } }), { id: roomId });
    expect(start.status).toBe(409);
    expect((await test.database.prepare("SELECT COUNT(*) AS n FROM final_results WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?)").bind(roomId).first<{ n: number }>())?.n).toBe(0);
  });

  it("lets only the mate host cancel and create again", async () => {
    const test = context();
    const created = await createMateRoom(test);
    const roomId = created.body.room.id;
    const guestToken = createParticipantToken();
    const guest = await test.handlers.joinRoom(apiRequest(`/api/rooms/${roomId}/join`, { method: "POST", token: guestToken, json: { requestId: crypto.randomUUID(), nickname: "ゲスト" } }), { id: roomId });
    expect(guest.status).toBe(201);
    const body = { requestId: crypto.randomUUID(), expectedRevision: 1 };
    expect((await test.handlers.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", token: guestToken, json: body }), { id: roomId })).status).toBe(403);
    expect((await test.handlers.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", token: created.token, json: body }), { id: roomId })).status).toBe(200);
    const next = await createMateRoom(test, { creationKey: created.creationKey, token: created.token });
    expect(next.response.status).toBe(201);
  });

  it("rejects another teacher and an expired room", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const roomId = created.body.room.id;
    const body = { requestId: crypto.randomUUID(), expectedRevision: 0 };
    const otherTeacher = createApiHandlers({ ...test.dependencies, teacherIdentity: { getVerifiedIdentity: async () => ({ id: "teacher-2", email: "teacher@example.com" }) } });
    expect((await otherTeacher.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", json: body }), { id: roomId })).status).toBe(403);
    test.setNow(1_000 + 2 * 60 * 60 * 1_000);
    expect((await test.handlers.cancelRoom(apiRequest(`/api/rooms/${roomId}/cancel`, { method: "POST", json: body }), { id: roomId })).status).toBe(410);
  });
});

describe("class result privacy", () => {
  it("returns top three to a participant and full ranking to the creator", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const roomId = created.body.room.id;
    const joined = [];
    for (let index = 0; index < 5; index += 1) joined.push(await joinClassRoom(test, roomId, `生徒${index + 1}`));
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 5 } }), { id: roomId });
    expect(start.status).toBe(200);
    const { deadlineAtMs } = await start.json() as { deadlineAtMs: number };
    test.database.sqlite.prepare("UPDATE participants SET correct_count = joined_order WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?)").run(roomId);
    test.setNow(deadlineAtMs + 1);
    const ownResponse = await test.handlers.results(apiRequest(`/api/rooms/${roomId}/results`, { token: joined[0].token }), { id: roomId });
    expect(ownResponse.status).toBe(200);
    const own = await ownResponse.json() as { ranking: { rank: number }[]; own: { rank: number; correctCount: number } };
    expect(own.ranking.map(row => row.rank)).toEqual([1, 2, 3]);
    expect(own.own).toMatchObject({ rank: 5, correctCount: 1 });
    const teacher = await (await test.handlers.results(apiRequest(`/api/rooms/${roomId}/results`), { id: roomId })).json() as { ranking: unknown[] };
    expect(teacher.ranking).toHaveLength(5);
  });
});
