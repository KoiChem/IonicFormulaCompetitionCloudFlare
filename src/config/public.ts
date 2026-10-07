export const PUBLIC_CONFIG = {
  questionCounts: [5, 10, 15],
  defaultQuestionCount: 10,
  timeLimitMinutes: [3, 4, 5, 6, 7, 8, 9, 10],
  defaultTimeLimitMinutes: 5,
  participantLimits: {
    classCompetition: 50,
    mateMatch: 4,
  },
  retentionMs: {
    classCompetition: 7 * 24 * 60 * 60 * 1_000,
    mateMatch: 24 * 60 * 60 * 1_000,
    cancelledRoom: 24 * 60 * 60 * 1_000,
  },
  waitingRoomLifetimeMs: 2 * 60 * 60 * 1_000,
  pollingMs: {
    lobby: 2_000,
    runningParticipant: 5_000,
    progress: 2_000,
    participantFinished: 3_000,
  },
  countdownSeconds: 5,
  timingToleranceMs: {
    aheadOfServer: 250,
    behindServer: 2_000,
  },
} as const;

export type CompetitionSettings = {
  questionCount: (typeof PUBLIC_CONFIG.questionCounts)[number];
  timeLimitMinutes: (typeof PUBLIC_CONFIG.timeLimitMinutes)[number];
};

export function parseCompetitionSettings(input: unknown): CompetitionSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("競技設定はオブジェクトで指定してください");
  }

  const { questionCount, timeLimitMinutes } = input as Record<string, unknown>;

  if (
    typeof questionCount !== "number" ||
    !PUBLIC_CONFIG.questionCounts.some((value) => value === questionCount)
  ) {
    throw new TypeError("問題数は5問、10問、15問から選んでください");
  }

  if (
    typeof timeLimitMinutes !== "number" ||
    !PUBLIC_CONFIG.timeLimitMinutes.some(
      (value) => value === timeLimitMinutes,
    )
  ) {
    throw new TypeError("制限時間は3分から10分の間で選んでください");
  }

  return { questionCount, timeLimitMinutes } as CompetitionSettings;
}
