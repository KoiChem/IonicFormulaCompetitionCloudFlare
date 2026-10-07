import { afterEach, describe, expect, it } from "vitest";

import { createApiHandlers } from "../../src/platform/http";
import { createParticipantToken } from "../../src/platform/participant-auth";
import {
  apiRequest,
  createApiTestContext,
  createClassRoom,
  createMateRoom,
  joinClassRoom,
} from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach((context) => context.close()));

function context(options: Parameters<typeof createApiTestContext>[0] = {}) {
  const value = createApiTestContext(options);
  contexts.push(value);
  return value;
}

async function removeParticipant(
  test: ReturnType<typeof context>,
  roomId: string,
  body: {
    requestId: string;
    participantId: string;
    expectedRoomRevision: number;
    expectedParticipantRevision: number;
  },
  token?: string,
) {
  return test.handlers.removeParticipant(
    apiRequest(`/api/rooms/${roomId}/remove`, { method: "POST", token, json: body }),
    { id: roomId },
  );
}

describe("Task 6 API contract fixes", () => {
  it("returns the full safe roster only to the participant-authenticated mate host", async () => {
    const test = context();
    const mate = await createMateRoom(test, { nickname: "ホスト" });
    const guest = await joinClassRoom(test, mate.body.room.id, "ゲスト");

    const hostResponse = await test.handlers.state(
      apiRequest(`/api/rooms/${mate.body.room.id}/state`, { token: mate.token }),
      { id: mate.body.room.id },
    );
    expect(hostResponse.status).toBe(200);
    const host = await hostResponse.json() as Record<string, unknown>;
    expect(host).toMatchObject({
      participant: { nickname: "ホスト" },
      participants: [
        {
          nickname: "ホスト",
          status: "ACTIVE",
          currentOrdinal: 0,
          correctCount: 0,
          resolvedQuestionCount: 0,
          revision: 0,
          elapsedCs: 0,
          timingSource: "client",
        },
        {
          nickname: "ゲスト",
          status: "ACTIVE",
          currentOrdinal: 0,
          correctCount: 0,
          resolvedQuestionCount: 0,
          revision: 0,
          elapsedCs: 0,
          timingSource: "client",
        },
      ],
    });
    expect(JSON.stringify(host)).not.toContain(mate.token);
    expect(JSON.stringify(host)).not.toContain(guest.token);
    expect(JSON.stringify(host)).not.toContain("token_hash");
    expect(JSON.stringify(host)).not.toContain("answer_snapshot");

    const guestResponse = await test.handlers.state(
      apiRequest(`/api/rooms/${mate.body.room.id}/state`, { token: guest.token }),
      { id: mate.body.room.id },
    );
    expect(guestResponse.status).toBe(200);
    const guestState = await guestResponse.json() as Record<string, unknown>;
    expect(guestState).toMatchObject({ participant: { nickname: "ゲスト" } });
    expect(guestState).not.toHaveProperty("participants");
  });

  it("keeps the class teacher roster response unchanged", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id, "生徒");
    const response = await test.handlers.state(
      apiRequest(`/api/rooms/${created.body.room.id}/state`),
      { id: created.body.room.id },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      participants: [{ id: joined.body.participant.id, nickname: "生徒" }],
    });
  });

  it("resolves the same minimal public join information by code or stable publicId", async () => {
    const test = context();
    const created = await createClassRoom(test);
    await joinClassRoom(test, created.body.room.id, "生徒");
    const stored = test.database.sqlite.prepare("SELECT join_code FROM rooms WHERE public_id = ?")
      .get(created.body.room.id) as { join_code: string };

    const byCode = await test.handlers.joinInfo(apiRequest(`/api/join-info?code=${stored.join_code}`));
    const byPublicId = await test.handlers.joinInfo(apiRequest(`/api/join-info?publicId=${created.body.room.id}`));
    expect(byCode.status).toBe(200);
    expect(byPublicId.status).toBe(200);
    const codeBody = await byCode.json() as Record<string, unknown>;
    const publicIdBody = await byPublicId.json() as Record<string, unknown>;
    expect(publicIdBody).toEqual(codeBody);
    expect(publicIdBody).toEqual({
      room: {
        id: created.body.room.id,
        kind: "class",
        state: "WAITING",
        settings: expect.any(Object),
      },
      participantCount: 1,
      capacity: 50,
    });
    expect(publicIdBody).not.toHaveProperty("participants");
    expect(publicIdBody).not.toHaveProperty("room.revision");
    expect(publicIdBody).not.toHaveProperty("room.joinCode");
    expect(JSON.stringify(publicIdBody)).not.toMatch(
      /ownerTeacherId|mateHostId|answer_snapshot|token_hash|"questions"|room-\d/u,
    );
  });

  it("lets class teachers and mate hosts remove waiting participants and revokes the removed bearer", async () => {
    const classTest = context();
    const classRoom = await createClassRoom(classTest);
    const student = await joinClassRoom(classTest, classRoom.body.room.id, "生徒");
    const classRemoval = await removeParticipant(classTest, classRoom.body.room.id, {
      requestId: crypto.randomUUID(),
      participantId: student.body.participant.id,
      expectedRoomRevision: 1,
      expectedParticipantRevision: 0,
    });
    expect(classRemoval.status).toBe(200);
    expect(await classRemoval.json()).toMatchObject({
      participant: { id: student.body.participant.id, status: "REMOVED", revision: 1 },
      roomRevision: 2,
    });
    expect((await classTest.handlers.state(
      apiRequest(`/api/rooms/${classRoom.body.room.id}/state`, { token: student.token }),
      { id: classRoom.body.room.id },
    )).status).toBe(403);

    const mateTest = context();
    const mate = await createMateRoom(mateTest);
    const guest = await joinClassRoom(mateTest, mate.body.room.id, "ゲスト");
    const mateRemoval = await removeParticipant(mateTest, mate.body.room.id, {
      requestId: crypto.randomUUID(),
      participantId: guest.body.participant.id,
      expectedRoomRevision: 1,
      expectedParticipantRevision: 0,
    }, mate.token);
    expect(mateRemoval.status).toBe(200);
    expect(await mateRemoval.json()).toMatchObject({
      participant: { id: guest.body.participant.id, status: "REMOVED", revision: 1 },
      roomRevision: 2,
    });
  });

  it("enforces removal ownership and never permits removing the mate host", async () => {
    const test = context();
    const mate = await createMateRoom(test);
    const guest = await joinClassRoom(test, mate.body.room.id, "ゲスト");
    const secondGuest = await joinClassRoom(test, mate.body.room.id, "ゲスト2");
    const body = {
      requestId: crypto.randomUUID(),
      participantId: secondGuest.body.participant.id,
      expectedRoomRevision: 2,
      expectedParticipantRevision: 0,
    };
    expect((await removeParticipant(test, mate.body.room.id, body, guest.token)).status).toBe(403);

    const hostRemoval = await removeParticipant(test, mate.body.room.id, {
      ...body,
      requestId: crypto.randomUUID(),
      participantId: mate.body.participant.id,
    }, mate.token);
    expect(hostRemoval.status).toBe(403);
    expect(test.database.sqlite.prepare("SELECT status FROM participants WHERE id = ?")
      .get(mate.body.participant.id)).toEqual({ status: "ACTIVE" });
  });

  it("rejects another teacher, another room's participant, stale revisions, started rooms, and expired rooms", async () => {
    const test = context();
    const first = await createClassRoom(test);
    const firstParticipant = await joinClassRoom(test, first.body.room.id, "生徒1");
    const second = await createClassRoom(test);
    const secondParticipant = await joinClassRoom(test, second.body.room.id, "生徒2");

    const otherTeacherHandlers = createApiHandlers({
      ...test.dependencies,
      teacherIdentity: { getVerifiedIdentity: async () => ({ id: "teacher-2", email: "teacher2@example.com" }) },
      serverConfig: { teacherAllowedEmails: ["teacher2@example.com"] },
    });
    const otherTeacher = await otherTeacherHandlers.removeParticipant(
      apiRequest(`/api/rooms/${first.body.room.id}/remove`, {
        method: "POST",
        json: {
          requestId: crypto.randomUUID(), participantId: firstParticipant.body.participant.id,
          expectedRoomRevision: 1, expectedParticipantRevision: 0,
        },
      }),
      { id: first.body.room.id },
    );
    expect(otherTeacher.status).toBe(403);

    expect((await removeParticipant(test, first.body.room.id, {
      requestId: crypto.randomUUID(), participantId: secondParticipant.body.participant.id,
      expectedRoomRevision: 1, expectedParticipantRevision: 0,
    })).status).toBe(404);
    expect((await removeParticipant(test, first.body.room.id, {
      requestId: crypto.randomUUID(), participantId: firstParticipant.body.participant.id,
      expectedRoomRevision: 0, expectedParticipantRevision: 0,
    })).status).toBe(409);
    expect((await removeParticipant(test, first.body.room.id, {
      requestId: crypto.randomUUID(), participantId: firstParticipant.body.participant.id,
      expectedRoomRevision: 1, expectedParticipantRevision: 1,
    })).status).toBe(409);

    await test.handlers.startRoom(apiRequest(`/api/rooms/${first.body.room.id}/start`, {
      method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 },
    }), { id: first.body.room.id });
    expect((await removeParticipant(test, first.body.room.id, {
      requestId: crypto.randomUUID(), participantId: firstParticipant.body.participant.id,
      expectedRoomRevision: 2, expectedParticipantRevision: 0,
    })).status).toBe(409);

    test.database.sqlite.prepare("UPDATE rooms SET expires_at_ms = ? WHERE public_id = ?")
      .run(test.dependencies.now(), second.body.room.id);
    expect((await removeParticipant(test, second.body.room.id, {
      requestId: crypto.randomUUID(), participantId: secondParticipant.body.participant.id,
      expectedRoomRevision: 1, expectedParticipantRevision: 0,
    })).status).toBe(410);
  });

  it("replays an exact removal and rejects requestId reuse with a changed body", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const first = await joinClassRoom(test, created.body.room.id, "生徒1");
    const second = await joinClassRoom(test, created.body.room.id, "生徒2");
    const body = {
      requestId: crypto.randomUUID(),
      participantId: first.body.participant.id,
      expectedRoomRevision: 2,
      expectedParticipantRevision: 0,
    };
    const initial = await removeParticipant(test, created.body.room.id, body);
    const replay = await removeParticipant(test, created.body.room.id, body);
    expect(initial.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await initial.json());
    expect(test.database.sqlite.prepare("SELECT revision FROM rooms WHERE public_id = ?")
      .get(created.body.room.id)).toEqual({ revision: 3 });

    const changed = await removeParticipant(test, created.body.room.id, {
      ...body,
      participantId: second.body.participant.id,
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "request_id_reused" } });
  });

  it("rejects the original join request after the participant is removed", async () => {
    const test = context();
    const created = await createClassRoom(test);
    const token = createParticipantToken();
    const joinBody = { requestId: crypto.randomUUID(), nickname: "削除対象" };
    const joinRequest = () => test.handlers.joinRoom(apiRequest(
      `/api/rooms/${created.body.room.id}/join`,
      { method: "POST", token, json: joinBody },
    ), { id: created.body.room.id });
    const joined = await joinRequest();
    const participant = await joined.json() as { participant: { id: string; revision: number } };
    expect(joined.status).toBe(201);
    expect((await removeParticipant(test, created.body.room.id, {
      requestId: crypto.randomUUID(),
      participantId: participant.participant.id,
      expectedRoomRevision: 1,
      expectedParticipantRevision: participant.participant.revision,
    })).status).toBe(200);

    const replay = await joinRequest();
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ error: { code: "not_authorized" } });
  });
});
