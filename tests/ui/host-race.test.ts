import { describe, expect, it } from "vitest";
import { raceRows, raceProgress, raceScale, raceCapacity, racePace, effectiveRaceMotion, raceFollowStart, raceVisibleRange, isRaceGoal, increasedRaceIds } from "../../src/features/lobby/host-race-model";

const participant = (id: string, count: number) => ({ id, nickname: id, status: "PLAYING", currentOrdinal: 0, correctCount: count, answeredCount: count, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null });

describe("host race model", () => {
  it("dashes every existing participant whose count increased, but not newcomers or submissions alone", () => {
    const previous = new Map([["a", 2], ["b", 3], ["c", 4]]);
    expect(increasedRaceIds([participant("a", 3), participant("b", 4), participant("c", 4), participant("new", 2)], previous, "deferred")).toEqual(["a", "b"]);
  });
  it("uses score fields rather than question count", () => {
    expect(raceProgress(participant("a", 10), "immediate", 20)).toBe(0.5);
    expect(raceProgress({ ...participant("a", 0), answeredCount: 20 }, "deferred", 20)).toBe(1);
  });
  it("retains previous order and equal ranks on ties", () => {
    const rows = raceRows([participant("a", 8), participant("b", 8), participant("c", 9)], "immediate", ["b", "a", "c"], 10);
    expect(rows.map(row => [row.id, row.rank])).toEqual([["c", 1], ["b", 2], ["a", 2]]);
  });
  it("caps at ten and shrinks fourth place onwards", () => {
    const rows = raceRows(Array.from({ length: 12 }, (_, i) => participant(String(i), 12 - i)), "immediate", [], 10);
    expect(rows).toHaveLength(10);
    expect(raceScale(rows[2].rank)).toBe(1);
    expect(raceScale(rows[3].rank)).toBe(0.96);
    expect(raceScale(rows[9].rank)).toBe(0.72);
  });
  it("moves backwards when a deferred answer is erased", () => {
    expect(raceProgress({ ...participant("a", 0), answeredCount: 4 }, "deferred", 10)).toBe(0.4);
    expect(raceProgress({ ...participant("a", 0), answeredCount: 3 }, "deferred", 10)).toBe(0.3);
  });
  it("uses measured race height for at most eleven readable lanes", () => {
    expect(raceCapacity(615)).toBe(11);
    expect(raceCapacity(560)).toBe(10);
    expect(raceCapacity(290)).toBe(5);
    expect(raceCapacity(1200)).toBe(11);
  });
  it("keeps the leading five non-goal runners in view when goals accumulate", () => {
    const rows = raceRows(Array.from({ length: 42 }, (_, i) => participant(String(i), i < 12 ? 10 : 9 - i / 100)), "immediate", [], 42);
    expect(raceFollowStart(rows, "immediate", 10, 11)).toBe(6);
    expect(rows.slice(6, 17).filter(row => !isRaceGoal(row, "immediate", 10))).toHaveLength(5);
    expect(raceFollowStart(rows, "immediate", 10, 5)).toBe(12);
  });
  it("shows all remaining non-goal runners and handles an all-goal room", () => {
    const rows = raceRows(Array.from({ length: 10 }, (_, i) => participant(String(i), i < 8 ? 10 : 9)), "immediate", [], 10);
    expect(raceFollowStart(rows, "immediate", 10, 5)).toBe(5);
    expect(raceFollowStart(rows.map(row => ({ ...row, correctCount: 10 })), "immediate", 10, 5)).toBe(0);
    expect(raceFollowStart([], "immediate", 10, 5)).toBe(0);
  });
  it("does not treat deferred full input as a goal", () => {
    const rows = raceRows([participant("a", 10), participant("b", 10), participant("c", 2)], "deferred", [], 3);
    expect(isRaceGoal(rows[0], "deferred", 10)).toBe(false);
    expect(raceFollowStart(rows, "deferred", 10, 2)).toBe(0);
  });
  it("does not draw a clipped previous runner above the first visible lane", () => {
    expect(raceVisibleRange(0, 54, 594, 42)).toEqual({ start: 0, end: 13 });
    expect(raceVisibleRange(540, 54, 594, 42)).toEqual({ start: 10, end: 23 });
    expect(raceVisibleRange(1000, 54, 594, 3)).toEqual({ start: 0, end: 3 });
  });
  it("increases running cadence at three remaining-time thresholds", () => {
    expect([100, 60, 30, 10, 0].map(remaining => racePace(remaining, 100))).toEqual([0, 1, 2, 3, 3]);
    expect(racePace(10, 0)).toBe(0);
  });
  it("defaults to normal regardless of the OS and honors an explicit light choice", () => {
    expect(effectiveRaceMotion("auto", true)).toBe("normal");
    expect(effectiveRaceMotion("auto", false)).toBe("normal");
    expect(effectiveRaceMotion("normal", true)).toBe("normal");
    expect(effectiveRaceMotion("light", false)).toBe("light");
  });
});
