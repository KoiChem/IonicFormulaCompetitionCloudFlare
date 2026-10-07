import { afterEach, describe, expect, it } from "vitest";

import { PersistenceConflictError } from "../../src/persistence/db";
import { joinRoom } from "../../src/persistence/participants";
import { cancelRoom, createRoom, startRoom } from "../../src/persistence/rooms";
import { QUESTION, SqliteD1, classRoomInput, joinInput, mateRoomInput, scalar } from "./helpers";

const databases: SqliteD1[] = [];
function database() {
  const value = new SqliteD1();
  databases.push(value);
  return value;
}
afterEach(() => databases.splice(0).forEach((value) => value.close()));

describe("room persistence races", () => {
  it("cancels once under concurrent retries and rejects a later start", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    const input = { roomId: "room-1", requestId: "cancel-1", bodyHash: "cancel-body", expectedRoomRevision: 1, nowMs: 2_000 };
    const [first, second] = await Promise.all([cancelRoom(db, input), cancelRoom(db, input)]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "CANCELLED", roomRevision: 2 });
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE result_code = 'cancelled'")).toBe(1);
    await expect(startRoom(db, { roomId: "room-1", requestId: "start-after-cancel", bodyHash: "x", expectedRoomRevision: 2, nowMs: 3_000, startAtMs: 8_000, deadlineAtMs: 188_000, questions: [QUESTION] })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("does not cancel a room that another tab already started", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    await startRoom(db, { roomId: "room-1", requestId: "start-first", bodyHash: "start-first", expectedRoomRevision: 1, nowMs: 2_000, startAtMs: 7_000, deadlineAtMs: 187_000, questions: [QUESTION] });
    await expect(cancelRoom(db, { roomId: "room-1", requestId: "cancel-later", bodyHash: "cancel-later", expectedRoomRevision: 1, nowMs: 3_000 })).rejects.toMatchObject({ code: "stale_room_revision" });
    expect(await db.prepare("SELECT state FROM rooms WHERE id = ?").bind("room-1").first()).toEqual({ state: "COUNTDOWN" });
  });
  it("does not start an empty class room", async () => {
    const db = database();
    await createRoom(db, classRoomInput());

    await expect(startRoom(db, {
      roomId: "room-1", requestId: "empty-start", bodyHash: "empty-start", expectedRoomRevision: 0,
      nowMs: 2_000, startAtMs: 7_000, deadlineAtMs: 187_000, questions: [QUESTION],
    })).rejects.toMatchObject({ code: "invalid_state" });
    expect(await db.prepare("SELECT state, revision FROM rooms WHERE id = ?").bind("room-1").first())
      .toEqual({ state: "WAITING", revision: 0 });
  });

  it("requires a guest beside the host before starting a mate room", async () => {
    const db = database();
    await createRoom(db, mateRoomInput());
    const input = {
      roomId: "mate-room", requestId: "mate-start", bodyHash: "mate-start", expectedRoomRevision: 0,
      nowMs: 2_000, startAtMs: 7_000, deadlineAtMs: 187_000, questions: [QUESTION],
    };

    await expect(startRoom(db, input)).rejects.toMatchObject({ code: "invalid_state" });
    await joinRoom(db, joinInput(9, { roomId: "mate-room" }));
    await expect(startRoom(db, {
      ...input, requestId: "mate-start-with-guest", bodyHash: "mate-start-with-guest", expectedRoomRevision: 1,
    })).resolves.toMatchObject({ state: "COUNTDOWN", roomRevision: 2 });
  });

  it("admits at most 50 of 51 concurrent class joins", async () => {
    const db = database();
    await createRoom(db, classRoomInput());

    const attempts = await Promise.allSettled(Array.from({ length: 51 }, (_, index) => joinRoom(db, joinInput(index))));

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(50);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await scalar(db, "SELECT COUNT(*) FROM participants WHERE room_id = ? AND status = 'ACTIVE'", "room-1")).toBe(50);
  });

  it("counts the host in the four-person mate capacity", async () => {
    const db = database();
    await createRoom(db, mateRoomInput());

    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => joinRoom(db, joinInput(index, { roomId: "mate-room" }))));

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(3);
    expect(await scalar(db, "SELECT COUNT(*) FROM participants WHERE room_id = ? AND status = 'ACTIVE'", "mate-room")).toBe(4);
  });

  it("returns the same participant for a retried join request", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    const input = joinInput(1);

    const [first, retry] = await Promise.all([joinRoom(db, input), joinRoom(db, input)]);

    expect(retry).toEqual(first);
    expect(await scalar(db, "SELECT COUNT(*) FROM participants WHERE room_id = ?", "room-1")).toBe(1);
  });

  it("keys join idempotency by stable token when a regenerated participant ID retries", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    const first = await joinRoom(db, joinInput(1));

    const retry = await joinRoom(db, joinInput(1, { participantId: "replacement-id" }));

    expect(retry).toEqual(first);
    await expect(joinRoom(db, joinInput(1, { participantId: "replacement-id", bodyHash: "changed" })))
      .rejects.toMatchObject({ code: "request_id_reused" });
    expect(await scalar(db, "SELECT COUNT(*) FROM participants WHERE room_id = ?", "room-1")).toBe(1);
  });

  it("deduplicates room creation and rejects request ID reuse with another body", async () => {
    const db = database();
    const input = classRoomInput();
    const [first, retry] = await Promise.all([createRoom(db, input), createRoom(db, input)]);

    expect(retry).toEqual(first);
    expect(await createRoom(db, input)).toEqual(first);
    await expect(createRoom(db, classRoomInput({ roomId: "room-other", publicId: "public-other", joinCode: "OTHER1", bodyHash: "different" })))
      .rejects.toMatchObject({ code: "request_id_reused" });
    expect(await scalar(db, "SELECT COUNT(*) FROM rooms")).toBe(1);
  });

  it("makes concurrent start idempotent without changing questions or timestamps", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    const input = {
      roomId: "room-1", requestId: "start-1", bodyHash: "start-body", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 7_000, deadlineAtMs: 187_000, questions: [QUESTION],
    };

    const [first, second] = await Promise.all([startRoom(db, input), startRoom(db, input)]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ startAtMs: 7_000, deadlineAtMs: 187_000, questionIds: ["question-1"] });
    expect(await scalar(db, "SELECT COUNT(*) FROM room_questions WHERE room_id = ?", "room-1")).toBe(1);
  });

  it("rejects stale room revisions instead of replacing a started snapshot", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    await startRoom(db, {
      roomId: "room-1", requestId: "start-1", bodyHash: "a", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 7_000, deadlineAtMs: 187_000, questions: [QUESTION],
    });

    await expect(startRoom(db, {
      roomId: "room-1", requestId: "start-2", bodyHash: "b", expectedRoomRevision: 1,
      nowMs: 3_000, startAtMs: 9_000, deadlineAtMs: 189_000, questions: [{ ...QUESTION, id: "changed" }],
    })).rejects.toBeInstanceOf(PersistenceConflictError);
    expect(await scalar(db, "SELECT start_at_ms FROM rooms WHERE id = ?", "room-1")).toBe(7_000);
  });

  it("recovers a start result when the batch committed but its response was lost", async () => {
    const db = database();
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    db.throwAfterNextBatchCommit();

    const result = await startRoom(db, {
      roomId: "room-1", requestId: "start-lost", bodyHash: "start-lost", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 7_000, deadlineAtMs: 187_000, questions: [QUESTION],
    });

    expect(result).toMatchObject({ roomRevision: 2, startAtMs: 7_000 });
    expect(await scalar(db, "SELECT COUNT(*) FROM room_questions WHERE room_id = ?", "room-1")).toBe(1);
  });
});
