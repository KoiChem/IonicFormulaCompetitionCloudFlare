import { describe, expect, it } from "vitest";

import { parseCompetitionSettings } from "../../src/config/public";
import { getServerConfig } from "../../src/config/server";

const valid = (overrides: Record<string, unknown> = {}) => ({
  questionCount: 10,
  timeLimitMinutes: 5,
  ...overrides,
});

describe("parseCompetitionSettings", () => {
  it.each([5, 10, 15])("accepts questionCount=%i", (questionCount) => {
    expect(parseCompetitionSettings(valid({ questionCount }))).toMatchObject({
      questionCount,
    });
  });

  it.each([3, 4, 5, 6, 7, 8, 9, 10])(
    "accepts timeLimitMinutes=%i",
    (timeLimitMinutes) => {
      expect(
        parseCompetitionSettings(valid({ timeLimitMinutes })),
      ).toMatchObject({ timeLimitMinutes });
    },
  );

  it.each([0, 4, 6, 14, 16])(
    "rejects unsupported question counts",
    (questionCount) => {
      expect(() =>
        parseCompetitionSettings(valid({ questionCount })),
      ).toThrow("問題数");
    },
  );

  it.each([2, 11, "5", null])(
    "rejects unsupported time limits and types",
    (timeLimitMinutes) => {
      expect(() =>
        parseCompetitionSettings(valid({ timeLimitMinutes })),
      ).toThrow("制限時間");
    },
  );
});

describe("getServerConfig", () => {
  it("normalizes and deduplicates the teacher allowlist", () => {
    expect(
      getServerConfig({
        TEACHER_ALLOWED_EMAILS:
          " Teacher.One@Example.com,teacher.two@example.com, teacher.one@example.com ",
      }).teacherAllowedEmails,
    ).toEqual(["teacher.one@example.com", "teacher.two@example.com"]);
  });

  it.each([{}, { TEACHER_ALLOWED_EMAILS: "  , " }])(
    "fails closed when the teacher allowlist is not configured",
    (env) => {
      expect(getServerConfig(env).teacherAllowedEmails).toEqual([]);
    },
  );
});
