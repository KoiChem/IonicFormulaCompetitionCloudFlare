export type SqlValue = string | number | null;

export type SqlRunResult = {
  readonly success: boolean;
  readonly results?: readonly unknown[];
  readonly meta: { readonly changes?: number };
};

export interface PreparedSql {
  readonly query?: string;
  bind(...values: SqlValue[]): PreparedSql;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<SqlRunResult>;
}

export interface PersistenceDatabase {
  readonly transactional?:boolean;
  readonly classCompetitionCapacity?: number;
  prepare(query: string): PreparedSql;
  batch(statements: PreparedSql[]): Promise<readonly SqlRunResult[]>;
}

export function fromD1(database: PersistenceDatabase): PersistenceDatabase {
  return {
    transactional: false,
    prepare: query => database.prepare(query),
    batch: statements => database.batch(statements),
  };
}

export type PersistenceErrorCode =
  | "active_room_exists"
  | "capacity"
  | "database_conflict"
  | "deadline"
  | "expired"
  | "invalid_state"
  | "mate_disabled"
  | "not_authorized"
  | "not_found"
  | "participant_not_found"
  | "not_ready"
  | "rate_limited"
  | "request_id_reused"
  | "stale_participant_revision"
  | "stale_question_profile"
  | "stale_room_revision";

export class PersistenceConflictError extends Error {
  readonly status: number;

  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    status = 409,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PersistenceConflictError";
    this.status = status;
  }
}

export type StoredReceipt = {
  readonly body_hash: string;
  readonly result_json: string;
};

export async function loadCommandReceipt<T>(
  database: PersistenceDatabase,
  roomId: string,
  actorId: string,
  requestId: string,
  bodyHash: string,
): Promise<T | null> {
  const receipt = await database.prepare(
    `SELECT c.body_hash, c.result_json
     FROM command_receipts c JOIN rooms r ON r.id = c.room_id
     WHERE c.room_id = ? AND c.actor_id = ? AND c.request_id = ?
       AND c.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
       AND r.expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
  ).bind(roomId, actorId, requestId).first<StoredReceipt>();
  if (!receipt) return null;
  if (receipt.body_hash !== bodyHash) {
    throw new PersistenceConflictError("request_id_reused", "requestId was already used with another payload");
  }
  return JSON.parse(receipt.result_json) as T;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function commandMarker(actorId: string, requestId: string): string {
  return `${actorId}:${requestId}:${crypto.randomUUID()}`;
}

export function changed(result: SqlRunResult | undefined): boolean {
  return Number(result?.meta.changes ?? 0) > 0;
}

export function isRetryableDatabaseConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED") return true;
  return typeof value.message === "string" && /(?:database.*(?:busy|locked)|D1_ERROR.*conflict)/i.test(value.message);
}
