export function teacherTopRank(participantCount: number): number {
  if (participantCount <= 3) return Math.max(0, participantCount);
  if (participantCount < 10) return 3;
  if (participantCount < 20) return 5;
  if (participantCount < 30) return 10;
  return 15;
}

export function topRankingRows<T extends { rank: number }>(rows: readonly T[], boundary: number): T[] {
  return rows.filter(row => row.rank <= boundary);
}
