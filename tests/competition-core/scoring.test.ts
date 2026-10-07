import { describe, expect, it } from "vitest";

import {
  applyFieldResult,
  applyPass,
  markUnansweredAtTimeout,
} from "../../src/competition-core/scoring";
import type { QuestionScore } from "../../src/competition-core/types";

function bothPending(): QuestionScore {
  return {
    fields: {
      formula: { state: "pending", attemptCount: 0 },
      name: { state: "pending", attemptCount: 0 },
    },
    correctCount: 0,
    resolved: false,
  };
}

describe("competition scoring", () => {
  it("keeps one correct field when the remaining field is passed", () => {
    const afterCorrect = applyFieldResult(bothPending(), "formula", true, 1_234);
    const afterPass = applyPass(afterCorrect, "name", 1_400);

    expect(afterPass.correctCount).toBe(1);
    expect(afterPass.resolved).toBe(true);
    expect(afterPass.fields).toMatchObject({
      formula: { state: "correct", resolvedAtMs: 1_234 },
      name: { state: "passed", resolvedAtMs: 1_400 },
    });
  });

  it("passing one field keeps the other available", () => {
    const afterPass = applyPass(bothPending(), "formula", 700);
    expect(afterPass.fields.formula?.state).toBe("passed");
    expect(afterPass.fields.name?.state).toBe("pending");
    expect(afterPass.resolved).toBe(false);
  });

  it("keeps a wrong field pending so a later correct attempt can score", () => {
    const afterWrong = applyFieldResult(bothPending(), "name", false, 800);
    const afterCorrect = applyFieldResult(afterWrong, "name", true, 1_100);

    expect(afterWrong.fields.name).toEqual({ state: "pending", attemptCount: 1 });
    expect(afterCorrect.fields.name).toEqual({
      state: "correct",
      attemptCount: 2,
      resolvedAtMs: 1_100,
    });
    expect(afterCorrect.correctCount).toBe(1);
  });

  it("does not score the same field twice", () => {
    const once = applyFieldResult(bothPending(), "formula", true, 500);
    const twice = applyFieldResult(once, "formula", true, 700);

    expect(twice).toEqual(once);
    expect(twice.correctCount).toBe(1);
  });

  it("retains accepted partial credit when pending fields time out", () => {
    const afterCorrect = applyFieldResult(bothPending(), "formula", true, 1_234);
    const timedOut = markUnansweredAtTimeout(afterCorrect);

    expect(timedOut.correctCount).toBe(1);
    expect(timedOut.resolved).toBe(false);
    expect(timedOut.fields).toMatchObject({
      formula: { state: "correct" },
      name: { state: "unanswered" },
    });
  });
});
