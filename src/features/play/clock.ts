export type ClockSample = { readonly sentAt: number; readonly receivedAt: number; readonly serverNow: number; readonly serverTiming?: {readonly receivedAtMs:number; readonly sentAtMs:number} };
export type ResolvedClockSample = ClockSample & { readonly roundTripMs: number; readonly serverAtPerformanceOriginMs: number };
function resolveSample(sample: ClockSample): ResolvedClockSample {
  const totalMs = Math.max(0, sample.receivedAt - sample.sentAt);
  const timing = sample.serverTiming;
  const validTiming = timing && Number.isSafeInteger(timing.receivedAtMs) && Number.isSafeInteger(timing.sentAtMs)
    && timing.sentAtMs >= timing.receivedAtMs && timing.sentAtMs - timing.receivedAtMs <= totalMs + 10;
  const serverReference = validTiming ? (timing.receivedAtMs + timing.sentAtMs) / 2 : sample.serverNow;
  const roundTripMs = validTiming ? Math.max(0, totalMs - (timing.sentAtMs - timing.receivedAtMs)) : totalMs;
  return { ...sample, roundTripMs, serverAtPerformanceOriginMs: serverReference - (sample.sentAt + totalMs / 2) };
}
export function chooseBestClockSample(samples: readonly ClockSample[]): ResolvedClockSample {
  if (!samples.length) throw new TypeError("時刻同期にはサンプルが必要です");
  return samples.map(resolveSample).reduce((best, sample) => sample.roundTripMs < best.roundTripMs ? sample : best);
}
export function formatCentiseconds(value: number): string {
  const cs = Math.max(0, Math.floor(value));
  return `${String(Math.floor(cs / 6000)).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
export class CompetitionClock {
  #offsetMs: number | null = null;
  #confirmedElapsedMs = 0;
  constructor(readonly startAtMs: number) {}
  get isSynchronized() { return this.#offsetMs !== null; }
  synchronize(sample: ClockSample) { this.#offsetMs = resolveSample(sample).serverAtPerformanceOriginMs; }
  synchronizeBest(samples: readonly ClockSample[]) { this.#offsetMs = chooseBestClockSample(samples).serverAtPerformanceOriginMs; }
  requireResync() { this.#offsetMs = null; }
  confirm(elapsedMs: number) { this.#confirmedElapsedMs = Math.max(this.#confirmedElapsedMs, elapsedMs); }
  serverNowMs(performanceNow: number) { return this.#offsetMs === null ? null : Math.floor(performanceNow + this.#offsetMs); }
  elapsedMs(performanceNow: number) { return this.#offsetMs === null ? this.#confirmedElapsedMs : Math.max(this.#confirmedElapsedMs, Math.floor(performanceNow + this.#offsetMs - this.startAtMs)); }
  captureElapsedMs(performanceNow: number) { return this.isSynchronized ? this.elapsedMs(performanceNow) : null; }
}
