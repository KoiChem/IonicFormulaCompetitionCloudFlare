import type { IonicFormulaGameSettings } from "../games/ionic-formula/shared/types";
import {
  PersistenceConflictError,
  changed,
  commandMarker,
  json,
  loadCommandReceipt,
  type PersistenceDatabase,
} from "./db";

export type UpdateRoomSettingsInput = {
  readonly roomId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly bodyHash: string;
  readonly expectedRevision: number;
  readonly settings: IonicFormulaGameSettings;
  readonly maxScore: number;
  readonly nowMs: number;
};

export type UpdatedRoomSettings = {
  readonly revision: number;
  readonly settings: IonicFormulaGameSettings;
  readonly maxScore: number;
};

export async function updateRoomSettingsCommand(
  database: PersistenceDatabase,
  input: UpdateRoomSettingsInput,
): Promise<UpdatedRoomSettings> {
  const actorId = `settings:${input.actorId}`;
  const existing = await loadCommandReceipt<UpdatedRoomSettings>(
    database, input.roomId, actorId, input.requestId, input.bodyHash,
  );
  if (existing) return existing;

  const result: UpdatedRoomSettings = {
    revision: input.expectedRevision + 1,
    settings: input.settings,
    maxScore: input.maxScore,
  };
  const marker = commandMarker(actorId, input.requestId);
  const statements = [database.prepare(`
    UPDATE rooms SET settings_json = ?, dataset_version = ?, max_score = ?, revision = revision + 1, last_command_id = ?
    WHERE id = ? AND state = 'WAITING' AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM v2_room_manifests m WHERE m.room_id = rooms.id AND m.state != 'WAITING')
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NOT EXISTS (
        SELECT 1 FROM command_receipts
        WHERE room_id = rooms.id AND actor_id = ? AND request_id = ?
      )
  `).bind(
    json(input.settings), input.settings.chemistryContentVersion ?? "4", input.maxScore, marker, input.roomId, input.expectedRevision,
    actorId, input.requestId,
  )];
  statements.push(database.prepare(`
    INSERT INTO command_receipts (
      room_id, actor_id, request_id, body_hash, result_code, result_json, processed_at_ms, expires_at_ms
    )
    SELECT id, ?, ?, ?, 'settings_updated', ?, ?, expires_at_ms
    FROM rooms WHERE id = ? AND last_command_id = ?
  `).bind(
    actorId, input.requestId, input.bodyHash, json(result), input.nowMs,
    input.roomId, marker,
  ));

  try {
    const batch = await database.batch(statements);
    if (changed(batch[0])) return result;
  } catch (error) {
    const committed = await loadCommandReceipt<UpdatedRoomSettings>(
      database, input.roomId, actorId, input.requestId, input.bodyHash,
    );
    if (committed) return committed;
    throw error;
  }
  const raced = await loadCommandReceipt<UpdatedRoomSettings>(
    database, input.roomId, actorId, input.requestId, input.bodyHash,
  );
  if (raced) return raced;
  throw new PersistenceConflictError("stale_room_revision", "room settings changed");
}

type SiteSettingReceipt = { readonly body_hash: string; readonly result_json: string };

const SITE_SETTING_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type UpdatedSiteSettings = { readonly enabled: boolean; readonly revision: number };

async function loadSiteSettingReceipt(
  database: PersistenceDatabase,
  teacherId: string,
  requestId: string,
  bodyHash: string,
): Promise<UpdatedSiteSettings | null> {
  const receipt = await database.prepare(`
    SELECT body_hash, result_json FROM site_setting_receipts
    WHERE teacher_id = ? AND request_id = ?
      AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  `).bind(teacherId, requestId).first<SiteSettingReceipt>();
  if (!receipt) return null;
  if (receipt.body_hash !== bodyHash) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  return JSON.parse(receipt.result_json) as UpdatedSiteSettings;
}

export async function updateSiteSettingsCommand(
  database: PersistenceDatabase,
  input: {
    readonly teacherId: string;
    readonly requestId: string;
    readonly bodyHash: string;
    readonly expectedRevision: number;
    readonly enabled: boolean;
    readonly nowMs: number;
  },
): Promise<UpdatedSiteSettings> {
  const existing = await loadSiteSettingReceipt(
    database, input.teacherId, input.requestId, input.bodyHash,
  );
  if (existing) return existing;
  const result = { enabled: input.enabled, revision: input.expectedRevision + 1 };
  const marker = commandMarker(`site-settings:${input.teacherId}`, input.requestId);
  const statements = [database.prepare(`
    DELETE FROM site_setting_receipts
    WHERE teacher_id = ? AND request_id = ?
      AND expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
  `).bind(input.teacherId, input.requestId), database.prepare(`
    INSERT INTO site_settings (id, mate_match_enabled, revision, updated_at_ms)
    VALUES (1, 1, 0, 0) ON CONFLICT(id) DO NOTHING
  `), database.prepare(`
    UPDATE site_settings
    SET mate_match_enabled = ?, revision = revision + 1, updated_at_ms = ?, last_command_id = ?
    WHERE id = 1 AND revision = ?
      AND NOT EXISTS (
        SELECT 1 FROM site_setting_receipts WHERE teacher_id = ? AND request_id = ?
      )
  `).bind(
    input.enabled ? 1 : 0, input.nowMs, marker, input.expectedRevision,
    input.teacherId, input.requestId,
  ), database.prepare(`
    INSERT INTO site_setting_receipts (
      teacher_id, request_id, body_hash, result_json, processed_at_ms, expires_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ? FROM site_settings WHERE id = 1 AND last_command_id = ?
  `).bind(
    input.teacherId, input.requestId, input.bodyHash, json(result), input.nowMs,
    input.nowMs + SITE_SETTING_RECEIPT_RETENTION_MS, marker,
  )];

  try {
    const batch = await database.batch(statements);
    if (changed(batch[2])) return result;
  } catch (error) {
    const committed = await loadSiteSettingReceipt(
      database, input.teacherId, input.requestId, input.bodyHash,
    );
    if (committed) return committed;
    throw error;
  }
  const raced = await loadSiteSettingReceipt(
    database, input.teacherId, input.requestId, input.bodyHash,
  );
  if (raced) return raced;
  throw new PersistenceConflictError("stale_room_revision", "site settings changed");
}
