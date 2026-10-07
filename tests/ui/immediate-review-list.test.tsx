import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImmediateReviewList } from "../../src/features/play/ImmediateReviewList";
import type { InternalQuestion } from "../../src/games/ionic-formula/shared/types";

const question = (id: string, ordinal: number, prompt: string): InternalQuestion => ({ id, ordinal, itemId: id, category: "compound", variant: "both", maxScore: 2,
  prompt: { kind: "ionName", values: [{ type: "name", value: prompt }] }, fields: [{ id: "formula", type: "formula" }, { id: "name", type: "name" }],
  answer: { type: "both", formula: { type: "formula", canonical: "NaCl", accepted: [] }, name: { type: "name", canonical: "塩化ナトリウム", accepted: [] } },
});

describe("immediate review cards", () => {
  it("does not render future question content or answer specifications", () => {
    const html = renderToStaticMarkup(createElement(ImmediateReviewList, { questions: [question("q0", 0, "表示する問題"), question("q1", 1, "未来の問題")], frontier: 0,
      fields: { "q0:formula": "passed", "q0:name": "correct" }, disabled: false, onRetry: () => undefined }));
    expect(html).toContain("表示する問題");
    expect(html).toContain("第2問：未着手");
    expect(html).not.toContain("未来の問題");
    expect(html).not.toContain("塩化ナトリウム");
    expect(html).toContain("式：パス・再解答する");
    expect(html).toContain("名称：正解");
  });
  it("offers each passed field independently in a two-field question", () => {
    const html = renderToStaticMarkup(createElement(ImmediateReviewList, { questions: [question("q0", 0, "問題")], frontier: 1,
      fields: { "q0:formula": "passedRetry", "q0:name": "passed" }, disabled: false, onRetry: () => undefined }));
    expect(html.match(/パス・再解答する/g)).toHaveLength(2);
    expect(html).toContain("再挑戦中");
  });
});

describe('normal continuation from the review list', () => {
  it('offers continuation only at the current frontier and preserves future concealment', () => {
    const html = renderToStaticMarkup(createElement(ImmediateReviewList, { questions: [question('q0', 0, '過去'), question('q1', 1, '続き'), question('q2', 2, '未来')], frontier: 1, fields: { 'q0:formula': 'correct', 'q0:name': 'correct' }, disabled: false, onRetry: () => undefined, onContinue: () => undefined }));
    expect(html.match(/この問題を解く/g)).toHaveLength(1);
    expect(html).toContain('第2問の解答に進む');
    expect(html).not.toContain('未来');
  });
  it('disables continuation when answering is unavailable', () => {
    const html = renderToStaticMarkup(createElement(ImmediateReviewList, { questions: [question('q0', 0, '問題')], frontier: 0, fields: {}, disabled: true, onRetry: () => undefined, onContinue: () => undefined }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>この問題を解く<\/button>/);
  });
});
