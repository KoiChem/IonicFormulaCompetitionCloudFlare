import type { InternalQuestion } from "../games/ionic-formula/shared/types";
import { replayV2Operations, type V2GradingMode, type V2Operation } from "../competition-core/v2-operations";
import { PersistenceConflictError, changed, commandMarker, json, type PersistenceDatabase } from "./db";

type Context = {
  state: string; start_at_ms: number | null; deadline_at_ms: number | null; expires_at_ms: number;
  end_reason: string; manifest_id: string; evaluator_version: string; grading_mode: V2GradingMode;
  cutoff_at_ms: number | null; collection_until_ms: number | null;
  preparation_generation: number; phase_state: string;
  status: string; writer_epoch: number; ack_seq: number; accepted_seq: number; last_elapsed_ms: number;
};
type Receipt = { body_hash: string; response_json: string };
export type ApplyV2OperationsInput = {
  readonly roomId: string; readonly participantId: string; readonly requestId: string;
  readonly writerEpoch: number; readonly manifestId: string; readonly evaluatorVersion: string;
  readonly operations: readonly V2Operation[]; readonly nowMs: number;
};
export type V2OperationAck = {
  readonly ackSeq: number; readonly acceptedSeq: number; readonly roomState: string;
  readonly cutoffAtMs: number; readonly collectionUntilMs: number;
  readonly correctCount: number; readonly answeredCount: number; readonly resolvedQuestionCount: number;
};

function bodyHash(input: ApplyV2OperationsInput): string {
  return json({ writerEpoch: input.writerEpoch, manifestId: input.manifestId,
    evaluatorVersion: input.evaluatorVersion, operations: input.operations });
}

async function receipt(db: PersistenceDatabase, input: ApplyV2OperationsInput, hash: string): Promise<V2OperationAck | null> {
  const row = await db.prepare(`SELECT c.body_hash, c.response_json, r.expires_at_ms, p.status
    FROM v2_batch_receipts c JOIN rooms r ON r.id=c.room_id
    JOIN participants p ON p.room_id=c.room_id AND p.id=c.participant_id
    WHERE c.room_id = ? AND c.participant_id = ? AND c.request_id = ?`)
    .bind(input.roomId, input.participantId, input.requestId).first<Receipt & { expires_at_ms: number; status: string }>();
  if (!row) return null;
  if (row.status === 'REMOVED') throw new PersistenceConflictError('not_authorized', 'participant cannot replay operations', 403);
  if (row.expires_at_ms <= input.nowMs) throw new PersistenceConflictError('expired', 'room expired', 410);
  if (row.body_hash !== hash) throw new PersistenceConflictError("request_id_reused", "requestId was reused with different operations");
  return JSON.parse(row.response_json) as V2OperationAck;
}

function validateBatch(input: ApplyV2OperationsInput, previousSeq: number, previousElapsed: number) {
  if (!input.requestId || input.requestId.length > 128 || !Number.isSafeInteger(input.writerEpoch) || input.writerEpoch < 0) throw new TypeError("invalid batch identity");
  if (!input.operations.length || input.operations.length > 128 || json(input.operations).length > 128 * 1024) throw new TypeError("invalid batch size");
  let elapsed = previousElapsed;
  for (const [index, operation] of input.operations.entries()) {
    if (operation.seq !== previousSeq + index + 1 || !operation.operationId || operation.operationId.length > 128) {
      throw new PersistenceConflictError("stale_participant_revision", `expected sequence ${previousSeq + 1}`);
    }
    if (!Number.isSafeInteger(operation.elapsedMs) || operation.elapsedMs < elapsed) throw new TypeError("operation time must be nonnegative and monotonic");
    elapsed = operation.elapsedMs;
    if (!["answer", "pass", "draft", "finish"].includes(operation.type)) throw new TypeError("invalid operation type");
    if (operation.value !== undefined && json(operation.value).length > 4096) throw new TypeError("answer too long");
    if (operation.type === "finish" && !["completed", "submitted", "timeout", "interrupted"].includes(operation.reason ?? "")) throw new TypeError("invalid finish reason");
  }
}

export async function applyV2Operations(db: PersistenceDatabase, input: ApplyV2OperationsInput): Promise<V2OperationAck> {
  const hash = bodyHash(input);
  const priorReceipt = await receipt(db, input, hash);
  if (priorReceipt) return priorReceipt;
  const context = await db.prepare(`SELECT r.state, r.start_at_ms, r.deadline_at_ms, r.expires_at_ms, r.end_reason,
    m.manifest_id, m.evaluator_version, m.grading_mode, m.cutoff_at_ms, m.collection_until_ms, m.preparation_generation, m.state AS phase_state,
    p.status, v.writer_epoch, v.ack_seq, v.accepted_seq, v.last_elapsed_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id
    JOIN participants p ON p.room_id = r.id AND p.id = ?
    JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE r.id = ?`).bind(input.participantId, input.roomId).first<Context>();
  if (!context || context.status === "REMOVED") throw new PersistenceConflictError("not_authorized", "participant cannot save operations", 403);
  if (context.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (context.manifest_id !== input.manifestId || context.evaluator_version !== input.evaluatorVersion) {
    throw new PersistenceConflictError("invalid_state", "manifest or evaluator version differs");
  }
  if (context.writer_epoch !== input.writerEpoch) throw new PersistenceConflictError("stale_participant_revision", "writer epoch is stale");
  if (context.start_at_ms == null || context.deadline_at_ms == null || input.nowMs < context.start_at_ms) throw new PersistenceConflictError("invalid_state", "competition has not started");
  if (!["COUNTDOWN", "RUNNING", "COLLECTING"].includes(context.state)) throw new PersistenceConflictError("invalid_state", "competition is not accepting records");
  const cutoffAtMs = context.cutoff_at_ms ?? context.deadline_at_ms;
  const collectionUntilMs = context.collection_until_ms ?? cutoffAtMs + 10_000;
  if (input.nowMs >= collectionUntilMs) throw new PersistenceConflictError("deadline", "record collection has ended");
  validateBatch(input, context.ack_seq, context.last_elapsed_ms);
  const questions = (await db.prepare(`SELECT answer_snapshot_json FROM room_questions WHERE room_id = ? ORDER BY ordinal`)
    .bind(input.roomId).all<{ answer_snapshot_json: string }>()).results.map((row) => JSON.parse(row.answer_snapshot_json) as InternalQuestion);
  const previousOps = (await db.prepare(`SELECT payload_json FROM v2_operations WHERE room_id = ? AND participant_id = ? ORDER BY seq`)
    .bind(input.roomId, input.participantId).all<{ payload_json: string }>()).results.map((row) => JSON.parse(row.payload_json) as V2Operation);
  const allOps = [...previousOps, ...input.operations];
  const interruption = context.end_reason === "interrupted";
  for (const operation of input.operations) {
    if (context.start_at_ms + operation.elapsedMs > input.nowMs + 250) {
      console.warn(JSON.stringify({event:'operation_clock_rejected',type:operation.type,aheadByMs:context.start_at_ms + operation.elapsedMs-input.nowMs}));
      throw new TypeError("operation time is in the future");
    }
    if (operation.type === "finish" && operation.reason === "interrupted" && !interruption) throw new TypeError("unexpected interruption finish");
    if (context.grading_mode === "immediate" && operation.type === "draft") throw new TypeError("draft is not valid in immediate mode");
    if (context.grading_mode === "deferred" && ["answer", "pass"].includes(operation.type)) throw new TypeError("answer or pass is not valid in deferred mode");
  }
  const replay = replayV2Operations(questions, context.grading_mode, allOps, context.start_at_ms, cutoffAtMs, interruption, false);
  const ackSeq = input.operations.at(-1)!.seq;
  let acceptedSeq = context.accepted_seq;
  for (const operation of input.operations) {
    const at = context.start_at_ms + operation.elapsedMs;
    const valid = at < cutoffAtMs || (!interruption && operation.type === "draft"
      && at === cutoffAtMs && context.start_at_ms + (operation.editedElapsedMs ?? operation.elapsedMs) < cutoffAtMs);
    if (valid) acceptedSeq = operation.seq;
  }
  const response: V2OperationAck = { ackSeq, acceptedSeq, roomState: context.state,
    cutoffAtMs, collectionUntilMs, correctCount: context.grading_mode === "immediate" ? replay.correctCount : 0,
    answeredCount: replay.answeredCount, resolvedQuestionCount: replay.resolvedQuestionCount };
  const marker = commandMarker(input.participantId, input.requestId);
  const statements = [db.prepare(`UPDATE v2_participant_progress SET ack_seq = ?, accepted_seq = ?, last_elapsed_ms = ?,
      answered_count = ?, finished_elapsed_ms = ?, finish_reason = ?, boundary_ack_at_ms = CASE WHEN ? THEN ? ELSE boundary_ack_at_ms END,
      last_sync_at_ms = ?, last_command_id = ?
    WHERE room_id = ? AND participant_id = ? AND writer_epoch = ? AND ack_seq = ?
      AND EXISTS (SELECT 1 FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id
        WHERE r.id = ? AND r.state IN ('COUNTDOWN', 'RUNNING', 'COLLECTING')
          AND r.expires_at_ms > ? AND r.start_at_ms = ? AND r.deadline_at_ms = ?
          AND r.end_reason = ? AND m.manifest_id = ? AND m.evaluator_version = ?
          AND m.preparation_generation = ? AND m.state = ?
          AND COALESCE(m.cutoff_at_ms, r.deadline_at_ms) = ?
          AND COALESCE(m.collection_until_ms, r.deadline_at_ms + 10000) = ?
          AND ? < COALESCE(m.collection_until_ms, r.deadline_at_ms + 10000)
          AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = r.id AND p.id = ? AND p.status != 'REMOVED'))`)
    .bind(ackSeq, acceptedSeq, input.operations.at(-1)!.elapsedMs, replay.answeredCount,
      replay.finishedElapsedMs, replay.finishReason, replay.boundaryAcknowledged ? 1 : 0,
      replay.boundaryAcknowledged ? input.nowMs : null, input.nowMs, marker,
      input.roomId, input.participantId, input.writerEpoch, context.ack_seq, input.roomId, input.nowMs, context.start_at_ms, context.deadline_at_ms,
      context.end_reason, input.manifestId, input.evaluatorVersion, context.preparation_generation,
      context.phase_state, cutoffAtMs, collectionUntilMs, input.nowMs, input.participantId)];
  statements.push(db.prepare(`INSERT INTO v2_operations
    (room_id, participant_id, seq, operation_id, payload_json, elapsed_ms, accepted_for_score, received_at_ms)
    SELECT v.room_id, v.participant_id, json_extract(value,'$.seq'), json_extract(value,'$.operationId'),
      json_extract(value,'$.payloadJson'), json_extract(value,'$.elapsedMs'), json_extract(value,'$.acceptedForScore'), ?
    FROM v2_participant_progress v JOIN json_each(?)
    WHERE v.room_id = ? AND v.participant_id = ? AND v.last_command_id = ?`).bind(
      input.nowMs, json(input.operations.map(operation => ({ seq: operation.seq, operationId: operation.operationId,
        payloadJson: json(operation), elapsedMs: operation.elapsedMs, acceptedForScore: operation.seq <= acceptedSeq ? 1 : 0 }))),
      input.roomId, input.participantId, marker,
    ));
  statements.push(db.prepare(`UPDATE participants SET correct_count = ?, resolved_question_count = ?,
    current_ordinal = ?, accepted_elapsed_ms = ?, wait_credit_ms = 0, revision = revision + 1
    WHERE room_id = ? AND id = ? AND EXISTS (SELECT 1 FROM v2_participant_progress v
      WHERE v.room_id = participants.room_id AND v.participant_id = participants.id AND v.last_command_id = ?)`)
    .bind(context.grading_mode === "immediate" ? replay.correctCount : 0, replay.resolvedQuestionCount,
      replay.resolvedQuestionCount, input.operations.at(-1)!.elapsedMs, input.roomId, input.participantId, marker));
  statements.push(db.prepare(`UPDATE rooms SET revision = revision + 1 WHERE id = ?
    AND EXISTS (SELECT 1 FROM v2_participant_progress v WHERE v.room_id = rooms.id
      AND v.participant_id = ? AND v.last_command_id = ?)`)
    .bind(input.roomId, input.participantId, marker));
  statements.push(db.prepare(`INSERT INTO v2_batch_receipts(room_id, participant_id, request_id, body_hash, response_json, processed_at_ms)
    SELECT room_id, participant_id, ?, ?, ?, ? FROM v2_participant_progress
    WHERE room_id = ? AND participant_id = ? AND last_command_id = ?`).bind(
    input.requestId, hash, json(response), input.nowMs, input.roomId, input.participantId, marker,
  ));
  try {
    const result = await db.batch(statements);
    if (changed(result[0])) return response;
  } catch (error) {
    const raced = await receipt(db, input, hash);
    if (raced) return raced;
    throw error;
  }
  const raced = await receipt(db, input, hash);
  if (raced) return raced;
  throw new PersistenceConflictError("stale_participant_revision", "operation sequence or writer changed");
}

export async function takeOverV2Writer(db: PersistenceDatabase, roomId: string, participantId: string, expectedEpoch: number) {
  const result = await db.prepare(`UPDATE v2_participant_progress SET writer_epoch = writer_epoch + 1
    WHERE room_id = ? AND participant_id = ? AND writer_epoch = ?
      AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = ? AND p.id = ? AND p.status = 'ACTIVE')`)
    .bind(roomId, participantId, expectedEpoch, roomId, participantId).run();
  if (!changed(result)) throw new PersistenceConflictError("stale_participant_revision", "writer epoch changed");
  return { writerEpoch: expectedEpoch + 1 };
}
