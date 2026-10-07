import { applyFieldResult, applyPass } from "../competition-core/scoring";
import { acceptElapsed } from "../competition-core/timing";
import { validateWaitCredit } from "../competition-core/wait-credit";
import type { FieldProgress, QuestionScore, TimingSource } from "../competition-core/types";
import { evaluateField } from "../games/ionic-formula/server/answer-evaluator";
import type { AnswerFieldId, InternalQuestion } from "../games/ionic-formula/shared/types";
import {
  PersistenceConflictError,
  changed,
  commandMarker,
  isRetryableDatabaseConflict,
  json,
  loadCommandReceipt,
  type PersistenceDatabase,
} from "./db";

export type PlayerAction =
  | { readonly type: "answer"; readonly fieldId: AnswerFieldId; readonly value: unknown }
  | { readonly type: "pass"; readonly fieldId: AnswerFieldId };

export type ApplyPlayerActionInput = {
  readonly roomId: string;
  readonly participantId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly questionId: string;
  readonly expectedParticipantRevision: number;
  readonly clientElapsedMs: number | null;
  readonly waitCredit?: { readonly sourceRequestId: string; readonly waitMs: number };
  readonly serverNowMs: number;
  readonly retryServerNowMs?: (attempt: number) => number;
  readonly action: PlayerAction;
};

export type PlayerActionResult = {
  readonly code: "accepted";
  readonly correct: boolean | null;
  readonly participantRevision: number;
  readonly correctCount: number;
  readonly resolvedQuestionCount: number;
  readonly currentOrdinal: number;
  readonly finished: boolean;
  readonly elapsedCs: number;
  readonly rawElapsedMs: number;
  readonly waitCreditMs: number;
  readonly timingSource: "client" | "server_fallback";
};

type RoomRow = {
  readonly state: string;
  readonly start_at_ms: number | null;
  readonly deadline_at_ms: number | null;
  readonly expires_at_ms: number;
};

type ParticipantRow = {
  readonly revision: number;
  readonly status: string;
  readonly current_ordinal: number;
  readonly correct_count: number;
  readonly resolved_question_count: number;
  readonly accepted_elapsed_ms: number;
  readonly wait_credit_ms: number;
  readonly last_action_request_id: string | null;
  readonly elapsed_cs: number;
  readonly timing_source: TimingSource;
};

type QuestionRow = {
  readonly question_id: string;
  readonly ordinal: number;
  readonly answer_snapshot_json: string;
};

type FieldRow = {
  readonly field_id: AnswerFieldId;
  readonly state: FieldProgress["state"];
  readonly resolved_at_ms: number | null;
  readonly attempt_count: number;
};

const ACTION_RATE_LIMIT = 120;
const ACTION_RATE_WINDOW_MS = 60_000;
const ACTION_OPERATION = "player_action";

type OperationAttempt = {
  readonly body_hash: string;
  readonly outcome_code: string | null;
  readonly outcome_status: number | null;
  readonly retry_after_seconds: number | null;
};

function replayAttemptFailure(attempt: OperationAttempt, bodyHash: string): void {
  if (attempt.body_hash !== bodyHash) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  if (attempt.outcome_code) {
    throw new PersistenceConflictError(
      attempt.outcome_code as ConstructorParameters<typeof PersistenceConflictError>[0],
      "the previous rejected action was replayed",
      attempt.outcome_status ?? 409,
      attempt.retry_after_seconds ?? undefined,
    );
  }
}

async function loadOperationAttempt(
  database: PersistenceDatabase,
  input: ApplyPlayerActionInput,
): Promise<OperationAttempt | null> {
  return await database.prepare(`
    SELECT a.body_hash, a.outcome_code, a.outcome_status, a.retry_after_seconds
    FROM operation_attempts a JOIN rooms r ON r.id = a.room_id
    WHERE a.room_id = ? AND a.actor_id = ? AND a.operation = ? AND a.request_id = ?
      AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  `).bind(input.roomId, input.participantId, ACTION_OPERATION, input.requestId).first<OperationAttempt>();
}

async function claimOperationAttempt(
  database: PersistenceDatabase,
  input: ApplyPlayerActionInput,
): Promise<void> {
  const existing = await loadOperationAttempt(database, input);
  if (existing) {
    replayAttemptFailure(existing, input.bodyHash);
    return;
  }

  const claimed = await database.prepare(`
    INSERT INTO operation_attempts (
      room_id, actor_id, operation, request_id, body_hash,
      processed_at_ms, expires_at_ms
    )
    SELECT p.room_id, p.id, ?, ?, ?,
      CAST(unixepoch('subsec') * 1000 AS INTEGER), r.expires_at_ms
    FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.id = ?
      AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NOT EXISTS (
        SELECT 1 FROM operation_attempts duplicate
        WHERE duplicate.room_id = p.room_id AND duplicate.actor_id = p.id
          AND duplicate.operation = ? AND duplicate.request_id = ?
      )
      AND (
        SELECT COUNT(*) FROM operation_attempts recent
        WHERE recent.room_id = p.room_id AND recent.actor_id = p.id
          AND recent.operation = ?
          AND recent.processed_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?
      ) < ?
  `).bind(
    ACTION_OPERATION, input.requestId, input.bodyHash,
    input.roomId, input.participantId,
    ACTION_OPERATION, input.requestId,
    ACTION_OPERATION, ACTION_RATE_WINDOW_MS, ACTION_RATE_LIMIT,
  ).run();
  if (changed(claimed)) return;

  const raced = await loadOperationAttempt(database, input);
  if (raced) {
    replayAttemptFailure(raced, input.bodyHash);
    return;
  }
  const rate = await database.prepare(`
    SELECT COUNT(*) AS recent_count, MIN(processed_at_ms) AS oldest_recent,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
    FROM operation_attempts
    WHERE room_id = ? AND actor_id = ? AND operation = ?
      AND processed_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?
  `).bind(input.roomId, input.participantId, ACTION_OPERATION, ACTION_RATE_WINDOW_MS).first<{
    recent_count: number;
    oldest_recent: number | null;
    database_now_ms: number;
  }>();
  if (Number(rate?.recent_count ?? 0) >= ACTION_RATE_LIMIT) {
    const nowMs = rate?.database_now_ms ?? input.serverNowMs;
    const remainingMs = Math.max(1_000, (rate?.oldest_recent ?? nowMs) + ACTION_RATE_WINDOW_MS - nowMs);
    throw new PersistenceConflictError(
      "rate_limited",
      "participant action rate limit reached",
      429,
      Math.max(1, Math.ceil(remainingMs / 1_000)),
    );
  }
  const room = await database.prepare(`
    SELECT expires_at_ms,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
    FROM rooms WHERE id = ?
  `).bind(input.roomId).first<{ expires_at_ms: number; database_now_ms: number }>();
  if (room && room.expires_at_ms <= room.database_now_ms) {
    throw new PersistenceConflictError("expired", "room expired", 410);
  }
  throw new PersistenceConflictError("not_found", "participant or room not found", 404);
}

async function recordAttemptFailure(
  database: PersistenceDatabase,
  input: ApplyPlayerActionInput,
  error: PersistenceConflictError,
): Promise<void> {
  await database.prepare(`
    UPDATE operation_attempts
    SET outcome_code = ?, outcome_status = ?, retry_after_seconds = ?
    WHERE room_id = ? AND actor_id = ? AND operation = ? AND request_id = ?
      AND body_hash = ? AND outcome_code IS NULL
  `).bind(
    error.code, error.status, error.retryAfterSeconds ?? null,
    input.roomId, input.participantId, ACTION_OPERATION, input.requestId, input.bodyHash,
  ).run();
}

function scoreFromRows(rows: readonly FieldRow[]): QuestionScore {
  const fields = Object.fromEntries(rows.map((field) => [field.field_id, {
    state: field.state,
    attemptCount: field.attempt_count,
    ...(field.resolved_at_ms == null ? {} : { resolvedAtMs: field.resolved_at_ms }),
  }])) as QuestionScore["fields"];
  return {
    fields,
    correctCount: Object.values(fields).filter((field) => field?.state === "correct").length,
    resolved: Object.values(fields).every((field) => field?.state === "correct" || field?.state === "passed"),
  };
}

async function applyPlayerActionOnce(
  database: PersistenceDatabase,
  input: ApplyPlayerActionInput,
): Promise<PlayerActionResult> {
  const existing = await loadCommandReceipt<PlayerActionResult>(
    database, input.roomId, input.participantId, input.requestId, input.bodyHash,
  );
  if (existing) return existing;

  const room = await database.prepare(
    "SELECT state, start_at_ms, deadline_at_ms, expires_at_ms FROM rooms WHERE id = ?",
  ).bind(input.roomId).first<RoomRow>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.serverNowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.start_at_ms == null || room.deadline_at_ms == null || input.serverNowMs < room.start_at_ms) {
    throw new PersistenceConflictError("invalid_state", "competition has not started");
  }
  if (input.serverNowMs >= room.deadline_at_ms) throw new PersistenceConflictError("deadline", "competition deadline reached");
  if (room.state !== "RUNNING" && room.state !== "COUNTDOWN") {
    throw new PersistenceConflictError("invalid_state", `cannot act in ${room.state}`);
  }

  const participant = await database.prepare(`
    SELECT revision, status, current_ordinal, correct_count, resolved_question_count,
      accepted_elapsed_ms, wait_credit_ms, last_action_request_id, elapsed_cs, timing_source
    FROM participants WHERE room_id = ? AND id = ?
  `).bind(input.roomId, input.participantId).first<ParticipantRow>();
  if (!participant) throw new PersistenceConflictError("not_found", "participant not found", 404);
  if (participant.revision !== input.expectedParticipantRevision) {
    throw new PersistenceConflictError("stale_participant_revision", "participant revision is stale");
  }
  const question = await database.prepare(`
    SELECT question_id, ordinal, answer_snapshot_json FROM room_questions
    WHERE room_id = ? AND question_id = ?
  `).bind(input.roomId, input.questionId).first<QuestionRow>();
  if (!question || question.ordinal !== participant.current_ordinal) {
    throw new PersistenceConflictError("stale_participant_revision", "question is no longer current");
  }
  const { results: fieldRows } = await database.prepare(`
    SELECT field_id, state, resolved_at_ms, attempt_count FROM participant_fields
    WHERE room_id = ? AND participant_id = ? AND question_id = ? ORDER BY field_id
  `).bind(input.roomId, input.participantId, input.questionId).all<FieldRow>();
  const before = scoreFromRows(fieldRows);
  if (!before.fields[input.action.fieldId] || before.fields[input.action.fieldId]?.state !== "pending") {
    throw new PersistenceConflictError("invalid_state", "answer field is already resolved");
  }
  const internalQuestion = JSON.parse(question.answer_snapshot_json) as InternalQuestion;
  const evaluation = input.action.type === "answer"
    ? evaluateField(internalQuestion, input.action.fieldId, input.action.value)
    : null;
  const elapsed = acceptElapsed({
    clientElapsedMs: input.clientElapsedMs,
    serverNowMs: input.serverNowMs,
    startAtMs: room.start_at_ms,
    deadlineAtMs: room.deadline_at_ms,
    previousAcceptedElapsedMs: participant.accepted_elapsed_ms,
    previousTimingSource: participant.timing_source,
  });
  if (!elapsed.accepted) throw new PersistenceConflictError(elapsed.reason === "deadline" ? "deadline" : "invalid_state", elapsed.reason);
  let addedWaitCreditMs = 0;
  if (input.waitCredit && participant.last_action_request_id === input.waitCredit.sourceRequestId) {
    const source = await database.prepare(`
      SELECT processed_at_ms FROM command_receipts
      WHERE room_id = ? AND actor_id = ? AND request_id = ? AND result_code = 'accepted'
    `).bind(input.roomId, input.participantId, input.waitCredit.sourceRequestId).first<{ processed_at_ms: number }>();
    if (source) addedWaitCreditMs = validateWaitCredit({
      waitMs: input.waitCredit.waitMs,
      sourceActionAtMs: participant.timing_source === "client"
        ? Math.min(source.processed_at_ms, room.start_at_ms + participant.accepted_elapsed_ms)
        : source.processed_at_ms,
      nextAcceptedAtMs: input.serverNowMs,
      previousRawElapsedMs: participant.accepted_elapsed_ms,
      nextRawElapsedMs: elapsed.acceptedElapsedMs,
    });
  }
  const waitCreditMs = participant.wait_credit_ms + addedWaitCreditMs;
  const recordedElapsedCs = Math.max(participant.elapsed_cs, Math.floor((elapsed.acceptedElapsedMs - waitCreditMs) / 10));
  const after = input.action.type === "answer"
    ? applyFieldResult(before, input.action.fieldId, evaluation!.correct, elapsed.acceptedElapsedMs)
    : applyPass(before, input.action.fieldId, elapsed.acceptedElapsedMs);
  const newlyResolved = !before.resolved && after.resolved;
  const nextOrdinal = participant.current_ordinal + (newlyResolved ? 1 : 0);
  const questionCountRow = await database.prepare("SELECT COUNT(*) AS count FROM room_questions WHERE room_id = ?")
    .bind(input.roomId).first<{ count: number }>();
  const finished = newlyResolved && nextOrdinal >= Number(questionCountRow?.count ?? 0);
  const result: PlayerActionResult = {
    code: "accepted",
    correct: evaluation?.correct ?? null,
    participantRevision: participant.revision + 1,
    correctCount: participant.correct_count + (after.correctCount - before.correctCount),
    resolvedQuestionCount: participant.resolved_question_count + (newlyResolved ? 1 : 0),
    currentOrdinal: nextOrdinal,
    finished,
    elapsedCs: recordedElapsedCs,
    rawElapsedMs: elapsed.acceptedElapsedMs,
    waitCreditMs,
    timingSource: elapsed.timingSource,
  };
  const marker = commandMarker(input.participantId, input.requestId);
  const statements = [database.prepare(`
    UPDATE participants
    SET revision = revision + 1, last_command_id = ?, correct_count = ?,
      resolved_question_count = ?, current_ordinal = ?, status = ?, finished_at_ms = ?,
      accepted_elapsed_ms = ?, wait_credit_ms = ?, last_action_request_id = ?, elapsed_cs = ?, timing_source = ?
    WHERE room_id = ? AND id = ? AND revision = ? AND status = 'ACTIVE' AND current_ordinal = ?
      AND EXISTS (
        SELECT 1 FROM room_questions q
        WHERE q.room_id = participants.room_id AND q.question_id = ? AND q.ordinal = participants.current_ordinal
      )
      AND EXISTS (
        SELECT 1 FROM rooms r WHERE r.id = participants.room_id
          AND r.state IN ('COUNTDOWN', 'RUNNING')
          AND r.start_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND r.deadline_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      )
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts c
        WHERE c.room_id = participants.room_id AND c.actor_id = participants.id AND c.request_id = ?
      )
  `).bind(
    marker, result.correctCount, result.resolvedQuestionCount, result.currentOrdinal,
    finished ? "FINISHED" : "ACTIVE", finished ? input.serverNowMs : null,
    elapsed.acceptedElapsedMs, waitCreditMs, input.requestId, recordedElapsedCs, elapsed.timingSource,
    input.roomId, input.participantId, input.expectedParticipantRevision, participant.current_ordinal,
    input.questionId, input.requestId,
  )];
  for (const [fieldId, field] of Object.entries(after.fields)) {
    if (!field) continue;
    const submitted = input.action.type === "answer" && input.action.fieldId === fieldId;
    // Store only the last accepted answer; pass and timeout leave it intact.
    const answerJson = submitted ? json(input.action.value) : null;
    statements.push(database.prepare(`
      UPDATE participant_fields
      SET state = ?, attempt_count = ?, resolved_at_ms = ?, last_command_id = ?,
          last_answer_json = CASE WHEN ? = 1 THEN ? ELSE last_answer_json END,
          last_answer_correct = CASE WHEN ? = 1 THEN ? ELSE last_answer_correct END
      WHERE room_id = ? AND participant_id = ? AND question_id = ? AND field_id = ?
        AND EXISTS (
          SELECT 1 FROM participants p
          WHERE p.room_id = participant_fields.room_id AND p.id = participant_fields.participant_id
            AND p.last_command_id = ?
        )
    `).bind(
      field.state, field.attemptCount, field.resolvedAtMs ?? null, marker,
      submitted ? 1 : 0, answerJson, submitted ? 1 : 0, submitted ? (evaluation!.correct ? 1 : 0) : null,
      input.roomId, input.participantId, input.questionId, fieldId, marker,
    ));
  }
  statements.push(database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT p.room_id, p.id, ?, ?, 'accepted', ?, ?, r.expires_at_ms
    FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.id = ? AND p.last_command_id = ?
  `).bind(
    input.requestId, input.bodyHash, json(result), input.serverNowMs,
    input.roomId, input.participantId, marker,
  ));

  const batch = await database.batch(statements);
  if (changed(batch[0])) return result;
  const raced = await loadCommandReceipt<PlayerActionResult>(
    database, input.roomId, input.participantId, input.requestId, input.bodyHash,
  );
  if (raced) return raced;
  const latestRoom = await database.prepare(`
    SELECT state, deadline_at_ms, expires_at_ms,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
    FROM rooms WHERE id = ?
  `).bind(input.roomId).first<{ state: string; deadline_at_ms: number; expires_at_ms: number; database_now_ms: number }>();
  if (!latestRoom || latestRoom.expires_at_ms <= latestRoom.database_now_ms) throw new PersistenceConflictError("expired", "room expired", 410);
  if (latestRoom.database_now_ms >= latestRoom.deadline_at_ms) throw new PersistenceConflictError("deadline", "competition deadline reached");
  throw new PersistenceConflictError("stale_participant_revision", "participant changed while applying the action");
}

export async function applyPlayerAction(
  database: PersistenceDatabase,
  input: ApplyPlayerActionInput,
): Promise<PlayerActionResult> {
  const existing = await loadCommandReceipt<PlayerActionResult>(
    database, input.roomId, input.participantId, input.requestId, input.bodyHash,
  );
  if (existing) return existing;
  await claimOperationAttempt(database, input);
  const retryStartedAt = performance.now();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const serverNowMs = attempt === 1
      ? input.serverNowMs
      : input.retryServerNowMs?.(attempt)
        ?? input.serverNowMs + Math.max(0, Math.ceil(performance.now() - retryStartedAt));
    try {
      return await applyPlayerActionOnce(database, { ...input, serverNowMs });
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        const committed = await loadCommandReceipt<PlayerActionResult>(
          database, input.roomId, input.participantId, input.requestId, input.bodyHash,
        );
        if (committed) return committed;
        await recordAttemptFailure(database, input, error);
        throw error;
      }
      if (!isRetryableDatabaseConflict(error)) throw error;
      const stored = await loadCommandReceipt<PlayerActionResult>(
        database, input.roomId, input.participantId, input.requestId, input.bodyHash,
      );
      if (stored) return stored;
      if (attempt === 3) {
        throw new PersistenceConflictError(
          "database_conflict",
          "database conflict; retry with the same requestId",
          503,
        );
      }
    }
  }
  throw new PersistenceConflictError("database_conflict", "database conflict", 503);
}
