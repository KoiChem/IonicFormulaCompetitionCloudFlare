import { describe, expect, it } from "vitest";
import { CountdownSoundGate } from "../../src/features/lobby/host-countdown-sound";

describe("host countdown sound", () => {
  it("sounds once for each observed visible digit without replaying missed seconds", () => {
    const gate = new CountdownSoundGate();
    expect(gate.observe(10_000, 5, true)).toBe(true);
    expect(gate.observe(10_000, 5, true)).toBe(false);
    expect(gate.observe(10_000, 3, true)).toBe(true);
    expect(gate.observe(10_000, 2, false)).toBe(false);
    expect(gate.observe(10_000, 2, true)).toBe(false);
    expect(gate.observe(10_000, 1, true)).toBe(true);
    expect(gate.observe(10_000, 0, true)).toBe(false);
    expect(gate.observe(20_000, 5, true)).toBe(true);
  });
});
