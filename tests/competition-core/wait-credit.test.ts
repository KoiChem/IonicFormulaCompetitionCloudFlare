import { describe, expect, it } from "vitest";
import { validateWaitCredit } from "../../src/competition-core/wait-credit";

describe("communication wait credit", () => {
  it("accepts bounded wait from an earlier accepted action", () => {
    expect(validateWaitCredit({ waitMs: 500, sourceActionAtMs: 10_100, nextAcceptedAtMs: 12_000, previousRawElapsedMs: 1_000, nextRawElapsedMs: 3_000 })).toBe(500);
  });
  it("does not let the record go backwards", () => {
    expect(validateWaitCredit({ waitMs: 700, sourceActionAtMs: 10_100, nextAcceptedAtMs: 11_000, previousRawElapsedMs: 1_000, nextRawElapsedMs: 1_500 })).toBe(0);
  });
  it("rejects wait longer than the interval after the accepted source", () => {
    expect(validateWaitCredit({ waitMs: 2_000, sourceActionAtMs: 10_100, nextAcceptedAtMs: 11_000, previousRawElapsedMs: 1_000, nextRawElapsedMs: 2_000 })).toBe(0);
  });
});
