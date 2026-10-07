import { afterEach, describe, expect, it } from "vitest";

import { removeParticipant } from "../../src/persistence/participants";
import { createRoom } from "../../src/persistence/rooms";
import { joinRoom } from "../../src/persistence/participants";
import { classRoomInput, joinInput, scalar, SqliteD1 } from "./helpers";

const databases: SqliteD1[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function database() {
  const value = new SqliteD1();
  value.setNow(2_000);
  databases.push(value);
  return value;
}

describe("participant removal persistence", () => {
  it("atomically increments room and participant revisions and persists a replay receipt", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(1));
    const input = {
      roomId: "room-1",
      actorId: "teacher:teacher-1",
      targetParticipantId: "p-1",
      requestId: "remove-1",
      bodyHash: "remove-body",
      expectedRoomRevision: 1,
      expectedParticipantRevision: 0,
      nowMs: 2_000,
    };

    const first = await removeParticipant(db, input);
    const replay = await removeParticipant(db, input);
    expect(replay).toEqual(first);
    expect(first).toEqual({
      participantId: "p-1",
      participantStatus: "REMOVED",
      participantRevision: 1,
      roomRevision: 2,
    });
    expect(await scalar(db, "SELECT revision FROM rooms WHERE id = ?", "room-1")).toBe(2);
    expect(db.sqlite.prepare("SELECT status, revision FROM participants WHERE room_id = ? AND id = ?")
      .get("room-1", "p-1")).toEqual({ status: "REMOVED", revision: 1 });
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE room_id = ?", "room-1")).toBe(2);
  });

  it("allows only one of two removals using the same room revision", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(1));
    await joinRoom(db, joinInput(2));
    const command = (participantId: string, requestId: string) => removeParticipant(db, {
      roomId: "room-1",
      actorId: "teacher:teacher-1",
      targetParticipantId: participantId,
      requestId,
      bodyHash: requestId,
      expectedRoomRevision: 2,
      expectedParticipantRevision: 0,
      nowMs: 2_000,
    });

    const settled = await Promise.allSettled([
      command("p-1", "remove-1"),
      command("p-2", "remove-2"),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await scalar(db, "SELECT COUNT(*) FROM participants WHERE status = 'REMOVED'")).toBe(1);
    expect(await scalar(db, "SELECT revision FROM rooms WHERE id = ?", "room-1")).toBe(3);
  });

  it("loses safely to a concurrent start without partially removing the participant", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(1));
    const paused = db.pauseNextBatch();
    const removing = removeParticipant(db, {
      roomId: "room-1",
      actorId: "teacher:teacher-1",
      targetParticipantId: "p-1",
      requestId: "remove-1",
      bodyHash: "remove-body",
      expectedRoomRevision: 1,
      expectedParticipantRevision: 0,
      nowMs: 2_000,
    });
    await paused.reached;
    db.sqlite.prepare("UPDATE rooms SET state = 'COUNTDOWN', revision = revision + 1 WHERE id = ?")
      .run("room-1");
    paused.release();

    await expect(removing).rejects.toMatchObject({ code: "invalid_state" });
    expect(db.sqlite.prepare("SELECT status, revision FROM participants WHERE room_id = ? AND id = ?")
      .get("room-1", "p-1")).toEqual({ status: "ACTIVE", revision: 0 });
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id = ?", "remove-1")).toBe(0);
  });

  it("rejects an exact join replay after that participant was removed", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    const joined = joinInput(1);
    await joinRoom(db, joined);
    await removeParticipant(db, {
      roomId: "room-1",
      actorId: "teacher:teacher-1",
      targetParticipantId: "p-1",
      requestId: "remove-1",
      bodyHash: "remove-body",
      expectedRoomRevision: 1,
      expectedParticipantRevision: 0,
      nowMs: 2_000,
    });

    await expect(joinRoom(db, joined)).rejects.toMatchObject({
      code: "not_authorized",
      status: 403,
    });
  });
});
