import { afterEach, describe, expect, it, vi } from "vitest";
import { operationRetryDelay, retryableOperationFailure } from "../../src/features/play/v2-send-policy";
import { fetchJsonWithTimeout, retryAfterMs } from "../../src/features/play/useRoomSync";

vi.mock('../../src/web/supabase', () => ({ ensureSession: async () => ({access_token:'test-jwt'}), getSupabaseClient: () => ({auth:{refreshSession:async()=>{}}}) }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("participant operation retry policy", () => {
  it("retries only temporary failures and keeps explicit conflicts terminal", () => {
    for (const failure of [{ code: "timeout" }, { status: 408 }, { status: 429 }, { status: 503 }, { status: 409, code: "database_conflict" }]) {
      expect(retryableOperationFailure(failure)).toBe(true);
    }
    for (const failure of [{ status: 409, code: "stale_participant_revision" }, { status: 409, code: "request_id_reused" }, { status: 403 }]) {
      expect(retryableOperationFailure(failure)).toBe(false);
    }
  });
  it("honors Retry-After and bounds normal collection retries", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("Wed, 29 Sep 2026 00:00:03 GMT", Date.parse("2026-09-29T00:00:00Z"))).toBe(3000);
    expect(operationRetryDelay({ status: 429, retryAfterMs: 4000 }, 1000, true, 0)).toBe(4000);
    expect(operationRetryDelay({ status: 503 }, 8000, true, 1)).toBe(1000);
  });
  it("preserves HTTP metadata when an error response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503, headers: { "retry-after": "2" } })));
    await expect(fetchJsonWithTimeout("/api/operations", {}, 5000)).rejects.toMatchObject({ status: 503, retryAfterMs: 2000 });
  });
  it("settles even if fetch never responds to abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const request = fetchJsonWithTimeout("/api/operations", {}, 5000);
    const rejected = expect(request).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
  });
});
