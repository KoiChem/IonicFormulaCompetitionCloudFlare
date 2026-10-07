export type ResultLoadState = {
  full: any | null;
  summary: any | null;
  status: "loading" | "retrying" | "offline" | "failed" | "complete";
  error: string;
  requestId: string | null;
  canRetry: boolean;
  terminal: boolean;
};

type LoaderOptions = {
  roomId: string;
  token?: string;
  expiresAtMs?: number;
  fetcher?: typeof fetch;
  random?: () => number;
  isAvailable?: () => boolean;
  onChange?: (state: ResultLoadState) => void;
};

type Failure = { status: number; code?: string; retryAfterMs?: number; requestId?: string };
const terminalStatus = (status: number) => [401, 403, 404, 410].includes(status);
const retryable = (failure: Failure) => failure.status === 0 || failure.status >= 500 || failure.status === 429
  || (failure.status === 409 && failure.code === "results_not_ready");

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export class ResultLoader {
  state: ResultLoadState = { full: null, summary: null, status: "loading", error: "", requestId: null,
    canRetry: false, terminal: false };
  private running = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LoaderOptions) {}

  private update(partial: Partial<ResultLoadState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...partial };
    this.options.onChange?.(this.state);
  }

  private async request(summary: boolean): Promise<{ value?: any; failure?: Failure }> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const endpoint = summary ? "result-summary" : "results";
    try {
      const response = await (this.options.fetcher ?? apiFetch)(`/api/rooms/${encodeURIComponent(this.options.roomId)}/${endpoint}`,
        { cache: "no-store", headers: this.options.token ? { authorization: `Bearer ${this.options.token}` } : undefined,
          signal: controller.signal });
      let value: any;
      try { value = await response.json(); }
      catch { return { failure: { status: response.status === 200 ? 0 : response.status } }; }
      if (response.status !== 200) return { failure: { status: response.status, code: value?.error?.code,
        requestId: value?.error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")) } };
      if (!value || typeof value !== "object" || !value.room || typeof value.room !== "object"
        || value.room.id !== this.options.roomId || value.room.state !== "FINISHED"
        || (summary ? !this.options.token || !value.own || typeof value.own !== "object"
          : !Array.isArray(value.ranking) || (this.options.token && (!value.own || !Array.isArray(value.questions))))) {
        return { failure: { status: 0 } };
      }
      return { value };
    } catch {
      return { failure: { status: 0 } };
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    if (this.disposed) return;
    await new Promise<void>(resolve => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, milliseconds);
    });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.wake = null;
    while (!this.disposed && !(this.options.isAvailable?.() ?? true)) {
      this.update({ status: "offline" });
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }

  availabilityChanged() {
    if (this.wake && !this.timer && (this.options.isAvailable?.() ?? true)) this.wake();
  }

  async start(): Promise<void> {
    if (this.running || this.disposed || this.state.full || this.state.terminal) return;
    this.running = true;
    this.update({ status: "loading", error: "", canRetry: false });
    try {
      for (let attempt = 1; attempt <= 5 && !this.disposed; attempt += 1) {
        if (this.options.expiresAtMs && Date.now() >= this.options.expiresAtMs) {
          this.update({ status: "failed", error: "閲覧期限が切れました", terminal: true }); return;
        }
        if (!(this.options.isAvailable?.() ?? true)) await this.wait(0);
        if (this.disposed) return;
        const result = await this.request(false);
        if (this.disposed) return;
        if (result.value) { this.update({ full: result.value, status: "complete", error: "", canRetry: false }); return; }
        const failure = result.failure!;
        if (failure.requestId) this.update({ requestId: failure.requestId });
        if (terminalStatus(failure.status)) {
          this.update({ status: "failed", terminal: true, error: failure.status === 410 ? "閲覧期限が切れました"
            : failure.status === 404 ? "ルームが見つかりません" : "閲覧資格を確認できません" }); return;
        }
        if (!retryable(failure)) { this.update({ status: "failed", error: "結果を取得できませんでした", canRetry: false }); return; }
        if (attempt === 2 && this.options.token && !this.state.summary) {
          if (!(this.options.isAvailable?.() ?? true)) await this.wait(0);
          if (this.disposed) return;
          const partial = await this.request(true);
          if (this.disposed) return;
          if (partial.value) this.update({ summary: partial.value });
          else if (partial.failure && terminalStatus(partial.failure.status)) {
            this.update({ status: "failed", terminal: true,
              error: partial.failure.status === 410 ? "閲覧期限が切れました"
                : partial.failure.status === 404 ? "ルームが見つかりません" : "閲覧資格を確認できません" }); return;
          }
        }
        if (attempt === 5) { this.update({ status: "failed", error: "結果を取得できませんでした", canRetry: true }); return; }
        this.update({ status: failure.code === "results_not_ready" ? "loading" : "retrying" });
        const jitter = 0.8 + 0.4 * (this.options.random?.() ?? Math.random());
        const delay = Math.max(2 ** (attempt - 1) * 1000 * jitter, failure.retryAfterMs ?? 0);
        await this.wait(this.options.expiresAtMs ? Math.min(delay, Math.max(0, this.options.expiresAtMs - Date.now())) : delay);
      }
    } finally { this.running = false; }
  }

  retry(): void {
    if (this.running || this.disposed || this.state.full || this.state.terminal) return;
    this.update({ canRetry: false, requestId: null });
    void this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    this.timer = null; this.wake = null;
  }
}
import { apiFetch } from '../../web/api';
