import {insertRoomQuestions} from './question-insert';
import type { SavedQuestionProfile } from "./question-profiles";
import { toPublicQuestion } from "../games/ionic-formula/server/question-generator";
import type { InternalQuestion, IonicFormulaGameSettings } from "../games/ionic-formula/shared/types";
import { PUBLIC_CONFIG } from "../config/public";
import {
  PersistenceConflictError,
  changed,
  commandMarker,
  json,
  loadCommandReceipt,
  type PersistenceDatabase,
} from "./db";

export type RoomKind = "class" | "mate";

type HostParticipant = {
  readonly participantId: string;
  readonly tokenHash: string;
  readonly nickname: string;
  readonly nicknameKey: string;
};

export type CreateRoomInput = {
  readonly roomId: string;
  readonly publicId: string;
  readonly joinCode: string;
  readonly kind: RoomKind;
  readonly ownerTeacherId: string | null;
  readonly settings: IonicFormulaGameSettings;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly datasetVersion: string;
  readonly maxScore: number;
  readonly actorKeyHash: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly host?: HostParticipant;
  readonly questionProfile?: SavedQuestionProfile;
};

export type CreatedRoom = {
  readonly roomId: string;
  readonly publicId: string;
  readonly joinCode: string;
  readonly kind: RoomKind;
  readonly state: "WAITING";
  readonly revision: number;
  readonly hostParticipant?: {
    readonly id: string;
    readonly nickname: string;
    readonly revision: 0;
  };
};

const MATE_CREATION_LIMIT = 3;
const MATE_CREATION_WINDOW_MS = 10 * 60 * 1_000;

type CreationReceipt = {
  readonly body_hash: string;
  readonly result_json: string;
  readonly expires_at_ms: number;
  readonly database_now_ms: number;
};

async function loadCreationReceipt(
  database: PersistenceDatabase,
  input: Pick<CreateRoomInput, "actorKeyHash" | "requestId" | "bodyHash">,
): Promise<CreatedRoom | null> {
  const receipt = await database.prepare(
    `SELECT c.body_hash, c.result_json, c.expires_at_ms,
       CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
     FROM creation_receipts c JOIN rooms r ON r.id = c.room_id
     WHERE c.actor_key_hash = ? AND c.request_id = ?`,
  ).bind(input.actorKeyHash, input.requestId).first<CreationReceipt>();
  if (!receipt) return null;
  if (receipt.expires_at_ms <= receipt.database_now_ms) {
    throw new PersistenceConflictError("expired", "creation receipt expired", 410);
  }
  if (receipt.body_hash !== input.bodyHash) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  return JSON.parse(receipt.result_json) as CreatedRoom;
}

export async function createRoom(
  database: PersistenceDatabase,
  input: CreateRoomInput,
): Promise<CreatedRoom> {
  const existing = await loadCreationReceipt(database, input);
  if (existing) return existing;
  if (input.kind === "mate" && !input.host) throw new TypeError("mate rooms require a host participant");
  if (input.kind === "class" && input.host) throw new TypeError("class rooms cannot have a mate host");
  const mateSettingBefore = input.kind === "mate"
    ? await database.prepare("SELECT mate_match_enabled, revision FROM site_settings WHERE id = 1")
      .first<{ mate_match_enabled: number; revision: number }>()
    : null;

  const result: CreatedRoom = {
    roomId: input.roomId,
    publicId: input.publicId,
    joinCode: input.joinCode,
    kind: input.kind,
    state: "WAITING",
    revision: 0,
    ...(input.host ? {
      hostParticipant: {
        id: input.host.participantId,
        nickname: input.host.nickname,
        revision: 0 as const,
      },
    } : {}),
  };
  const marker = commandMarker(input.actorKeyHash, input.requestId);
  const statements = [
    database.prepare(`
      INSERT INTO rooms (
        id, public_id, join_code, kind, owner_teacher_id, mate_host_id, settings_json,
        game_id, game_version, dataset_version, state, revision, max_score,
        created_at_ms, expires_at_ms, last_command_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', 0, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM creation_receipts WHERE actor_key_hash = ? AND request_id = ?
      )
        AND (
          ? != 'mate'
          OR (
            COALESCE((SELECT mate_match_enabled FROM site_settings WHERE id = 1), 1) = 1
            AND
            NOT EXISTS (
              SELECT 1 FROM creation_receipts active_receipt
              JOIN rooms active_room ON active_room.id = active_receipt.room_id
              WHERE active_receipt.actor_key_hash = ? AND active_room.kind = 'mate'
                AND active_room.state NOT IN ('FINISHED', 'CANCELLED', 'EXPIRED')
                AND active_room.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            )
            AND (
              SELECT COUNT(*) FROM creation_receipts recent_receipt
              JOIN rooms recent_room ON recent_room.id = recent_receipt.room_id
              WHERE recent_receipt.actor_key_hash = ? AND recent_room.kind = 'mate'
                AND recent_receipt.processed_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?
            ) < ?
          )
        )
    `).bind(
      input.roomId, input.publicId, input.joinCode, input.kind,
      input.ownerTeacherId,
      input.host?.participantId ?? null,
      json(input.settings), input.gameId, input.gameVersion, input.datasetVersion,
      input.maxScore, input.nowMs, input.expiresAtMs, marker,
      input.actorKeyHash, input.requestId,
      input.kind, input.actorKeyHash, input.actorKeyHash,
      MATE_CREATION_WINDOW_MS, MATE_CREATION_LIMIT,
    ),
  ];
  if (input.questionProfile) {
    statements.push(database.prepare(`INSERT INTO room_question_profiles (room_id, profile_json, profile_revision)
      SELECT id, ?, ? FROM rooms WHERE id = ? AND last_command_id = ?`).bind(
        json(input.questionProfile.profile), input.questionProfile.revision, input.roomId, marker,
      ));
  }
  if (input.host) {
    statements.push(database.prepare(`
      INSERT INTO participants (
        room_id, id, token_hash, nickname, nickname_key, joined_at_ms, joined_order
      )
      SELECT id, ?, ?, ?, ?, ?, 1 FROM rooms
      WHERE id = ? AND last_command_id = ?
    `).bind(
      input.host.participantId, input.host.tokenHash, input.host.nickname,
      input.host.nicknameKey, input.nowMs, input.roomId, marker,
    ));
  }
  statements.push(database.prepare(`
    INSERT INTO creation_receipts (
      actor_key_hash, request_id, body_hash, room_id, result_json, processed_at_ms, expires_at_ms
    )
    SELECT ?, ?, ?, id, ?, ?, expires_at_ms FROM rooms
    WHERE id = ? AND last_command_id = ?
  `).bind(
    input.actorKeyHash, input.requestId, input.bodyHash, json(result), input.nowMs,
    input.roomId, marker,
  ));

  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await loadCreationReceipt(database, input);
    if (raced) return raced;
    throw error;
  }
  const stored = await loadCreationReceipt(database, input);
  if (!stored && input.kind === "mate") {
    const siteSettings = await database.prepare(
      "SELECT mate_match_enabled, revision FROM site_settings WHERE id = 1",
    ).first<{ mate_match_enabled: number; revision: number }>();
    if (siteSettings?.mate_match_enabled === 0) {
      throw new PersistenceConflictError("mate_disabled", "mate match creation is disabled", 403);
    }
    const limits = await database.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM creation_receipts active_receipt
          JOIN rooms active_room ON active_room.id = active_receipt.room_id
          WHERE active_receipt.actor_key_hash = ? AND active_room.kind = 'mate'
            AND active_room.state NOT IN ('FINISHED', 'CANCELLED', 'EXPIRED')
            AND active_room.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        ) AS has_active,
        COUNT(CASE WHEN recent_receipt.processed_at_ms >
          CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? THEN 1 END) AS recent_count,
        MIN(CASE WHEN recent_receipt.processed_at_ms >
          CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? THEN recent_receipt.processed_at_ms END) AS oldest_recent,
        CAST(unixepoch('subsec') * 1000 AS INTEGER) AS database_now_ms
      FROM creation_receipts recent_receipt
      JOIN rooms recent_room ON recent_room.id = recent_receipt.room_id
      WHERE recent_receipt.actor_key_hash = ? AND recent_room.kind = 'mate'
    `).bind(
      input.actorKeyHash,
      MATE_CREATION_WINDOW_MS,
      MATE_CREATION_WINDOW_MS,
      input.actorKeyHash,
    ).first<{
      has_active: number;
      recent_count: number;
      oldest_recent: number | null;
      database_now_ms: number;
    }>();
    if (limits?.has_active) {
      throw new PersistenceConflictError("active_room_exists", "creation credential already has an unfinished room");
    }
    if (Number(limits?.recent_count ?? 0) >= MATE_CREATION_LIMIT) {
      const remainingMs = Math.max(
        1_000,
        (limits?.oldest_recent ?? limits?.database_now_ms ?? input.nowMs)
          + MATE_CREATION_WINDOW_MS - (limits?.database_now_ms ?? input.nowMs),
      );
      throw new PersistenceConflictError(
        "rate_limited",
        "mate room creation rate limit reached",
        429,
        Math.max(1, Math.ceil(remainingMs / 1_000)),
      );
    }
    const settingRevisionBefore = mateSettingBefore?.revision ?? 0;
    const settingRevisionAfter = siteSettings?.revision ?? 0;
    if (settingRevisionAfter !== settingRevisionBefore) {
      throw new PersistenceConflictError("mate_disabled", "mate match creation was disabled during this request", 403);
    }
  }
  if (!stored) throw new PersistenceConflictError("invalid_state", "room creation did not commit");
  return stored;
}

export type StartRoomInput = {
  readonly roomId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly expectedRoomRevision: number;
  readonly nowMs: number;
  readonly clock?:()=>number;
  readonly startAtMs: number;
  readonly deadlineAtMs: number;
  readonly questions: readonly InternalQuestion[];
};

export type StartedRoom = {
  readonly roomId: string;
  readonly state: "COUNTDOWN";
  readonly roomRevision: number;
  readonly startAtMs: number;
  readonly deadlineAtMs: number;
  readonly questionIds: readonly string[];
};

export type CancelRoomInput = {
  readonly roomId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly expectedRoomRevision: number;
  readonly nowMs: number;
};

export async function cancelRoom(database: PersistenceDatabase, input: CancelRoomInput): Promise<{ state: "CANCELLED"; roomRevision: number }> {
  const actorId = `room:${input.roomId}`;
  const existing = await loadCommandReceipt<{ state: "CANCELLED"; roomRevision: number }>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  const result = { state: "CANCELLED" as const, roomRevision: input.expectedRoomRevision + 1 };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET state = 'CANCELLED', revision = revision + 1, ended_at_ms = ?,
      expires_at_ms = ? + ?, last_command_id = ?
    WHERE id = ? AND revision = ? AND state = 'WAITING' AND expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM command_receipts WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?)
  `).bind(input.nowMs, input.nowMs, PUBLIC_CONFIG.retentionMs.cancelledRoom, marker,
    input.roomId, input.expectedRoomRevision, input.nowMs, actorId, input.requestId)];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    INSERT INTO command_receipts (room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms)
    SELECT id, ?, ?, ?, 'cancelled', ?, ?, expires_at_ms FROM rooms WHERE id = ? AND last_command_id = ?
  `).bind(actorId, input.requestId, input.bodyHash, json(result), input.nowMs, input.roomId, marker));
  let batch;
  try { batch = await database.batch(statements); }
  catch (error) {
    const committed = await loadCommandReceipt<typeof result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) return result;
  const raced = await loadCommandReceipt<typeof result>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  const room = await database.prepare("SELECT state, revision, expires_at_ms FROM rooms WHERE id = ?")
    .bind(input.roomId).first<{ state: string; revision: number; expires_at_ms: number }>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  throw new PersistenceConflictError("invalid_state", `cannot cancel a room in ${room.state}`);
}

export async function startRoom(
  database: PersistenceDatabase,
  input: StartRoomInput,
): Promise<StartedRoom> {
  const actorId = `room:${input.roomId}`;
  const existing = await loadCommandReceipt<StartedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (existing) return existing;
  if (!input.questions.length) throw new TypeError("a room needs at least one question");
  if (input.startAtMs <= input.nowMs || input.deadlineAtMs <= input.startAtMs) throw new TypeError("invalid room schedule");

  const marker = commandMarker(actorId, input.requestId);
  let result: StartedRoom = {
    roomId: input.roomId,
    state: "COUNTDOWN",
    roomRevision: input.expectedRoomRevision + 1,
    startAtMs: input.startAtMs,
    deadlineAtMs: input.deadlineAtMs,
    questionIds: input.questions.map((question) => question.id),
  };
  const statements = [database.prepare(`
    UPDATE rooms
    SET state = 'COUNTDOWN', revision = revision + 1, start_at_ms = ?, deadline_at_ms = ?,
      expires_at_ms = MAX(expires_at_ms, ? + CASE kind WHEN 'class' THEN ? ELSE ? END),
      last_command_id = ?
    WHERE id = ? AND revision = ? AND state = 'WAITING' AND expires_at_ms > ?
      AND (SELECT COUNT(*) FROM participants p WHERE p.room_id = rooms.id AND p.status != 'REMOVED')
        >= CASE rooms.kind WHEN 'class' THEN 1 ELSE 2 END
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts
        WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
      )
  `).bind(
    input.startAtMs, input.deadlineAtMs, input.deadlineAtMs,
    PUBLIC_CONFIG.retentionMs.classCompetition, PUBLIC_CONFIG.retentionMs.mateMatch,
    marker, input.roomId,
    input.expectedRoomRevision, input.nowMs, actorId, input.requestId,
  )];
  statements.push(database.prepare(`
    UPDATE creation_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));
  statements.push(database.prepare(`
    UPDATE command_receipts SET expires_at_ms = (SELECT expires_at_ms FROM rooms WHERE id = ?)
    WHERE room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND last_command_id = ?)
  `).bind(input.roomId, input.roomId, input.roomId, marker));

  statements.push(insertRoomQuestions(database,input.roomId,marker,input.questions));
  statements.push(database.prepare(`
    INSERT INTO participant_fields (room_id, participant_id, question_id, field_id)
    SELECT p.room_id, p.id, q.question_id, json_extract(field.value, '$.id')
    FROM participants p
    JOIN rooms r ON r.id = p.room_id
    JOIN room_questions q ON q.room_id = p.room_id
    JOIN json_each(q.field_spec_json) AS field
    WHERE p.room_id = ? AND p.status = 'ACTIVE' AND r.last_command_id = ?
  `).bind(input.roomId, marker));
  const receipt=()=>database.prepare(`INSERT INTO command_receipts(room_id,actor_id,request_id,body_hash,result_code,result_json,processed_at_ms,expires_at_ms)
    SELECT id,?,?,?,'started',?,?,expires_at_ms FROM rooms WHERE id=? AND last_command_id=?`)
    .bind(actorId,input.requestId,input.bodyHash,json(result),input.clock?.()??input.nowMs,input.roomId,marker);
  const lateSchedule=database.transactional&&input.clock;
  if(!lateSchedule)statements.push(receipt());
  let batch;
  try {
    batch = await database.batch(statements);
    if(lateSchedule&&changed(batch[0])){
      const startedAt=input.clock!()+PUBLIC_CONFIG.countdownSeconds*1000;
      result={...result,startAtMs:startedAt,deadlineAtMs:startedAt+(input.deadlineAtMs-input.startAtMs)};
      await database.batch([
        database.prepare(`UPDATE rooms SET start_at_ms=?,deadline_at_ms=?,expires_at_ms=MAX(expires_at_ms,?+CASE kind WHEN 'class' THEN ? ELSE ? END) WHERE id=? AND last_command_id=?`)
          .bind(result.startAtMs,result.deadlineAtMs,result.deadlineAtMs,PUBLIC_CONFIG.retentionMs.classCompetition,PUBLIC_CONFIG.retentionMs.mateMatch,input.roomId,marker),
        database.prepare(`UPDATE creation_receipts SET expires_at_ms=(SELECT expires_at_ms FROM rooms WHERE id=?) WHERE room_id=?`).bind(input.roomId,input.roomId),
        database.prepare(`UPDATE command_receipts SET expires_at_ms=(SELECT expires_at_ms FROM rooms WHERE id=?) WHERE room_id=?`).bind(input.roomId,input.roomId),receipt(),
      ]);
    }
  } catch (error) {
    const committed = await loadCommandReceipt<StartedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
    if (committed) return committed;
    throw error;
  }
  if (changed(batch[0])) return result;
  const raced = await loadCommandReceipt<StartedRoom>(database, input.roomId, actorId, input.requestId, input.bodyHash);
  if (raced) return raced;
  const room = await database.prepare("SELECT state, revision, expires_at_ms FROM rooms WHERE id = ?")
    .bind(input.roomId).first<{ state: string; revision: number; expires_at_ms: number }>();
  if (!room) throw new PersistenceConflictError("not_found", "room not found", 404);
  if (room.expires_at_ms <= input.nowMs) throw new PersistenceConflictError("expired", "room expired", 410);
  if (room.revision !== input.expectedRoomRevision) throw new PersistenceConflictError("stale_room_revision", "room revision is stale");
  throw new PersistenceConflictError("invalid_state", `cannot start a room in ${room.state}`);
}
