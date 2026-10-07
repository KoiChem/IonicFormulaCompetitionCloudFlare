import { PUBLIC_CONFIG } from "../config/public";
import type { InternalQuestion } from "../games/ionic-formula/shared/types";
import { replayV2Operations, type V2GradingMode, type V2Operation } from "../competition-core/v2-operations";
import { PersistenceConflictError, changed, commandMarker, json, type PersistenceDatabase } from "./db";

type Room = { phase_state: string; revision: number; kind: "class" | "mate"; start_at_ms: number | null;
  deadline_at_ms: number | null; expires_at_ms: number; end_reason: string;
  grading_mode: V2GradingMode; cutoff_at_ms: number | null; collection_until_ms: number | null; finalized_at_ms: number | null };
type Participant = { id: string; joined_order: number; status: string; finished_elapsed_ms: number | null;
  finish_reason: string | null; boundary_ack_at_ms: number | null };

async function loadRoom(db: PersistenceDatabase, roomId: string) {
  return db.prepare(`SELECT r.state, r.revision, r.kind, r.start_at_ms, r.deadline_at_ms, r.expires_at_ms,
    r.end_reason, m.state AS phase_state, m.grading_mode, m.cutoff_at_ms, m.collection_until_ms, m.finalized_at_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id WHERE r.id = ?`)
    .bind(roomId).first<Room>();
}

export async function collectV2Room(db: PersistenceDatabase, input: { roomId: string; nowMs: number; interrupted?: boolean }) {
  const room = await loadRoom(db, input.roomId);
  if (!room) throw new PersistenceConflictError("not_found", "v2 room not found", 404);
  if (room.phase_state === "FINISHED") return { state: "FINISHED" as const, cutoffAtMs: room.cutoff_at_ms ?? room.deadline_at_ms!, collectionUntilMs: room.collection_until_ms ?? (room.deadline_at_ms! + 10_000) };
  if (room.phase_state === "COLLECTING") return { state: "COLLECTING" as const, cutoffAtMs: room.cutoff_at_ms!, collectionUntilMs: room.collection_until_ms! };
  if (room.phase_state !== "COUNTDOWN" || room.start_at_ms == null || room.deadline_at_ms == null) {
    throw new PersistenceConflictError("invalid_state", "room has not started");
  }
  if (!input.interrupted && input.nowMs < room.deadline_at_ms) throw new PersistenceConflictError("invalid_state", "deadline has not arrived");
  const cutoffAtMs = input.interrupted ? Math.min(input.nowMs, room.deadline_at_ms) : room.deadline_at_ms;
  const marker = commandMarker("v2-collect", `${input.roomId}:${cutoffAtMs}`);
  const statements = [db.prepare(`UPDATE rooms SET state = 'RUNNING', revision = revision + 1,
    end_reason = ?, ended_at_ms = ?, last_command_id = ?
    WHERE id = ? AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state = 'COUNTDOWN')`)
    .bind(input.interrupted ? "interrupted" : "normal", cutoffAtMs, marker, input.roomId, room.revision)];
  statements.push(db.prepare(`UPDATE v2_room_manifests SET state = 'COLLECTING', collecting_at_ms = ?, cutoff_at_ms = ?, collection_until_ms = ?
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
    .bind(input.nowMs, cutoffAtMs, cutoffAtMs + 10_000, input.roomId, input.roomId, marker));
  const results = await db.batch(statements);
  if (!changed(results[0])) return collectV2Room(db, input);
  return { state: "COLLECTING" as const, cutoffAtMs, collectionUntilMs: cutoffAtMs + 10_000 };
}

export type V2FinalizedRoom = { roomId: string; state: "FINISHED"; cutoffAtMs: number; finalizedAtMs: number; participantCount: number };

export async function maybeFinalizeV2Room(db: PersistenceDatabase, input: { roomId: string; nowMs: number }): Promise<V2FinalizedRoom | null> {
  let room = await loadRoom(db, input.roomId);
  if (!room) throw new PersistenceConflictError("not_found", "v2 room not found", 404);
  if (room.phase_state === "FINISHED") return { roomId: input.roomId, state: "FINISHED",
    cutoffAtMs: room.cutoff_at_ms ?? room.deadline_at_ms ?? 0, finalizedAtMs: room.finalized_at_ms ?? input.nowMs,
    participantCount: Number((await db.prepare("SELECT COUNT(*) AS count FROM final_results WHERE room_id = ?")
      .bind(input.roomId).first<{ count: number }>())?.count ?? 0) };
  if (room.start_at_ms == null || room.deadline_at_ms == null) return null;
  if (input.nowMs >= room.deadline_at_ms && room.phase_state !== "COLLECTING") {
    await collectV2Room(db, { roomId: input.roomId, nowMs: input.nowMs });
    room = (await loadRoom(db, input.roomId))!;
  }
  const participants = (await db.prepare(`SELECT p.id, p.joined_order, p.status, v.finished_elapsed_ms, v.finish_reason, v.boundary_ack_at_ms
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE p.room_id = ? AND p.status != 'REMOVED' ORDER BY p.joined_order`)
    .bind(input.roomId).all<Participant>()).results;
  const allFinished = participants.length > 0 && participants.every((p) => p.finished_elapsed_ms != null);
  const boundaryReady = participants.every((p) => p.finished_elapsed_ms != null || p.boundary_ack_at_ms != null);
  const cutoff = room.cutoff_at_ms ?? room.deadline_at_ms!;
  const until = room.collection_until_ms ?? room.deadline_at_ms! + 10_000;
  if (room.phase_state === "COLLECTING") {
    if (!boundaryReady && input.nowMs < until) return null;
  } else if (!allFinished) return null;
  const questions = (await db.prepare("SELECT answer_snapshot_json FROM room_questions WHERE room_id = ? ORDER BY ordinal")
    .bind(input.roomId).all<{ answer_snapshot_json: string }>()).results.map((row) => JSON.parse(row.answer_snapshot_json) as InternalQuestion);
  const operationRows = (await db.prepare(`SELECT participant_id, payload_json FROM v2_operations WHERE room_id = ? ORDER BY participant_id, seq`)
    .bind(input.roomId).all<{ participant_id: string; payload_json: string }>()).results;
  const operations = new Map<string, V2Operation[]>();
  for (const row of operationRows) {
    const current = operations.get(row.participant_id) ?? [];
    current.push(JSON.parse(row.payload_json) as V2Operation);
    operations.set(row.participant_id, current);
  }
  const scored = participants.map((participant) => {
    const replay = replayV2Operations(questions, room.grading_mode, operations.get(participant.id) ?? [],
      room.start_at_ms!, cutoff, room.end_reason === "interrupted");
    const elapsedMs = replay.finishedElapsedMs ?? cutoff - room.start_at_ms!;
    return { participantId: participant.id, joinedOrder: participant.joined_order,
      correctCount: replay.correctCount, elapsedCs: Math.floor(elapsedMs / 10),
      finishReason: replay.finishReason === "submitted" ? "submitted" : replay.finishReason ? "completed" : room.end_reason === "interrupted" ? "interrupted" : "timeout",
      finalSyncUnconfirmed: !replay.finishReason && !replay.boundaryAcknowledged,
      fields: replay.fields };
  });
  scored.sort((a, b) => b.correctCount - a.correctCount || a.elapsedCs - b.elapsedCs || a.joinedOrder - b.joinedOrder);
  const ranked: Array<(typeof scored)[number] & { rank: number }> = [];
  scored.forEach((row, index) => {
    const previous = ranked.at(-1);
    ranked.push({ ...row, rank: previous && previous.correctCount === row.correctCount && previous.elapsedCs === row.elapsedCs
      ? previous.rank : index + 1 });
  });
  const fieldRows = ranked.flatMap((row) => questions.flatMap((question) => question.fields.map((field) => {
    const scoredField = row.fields[`${question.id}:${field.id}`];
    return { participantId: row.participantId, questionId: question.id, fieldId: field.id,
      state: scoredField?.state ?? "unanswered", answerJson: scoredField?.value == null ? null : json(scoredField.value) };
  })));
  const marker = commandMarker("v2-finalize", input.roomId);
  const retention = room.kind === "class" ? PUBLIC_CONFIG.retentionMs.classCompetition : PUBLIC_CONFIG.retentionMs.mateMatch;
  const statements = [db.prepare(`UPDATE rooms SET state = 'FINISHED', revision = revision + 1,
    ended_at_ms = ?, expires_at_ms = ? + ?, last_command_id = ?
    WHERE id = ? AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state IN ('COUNTDOWN', 'COLLECTING'))`)
    .bind(cutoff, input.nowMs, retention, marker, input.roomId, room.revision)];
  statements.push(db.prepare(`UPDATE v2_room_manifests SET state = 'FINISHED', finalized_at_ms = ? WHERE room_id = ?
    AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
    .bind(input.nowMs, input.roomId, input.roomId, marker));
  statements.push(db.prepare(`INSERT INTO final_results(room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason)
    SELECT ?, json_extract(value,'$.participantId'), json_extract(value,'$.correctCount'),
      json_extract(value,'$.elapsedCs'), json_extract(value,'$.rank'), json_extract(value,'$.finishReason')
    FROM json_each(?) WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
    .bind(input.roomId, json(ranked.map(({ participantId, correctCount, elapsedCs, rank, finishReason }) =>
      ({ participantId, correctCount, elapsedCs, rank, finishReason }))), input.roomId, marker));
  statements.push(db.prepare(`INSERT INTO v2_final_fields(room_id, participant_id, question_id, field_id, state, answer_json)
    SELECT ?, json_extract(value,'$.participantId'), json_extract(value,'$.questionId'),
      json_extract(value,'$.fieldId'), json_extract(value,'$.state'), json_extract(value,'$.answerJson')
    FROM json_each(?) WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
    .bind(input.roomId, json(fieldRows), input.roomId, marker));
  statements.push(db.prepare(`UPDATE participants SET status = 'FINISHED', finished_at_ms = ?,
    correct_count = COALESCE((SELECT f.correct_count FROM final_results f WHERE f.room_id = participants.room_id AND f.participant_id = participants.id), 0),
    elapsed_cs = COALESCE((SELECT f.elapsed_cs FROM final_results f WHERE f.room_id = participants.room_id AND f.participant_id = participants.id), 0),
    wait_credit_ms = 0 WHERE room_id = ? AND status != 'REMOVED'
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
    .bind(cutoff, input.roomId, input.roomId, marker));
  try {
    const results = await db.batch(statements);
    if (changed(results[0])) return { roomId: input.roomId, state: "FINISHED", cutoffAtMs: cutoff,
      finalizedAtMs: input.nowMs, participantCount: participants.length };
  } catch (error) {
    const after = await loadRoom(db, input.roomId);
    if (after?.phase_state === "FINISHED") return maybeFinalizeV2Room(db, input);
    throw error;
  }
  const after = await loadRoom(db, input.roomId);
  if (after?.phase_state === "FINISHED") return maybeFinalizeV2Room(db, input);
  return null;
}
