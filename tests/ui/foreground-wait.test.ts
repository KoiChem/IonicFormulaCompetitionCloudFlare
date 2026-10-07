import { describe, expect, it } from "vitest";
import { ForegroundWait } from "../../src/features/play/foreground-wait";

describe("foreground action wait", () => {
  it("excludes hidden time and counts retries as one wait", () => {
    const wait = new ForegroundWait(100);
    wait.hidden(400);
    wait.visible(2_000);
    expect(wait.stop(2_300)).toBe(600);
  });
  it("does not credit a long unsampled gap such as device sleep", () => {
    const wait = new ForegroundWait(100);
    wait.sample(300);
    expect(wait.stop(30_300)).toBe(200);
  });
  it("restores measured foreground time without counting the reload gap", () => {
    const beforeReload = new ForegroundWait(100);
    beforeReload.sample(350);
    const restored = new ForegroundWait(10_000, true, beforeReload.measuredMs);
    expect(restored.stop(10_200)).toBe(450);
  });
});
