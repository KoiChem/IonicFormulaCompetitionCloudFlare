import type { AnswerFieldId } from "../games/ionic-formula/shared/types";

export type FieldState = "pending" | "correct" | "passed" | "unanswered";

export type FieldProgress = {
  readonly state: FieldState;
  readonly attemptCount: number;
  readonly resolvedAtMs?: number;
};

export type QuestionScore = {
  readonly fields: Readonly<Partial<Record<AnswerFieldId, FieldProgress>>>;
  readonly correctCount: number;
  readonly resolved: boolean;
};

export type RankingCandidate = {
  readonly participantId: string;
  readonly correctCount: number;
  readonly elapsedCs: number;
  readonly joinedOrder: number;
  readonly finished: boolean;
};

export type RankedResult = RankingCandidate & { readonly rank: number };

export type TimingSource = "client" | "server_fallback" | "timeout";

export type AcceptElapsedInput = {
  readonly clientElapsedMs: number | null | undefined;
  readonly serverNowMs: number;
  readonly startAtMs: number;
  readonly deadlineAtMs: number;
  readonly previousAcceptedElapsedMs: number;
  readonly previousTimingSource: TimingSource;
  readonly aheadToleranceMs?: number;
  readonly behindToleranceMs?: number;
};

export type AcceptedElapsed = {
  readonly accepted: true;
  readonly acceptedElapsedMs: number;
  readonly elapsedCs: number;
  readonly timingSource: "client" | "server_fallback";
};

export type RejectedElapsed = {
  readonly accepted: false;
  readonly reason: "not_started" | "deadline";
};

export type RoomState =
  | "CREATED"
  | "WAITING"
  | "PREPARING"
  | "COUNTDOWN"
  | "RUNNING"
  | "COLLECTING"
  | "FINISHED"
  | "CANCELLED"
  | "EXPIRED";

export type TimedRoomState = {
  readonly storedState: RoomState;
  readonly startAtMs?: number | null;
  readonly deadlineAtMs?: number | null;
};
