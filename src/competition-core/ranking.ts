import type { RankedResult, RankingCandidate } from "./types";

export function rankResults(
  results: readonly RankingCandidate[],
  timeLimitSeconds?: number,
): RankedResult[] {
  const sorted = results
    .map((candidate, inputOrder) => {
      if (!candidate.finished && timeLimitSeconds === undefined) {
        throw new TypeError("timeLimitSeconds is required for unfinished results");
      }
      const result = candidate.finished
        ? candidate
        : { ...candidate, elapsedCs: timeLimitSeconds! * 100 };
      return { result, inputOrder };
    })
    .sort((left, right) =>
      right.result.correctCount - left.result.correctCount
      || left.result.elapsedCs - right.result.elapsedCs
      || left.result.joinedOrder - right.result.joinedOrder
      || left.inputOrder - right.inputOrder,
    );

  const ranked: RankedResult[] = [];
  for (const [index, { result }] of sorted.entries()) {
    const previous = ranked[index - 1];
    const tied = previous !== undefined
      && previous.correctCount === result.correctCount
      && previous.elapsedCs === result.elapsedCs;
    ranked.push({ ...result, rank: tied ? previous.rank : index + 1 });
  }
  return ranked;
}
