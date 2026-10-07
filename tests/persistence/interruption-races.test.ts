import { afterEach, expect, it } from "vitest";
import { applyPlayerAction } from "../../src/persistence/actions";
import { interruptRoom } from "../../src/persistence/results";
import { createRoom, startRoom } from "../../src/persistence/rooms";
import { joinRoom } from "../../src/persistence/participants";
import { QUESTION, SqliteD1, classRoomInput, joinInput, scalar } from "./helpers";

const databases: SqliteD1[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

async function activeRoom() {
  const database = new SqliteD1(); databases.push(database);
  await createRoom(database, classRoomInput());
  await joinRoom(database, joinInput(0));
  await joinRoom(database, joinInput(1));
  await startRoom(database, { roomId: "room-1", requestId: "start", bodyHash: "start", expectedRoomRevision: 2,
    nowMs: 2_000, startAtMs: 3_000, deadlineAtMs: 183_000, questions: [QUESTION] });
  database.setNow(4_000);
  return database;
}

const answer = { roomId: "room-1", participantId: "p-0", requestId: "answer", bodyHash: "answer",
  questionId: "question-1", expectedParticipantRevision: 0, clientElapsedMs: 1_000, serverNowMs: 4_000,
  action: { type: "answer" as const, fieldId: "formula" as const, value: "Na+" } };
const interrupt = { roomId: "room-1", requestId: "interrupt", bodyHash: "interrupt", expectedRoomRevision: 3, nowMs: 4_000 };

it("rejects answers submitted after interruption without changing the frozen result", async () => {
  const database = await activeRoom();
  await interruptRoom(database, interrupt);
  await expect(applyPlayerAction(database, answer)).rejects.toBeDefined();
  expect(await scalar(database, "SELECT correct_count FROM final_results WHERE participant_id = ?", "p-0")).toBe(0);
  expect(await scalar(database, "SELECT elapsed_cs FROM final_results WHERE participant_id = ?", "p-0")).toBe(100);
});

it("keeps an answer that commits before interruption", async () => {
  const database = await activeRoom();
  const pause = database.pauseNextBatch();
  const answering = applyPlayerAction(database, answer);
  await pause.reached;
  const interruption = interruptRoom(database, interrupt);
  pause.release();
  await answering;
  await interruption;
  expect(await scalar(database, "SELECT correct_count FROM final_results WHERE participant_id = ?", "p-0")).toBe(1);
  expect(await scalar(database, "SELECT finish_reason FROM final_results WHERE participant_id = ?", "p-0")).toBe("completed");
});

it("uses the database clock when the interruption is committed", async () => {
  const database = await activeRoom();
  const pause = database.pauseNextBatch();
  const pending = interruptRoom(database, interrupt);
  await pause.reached;
  database.setNow(5_000);
  pause.release();
  expect(await pending).toMatchObject({ endedAtMs: 5_000 });
  expect(await scalar(database, "SELECT elapsed_cs FROM final_results WHERE participant_id = ?", "p-0")).toBe(200);
});

it("refuses a delayed interruption after the database deadline", async () => {
  const database = await activeRoom();
  const pause = database.pauseNextBatch();
  const pending = interruptRoom(database, interrupt);
  await pause.reached;
  database.setNow(183_000);
  pause.release();
  await expect(pending).rejects.toMatchObject({ code: "invalid_state" });
  expect(await scalar(database, "SELECT COUNT(*) FROM final_results")).toBe(0);
});
