import {insertRoomQuestions} from './question-insert';
import { PUBLIC_CONFIG } from "../config/public";
import { toPublicQuestion } from "../games/ionic-formula/server/question-generator";
import type { InternalQuestion } from "../games/ionic-formula/shared/types";
import type { V2GradingMode } from "../competition-core/v2-operations";
import { PersistenceConflictError, changed, commandMarker, json, loadCommandReceipt, type PersistenceDatabase } from "./db";

type RoomRow = { state: string; revision: number; expires_at_ms: number; settings_json: string; start_at_ms: number | null; deadline_at_ms: number | null };
type ManifestRow = { manifest_id: string; evaluator_version: string; grading_mode: V2GradingMode; settings_revision: number; settings_json: string; preparation_generation: number; prepared_at_ms: number; v2_state: string };

export type PrepareV2RoomInput = {
  readonly roomId: string; readonly requestId: string; readonly bodyHash: string;
  readonly expectedRoomRevision: number; readonly nowMs: number; readonly clock?:()=>number;
  readonly manifestId: string; readonly evaluatorVersion: string;
  readonly gradingMode: V2GradingMode; readonly questions: readonly InternalQuestion[];
};
export type PreparedV2Room = { readonly state: "PREPARING"; readonly manifestId: string; readonly preparationGeneration: number; readonly roomRevision: number };

export async function prepareV2Room(db: PersistenceDatabase, input: PrepareV2RoomInput): Promise<PreparedV2Room> {
  const actor = `v2-prepare:${input.roomId}`;
  const receipt = await loadCommandReceipt<PreparedV2Room>(db, input.roomId, actor, input.requestId, input.bodyHash);
  if (receipt) return receipt;
  const room = await db.prepare("SELECT state, revision, expires_at_ms, settings_json, start_at_ms, deadline_at_ms FROM rooms WHERE id = ?")
    .bind(input.roomId).first<RoomRow>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.state !== "WAITING" || room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("invalid_state", "room is not waiting at the expected revision");
  if (!input.questions.length || input.questions.some((question, index) => question.ordinal !== index)) throw new TypeError("invalid question order");
  const settings = JSON.parse(room.settings_json) as { gradingMode?: string; questionCount?: number };
  if (settings.gradingMode !== input.gradingMode || settings.questionCount !== input.questions.length) throw new TypeError("settings and manifest differ");
  const existing = await db.prepare("SELECT *, state AS v2_state FROM v2_room_manifests WHERE room_id = ?")
    .bind(input.roomId).first<ManifestRow>();
  if (existing && existing.v2_state !== "WAITING") throw new PersistenceConflictError("invalid_state", "previous preparation is still active");
  const reuseQuestions = !!existing && existing.settings_json === room.settings_json;
  const manifestId = reuseQuestions ? existing.manifest_id : input.manifestId;
  const generation = existing ? existing.preparation_generation + 1 : 1;
  const response: PreparedV2Room = { state: "PREPARING", manifestId, preparationGeneration: generation, roomRevision: room.revision + 1 };
  const marker = commandMarker(actor, input.requestId);
  const statements = [db.prepare(`UPDATE rooms SET revision = revision + 1, last_command_id = ?
    WHERE id = ? AND state = 'WAITING' AND revision = ? AND expires_at_ms > ?
      AND (SELECT COUNT(*) FROM participants p WHERE p.room_id = rooms.id AND p.status = 'ACTIVE') >= CASE kind WHEN 'class' THEN 1 ELSE 2 END`)
    .bind(marker, input.roomId, input.expectedRoomRevision, input.nowMs)];
  if (existing) {
    statements.push(db.prepare(`UPDATE v2_room_manifests SET state = 'PREPARING', manifest_id = ?, evaluator_version = ?, grading_mode = ?,
      settings_revision = ?, settings_json = ?, preparation_generation = ?, prepared_at_ms = ?, collecting_at_ms = NULL,
      cutoff_at_ms = NULL, collection_until_ms = NULL, finalized_at_ms = NULL
      WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
      .bind(manifestId, input.evaluatorVersion, input.gradingMode, room.revision, room.settings_json,
        generation, input.nowMs, input.roomId, input.roomId, marker));
  } else {
    statements.push(db.prepare(`INSERT INTO v2_room_manifests(room_id, state, manifest_id, evaluator_version, grading_mode, settings_revision,
      settings_json, preparation_generation, prepared_at_ms) SELECT id, 'PREPARING', ?, ?, ?, ?, settings_json, 1, ? FROM rooms WHERE id = ? AND last_command_id = ?`)
      .bind(manifestId, input.evaluatorVersion, input.gradingMode, room.revision, input.nowMs, input.roomId, marker));
  }
  if (!reuseQuestions) {
    if (existing) statements.push(db.prepare(`DELETE FROM room_questions WHERE room_id = ?
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
      .bind(input.roomId, input.roomId, marker));
    statements.push(insertRoomQuestions(db,input.roomId,marker,input.questions));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO v2_participant_progress(room_id, participant_id)
    SELECT p.room_id, p.id FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.status = 'ACTIVE' AND r.last_command_id = ?`).bind(input.roomId, marker));
  statements.push(db.prepare(`INSERT INTO command_receipts(room_id, actor_id, request_id, body_hash, result_code,
    result_json, processed_at_ms, expires_at_ms) SELECT id, ?, ?, ?, 'prepared', ?, ?, expires_at_ms
    FROM rooms WHERE id = ? AND last_command_id = ?`).bind(actor, input.requestId, input.bodyHash, json(response), input.nowMs, input.roomId, marker));
  try {
    const result = await db.batch(statements);
    if (changed(result[0])) {
      if(input.clock)await db.prepare(`UPDATE v2_room_manifests SET prepared_at_ms=? WHERE room_id=? AND preparation_generation=?`).bind(input.clock(),input.roomId,generation).run();
      return response;
    }
  } catch (error) {
    const raced = await loadCommandReceipt<PreparedV2Room>(db, input.roomId, actor, input.requestId, input.bodyHash);
    if (raced) return raced;
    throw error;
  }
  const raced = await loadCommandReceipt<PreparedV2Room>(db, input.roomId, actor, input.requestId, input.bodyHash);
  if (raced) return raced;
  throw new PersistenceConflictError("invalid_state", "room preparation did not commit");
}

export async function loadV2Manifest(db: PersistenceDatabase, roomId: string, participantId: string) {
  const row = await db.prepare(`SELECT m.manifest_id, m.evaluator_version, m.grading_mode, m.preparation_generation, m.state, p.status
    FROM v2_room_manifests m JOIN rooms r ON r.id = m.room_id
    JOIN participants p ON p.room_id = m.room_id AND p.id = ? WHERE m.room_id = ?`)
    .bind(participantId, roomId).first<ManifestRow & { state: string; status: string }>();
  if (!row || row.status === "REMOVED") throw new PersistenceConflictError("not_authorized", "participant cannot read manifest", 403);
  if (!["PREPARING", "COUNTDOWN", "RUNNING", "COLLECTING"].includes(row.state)) throw new PersistenceConflictError("invalid_state", "manifest is unavailable");
  const questionRows = await db.prepare("SELECT public_payload_json, answer_snapshot_json FROM room_questions WHERE room_id = ? ORDER BY ordinal")
    .bind(roomId).all<{ public_payload_json: string; answer_snapshot_json: string }>();
  return { manifestId: row.manifest_id, evaluatorVersion: row.evaluator_version, gradingMode: row.grading_mode,
    preparationGeneration: row.preparation_generation,
    questions: questionRows.results.map((question) => JSON.parse(row.grading_mode === "immediate" ? question.answer_snapshot_json : question.public_payload_json)) };
}

export type MarkV2ReadyInput = { readonly roomId: string; readonly participantId: string; readonly manifestId: string;
  readonly preparationGeneration: number; readonly evaluatorVersion: string; readonly nowMs: number; readonly clock?:()=>number };
export async function markV2Ready(db: PersistenceDatabase, input: MarkV2ReadyInput) {
  const room = await db.prepare(`SELECT m.state, r.start_at_ms, r.deadline_at_ms, r.expires_at_ms, r.settings_json,
      m.manifest_id, m.evaluator_version, m.preparation_generation, m.prepared_at_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id WHERE r.id = ?`)
    .bind(input.roomId).first<RoomRow & ManifestRow>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.manifest_id !== input.manifestId || room.evaluator_version !== input.evaluatorVersion
    || room.preparation_generation !== input.preparationGeneration) throw new PersistenceConflictError("invalid_state", "stale preparation generation");
  if (room.state !== "PREPARING" && room.state !== "COUNTDOWN" && room.state !== "RUNNING") throw new PersistenceConflictError("invalid_state", "room is not preparing");
  const readyWrite = await db.prepare(`UPDATE v2_participant_progress SET ready_generation = ? WHERE room_id = ? AND participant_id = ?
    AND EXISTS (SELECT 1 FROM participants p WHERE p.room_id = ? AND p.id = ? AND p.status = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM v2_room_manifests m JOIN rooms r ON r.id = m.room_id
      WHERE m.room_id = v2_participant_progress.room_id
        AND m.manifest_id = ? AND m.evaluator_version = ? AND m.preparation_generation = ?
        AND m.state IN ('PREPARING', 'COUNTDOWN', 'RUNNING')
        AND r.state IN ('WAITING', 'COUNTDOWN', 'RUNNING') AND r.expires_at_ms > ?)`)
    .bind(input.preparationGeneration, input.roomId, input.participantId, input.roomId, input.participantId,
      input.manifestId, input.evaluatorVersion, input.preparationGeneration, input.nowMs).run();
  if (!changed(readyWrite)) throw new PersistenceConflictError("invalid_state", "readiness context changed before commit");
  const counts = await db.prepare(`SELECT COUNT(*) AS participant_count,
    SUM(CASE WHEN v.ready_generation = ? THEN 1 ELSE 0 END) AS ready_count
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE p.room_id = ? AND p.status = 'ACTIVE'`).bind(input.preparationGeneration, input.roomId)
    .first<{ participant_count: number; ready_count: number }>();
  const participantCount = Number(counts?.participant_count ?? 0);
  const readyCount = Number(counts?.ready_count ?? 0);
  const decisionAtMs=input.clock?.()??input.nowMs;
  let attemptedCountdown=false;
  if (participantCount && readyCount === participantCount && room.state === "PREPARING"
    && decisionAtMs < room.prepared_at_ms + 30_000) {
    attemptedCountdown=true;
    const startAtMs = decisionAtMs + PUBLIC_CONFIG.countdownSeconds * 1_000;
    const timeLimit = (JSON.parse(room.settings_json) as { timeLimitMinutes: number }).timeLimitMinutes * 60_000;
    const marker = commandMarker("v2-ready", `${input.roomId}:${input.preparationGeneration}`);
    await db.batch([db.prepare(`UPDATE rooms SET state = 'COUNTDOWN', revision = revision + 1,
      start_at_ms = ?, deadline_at_ms = ?, expires_at_ms = MAX(expires_at_ms, ? + CASE kind WHEN 'class' THEN ? ELSE ? END), last_command_id = ?
      WHERE id = ? AND state = 'WAITING' AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id
        AND m.state = 'PREPARING' AND m.preparation_generation = ? AND ? < m.prepared_at_ms + 30000) AND NOT EXISTS (
        SELECT 1 FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
        WHERE p.room_id = rooms.id AND p.status = 'ACTIVE' AND COALESCE(v.ready_generation, 0) != ?)`)
      .bind(startAtMs, startAtMs + timeLimit, startAtMs + timeLimit,
        PUBLIC_CONFIG.retentionMs.classCompetition, PUBLIC_CONFIG.retentionMs.mateMatch,
        marker, input.roomId, input.preparationGeneration, decisionAtMs, input.preparationGeneration),
    db.prepare(`UPDATE v2_room_manifests SET state = 'COUNTDOWN' WHERE room_id = ?
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
      .bind(input.roomId, input.roomId, marker),
    db.prepare(`UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
      WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
      .bind(input.roomId, input.roomId, input.roomId, marker),
    db.prepare(`UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
      WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`)
      .bind(input.roomId, input.roomId, input.roomId, marker)]);
  }
  const latest = attemptedCountdown ? await db.prepare(`SELECT m.state, r.start_at_ms, r.deadline_at_ms
    FROM rooms r JOIN v2_room_manifests m ON m.room_id = r.id WHERE r.id = ?`)
    .bind(input.roomId).first<Pick<RoomRow, "state" | "start_at_ms" | "deadline_at_ms">>() : room;
  return { state: latest?.state ?? room.state, readyCount, participantCount,
    startAtMs: latest?.start_at_ms ?? null, deadlineAtMs: latest?.deadline_at_ms ?? null,
    preparationTimedOut: room.state === "PREPARING" && decisionAtMs >= room.prepared_at_ms + 30_000 };
}

export async function cancelV2Preparation(db: PersistenceDatabase, input: { roomId: string; expectedRoomRevision: number; nowMs: number }) {
  const marker = commandMarker("v2-cancel", input.roomId);
  const results = await db.batch([db.prepare(`UPDATE rooms SET revision = revision + 1, last_command_id = ? WHERE id = ? AND state = 'WAITING'
    AND revision = ? AND expires_at_ms > ? AND EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state = 'PREPARING')`)
    .bind(marker, input.roomId, input.expectedRoomRevision, input.nowMs),
  db.prepare(`UPDATE v2_room_manifests SET state = 'WAITING' WHERE room_id = ? AND EXISTS
    (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)`).bind(input.roomId, input.roomId, marker)]);
  const result = results[0];
  if (!changed(result)) throw new PersistenceConflictError("invalid_state", "preparation could not be cancelled");
  return { state: "WAITING" as const, roomRevision: input.expectedRoomRevision + 1 };
}

export async function loadV2RoomPhase(db: PersistenceDatabase, roomId: string, nowMs: number) {
  const row = await db.prepare(`SELECT m.state, m.manifest_id, m.grading_mode, m.evaluator_version,
    m.preparation_generation, m.prepared_at_ms, m.cutoff_at_ms, m.collection_until_ms, m.finalized_at_ms,
    r.start_at_ms, r.deadline_at_ms, r.revision, r.end_reason
    FROM v2_room_manifests m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ?`)
    .bind(roomId).first<{ state: string; manifest_id: string; grading_mode: V2GradingMode; evaluator_version: string;
      preparation_generation: number; prepared_at_ms: number; cutoff_at_ms: number | null;
      collection_until_ms: number | null; finalized_at_ms: number | null; start_at_ms: number | null;
      deadline_at_ms: number | null; revision: number; end_reason: string }>();
  if (!row) return null;
  const state = row.state === "COUNTDOWN" && row.start_at_ms != null && nowMs >= row.start_at_ms
    ? "RUNNING" : row.state;
  return { state, manifestId: row.manifest_id, gradingMode: row.grading_mode,
    evaluatorVersion: row.evaluator_version, preparationGeneration: row.preparation_generation,
    preparationTimedOut: row.state === "PREPARING" && nowMs >= row.prepared_at_ms + 30_000,
    startAtMs: row.start_at_ms, deadlineAtMs: row.deadline_at_ms,
    cutoffAtMs: row.cutoff_at_ms ?? row.deadline_at_ms,
    collectionUntilMs: row.collection_until_ms ?? (row.deadline_at_ms == null ? null : row.deadline_at_ms + 10_000),
    finalizedAtMs: row.finalized_at_ms, roomRevision: row.revision, endReason: row.end_reason };
}
