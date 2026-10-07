import { afterEach, describe, expect, it } from "vitest";

import { applyPlayerAction } from "../../src/persistence/actions";
import { finalizeRoom } from "../../src/persistence/results";
import { createRoom, startRoom } from "../../src/persistence/rooms";
import { joinRoom } from "../../src/persistence/participants";
import { QUESTION, SqliteD1, classRoomInput, joinInput, scalar } from "./helpers";

const databases: SqliteD1[] = [];
afterEach(() => databases.splice(0).forEach((value) => value.close()));

async function runningRoom(participantCount = 1) {
  const db = new SqliteD1();
  databases.push(db);
  await createRoom(db, classRoomInput());
  for (let index = 0; index < participantCount; index += 1) await joinRoom(db, joinInput(index));
  await startRoom(db, {
    roomId: "room-1", requestId: "start", bodyHash: "start-body", expectedRoomRevision: participantCount,
    nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION],
  });
  db.setNow(4_000);
  return db;
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-1", participantId: "p-0", requestId: "action-1", bodyHash: "action-body",
    questionId: "question-1", expectedParticipantRevision: 0, clientElapsedMs: 1_000,
    serverNowMs: 4_000, action: { type: "answer" as const, fieldId: "formula" as const, value: "Na+" },
    ...overrides,
  };
}

describe("player action races", () => {
  it("subtracts the previous accepted action's wait only once from a completed record", async () => {
    const db = await runningRoom();
    await applyPlayerAction(db, answer({ requestId: "wrong", bodyHash: "wrong", action: { type: "answer", fieldId: "formula", value: "K+" } }));
    db.setNow(6_000);
    const second = answer({ requestId: "correct", bodyHash: "correct", expectedParticipantRevision: 1, serverNowMs: 6_000, clientElapsedMs: 3_000, waitCredit: { sourceRequestId: "wrong", waitMs: 500 } });
    const result = await applyPlayerAction(db, second);
    expect(result).toMatchObject({ rawElapsedMs: 3_000, waitCreditMs: 500, elapsedCs: 250 });
    expect(await applyPlayerAction(db, second)).toEqual(result);
    expect(await scalar(db, "SELECT wait_credit_ms FROM participants WHERE id = ?", "p-0")).toBe(500);
    await finalizeRoom(db, { roomId: "room-1", requestId: "final-with-credit", bodyHash: "final-with-credit", nowMs: 6_000 });
    expect(await scalar(db, "SELECT elapsed_cs FROM final_results WHERE participant_id = ?", "p-0")).toBe(250);
  });
  it("ignores credit for an unrelated request and keeps the raw clock authoritative", async () => {
    const db = await runningRoom();
    await applyPlayerAction(db, answer({ requestId: "wrong", bodyHash: "wrong", action: { type: "answer", fieldId: "formula", value: "K+" } }));
    db.setNow(6_000);
    const result = await applyPlayerAction(db, answer({ requestId: "correct", bodyHash: "correct", expectedParticipantRevision: 1, serverNowMs: 6_000, clientElapsedMs: 3_000, waitCredit: { sourceRequestId: "not-my-previous-action", waitMs: 1_000 } }));
    expect(result).toMatchObject({ rawElapsedMs: 3_000, waitCreditMs: 0, elapsedCs: 300 });
  });
  it("preserves validated credit when the client clock falls back to server time", async () => {
    const db = await runningRoom();
    await applyPlayerAction(db, answer({ requestId: "wrong", bodyHash: "wrong", action: { type: "answer", fieldId: "formula", value: "K+" } }));
    db.setNow(6_000);
    const result = await applyPlayerAction(db, answer({ requestId: "correct", bodyHash: "correct", expectedParticipantRevision: 1, serverNowMs: 6_000, clientElapsedMs: 0, waitCredit: { sourceRequestId: "wrong", waitMs: 500 } }));
    expect(result).toMatchObject({ timingSource: "server_fallback", rawElapsedMs: 3_000, waitCreditMs: 500, elapsedCs: 250 });
  });
  it("credits the outgoing part of a fast response when the previous click time was verified", async () => {
    const db = await runningRoom();
    db.setNow(4_100);
    await applyPlayerAction(db, answer({ requestId: "quick-wrong", bodyHash: "quick-wrong", serverNowMs: 4_100, clientElapsedMs: 1_000, action: { type: "answer", fieldId: "formula", value: "K+" } }));
    db.setNow(4_120);
    const result = await applyPlayerAction(db, answer({ requestId: "quick-correct", bodyHash: "quick-correct", expectedParticipantRevision: 1, serverNowMs: 4_120, clientElapsedMs: 1_110, waitCredit: { sourceRequestId: "quick-wrong", waitMs: 110 } }));
    expect(result).toMatchObject({ rawElapsedMs: 1_110, waitCreditMs: 110, elapsedCs: 100 });
  });
  it("returns the stored response for same-body retries and scores once", async () => {
    const db = await runningRoom();
    const input = answer();

    const [first, retry] = await Promise.all([applyPlayerAction(db, input), applyPlayerAction(db, input)]);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({ code: "accepted", correctCount: 1, participantRevision: 1 });
    expect(await scalar(db, "SELECT correct_count FROM participants WHERE id = ?", "p-0")).toBe(1);
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id = ?", "action-1")).toBe(1);
  });

  it("rejects request ID reuse with a different action body", async () => {
    const db = await runningRoom();
    await applyPlayerAction(db, answer());

    await expect(applyPlayerAction(db, answer({ bodyHash: "different", action: { type: "pass", fieldId: "formula" } })))
      .rejects.toMatchObject({ code: "request_id_reused" });
  });

  it("allows only one of two concurrent correct answers for the same field", async () => {
    const db = await runningRoom();
    const attempts = await Promise.allSettled([
      applyPlayerAction(db, answer({ requestId: "a", bodyHash: "a" })),
      applyPlayerAction(db, answer({ requestId: "b", bodyHash: "b" })),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(await scalar(db, "SELECT correct_count FROM participants WHERE id = ?", "p-0")).toBe(1);
    expect(await scalar(db, "SELECT attempt_count FROM participant_fields WHERE participant_id = ? AND field_id = 'formula'", "p-0")).toBe(1);
  });

  it("orders answer versus pass without applying the loser to another question", async () => {
    const db = await runningRoom();
    const attempts = await Promise.allSettled([
      applyPlayerAction(db, answer({ requestId: "answer", bodyHash: "answer" })),
      applyPlayerAction(db, answer({ requestId: "pass", bodyHash: "pass", action: { type: "pass", fieldId: "formula" } })),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id IN ('answer', 'pass')")).toBe(1);
    expect(await scalar(db, "SELECT current_ordinal FROM participants WHERE id = ?", "p-0")).toBe(1);
  });

  it("rejects stale participant revisions from another tab", async () => {
    const db = await runningRoom();
    await applyPlayerAction(db, answer());

    await expect(applyPlayerAction(db, answer({ requestId: "stale", bodyHash: "stale" })))
      .rejects.toMatchObject({ code: "stale_participant_revision" });
    expect(await scalar(db, "SELECT correct_count FROM participants WHERE id = ?", "p-0")).toBe(1);
  });

  it("rejects an action at the exact deadline without partial writes", async () => {
    const db = await runningRoom();

    await expect(applyPlayerAction(db, answer({ serverNowMs: 183_000, clientElapsedMs: 180_000 })))
      .rejects.toMatchObject({ code: "deadline" });
    expect(await scalar(db, "SELECT correct_count FROM participants WHERE id = ?", "p-0")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM participant_fields WHERE participant_id = ?", "p-0")).toBe(1);
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id = ?", "action-1")).toBe(0);
  });

  it("accepts one millisecond before the deadline", async () => {
    const db = await runningRoom();
    db.setNow(182_999);

    const result = await applyPlayerAction(db, answer({ serverNowMs: 182_999, clientElapsedMs: 179_999 }));

    expect(result).toMatchObject({ correctCount: 1, elapsedCs: 17_999 });
  });

  it("rejects when processing crosses the deadline before the participant CAS", async () => {
    const db = await runningRoom();
    db.setNow(182_999);
    const barrier = db.pauseNextBatch();
    const pending = applyPlayerAction(db, answer({ serverNowMs: 182_999, clientElapsedMs: 179_999 }));
    await barrier.reached;
    db.setNow(183_000);
    barrier.release();

    await expect(pending).rejects.toMatchObject({ code: "deadline" });
    expect(await scalar(db, "SELECT revision FROM participants WHERE id = ?", "p-0")).toBe(0);
  });

  it("rolls back participant, field, and receipt writes when the batch fails", async () => {
    const db = await runningRoom();
    db.sqlite.exec(`
      CREATE TRIGGER reject_test_receipt BEFORE INSERT ON command_receipts
      WHEN NEW.request_id = 'rollback'
      BEGIN SELECT RAISE(ABORT, 'receipt fault'); END;
    `);

    await expect(applyPlayerAction(db, answer({ requestId: "rollback", bodyHash: "rollback" })))
      .rejects.toThrow("receipt fault");
    expect(await db.prepare("SELECT revision, correct_count FROM participants WHERE id = ?").bind("p-0").first())
      .toMatchObject({ revision: 0, correct_count: 0 });
    expect(await db.prepare("SELECT state, attempt_count FROM participant_fields WHERE participant_id = ?").bind("p-0").first())
      .toMatchObject({ state: "pending", attempt_count: 0 });
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id = 'rollback'")).toBe(0);
  });

  it("orders finalization and the last answer atomically", async () => {
    const db = await runningRoom();
    const results = await Promise.allSettled([
      applyPlayerAction(db, answer()),
      finalizeRoom(db, { roomId: "room-1", requestId: "final", bodyHash: "final", nowMs: 4_000 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const state = await db.prepare("SELECT state FROM rooms WHERE id = ?").bind("room-1").first<{ state: string }>();
    expect(["COUNTDOWN", "FINISHED"]).toContain(state?.state);
    expect(await scalar(db, "SELECT COUNT(*) FROM final_results WHERE room_id = ?", "room-1")).toBe(state?.state === "FINISHED" ? 1 : 0);
  });

  it("freezes results from participant rows current at the room CAS", async () => {
    const db = await runningRoom(2);
    await applyPlayerAction(db, answer({ participantId: "p-1", requestId: "p1", bodyHash: "p1", serverNowMs: 4_000 }));
    db.setNow(183_000);
    const barrier = db.pauseNextBatch();
    const finalizing = finalizeRoom(db, { roomId: "room-1", requestId: "final-race", bodyHash: "final-race", nowMs: 183_000 });
    await barrier.reached;
    db.setNow(182_999);
    await applyPlayerAction(db, answer({ serverNowMs: 182_999, clientElapsedMs: 179_999 }));
    db.setNow(183_000);
    barrier.release();
    await finalizing;

    const results = await db.prepare(`
      SELECT participant_id, correct_count, elapsed_cs, rank, finish_reason
      FROM final_results WHERE room_id = ? ORDER BY rank
    `).bind("room-1").all<Record<string, unknown>>();
    expect(results.results).toEqual([
      { participant_id: "p-1", correct_count: 1, elapsed_cs: 100, rank: 1, finish_reason: "completed" },
      { participant_id: "p-0", correct_count: 1, elapsed_cs: 17_999, rank: 2, finish_reason: "completed" },
    ]);
    expect(await scalar(db, "SELECT ended_at_ms FROM rooms WHERE id = ?", "room-1")).toBe(182_999);
  });

  it("lets different participants update without changing room revision", async () => {
    const db = await runningRoom(2);
    const roomRevision = await scalar(db, "SELECT revision FROM rooms WHERE id = ?", "room-1");

    const results = await Promise.all([
      applyPlayerAction(db, answer()),
      applyPlayerAction(db, answer({ participantId: "p-1", requestId: "p1-action", bodyHash: "p1-action" })),
    ]);

    expect(results.map((result) => result.correctCount)).toEqual([1, 1]);
    expect(await scalar(db, "SELECT revision FROM rooms WHERE id = ?", "room-1")).toBe(roomRevision);
  });

  it("retries transient database conflicts at most three times with the original action", async () => {
    const db = await runningRoom();
    db.failNextBatches(2);

    const result = await applyPlayerAction(db, answer({ clientElapsedMs: 1_000 }));

    expect(result).toMatchObject({ correctCount: 1, elapsedCs: 100 });
    expect(await scalar(db, "SELECT correct_count FROM participants WHERE id = ?", "p-0")).toBe(1);
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id = 'action-1'")).toBe(1);
  });

  it("rechecks the authoritative deadline before a database-conflict retry", async () => {
    const db = await runningRoom();
    db.failNextBatches(1);

    await expect(applyPlayerAction(db, answer({
      serverNowMs: 182_999,
      clientElapsedMs: 179_999,
      retryServerNowMs: () => 183_000,
    }))).rejects.toMatchObject({ code: "deadline" });
    expect(await scalar(db, "SELECT revision FROM participants WHERE id = ?", "p-0")).toBe(0);
    expect(await scalar(db, "SELECT COUNT(*) FROM command_receipts WHERE request_id = 'action-1'")).toBe(0);
  });
});

describe("last accepted answer record", () => {
  it("stores an accepted answer atomically and keeps it on exact replay", async () => {
    const db = await runningRoom();
    const input = answer();
    await applyPlayerAction(db, input);
    await applyPlayerAction(db, input);
    expect(db.sqlite.prepare("SELECT last_answer_json, last_answer_correct FROM participant_fields WHERE participant_id = ? AND field_id = ?").get("p-0", "formula"))
      .toEqual({ last_answer_json: '"Na+"', last_answer_correct: 1 });
  });
  it("keeps the last wrong answer after pass", async () => {
    const db = await runningRoom();
    await applyPlayerAction(db, answer({ action: { type: "answer", fieldId: "formula", value: "K+" } }));
    await applyPlayerAction(db, answer({ requestId: "pass-after-wrong", bodyHash: "pass-after-wrong", expectedParticipantRevision: 1, action: { type: "pass", fieldId: "formula" } }));
    expect(db.sqlite.prepare("SELECT last_answer_json, last_answer_correct, state FROM participant_fields WHERE participant_id = ? AND field_id = ?").get("p-0", "formula"))
      .toEqual({ last_answer_json: '"K+"', last_answer_correct: 0, state: "passed" });
  });
});
