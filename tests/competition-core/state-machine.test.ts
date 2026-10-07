import { describe, expect, it } from "vitest";

import { effectiveRoomState } from "../../src/competition-core/state-machine";

const scheduled = { startAtMs: 2_000, deadlineAtMs: 7_000 };

describe("effectiveRoomState", () => {
  it("derives countdown, running, and finished from authoritative timestamps", () => {
    expect(effectiveRoomState({ storedState: "COUNTDOWN", ...scheduled }, 1_999)).toBe("COUNTDOWN");
    expect(effectiveRoomState({ storedState: "COUNTDOWN", ...scheduled }, 2_000)).toBe("RUNNING");
    expect(effectiveRoomState({ storedState: "COUNTDOWN", ...scheduled }, 7_000)).toBe("FINISHED");
    expect(effectiveRoomState({ storedState: "RUNNING", ...scheduled }, 7_001)).toBe("FINISHED");
  });

  it("does not time-derive terminal cancellation and expiry states", () => {
    expect(effectiveRoomState({ storedState: "CANCELLED", ...scheduled }, 8_000)).toBe("CANCELLED");
    expect(effectiveRoomState({ storedState: "EXPIRED", ...scheduled }, 8_000)).toBe("EXPIRED");
  });
});
