import { PUBLIC_CONFIG } from "../config/public";
import {
  PersistenceConflictError,
  changed,
  commandMarker,
  loadCommandReceipt,
  type PersistenceDatabase,
} from "./db";

export type FinalizeRoomInput = {
  readonly roomId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly nowMs: number;
};

export type FinalizedRoom = {
  readonly roomId: string;
  readonly state: "FINISHED";
  readonly endedAtMs: number;
  readonly participantCount: number;
};

type FinalRoom = {
  state: string;
  revision: number;
  start_at_ms: number | null;
  deadline_at_ms: number | null;
  expires_at_ms: number;
};

export async function finalizeRoom(
  database: PersistenceDatabase,
  input: FinalizeRoomInput,
): Promise<FinalizedRoom> {
  const actorId = `finalize:${input.roomId}`;
  const existing = await loadCommandReceipt<FinalizedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const room = await database.prepare(
    "SELECT state, revision, start_at_ms, deadline_at_ms, expires_at_ms FROM rooms WHERE id = ?",
  ).bind(input.roomId).first<FinalRoom>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.state === "FINISHED") throw new PersistenceConflictError("invalid_state", "room was finalized by another command");
  if (room.state !== "COUNTDOWN" && room.state !== "RUNNING") {
    throw new PersistenceConflictError("invalid_state", `cannot finalize ${room.state}`);
  }
  if (room.start_at_ms == null || room.deadline_at_ms == null) throw new PersistenceConflictError("invalid_state", "room has no schedule");
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET
      state = 'FINISHED',
      revision = revision + 1,
      ended_at_ms = CASE
        WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
          THEN COALESCE((SELECT MAX(p.finished_at_ms) FROM participants p WHERE p.room_id = rooms.id AND p.status = 'FINISHED'), deadline_at_ms)
        ELSE deadline_at_ms
      END,
      expires_at_ms = (CASE
        WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
          THEN COALESCE((SELECT MAX(p.finished_at_ms) FROM participants p WHERE p.room_id = rooms.id AND p.status = 'FINISHED'), deadline_at_ms)
        ELSE deadline_at_ms
      END) + CASE kind WHEN 'class' THEN ? ELSE ? END,
      last_command_id = ?
    WHERE id = ? AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND (
        deadline_at_ms <= ?
        OR (
          EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status != 'REMOVED')
          AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
        )
      )
      AND expires_at_ms > ?
  `).bind(
    PUBLIC_CONFIG.retentionMs.classCompetition, PUBLIC_CONFIG.retentionMs.mateMatch,
    marker, input.roomId, room.revision, input.nowMs, input.nowMs,
  )];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO final_results (
      room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason
    )
    SELECT room_id, participant_id, correct_count, effective_elapsed_cs,
      RANK() OVER (ORDER BY correct_count DESC, effective_elapsed_cs ASC), finish_reason
    FROM (
      SELECT p.room_id, p.id AS participant_id, p.correct_count,
        CASE WHEN p.status = 'FINISHED' THEN p.elapsed_cs
          ELSE CAST((r.deadline_at_ms - r.start_at_ms) / 10 AS INTEGER) END AS effective_elapsed_cs,
        CASE WHEN p.status = 'FINISHED' THEN 'completed' ELSE 'timeout' END AS finish_reason,
        p.joined_order
      FROM participants p JOIN rooms r ON r.id = p.room_id
      WHERE p.room_id = ? AND p.status != 'REMOVED' AND r.last_command_id = ?
    ) frozen
    ORDER BY correct_count DESC, effective_elapsed_cs ASC, joined_order ASC
  `).bind(input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participant_fields SET state = 'unanswered', last_command_id = ?
    WHERE room_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participant_fields.room_id AND r.last_command_id = ?)
  `).bind(marker, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participants
    SET status = 'FINISHED', finished_at_ms = COALESCE(finished_at_ms, (SELECT ended_at_ms FROM rooms WHERE id = ?)),
      accepted_elapsed_ms = CASE WHEN status = 'ACTIVE' THEN (SELECT deadline_at_ms - start_at_ms FROM rooms WHERE id = ?) ELSE accepted_elapsed_ms END,
      elapsed_cs = CASE WHEN status = 'ACTIVE' THEN (SELECT CAST((deadline_at_ms - start_at_ms) / 10 AS INTEGER) FROM rooms WHERE id = ?) ELSE elapsed_cs END,
      timing_source = CASE WHEN status = 'ACTIVE' THEN 'timeout' ELSE timing_source END
    WHERE room_id = ? AND status != 'REMOVED'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT id, ?, ?, ?, 'finalized',
      json_object(
        'roomId', id,
        'state', 'FINISHED',
        'endedAtMs', ended_at_ms,
        'participantCount', (SELECT COUNT(*) FROM participants p WHERE p.room_id = rooms.id AND p.status != 'REMOVED')
      ), ?, expires_at_ms FROM rooms
    WHERE id = ? AND last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, input.nowMs, input.roomId, marker));
  let batch;
  try {
    batch = await database.batch(statements);
  } catch (error) {
    const committed = await loadCommandReceipt<FinalizedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) {
    const stored = await loadCommandReceipt<FinalizedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (stored) return stored;
  }
  const raced = await loadCommandReceipt<FinalizedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  throw new PersistenceConflictError("stale_room_revision", "room changed while finalizing");
}

export type LoadAuthorizedResultInput = {
  readonly roomId: string;
  readonly participantId: string;
  readonly tokenHash: string;
  readonly nowMs: number;
};

export type AuthorizedResult = {
  readonly participantId: string;
  readonly correctCount: number;
  readonly elapsedCs: number;
  readonly waitCreditMs: number;
  readonly timingSource: string;
  readonly rank: number;
  readonly finishReason: "completed" | "timeout" | "cancelled" | "interrupted";
};

export type InterruptRoomInput = {
  readonly roomId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly expectedRoomRevision: number;
  readonly nowMs: number;
};

export async function interruptRoom(database: PersistenceDatabase, input: InterruptRoomInput): Promise<{ state: "FINISHED"; roomRevision: number; endedAtMs: number }> {
  const actorId = `room:${input.roomId}`;
  type Result = { state: "FINISHED"; roomRevision: number; endedAtMs: number };
  const existing = await loadCommandReceipt<Result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET state = 'FINISHED', revision = revision + 1, end_reason = 'interrupted',
      ended_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER),
      expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?, last_command_id = ?
    WHERE id = ? AND kind = 'class' AND revision = ? AND state IN ('COUNTDOWN', 'RUNNING')
      AND start_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND deadline_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE')
  `).bind(PUBLIC_CONFIG.retentionMs.classCompetition, marker, input.roomId, input.expectedRoomRevision)];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO final_results (room_id, participant_id, correct_count, elapsed_cs, rank, finish_reason)
    SELECT room_id, participant_id, correct_count, effective_elapsed_cs,
      RANK() OVER (ORDER BY correct_count DESC, effective_elapsed_cs ASC), finish_reason
    FROM (
      SELECT p.room_id, p.id AS participant_id, p.correct_count,
        CASE WHEN p.status = 'FINISHED' THEN p.elapsed_cs
          ELSE CAST((r.ended_at_ms - r.start_at_ms) / 10 AS INTEGER) END AS effective_elapsed_cs,
        CASE WHEN p.status = 'FINISHED' THEN 'completed' ELSE 'interrupted' END AS finish_reason,
        p.joined_order
      FROM participants p JOIN rooms r ON r.id = p.room_id
      WHERE p.room_id = ? AND p.status != 'REMOVED' AND r.last_command_id = ?
    ) frozen ORDER BY correct_count DESC, effective_elapsed_cs ASC, joined_order ASC
  `).bind(input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participant_fields SET state = 'unanswered', last_command_id = ?
    WHERE room_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participant_fields.room_id AND r.last_command_id = ?)
  `).bind(marker, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE participants SET status = 'FINISHED', revision = revision + CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END,
      finished_at_ms = COALESCE(finished_at_ms, (SELECT ended_at_ms FROM rooms WHERE id = ?)),
      accepted_elapsed_ms = CASE WHEN status = 'ACTIVE' THEN (SELECT ended_at_ms - start_at_ms FROM rooms WHERE id = ?) ELSE accepted_elapsed_ms END,
      elapsed_cs = CASE WHEN status = 'ACTIVE' THEN (SELECT CAST((ended_at_ms - start_at_ms) / 10 AS INTEGER) FROM rooms WHERE id = ?) ELSE elapsed_cs END,
      timing_source = CASE WHEN status = 'ACTIVE' THEN 'timeout' ELSE timing_source END
    WHERE room_id = ? AND status != 'REMOVED'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO command_receipts (room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms)
    SELECT id, ?, ?, ?, 'interrupted',
      json_object('state', 'FINISHED', 'roomRevision', revision, 'endedAtMs', ended_at_ms),
      ended_at_ms, expires_at_ms FROM rooms WHERE id = ? AND last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, input.roomId, marker));
  let batch;
  try { batch = await database.batch(statements); }
  catch (error) {
    const committed = await loadCommandReceipt<Result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) {
    const stored = await loadCommandReceipt<Result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (stored) return stored;
  }
  const raced = await loadCommandReceipt<Result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  const room = await database.prepare("SELECT state, revision, expires_at_ms FROM rooms WHERE id = ?").bind(input.roomId).first<{ state: string; revision: number; expires_at_ms: number }>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  throw new PersistenceConflictError("invalid_state", `cannot interrupt ${room.state}`);
}

export async function loadAuthorizedResult(
  database: PersistenceDatabase,
  input: LoadAuthorizedResultInput,
): Promise<AuthorizedResult> {
  const result = await database.prepare(`
    SELECT f.participant_id, f.correct_count, f.elapsed_cs, f.rank, f.finish_reason,
      CASE WHEN f.finish_reason = 'completed' THEN p.wait_credit_ms ELSE 0 END AS wait_credit_ms,
      p.timing_source
    FROM final_results f
    JOIN participants p ON p.room_id = f.room_id AND p.id = f.participant_id
    JOIN rooms r ON r.id = f.room_id
    WHERE f.room_id = ? AND f.participant_id = ? AND p.token_hash = ?
      AND r.state = 'FINISHED' AND r.expires_at_ms > ?
  `).bind(input.roomId, input.participantId, input.tokenHash, input.nowMs).first<{
    participant_id: string; correct_count: number; elapsed_cs: number; rank: number; wait_credit_ms: number; timing_source: string;
    finish_reason: AuthorizedResult["finishReason"];
  }>();
  if (!result) {
    const room = await database.prepare("SELECT expires_at_ms FROM rooms WHERE id = ?")
      .bind(input.roomId).first<{ expires_at_ms: number }>();
    if (room && room.expires_at_ms <= input.nowMs) {
      throw new PersistenceConflictError("expired", "room expired", 410);
    }
    throw new PersistenceConflictError("not_authorized", "result is unavailable", 403);
  }
  return {
    participantId: result.participant_id,
    correctCount: result.correct_count,
    elapsedCs: result.elapsed_cs,
    waitCreditMs: result.wait_credit_ms,
    timingSource: result.timing_source,
    rank: result.rank,
    finishReason: result.finish_reason,
  };
}
