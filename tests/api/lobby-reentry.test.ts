import { afterEach, describe, expect, it } from "vitest";

import { createParticipantToken } from "../../src/platform/participant-auth";
import { apiRequest, createApiTestContext, createClassRoom, createMateRoom, joinClassRoom } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(context => context.close()));

function context() {
  const test = createApiTestContext();
  contexts.push(test);
  return test;
}

async function remove(test: ReturnType<typeof context>, roomId: string, participantId: string, roomRevision: number, hostToken?: string) {
  return test.handlers.removeParticipant(apiRequest(`/api/rooms/${roomId}/remove`, {
    method: "POST", token: hostToken,
    json: { requestId: crypto.randomUUID(), participantId, expectedRoomRevision: roomRevision, expectedParticipantRevision: 0 },
  }), { id: roomId });
}

describe("removed lobby participants", () => {
  it.each(["class", "mate"] as const)("shows only the removed participant's status in a %s room and permits a fresh same-name entry", async kind => {
    const test = context();
    const created = kind === "class" ? await createClassRoom(test) : await createMateRoom(test);
    const roomId = created.body.room.id;
    const old = await joinClassRoom(test, roomId, "再参加者");
    expect((await remove(test, roomId, old.body.participant.id, 1, kind === "mate" ? (created as Awaited<ReturnType<typeof createMateRoom>>).token : undefined)).status).toBe(200);

    const state = await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: old.token }), { id: roomId });
    expect(state.status).toBe(403);
    const removed = await state.json();
    expect(removed).toMatchObject({ error: { code: "participant_removed", nickname: "再参加者", canRejoin: true, roomState: "WAITING" } });
    expect(JSON.stringify(removed)).not.toContain("participants");
    expect((await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: createParticipantToken() }), { id: roomId })).status).toBe(403);

    const next = await joinClassRoom(test, roomId, "再参加者");
    expect(next.response.status).toBe(201);
    expect(next.body.participant.id).not.toBe(old.body.participant.id);
    expect((next.body.participant as any).joinedOrder).toBe(kind === "mate" ? 3 : 2);
    expect((await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: next.token }), { id: roomId })).status).toBe(200);
    expect((await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token: old.token }), { id: roomId })).status).toBe(403);
  });

  it("keeps a successful join replay recoverable after the host starts the room", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const roomId = created.body.room.id;
    const token = createParticipantToken();
    const body = { requestId: crypto.randomUUID(), nickname: "参加者" };
    const join = () => test.handlers.joinRoom(apiRequest(`/api/rooms/${roomId}/join`, { method: "POST", token, json: body }), { id: roomId });
    expect((await join()).status).toBe(201);
    expect((await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
      method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
    }), { id: roomId })).status).toBe(200);
    expect((await join()).status).toBe(201);
  });
});
