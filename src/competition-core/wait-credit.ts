export type WaitCreditInput = {
  readonly waitMs: number;
  readonly sourceActionAtMs: number;
  readonly nextAcceptedAtMs: number;
  readonly previousRawElapsedMs: number;
  readonly nextRawElapsedMs: number;
};

export function validateWaitCredit(input: WaitCreditInput): number {
  const { waitMs, sourceActionAtMs, nextAcceptedAtMs, previousRawElapsedMs, nextRawElapsedMs } = input;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || !Number.isSafeInteger(sourceActionAtMs)) return 0;
  if (sourceActionAtMs >= nextAcceptedAtMs || waitMs > nextAcceptedAtMs - sourceActionAtMs) return 0;
  if (waitMs > nextRawElapsedMs - previousRawElapsedMs) return 0;
  return waitMs;
}
