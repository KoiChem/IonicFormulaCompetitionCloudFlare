import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { InternalQuestion } from "../../src/games/ionic-formula/shared/types";

type Bound = string | number | null;

class SqlitePrepared {
  #bindings: Bound[] = [];

  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    private readonly operationMetrics: { reads: number; writes: number },
  ) {}

  bind(...bindings: Bound[]) {
    const statement = new SqlitePrepared(this.database, this.query, this.operationMetrics);
    statement.#bindings = bindings;
    return statement;
  }

  async first<T>(): Promise<T | null> {
    this.operationMetrics.reads += 1;
    return (this.database.prepare(this.query).get(...this.#bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    this.operationMetrics.reads += 1;
    return { results: this.database.prepare(this.query).all(...this.#bindings) as T[] };
  }

  async run() {
    this.operationMetrics.writes += 1;
    const result = this.database.prepare(this.query).run(...this.#bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  raw() {
    this.operationMetrics.reads += 1;
    return this.database.prepare(this.query).all(...this.#bindings).map((row) => Object.values(row));
  }
}

export class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  #batchTail: Promise<void> = Promise.resolve();
  #transientBatchFailures = 0;
  #databaseNowMs = 0;
  #commitThenThrow = false;
  #operationMetrics = { reads: 0, writes: 0, batches: 0 };
  #batchPause: {
    reached: () => void;
    wait: Promise<void>;
  } | null = null;

  constructor() {
    this.sqlite.function("unixepoch", (modifier) => {
      if (modifier !== "subsec") throw new Error(`unsupported unixepoch modifier: ${modifier}`);
      return this.#databaseNowMs / 1_000;
    });
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const migrationDirectory = fileURLToPath(new URL("../../drizzle/", import.meta.url));
    for (const migration of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(`${migrationDirectory}/${migration}`, "utf8"));
    }
  }

  prepare(query: string) {
    return new SqlitePrepared(this.sqlite, query, this.#operationMetrics);
  }

  async batch(statements: SqlitePrepared[]) {
    this.#operationMetrics.batches += 1;
    if (this.#transientBatchFailures > 0) {
      this.#transientBatchFailures -= 1;
      throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
    }
    const pause = this.#batchPause;
    if (pause) {
      this.#batchPause = null;
      pause.reached();
      await pause.wait;
    }
    let release!: () => void;
    const previous = this.#batchTail;
    this.#batchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.sqlite.exec("BEGIN IMMEDIATE");
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      if (this.#commitThenThrow) {
        this.#commitThenThrow = false;
        throw Object.assign(new Error("response lost after commit"), { committed: true });
      }
      return results;
    } catch (error) {
      if (!((error as { committed?: boolean }).committed)) this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }

  failNextBatches(count: number) {
    this.#transientBatchFailures = count;
  }

  setNow(nowMs: number) {
    this.#databaseNowMs = nowMs;
  }

  metrics() {
    return { ...this.#operationMetrics };
  }

  throwAfterNextBatchCommit() {
    this.#commitThenThrow = true;
  }

  pauseNextBatch() {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.#batchPause = { reached, wait };
    return { reached: reachedPromise, release };
  }

  close() {
    this.sqlite.close();
  }
}

export const QUESTION: InternalQuestion = Object.freeze({
  id: "question-1",
  ordinal: 0,
  itemId: "sodium",
  category: "ionSimple",
  variant: "ionNameToFormula",
  prompt: Object.freeze({ kind: "ionName", values: Object.freeze([{ type: "name" as const, value: "ナトリウムイオン" }]) }),
  fields: Object.freeze([{ id: "formula" as const, type: "formula" as const }]),
  maxScore: 1,
  answer: Object.freeze({ type: "formula" as const, canonical: "Na+", accepted: Object.freeze([]) }),
});

export const ROOM_SETTINGS = Object.freeze({
  questionCount: 5 as const,
  timeLimitMinutes: 3 as const,
  mode: "ion" as const,
  difficulty: "normal" as const,
  ionAnswer: "formula" as const,
  compoundPrompts: Object.freeze({ formula: true, name: false }),
  compoundAnswer: "formula" as const,
});

export function classRoomInput(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-1",
    publicId: "public-1",
    joinCode: "ABC123",
    kind: "class" as const,
    ownerTeacherId: "teacher-1",
    settings: ROOM_SETTINGS,
    gameId: "ionic-formula",
    gameVersion: "1",
    datasetVersion: "4",
    maxScore: 5,
    actorKeyHash: "teacher-key",
    requestId: "create-1",
    bodyHash: "create-body",
    nowMs: 1_000,
    expiresAtMs: 1_000 + 7 * 24 * 60 * 60 * 1_000,
    ...overrides,
  };
}

export function mateRoomInput(overrides: Record<string, unknown> = {}) {
  return {
    ...classRoomInput({
      roomId: "mate-room",
      publicId: "mate-public",
      joinCode: "MATE01",
      kind: "mate",
      ownerTeacherId: null,
      actorKeyHash: "mate-creator",
      requestId: "mate-create",
      expiresAtMs: 1_000 + 24 * 60 * 60 * 1_000,
    }),
    host: {
      participantId: "host",
      tokenHash: "host-token",
      nickname: "Host",
      nicknameKey: "host",
    },
    ...overrides,
  };
}

export function joinInput(index: number, overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-1",
    participantId: `p-${index}`,
    tokenHash: `token-${index}`,
    nickname: `Player ${index}`,
    nicknameKey: `player-${index}`,
    requestId: `join-${index}`,
    bodyHash: `join-body-${index}`,
    nowMs: 1_500,
    ...overrides,
  };
}

export async function scalar(database: SqliteD1, sql: string, ...bindings: Bound[]) {
  const row = await database.prepare(sql).bind(...bindings).first<Record<string, number>>();
  return row ? Object.values(row)[0] : null;
}
