import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Lobby } from "../../src/features/lobby/Lobby";
import { Results } from "../../src/features/results/Results";
import { rankResults } from "../../src/competition-core/ranking";

const room = { id: "room-public", kind: "class" as const, state: "WAITING" as const, revision: 1, settings: { questionCount: 5, timeLimitMinutes: 3 }, maxScore: 5, startAtMs: null, deadlineAtMs: null, expiresAtMs: 99_999 };
it("renders a lobby with code, participant progress, and an accessible start control", () => {
  const html = renderToStaticMarkup(createElement(Lobby, { room, joinCode: "ABC234", canStart: true, onStart: () => {}, participants: [{ id: "p1", nickname: "A", status: "ACTIVE", currentOrdinal: 0, correctCount: 0, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null }] }));
  expect(html).toContain("ABC234"); expect(html).toContain("5秒後に開始"); expect(html).toContain("参加用QRコード");
});

describe("final competition ranking", () => {
  it("renders shared ranks 1, 1, 3 after partial credit, pass, and timeout totals", () => {
    const ranked = rankResults([
      { participantId: "a", joinedOrder: 0, correctCount: 1, elapsedCs: 100, finished: true },
      { participantId: "b", joinedOrder: 1, correctCount: 1, elapsedCs: 100, finished: true },
      { participantId: "c", joinedOrder: 2, correctCount: 0, elapsedCs: 18_000, finished: false },
    ], 180);
    expect(ranked.map((item) => item.rank)).toEqual([1, 1, 3]);
    const html = renderToStaticMarkup(createElement(Results, { data: { ranking: ranked.map((r) => ({ ...r, nickname: ({ a: "A", b: "B", c: "C" } as Record<string, string>)[r.participantId], finishReason: r.finished ? "completed" : "timeout" })) } }));
    expect(html).toContain("1位"); expect(html).toContain("3位"); expect(html).toContain("00:01.00");
  });
});
