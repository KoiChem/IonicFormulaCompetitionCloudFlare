import { describe, expect, it } from "vitest";
import { replayV2Operations, type V2Operation } from "../../src/competition-core/v2-operations";
import type { InternalQuestion } from "../../src/games/ionic-formula/shared/types";
const questions: InternalQuestion[] = [0, 1].map(ordinal => ({ id: `q${ordinal}`, ordinal, itemId: `i${ordinal}`, category: "compound", variant: "both", maxScore: 2,
  prompt: { kind: "compoundIons", values: [{ type: "formula", value: "Na", charge: 1 }, { type: "formula", value: "Cl", charge: -1 }] },
  fields: [{ id: "formula", type: "formula" }, { id: "name", type: "name" }],
  answer: { type: "both", formula: { type: "formula", canonical: "NaCl", accepted: [] }, name: { type: "name", canonical: "塩化ナトリウム", accepted: [] } },
}));
const draft = (seq: number, questionId = "q0", value = "塩化ナトリウム"): V2Operation => ({ seq, operationId: `o${seq}`, type: "draft", questionId, fieldId: "name", value, elapsedMs: seq * 100 });
const advance = (seq: number, questionId = "q0"): V2Operation => ({ seq, operationId: `o${seq}`, type: "advance", questionId, elapsedMs: seq * 100 });
const replay = (ops: V2Operation[]) => replayV2Operations(questions, "deferred", ops, 0, 1000, false, false);
describe("deferred question transitions", () => {
  it("keeps periodic saves stationary until leaving an answered question", () => {
    expect(replay([draft(1), draft(2)]).resolvedQuestionCount).toBe(0);
    expect(replay([draft(1), advance(2)]).resolvedQuestionCount).toBe(1);
  });
  it("counts a question once even with only one of two fields, repeats, or later erasure", () => {
    const result = replay([draft(1), advance(2), advance(3), draft(4, "q0", ""), advance(5)]);
    expect(result.resolvedQuestionCount).toBe(1);
    expect(result.answeredCount).toBe(0);
  });
  it("does not count blank forward moves, but can count after filling and revisiting", () => {
    expect(replay([advance(1), draft(2), advance(3)]).resolvedQuestionCount).toBe(1);
  });
  it("counts the last question on the transition to review and does not count at cutoff", () => {
    expect(replay([draft(1), advance(2), draft(3, "q1"), advance(4, "q1")]).resolvedQuestionCount).toBe(2);
    expect(replay([draft(1), { ...advance(2), elapsedMs: 1000 }]).resolvedQuestionCount).toBe(0);
  });
  it("rejects transitions in immediate mode and malformed question transitions", () => {
    expect(() => replayV2Operations(questions, "immediate", [advance(1)], 0, 1000)).toThrow(/immediate/);
    expect(() => replay([advance(1, "unknown")])).toThrow();
    expect(() => replay([{ ...advance(1), fieldId: "name", value: "answer" }])).toThrow();
  });
});
