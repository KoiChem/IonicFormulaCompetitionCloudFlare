import { describe, expect, it } from "vitest";
import { FeedbackGate } from "../../src/features/play/answer-feedback";

describe("accepted answer feedback", () => {
  it("shows each accepted verdict only once and ignores passes", () => {
    const gate = new FeedbackGate();
    expect(gate.accept("a", true, 100)).toMatchObject({ kind: "correct", untilMs: 900 });
    expect(gate.accept("a", true, 300)).toBeNull();
    expect(gate.accept("pass", null, 400)).toBeNull();
    expect(gate.accept("b", false, 500)).toMatchObject({ kind: "incorrect", untilMs: 1500 });
    expect(gate.accept("b", false, 600)).toBeNull();
  });
  it("does not replay the last shown request after reloading", () => {
    const restored = new FeedbackGate(["previous"]);
    expect(restored.accept("previous", false, 2_000)).toBeNull();
    expect(restored.accept("new", true, 2_000)).toMatchObject({ requestId: "new", kind: "correct" });
  });
});
