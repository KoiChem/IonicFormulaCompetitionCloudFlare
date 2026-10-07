import { describe, expect, it } from "vitest";
import { recoveryDestination, shouldWarnBeforeLeaving } from "../../src/features/play/active-room-recovery";

describe("active room recovery", () => {
  it("offers the same room only while a participant can continue", () => {
    for (const state of ["WAITING", "PREPARING", "COUNTDOWN", "RUNNING", "COLLECTING"]) {
      expect(recoveryDestination(state)).toBe("room");
    }
    expect(recoveryDestination("FINISHED")).toBe("results");
    for (const state of ["CANCELLED", "EXPIRED", "REMOVED"]) expect(recoveryDestination(state)).toBe("none");
  });
  it("warns only during an active participant session", () => {
    expect(shouldWarnBeforeLeaving("RUNNING")).toBe(true);
    expect(shouldWarnBeforeLeaving("COLLECTING")).toBe(true);
    expect(shouldWarnBeforeLeaving("WAITING")).toBe(false);
    expect(shouldWarnBeforeLeaving("FINISHED")).toBe(false);
  });
});
