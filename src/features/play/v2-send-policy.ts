export type SendFailure = { status?: number; code?: string; retryAfterMs?: number | null };

export function retryableOperationFailure(failure: SendFailure): boolean {
  if (failure.code === "timeout" || failure.code === "database_conflict") return true;
  return failure.status === undefined || failure.status === 408 || failure.status === 429 || failure.status >= 500;
}

export function operationRetryDelay(failure: SendFailure, baseMs: number, collecting: boolean, random = Math.random()): number {
  if (failure.status === 429 && failure.retryAfterMs != null) return Math.max(0, failure.retryAfterMs);
  const jittered = Math.round(baseMs * (0.8 + random * 0.4));
  return collecting ? Math.min(1000, jittered) : jittered;
}
