import { describe, expect, it } from "vitest";
import { complexCountPreview, itemDifficulty, profileCandidateCounts } from "../../../app/teacher/QuestionProfileDialog";
describe("question profile ratio preview", () => {
  it("shows ceiling allocation at all supported question counts", () => {
    expect(complexCountPreview(10)).toEqual([1, 1, 2]);
    expect(complexCountPreview(20)).toEqual([1, 2, 3]);
    expect(complexCountPreview(21)).toEqual([2, 3, 4]);
  });
});

it("preserves server catalog defaults when profiles contain only overrides", () => {
  expect(itemDifficulty({ id: "excluded", defaultDifficulty: "off" }, {})).toBe("off");
  expect(itemDifficulty({ id: "excluded", defaultDifficulty: "off" }, { excluded: "hard" })).toBe("hard");
});

it("previews baseline hard exclusions and explicit re-enabling", () => {
  const items = [{ id: "ordinary", defaultDifficulty: "both" as const, category: "simple11", complex: false }];
  expect(profileCandidateCounts(items, {}, "compound", "hard", null)).toEqual({ordinary: 0, complex: 0});
  expect(profileCandidateCounts(items, {ordinary: "both"}, "compound", "hard", null)).toEqual({ordinary: 1, complex: 0});
});

it("keeps complex candidates independent of ordinary category weights", () => {
  const items = [{ id: "complex", defaultDifficulty: "both" as const, category: "ionSimple", complex: true }];
  expect(profileCandidateCounts(items, {}, "ion", "normal", {ionPolyatomic: 1})).toEqual({ordinary: 0, complex: 1});
});
