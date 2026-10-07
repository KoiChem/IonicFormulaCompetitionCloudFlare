import type { PersistenceDatabase } from "./db";

export type CleanupExpiredInput = { readonly nowMs: number; readonly limit: number };

export async function cleanupExpired(
  database: PersistenceDatabase,
  input: CleanupExpiredInput,
): Promise<{ readonly deletedRooms: number; readonly deletedSiteSettingReceipts: number }> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) throw new TypeError("cleanup limit must be a positive integer");
  const { results: expiredRooms } = await database.prepare(`
    SELECT id FROM rooms WHERE expires_at_ms <= ? ORDER BY expires_at_ms, id LIMIT ?
  `).bind(input.nowMs, input.limit).all<{ id: string }>();
  const { results: expiredSiteSettingReceipts } = await database.prepare(`
    SELECT teacher_id, request_id FROM site_setting_receipts
    WHERE expires_at_ms <= ? ORDER BY expires_at_ms, teacher_id, request_id LIMIT ?
  `).bind(input.nowMs, input.limit).all<{ teacher_id: string; request_id: string }>();
  if (!expiredRooms.length && !expiredSiteSettingReceipts.length) {
    return { deletedRooms: 0, deletedSiteSettingReceipts: 0 };
  }
  // Fixed statement count: large cleanup limits must not consume one query per row.
  const deleted = await database.batch([
    database.prepare(`DELETE FROM rooms WHERE expires_at_ms <= ?
      AND id IN (SELECT value FROM json_each(?)) RETURNING id`)
      .bind(input.nowMs, JSON.stringify(expiredRooms.map(({ id }) => id))),
    database.prepare(`DELETE FROM site_setting_receipts WHERE expires_at_ms <= ?
      AND (teacher_id, request_id) IN (
        SELECT json_extract(value, '$.teacher_id'), json_extract(value, '$.request_id') FROM json_each(?)) RETURNING teacher_id, request_id`)
      .bind(input.nowMs, JSON.stringify(expiredSiteSettingReceipts)),
  ]);
  return {
    deletedRooms: deleted[0]?.results?.length ?? Number(deleted[0]?.meta.changes ?? 0),
    deletedSiteSettingReceipts: deleted[1]?.results?.length ?? Number(deleted[1]?.meta.changes ?? 0),
  };
}
