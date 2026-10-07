import { describe, expect, it } from "vitest";

import { acceptElapsed, toCentiseconds } from "../../src/competition-core/timing";

const base = {
  startAtMs: 10_000,
  deadlineAtMs: 20_000,
  serverNowMs: 15_000,
  previousAcceptedElapsedMs: 1_000,
  previousTimingSource: "client" as const,
};

describe("competition timing", () => {
  it("floors milliseconds to centiseconds", () => {
    expect(toCentiseconds(13_479)).toBe(1_347);
    expect(toCentiseconds(73_999)).toBe(7_399);
  });

  it("accepts a plausible nondecreasing client time before the deadline", () => {
    expect(acceptElapsed({ ...base, clientElapsedMs: 4_900 })).toEqual({
      accepted: true,
      acceptedElapsedMs: 4_900,
      elapsedCs: 490,
      timingSource: "client",
    });
  });

  it.each([Number.NaN, -1, 999])(
    "falls back to bounded server time for invalid or backward client time %s",
    (clientElapsedMs) => {
      expect(acceptElapsed({ ...base, clientElapsedMs })).toEqual({
        accepted: true,
        acceptedElapsedMs: 5_000,
        elapsedCs: 500,
        timingSource: "server_fallback",
      });
    },
  );

  it("keeps using server time after fallback and never moves backward", () => {
    expect(acceptElapsed({
      ...base,
      serverNowMs: 10_500,
      clientElapsedMs: 500,
      previousAcceptedElapsedMs: 5_000,
      previousTimingSource: "server_fallback",
    })).toEqual({
      accepted: true,
      acceptedElapsedMs: 5_000,
      elapsedCs: 500,
      timingSource: "server_fallback",
    });
  });

  it("falls back when the client differs from server beyond either tolerance", () => {
    const ahead = acceptElapsed({ ...base, clientElapsedMs: 5_251 });
    const behind = acceptElapsed({ ...base, clientElapsedMs: 2_999 });
    expect(ahead).toMatchObject({ accepted: true, timingSource: "server_fallback" });
    expect(behind).toMatchObject({ accepted: true, timingSource: "server_fallback" });
  });

  it("compares against raw server elapsed before applying monotonic fallback", () => {
    const first = acceptElapsed({
      ...base,
      clientElapsedMs: 5_500,
      previousAcceptedElapsedMs: 5_250,
    });
    expect(first).toEqual({
      accepted: true,
      acceptedElapsedMs: 5_250,
      elapsedCs: 525,
      timingSource: "server_fallback",
    });

    const next = acceptElapsed({
      ...base,
      serverNowMs: 15_010,
      clientElapsedMs: 5_510,
      previousAcceptedElapsedMs: 5_250,
      previousTimingSource: "server_fallback",
    });
    expect(next).toEqual({
      accepted: true,
      acceptedElapsedMs: 5_250,
      elapsedCs: 525,
      timingSource: "server_fallback",
    });
  });

  it("rejects a new operation at the exact deadline", () => {
    expect(acceptElapsed({ ...base, serverNowMs: 20_000, clientElapsedMs: 9_999 })).toEqual({
      accepted: false,
      reason: "deadline",
    });
  });
});
