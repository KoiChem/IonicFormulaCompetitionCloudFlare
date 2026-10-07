import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollectingProgress, Progress } from "../../src/features/lobby/RoomScreen";

const participants = [
  { id: "a", nickname: "提出", status: "PLAYING", submitted: true, answeredCount: 4, correctCount: 0, resolvedQuestionCount: 0, currentOrdinal: 0, revision: 0, elapsedCs: null, timingSource: null },
  { id: "b", nickname: "時間切れ", status: "FINISHED", submitted: false, answeredCount: 2, correctCount: 0, resolvedQuestionCount: 0, currentOrdinal: 0, revision: 0, elapsedCs: null, timingSource: null },
] as const;

describe("class host collection progress", () => {
  it("starts collapsed with an accessible button", () => {
    const html = renderToStaticMarkup(createElement(CollectingProgress, { participants: [...participants], gradingMode: "deferred" }));
    expect(html).toContain("参加者の進捗を表示");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("時間切れ");
  });
  it("counts only confirmed submissions in deferred mode", () => {
    const html = renderToStaticMarkup(createElement(Progress, { participants: [...participants], gradingMode: "deferred" }));
    expect(html).toContain("提出 1 / 2人");
  });
});
