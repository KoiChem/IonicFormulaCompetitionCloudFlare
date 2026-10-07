import type { InternalQuestion, PublicQuestion } from "../../games/ionic-formula/shared/types";
import type { V2Operation } from "../../competition-core/v2-operations";

export type V2LocalRecord = {
  manifestId: string;
  preparationGeneration: number;
  evaluatorVersion: string;
  gradingMode: "immediate" | "deferred";
  questions: (InternalQuestion | PublicQuestion)[];
  writerEpoch: number;
  ackSeq: number;
  operations: V2Operation[];
  inflight?: { requestId: string; operations: V2Operation[]; writerEpoch?: number; manifestId?: string; evaluatorVersion?: string };
  ordinal: number;
  reviewTarget?: { questionId: string; fieldId: "formula" | "name" };
  drafts: Record<string, { value: unknown; editedElapsedMs: number }>;
  finished: boolean;
  expiresAtMs?: number;
};

export function isRestorableV2Local(value: unknown, manifestId: string, evaluatorVersion: string, questionIds: readonly string[]): value is V2LocalRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<V2LocalRecord>;
  return row.manifestId === manifestId && row.evaluatorVersion === evaluatorVersion
    && (row.gradingMode === "immediate" || row.gradingMode === "deferred")
    && Array.isArray(row.questions) && row.questions.length === questionIds.length
    && row.questions.every((question, index) => question?.id === questionIds[index])
    && Number.isInteger(row.writerEpoch) && row.writerEpoch! >= 1
    && Number.isInteger(row.ackSeq) && row.ackSeq! >= 0
    && Number.isInteger(row.ordinal) && row.ordinal! >= 0 && row.ordinal! < questionIds.length
    && (!row.reviewTarget || typeof row.reviewTarget.questionId === "string" && ["formula", "name"].includes(row.reviewTarget.fieldId))
    && Array.isArray(row.operations) && row.operations.every(operation => operation && Number.isInteger(operation.seq) && typeof operation.operationId === "string")
    && row.operations.every((operation, index) => operation.seq === index + 1)
    && row.ackSeq! <= row.operations.length
    && (!row.inflight || typeof row.inflight.requestId === "string" && Array.isArray(row.inflight.operations))
    && !!row.drafts && typeof row.drafts === "object" && !Array.isArray(row.drafts)
    && typeof row.finished === "boolean";
}

const DATABASE = "ionic-formula-competition-v2";
const STORE = "sessions";
export const v2LocalKey = (roomId: string, participantId: string, manifestId: string) => `${roomId}:${participantId}:${manifestId}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(key: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      let value: T;
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? request.error);
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  } finally { db.close(); }
}
export async function readV2Local(key: string) {
  const record = await transact<V2LocalRecord | undefined>(key, "readonly", store => store.get(key));
  if (record?.expiresAtMs && record.expiresAtMs <= Date.now()) {
    await deleteV2Local(key);
    return undefined;
  }
  return record;
}
export const writeV2Local = (key: string, record: V2LocalRecord) => transact<IDBValidKey>(key, "readwrite", store => store.put(record, key));
export const deleteV2Local = (key: string) => transact<undefined>(key, "readwrite", store => store.delete(key));
export async function pruneExpiredV2Local() {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const record = entry.value as V2LocalRecord;
        if (record.expiresAtMs && record.expiresAtMs <= Date.now()) entry.delete();
        entry.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
