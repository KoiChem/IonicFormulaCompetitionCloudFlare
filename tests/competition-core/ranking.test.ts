import { describe, expect, it } from "vitest";

import { rankResults } from "../../src/competition-core/ranking";
import type { RankingCandidate } from "../../src/competition-core/types";

function result(
  participantId: string,
  correctCount: number,
  elapsedCs: number,
  joinedOrder: number,
): RankingCandidate {
  return { participantId, correctCount, elapsedCs, joinedOrder, finished: true };
}

describe("competition ranking", () => {
  it("uses competition ranking with shared ranks", () => {
    expect(rankResults([
      result("A", 16, 13_347, 0),
      result("B", 16, 13_347, 1),
      result("C", 16, 30_000, 2),
      result("D", 15, 11_000, 3),
    ]).map(({ rank }) => rank)).toEqual([1, 1, 3, 4]);
  });

  it("sorts by score then centiseconds and keeps join order within a tie", () => {
    const ranked = rankResults([
      result("late-fast", 4, 500, 3),
      result("second-tie", 5, 1_000, 2),
      result("first-tie", 5, 1_000, 1),
      result("slow", 5, 1_001, 0),
    ]);

    expect(ranked.map(({ participantId }) => participantId)).toEqual([
      "first-tie", "second-tie", "slow", "late-fast",
    ]);
    expect(ranked.map(({ rank }) => rank)).toEqual([1, 1, 3, 4]);
  });

  it("ranks unfinished participants at the exact time limit", () => {
    const ranked = rankResults([
      { ...result("disconnected", 3, 100, 0), finished: false },
      { ...result("timed-out", 3, 20_000, 1), finished: false },
      result("completed", 3, 17_999, 2),
    ], 180);

    expect(ranked.map(({ participantId, elapsedCs, rank }) => ({ participantId, elapsedCs, rank }))).toEqual([
      { participantId: "completed", elapsedCs: 17_999, rank: 1 },
      { participantId: "disconnected", elapsedCs: 18_000, rank: 2 },
      { participantId: "timed-out", elapsedCs: 18_000, rank: 2 },
    ]);
  });
});
