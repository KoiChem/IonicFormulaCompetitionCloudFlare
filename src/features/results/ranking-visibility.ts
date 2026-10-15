export function teacherTopRank(): number {
  return 5;
}

export function topRankingRows<T extends { rank: number }>(rows: readonly T[], boundary: number): T[] {
  return rows.filter(row => row.rank <= boundary);
}
