export class ForegroundWait {
  #visibleSince: number | null;
  #accumulated: number;
  constructor(startedAt: number, visible = true, initialMeasuredMs = 0) {
    this.#visibleSince = visible ? startedAt : null;
    this.#accumulated = initialMeasuredMs;
  }
  get measuredMs(): number { return Math.floor(this.#accumulated); }
  sample(now: number) {
    if (this.#visibleSince === null) return;
    const delta = now - this.#visibleSince;
    if (delta >= 0 && delta <= 2_000) this.#accumulated += delta;
    this.#visibleSince = now;
  }
  hidden(now: number) {
    if (this.#visibleSince === null) return;
    this.sample(now);
    this.#visibleSince = null;
  }
  visible(now: number) {
    if (this.#visibleSince === null) this.#visibleSince = now;
  }
  stop(now: number): number {
    this.hidden(now);
    return Math.floor(this.#accumulated);
  }
}
