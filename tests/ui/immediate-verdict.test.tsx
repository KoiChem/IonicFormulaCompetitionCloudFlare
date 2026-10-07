import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImmediateVerdict } from "../../src/features/play/ImmediateVerdict";

describe("immediate verdict", () => {
  it("shows question, field, result and score without revealing an answer", () => {
    const html = renderToStaticMarkup(createElement(ImmediateVerdict, { verdict: { attemptId: "a", correct: true, questionNumber: 3, fieldLabel: "イオン名", fullScore: false } }));
    expect(html).toContain("第3問・イオン名");
    expect(html).toContain("○ 正解");
    expect(html).toContain("＋1");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("正答：");
  });
  it("makes an error and final full score unmistakable", () => {
    const incorrect = renderToStaticMarkup(createElement(ImmediateVerdict, { verdict: { attemptId: "b", correct: false, questionNumber: 2, fieldLabel: "組成式", fullScore: false } }));
    expect(incorrect).toContain("× 不正解");
    expect(incorrect).not.toContain("＋1");
    const perfect = renderToStaticMarkup(createElement(ImmediateVerdict, { verdict: { attemptId: "c", correct: true, questionNumber: 10, fieldLabel: "イオン式", fullScore: true } }));
    expect(perfect).toContain("全問正解！");
  });
});
