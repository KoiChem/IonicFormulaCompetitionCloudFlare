import { afterEach, describe, expect, it } from "vitest";

import { cleanupExpired } from "../../src/persistence/cleanup";
import { loadAuthorizedResult, finalizeRoom } from "../../src/persistence/results";
import { createRoom, startRoom } from "../../src/persistence/rooms";
import { joinRoom } from "../../src/persistence/participants";
import { QUESTION, SqliteD1, classRoomInput, joinInput, mateRoomInput, scalar } from "./helpers";
import { applyPlayerAction } from "../../src/persistence/actions";
import { PUBLIC_CONFIG } from "../../src/config/public";

const databases: SqliteD1[] = [];
afterEach(() => databases.splice(0).forEach((value) => value.close()));

describe("expiry and final results", () => {
  it("does not finalize an empty class room before its deadline", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, classRoomInput());
    await db.prepare(`
      UPDATE rooms SET state = 'COUNTDOWN', revision = 1, start_at_ms = ?, deadline_at_ms = ?
      WHERE id = ?
    `).bind(3_000, 183_000, "room-1").run();

    await expect(finalizeRoom(db, {
      roomId: "room-1", requestId: "empty-final", bodyHash: "empty-final", nowMs: 4_000,
    })).rejects.toMatchObject({ code: "stale_room_revision" });
    expect(await db.prepare("SELECT state, ended_at_ms FROM rooms WHERE id = ?").bind("room-1").first())
      .toEqual({ state: "COUNTDOWN", ended_at_ms: null });
    expect(await scalar(db, "SELECT COUNT(*) FROM final_results WHERE room_id = ?", "room-1")).toBe(0);
  });

  it("finalizes a timed-out room once and returns only an authorized result", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    await startRoom(db, {
      roomId: "room-1", requestId: "start", bodyHash: "start", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION],
    });

    const first = await finalizeRoom(db, { roomId: "room-1", requestId: "final", bodyHash: "final", nowMs: 183_000 });
    const retry = await finalizeRoom(db, { roomId: "room-1", requestId: "final", bodyHash: "final", nowMs: 190_000 });

    expect(retry).toEqual(first);
    await expect(loadAuthorizedResult(db, { roomId: "room-1", participantId: "p-0", tokenHash: "wrong", nowMs: 190_000 }))
      .rejects.toMatchObject({ code: "not_authorized" });
    expect(await loadAuthorizedResult(db, { roomId: "room-1", participantId: "p-0", tokenHash: "token-0", nowMs: 190_000 }))
      .toMatchObject({ participantId: "p-0", elapsedCs: 18_000, rank: 1, finishReason: "timeout" });
    expect(await scalar(db, "SELECT COUNT(*) FROM final_results WHERE room_id = ?", "room-1")).toBe(1);
  });

  it("extends waiting expiry on start and sets class retention from early completion", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, classRoomInput({ expiresAtMs: 5_000 }));
    await joinRoom(db, joinInput(0));
    await startRoom(db, {
      roomId: "room-1", requestId: "start", bodyHash: "start", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION],
    });
    expect(await scalar(db, "SELECT expires_at_ms FROM rooms WHERE id = ?", "room-1"))
      .toBe(183_000 + PUBLIC_CONFIG.retentionMs.classCompetition);
    db.setNow(4_000);
    await applyPlayerAction(db, {
      roomId: "room-1", participantId: "p-0", requestId: "answer", bodyHash: "answer",
      questionId: "question-1", expectedParticipantRevision: 0, clientElapsedMs: 1_000,
      serverNowMs: 4_000, action: { type: "answer", fieldId: "formula", value: "Na+" },
    });
    db.setNow(200_000);
    const finalized = await finalizeRoom(db, { roomId: "room-1", requestId: "final", bodyHash: "final", nowMs: 200_000 });

    expect(finalized.endedAtMs).toBe(4_000);
    expect(await scalar(db, "SELECT expires_at_ms FROM rooms WHERE id = ?", "room-1"))
      .toBe(4_000 + PUBLIC_CONFIG.retentionMs.classCompetition);
    const expiries = await db.prepare(`
      SELECT expires_at_ms FROM command_receipts WHERE room_id = ?
      UNION SELECT expires_at_ms FROM creation_receipts WHERE room_id = ?
    `).bind("room-1", "room-1").all<{ expires_at_ms: number }>();
    expect(expiries.results).toEqual([{ expires_at_ms: 4_000 + PUBLIC_CONFIG.retentionMs.classCompetition }]);
  });

  it("keeps successful action replay within retention and rejects it at expiry", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    await startRoom(db, {
      roomId: "room-1", requestId: "start", bodyHash: "start", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION],
    });
    const action = {
      roomId: "room-1", participantId: "p-0", requestId: "answer", bodyHash: "answer",
      questionId: "question-1", expectedParticipantRevision: 0, clientElapsedMs: 1_000,
      serverNowMs: 4_000, action: { type: "answer" as const, fieldId: "formula" as const, value: "Na+" },
    };
    db.setNow(4_000);
    const first = await applyPlayerAction(db, action);
    db.setNow(184_000);
    expect(await applyPlayerAction(db, { ...action, serverNowMs: 184_000 })).toEqual(first);
    const expiry = Number(await scalar(db, "SELECT expires_at_ms FROM rooms WHERE id = ?", "room-1"));
    db.setNow(expiry);
    await expect(applyPlayerAction(db, { ...action, serverNowMs: expiry }))
      .rejects.toMatchObject({ code: "expired" });
  });

  it("does not replay an expired creation receipt", async () => {
    const db = new SqliteD1(); databases.push(db);
    const input = classRoomInput({ expiresAtMs: 5_000 });
    await createRoom(db, input);
    db.setNow(5_000);

    await expect(createRoom(db, input)).rejects.toMatchObject({ code: "expired" });
  });

  it("uses deadline plus 24 hours for a timed-out mate room", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, mateRoomInput({ expiresAtMs: 5_000 }));
    await joinRoom(db, joinInput(1, { roomId: "mate-room" }));
    await startRoom(db, {
      roomId: "mate-room", requestId: "start", bodyHash: "start", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION],
    });
    db.setNow(183_000);

    const result = await finalizeRoom(db, { roomId: "mate-room", requestId: "final", bodyHash: "final", nowMs: 183_000 });

    expect(result.endedAtMs).toBe(183_000);
    expect(await scalar(db, "SELECT expires_at_ms FROM rooms WHERE id = ?", "mate-room"))
      .toBe(183_000 + PUBLIC_CONFIG.retentionMs.mateMatch);

    const expiry = 183_000 + PUBLIC_CONFIG.retentionMs.mateMatch;
    db.setNow(expiry - 1);
    expect(await loadAuthorizedResult(db, {
      roomId: "mate-room", participantId: "host", tokenHash: "host-token", nowMs: expiry - 1,
    })).toMatchObject({ participantId: "host", finishReason: "timeout" });
    db.setNow(expiry);
    await expect(loadAuthorizedResult(db, {
      roomId: "mate-room", participantId: "host", tokenHash: "host-token", nowMs: expiry,
    })).rejects.toMatchObject({ code: "expired" });
    expect(await cleanupExpired(db, { nowMs: expiry, limit: 100 })).toMatchObject({ deletedRooms: 1 });
    expect(await scalar(db, "SELECT COUNT(*) FROM rooms WHERE id = ?", "mate-room")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM participants WHERE room_id = ?", "mate-room")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM final_results WHERE room_id = ?", "mate-room")).toBe(0);
  });

  it("recovers finalization when its batch committed but the response was lost", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, classRoomInput());
    await joinRoom(db, joinInput(0));
    await startRoom(db, {
      roomId: "room-1", requestId: "start", bodyHash: "start", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION],
    });
    db.setNow(183_000);
    db.throwAfterNextBatchCommit();

    const result = await finalizeRoom(db, { roomId: "room-1", requestId: "final-lost", bodyHash: "final-lost", nowMs: 183_000 });

    expect(result).toMatchObject({ state: "FINISHED", endedAtMs: 183_000 });
    expect(await scalar(db, "SELECT COUNT(*) FROM final_results WHERE room_id = ?", "room-1")).toBe(1);
  });

  it("removes an expired room and all dependent receipts and snapshots", async () => {
    const db = new SqliteD1(); databases.push(db);
    await createRoom(db, classRoomInput({ expiresAtMs: 5_000 }));
    await joinRoom(db, joinInput(0));
    await startRoom(db, {
      roomId: "room-1", requestId: "start", bodyHash: "start", expectedRoomRevision: 1,
      nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 4_000, questions: [QUESTION],
    });

    const expiry = Number(await scalar(db, "SELECT expires_at_ms FROM rooms WHERE id = ?", "room-1"));
    expect(await cleanupExpired(db, { nowMs: expiry, limit: 100 })).toEqual({
      deletedRooms: 1,
      deletedSiteSettingReceipts: 0,
    });
    expect(await scalar(db, "SELECT COUNT(*) FROM rooms")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM participants")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM room_questions")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM creation_receipts")).toBe(0);
  });
});
