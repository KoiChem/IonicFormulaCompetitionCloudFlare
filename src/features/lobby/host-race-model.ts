import type { ParticipantState } from "../play/useRoomSync";

export type RaceMode = "immediate" | "deferred";
export type RaceRow = ParticipantState & { rank: number; count: number };
export type RaceMotionChoice = "auto" | "normal" | "light";

export function raceCapacity(fieldHeight: number): number {
  return Math.min(11, Math.max(1, Math.floor((fieldHeight - 20) / 54)));
}

export function isRaceGoal(participant: ParticipantState, mode: RaceMode, maxScore: number): boolean {
  return mode === "immediate" && maxScore > 0 && participant.correctCount >= maxScore;
}

export function raceFollowStart(rows: readonly RaceRow[], mode: RaceMode, maxScore: number, capacity: number): number {
  if (mode === "deferred" || rows.length === 0) return 0;
  const nonGoalIndices = rows.flatMap((row, index) => isRaceGoal(row, mode, maxScore) ? [] : [index]);
  if (!nonGoalIndices.length) return 0;
  const targetIndex = nonGoalIndices[Math.min(4, nonGoalIndices.length - 1)];
  return Math.min(Math.max(0, rows.length - capacity), Math.max(0, targetIndex - capacity + 1));
}

export function raceVisibleRange(scrollTop: number, laneHeight: number, viewportHeight: number, total: number): { start: number; end: number } {
  const clampedTop = Math.min(Math.max(0, scrollTop), Math.max(0, 20 + total * laneHeight - viewportHeight));
  const first = Math.floor(clampedTop / laneHeight);
  const last = Math.ceil((clampedTop + viewportHeight) / laneHeight);
  return { start: Math.min(total, first), end: Math.min(total, last + 2) };
}

export function racePace(remainingMs: number, totalMs: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  const fraction = Math.max(0, remainingMs) / totalMs;
  if (fraction > 0.6) return 0;
  if (fraction > 0.3) return 1;
  if (fraction > 0.1) return 2;
  return 3;
}

export function effectiveRaceMotion(choice: RaceMotionChoice, prefersReducedMotion: boolean): "normal" | "light" {
  void prefersReducedMotion;
  return choice === "light" ? "light" : "normal";
}

export function raceCount(participant: ParticipantState, mode: RaceMode): number {
  return Math.max(0, mode === "deferred" ? participant.answeredCount ?? 0 : participant.correctCount);
}

export function increasedRaceIds(participants: readonly ParticipantState[], previous: ReadonlyMap<string, number>, mode: RaceMode): string[] {
  return participants.filter(participant => previous.has(participant.id) && raceCount(participant, mode) > previous.get(participant.id)!).map(participant => participant.id);
}

export function raceProgress(participant: ParticipantState, mode: RaceMode, maxScore: number): number {
  return Number.isFinite(maxScore) && maxScore > 0 ? Math.min(1, raceCount(participant, mode) / maxScore) : 0;
}

export function raceScale(rank: number): number {
  return Math.max(0.72, 1 - Math.max(0, rank - 3) * 0.04);
}

export function raceRows(participants: readonly ParticipantState[], mode: RaceMode, previousIds: readonly string[], limit = 10): RaceRow[] {
  const order = new Map(previousIds.map((id, index) => [id, index]));
  const sourceOrder = new Map(participants.map((participant, index) => [participant.id, index]));
  const sorted = participants.filter(participant => participant.status !== "REMOVED")
    .map(participant => ({ ...participant, count: raceCount(participant, mode), rank: 0 }))
    .sort((a, b) => b.count - a.count || (order.get(a.id) ?? sourceOrder.get(a.id) ?? 0) - (order.get(b.id) ?? sourceOrder.get(b.id) ?? 0));
  sorted.forEach((row, index) => { row.rank = index && row.count === sorted[index - 1].count ? sorted[index - 1].rank : index + 1; });
  return sorted.slice(0, Math.max(0, limit));
}
