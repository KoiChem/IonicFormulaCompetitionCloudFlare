import { PUBLIC_CONFIG } from "../config/public";
import {
  PersistenceConflictError,
  changed,
  commandMarker,
  json,
  loadCommandReceipt,
  type PersistenceDatabase,
} from "./db";

export type JoinRoomInput = {
  readonly roomId: string;
  readonly participantId: string;
  readonly tokenHash: string;
  readonly nickname: string;
  readonly nicknameKey: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly nowMs: number;
};

export type JoinedParticipant = {
  readonly roomId: string;
  readonly participantId: string;
  readonly joinedOrder: number;
  readonly participantRevision: 0;
};

export type RenameParticipantInput = {
  readonly roomId: string;
  readonly participantId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly expectedParticipantRevision: number;
  readonly nickname: string;
  readonly nicknameKey: string;
  readonly nowMs: number;
};

export async function renameParticipant(database: PersistenceDatabase, input: RenameParticipantInput): Promise<{ nickname: string; revision: number }> {
  const actorId = `rename:${input.participantId}`;
  const existing = await loadCommandReceipt<{ nickname: string; revision: number }>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const result = { nickname: input.nickname, revision: input.expectedParticipantRevision + 1 };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE participants SET nickname = ?, nickname_key = ?, revision = revision + 1, last_command_id = ?
    WHERE room_id = ? AND id = ? AND revision = ? AND status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.state = 'WAITING'
        AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = r.id AND m.state != 'WAITING'))
      AND NOT EXISTS (SELECT 1 FROM command_receipts c WHERE c.room_id = participants.room_id
        AND c.actor_id = ? AND c.request_id = ?)
  `).bind(input.nickname, input.nicknameKey, marker, input.roomId, input.participantId,
    input.expectedParticipantRevision, actorId, input.requestId), database.prepare(`
    INSERT INTO command_receipts (room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms)
    SELECT p.room_id, ?, ?, ?, 'renamed', ?, ?, r.expires_at_ms
    FROM participants p JOIN rooms r ON r.id = p.room_id
    WHERE p.room_id = ? AND p.id = ? AND p.last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, json(result), input.nowMs,
    input.roomId, input.participantId, marker)];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) return result;
  } catch (error) {
    const committed = await loadCommandReceipt<typeof result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  const raced = await loadCommandReceipt<typeof result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  throw new PersistenceConflictError("invalid_state", "room started or participant state changed");
}

async function loadJoinReceipt(
  database: PersistenceDatabase,
  input: Pick<JoinRoomInput, "roomId" | "tokenHash" | "requestId" | "bodyHash">,
): Promise<JoinedParticipant | null> {
  const receipt = await loadCommandReceipt<JoinedParticipant>(
    database,
    input.roomId,
    `join:${input.tokenHash}`,
    input.requestId,
    input.bodyHash,
  );
  if (!receipt) return null;
  const participant = await database.prepare(
    "SELECT status FROM participants WHERE room_id = ? AND id = ? AND token_hash = ?",
  ).bind(input.roomId, receipt.participantId, input.tokenHash).first<{ status: string }>();
  if (!participant || participant.status === "REMOVED") {
    throw new PersistenceConflictError("not_authorized", "removed participant credentials cannot rejoin", 403);
  }
  return receipt;
}

export async function joinRoom(
  database: PersistenceDatabase,
  input: JoinRoomInput,
): Promise<JoinedParticipant> {
  const actorId = `join:${input.tokenHash}`;
  const existing = await loadJoinReceipt(database, input);
  if (existing) return existing;
  const room = await database.prepare("SELECT kind FROM rooms WHERE id = ?")
    .bind(input.roomId).first<{ kind: "class" | "mate" }>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  const capacity = room.kind === "class"
    ? (database.classCompetitionCapacity ?? PUBLIC_CONFIG.participantLimits.classCompetition)
    : PUBLIC_CONFIG.participantLimits.mateMatch;
  const marker = commandMarker(actorId, input.requestId);

  // joinedOrder is derived inside the same write transaction as the capacity
  // gate, so two callers cannot claim the same slot.
  const statements = [
    database.prepare(`
      UPDATE rooms
      SET revision = revision + 1, last_command_id = ?
      WHERE id = ? AND state = 'WAITING' AND expires_at_ms > ?
        AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state != 'WAITING')
        AND (SELECT COUNT(*) FROM participants WHERE room_id = rooms.id AND status != 'REMOVED') < ?
        AND NOT EXISTS (
          SELECT 1 FROM command_receipts
          WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
        )
    `).bind(marker, input.roomId, input.nowMs, capacity, actorId, input.requestId),
    database.prepare(`
      INSERT INTO participants (
        room_id, id, token_hash, nickname, nickname_key, joined_at_ms, joined_order
      )
      SELECT r.id, ?, ?, ?, ?, ?,
        (SELECT COUNT(*) + 1 FROM participants WHERE room_id = r.id)
      FROM rooms r WHERE r.id = ? AND r.last_command_id = ?
    `).bind(
      input.participantId, input.tokenHash, input.nickname, input.nicknameKey,
      input.nowMs, input.roomId, marker,
    ),
    database.prepare(`
      INSERT INTO command_receipts (
        room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
      )
      SELECT r.id, ?, ?, ?, 'joined',
        json_object(
          'roomId', r.id,
          'participantId', p.id,
          'joinedOrder', p.joined_order,
          'participantRevision', p.revision
        ), ?, r.expires_at_ms
      FROM rooms r JOIN participants p ON p.room_id = r.id AND p.id = ?
      WHERE r.id = ? AND r.last_command_id = ?
    `).bind(actorId, input.requestId, input.bodyHash, input.nowMs, input.participantId, input.roomId, marker),
  ];
  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) {
      const stored = await loadJoinReceipt(database, input);
      if (stored) return stored;
    }
  } catch (error) {
    const raced = await loadJoinReceipt(database, input);
    if (raced) return raced;
    throw error;
  }
  const raced = await loadJoinReceipt(database, input);
  if (raced) return raced;
  const latest = await database.prepare(`
    SELECT state, expires_at_ms,
      (SELECT COUNT(*) FROM participants WHERE room_id = rooms.id AND status != 'REMOVED') AS participant_count
    FROM rooms WHERE id = ?
  `).bind(input.roomId).first<{ state: string; expires_at_ms: number; participant_count: number }>();
  if (!latest) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (latest.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (latest.state !== "WAITING") throw new PersistenceConflictError("invalid_state", "room is no longer accepting participants");
  if (latest.participant_count >= capacity) throw new PersistenceConflictError("capacity", "room capacity reached");
  throw new PersistenceConflictError("stale_room_revision", "room changed while joining");
}

export type RemoveParticipantInput = {
  readonly roomId: string;
  readonly actorId: string;
  readonly targetParticipantId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly expectedRoomRevision: number;
  readonly expectedParticipantRevision: number;
  readonly nowMs: number;
};

export type RemovedParticipant = {
  readonly participantId: string;
  readonly participantStatus: "REMOVED";
  readonly participantRevision: number;
  readonly roomRevision: number;
};

export async function removeParticipant(
  database: PersistenceDatabase,
  input: RemoveParticipantInput,
): Promise<RemovedParticipant> {
  const actorId = `remove:${input.actorId}`;
  const existing = await loadCommandReceipt<RemovedParticipant>(
    database,
    input.roomId,
    actorId,
    input.requestId,
    input.bodyHash,
  );
  if (existing) return existing;

  const result: RemovedParticipant = {
    participantId: input.targetParticipantId,
    participantStatus: "REMOVED",
    participantRevision: input.expectedParticipantRevision + 1,
    roomRevision: input.expectedRoomRevision + 1,
  };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms
    SET revision = revision + 1, last_command_id = ?
    WHERE id = ? AND revision = ? AND state = 'WAITING'
      AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state != 'WAITING')
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND (mate_host_id IS NULL OR mate_host_id != ?)
      AND EXISTS (
        SELECT 1 FROM participants p
        WHERE p.room_id = rooms.id AND p.id = ? AND p.status != 'REMOVED' AND p.revision = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts
        WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
      )
  `).bind(
    marker,
    input.roomId,
    input.expectedRoomRevision,
    input.targetParticipantId,
    input.targetParticipantId,
    input.expectedParticipantRevision,
    actorId,
    input.requestId,
  ), database.prepare(`
    UPDATE participants
    SET status = 'REMOVED', revision = revision + 1, last_command_id = ?
    WHERE room_id = ? AND id = ? AND revision = ? AND status != 'REMOVED'
      AND EXISTS (
        SELECT 1 FROM rooms r WHERE r.id = participants.room_id AND r.last_command_id = ?
      )
  `).bind(
    marker,
    input.roomId,
    input.targetParticipantId,
    input.expectedParticipantRevision,
    marker,
  ), database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT r.id, ?, ?, ?, 'participant_removed', ?, ?, r.expires_at_ms
    FROM rooms r JOIN participants p ON p.room_id = r.id AND p.id = ?
    WHERE r.id = ? AND r.last_command_id = ? AND p.last_command_id = ?
  `).bind(
    actorId,
    input.requestId,
    input.bodyHash,
    json(result),
    input.nowMs,
    input.targetParticipantId,
    input.roomId,
    marker,
    marker,
  )];

  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) return result;
  } catch (error) {
    const committed = await loadCommandReceipt<RemovedParticipant>(
      database,
      input.roomId,
      actorId,
      input.requestId,
      input.bodyHash,
    );
    if (committed) return committed;
    throw error;
  }

  const raced = await loadCommandReceipt<RemovedParticipant>(
    database,
    input.roomId,
    actorId,
    input.requestId,
    input.bodyHash,
  );
  if (raced) return raced;
  const latest = await database.prepare(`
    SELECT r.state, r.revision, r.expires_at_ms, r.mate_host_id,
      CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms,
      p.status AS participant_status, p.revision AS participant_revision
    FROM rooms r LEFT JOIN participants p ON p.room_id = r.id AND p.id = ?
    WHERE r.id = ?
  `).bind(input.targetParticipantId, input.roomId).first<{
    state: string;
    revision: number;
    expires_at_ms: number;
    mate_host_id: string | null;
    database_now_ms: number;
    participant_status: string | null;
    participant_revision: number | null;
  }>();
  if (!latest) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (latest.expires_at_ms <= latest.database_now_ms) {
    throw new PersistenceConflictError("expired", "room expired", 410);
  }
  if (latest.state !== "WAITING") {
    throw new PersistenceConflictError("invalid_state", `cannot remove a participant in ${latest.state}`);
  }
  if (latest.mate_host_id === input.targetParticipantId) {
    throw new PersistenceConflictError("not_authorized", "the mate host cannot be removed", 403);
  }
  if (latest.participant_status === null || latest.participant_status === "REMOVED") {
    throw new PersistenceConflictError("participant_not_found", "participant not found", 404);
  }
  if (latest.revision !== input.expectedRoomRevision) {
    throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  }
  if (latest.participant_revision !== input.expectedParticipantRevision) {
    throw new PersistenceConflictError("stale_participant_revision", "participant revision is stale");
  }
  throw new PersistenceConflictError("database_conflict", "participant removal did not commit");
}
