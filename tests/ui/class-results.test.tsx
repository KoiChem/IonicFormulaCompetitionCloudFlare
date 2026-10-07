import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Results } from "../../src/features/results/Results";
import { teacherTopRank, topRankingRows } from "../../src/features/results/ranking-visibility";
import { ReturnHomeButton } from "../../src/features/setup/ReturnHomeButton";
import { EndRoomButton } from "../../src/features/lobby/EndRoomButton";

const ranking = Array.from({ length: 12 }, (_, index) => ({
  rank: index + 1,
  nickname: `生徒${index + 1}`,
  correctCount: 12 - index,
  elapsedCs: 1_000 + index,
  finishReason: "completed",
}));

describe("class result visibility", () => {
  it("shows the correct answer and an incorrect-colored unanswered badge in deferred results", () => {
    const html = renderToStaticMarkup(createElement(Results, { data: {
      room: { kind: "class", settings: { gradingMode: "deferred", mode: "ion", difficulty: "normal", ionAnswer: "formula", compoundPrompts: { formula: true, name: true }, compoundAnswer: "formula", questionCount: 5, timeLimitMinutes: 5 } },
      questions: [
        { id: "empty", ordinal: 0, prompt: { kind: "ionName", values: [{ type: "name", value: "ナトリウムイオン" }] }, fields: [{ id: "formula", state: "unanswered", correctAnswer: "Na+", correctFormulaCore: "Na", correctFormulaCharge: 1, lastAnswer: null, lastAnswerCorrect: null }] },
        { id: "right", ordinal: 1, prompt: { kind: "ionFormula", values: [{ type: "formula", value: "HCO3", charge: -1 }] }, fields: [{ id: "name", state: "correct", correctAnswer: "炭酸水素イオン", lastAnswer: "炭酸水素イオン", lastAnswerCorrect: true }] },
      ],
    } }));
    expect(html).toContain("第１問：");
    expect(html).toContain("第２問：");
    expect(html).toContain('class="verdict incorrect">未解答');
    expect(html).toContain("炭酸水素イオン");
    expect(html).not.toContain("問題：");
  });
  it("labels interrupted participants and unresolved fields without calling them timed out", () => {
    const html = renderToStaticMarkup(createElement(Results, { data: {
      room: { kind: "class", endReason: "interrupted" },
      ranking: [{ rank: 1, nickname: "A", correctCount: 0, elapsedCs: 100, finishReason: "interrupted" }],
      own: { rank: 1, correctCount: 0, elapsedCs: 100, finishReason: "interrupted" },
      questions: [{ id: "q", ordinal: 0, prompt: { kind: "ionName", values: [{ type: "name", value: "ナトリウムイオン" }] }, fields: [{ id: "formula", state: "unanswered", correctAnswer: "Na+", lastAnswer: null, lastAnswerCorrect: null }] }],
    } }));
    expect(html).toContain("中断時の結果");
    expect(html).toContain("中断時未回答");
    expect(html).not.toContain("時間切れ");
  });
  it.each([[1, 1], [2, 2], [3, 3], [5, 3], [8, 3], [10, 5], [19, 5], [20, 10], [25, 10], [29, 10], [30, 15], [40, 15], [42, 15]])("shows the expected top rank for %i participants", (count, expected) => {
    expect(teacherTopRank(count)).toBe(expected);
  });

  it("includes everyone tied at the boundary", () => {
    expect(topRankingRows([{ rank: 1 }, { rank: 3 }, { rank: 3 }, { rank: 4 }], 3)).toHaveLength(3);
  });
  it("shows top three and the rank-twelve participant's own result, without lower classmates", () => {
    const html = renderToStaticMarkup(createElement(Results, { data: {
      room: { kind: "class" }, ranking,
      own: { rank: 12, correctCount: 1, elapsedCs: 1_211, finishReason: "completed" },
      questions: [],
    } }));
    expect(html).toContain("生徒1");
    expect(html).toContain("生徒3");
    expect(html).not.toContain("生徒4");
    expect(html).toContain("あなたの結果");
    expect(html).toContain("12位");
    expect(html).toContain("あなたの問題別結果");
  });

  it("starts the class teacher list collapsed and leaves mate ranking complete", () => {
    const aggregate = { averageCorrectCount: 5, perfectCount: 1, completedCount: 12 };
    const teacher = renderToStaticMarkup(createElement(Results, { data: { room: { kind: "class" }, ranking, aggregate } }));
    expect(teacher).toContain("生徒5");
    expect(teacher).not.toContain("生徒6");
    expect(teacher).toContain("全成績を表示");
    expect(teacher).toContain('aria-expanded="false"');
    expect(teacher).toContain("クラス集計");

    const mate = renderToStaticMarkup(createElement(Results, { data: { room: { kind: "mate" }, ranking } }));
    expect(mate).toContain("生徒12");
    expect(mate).not.toContain("全成績を表示");
  });

  it("uses matching restrained podium styles for teacher and participant, including ties", () => {
    const tied = [{ ...ranking[0], rank: 1 }, { ...ranking[1], rank: 1 }, { ...ranking[2], rank: 3 }];
    const teacher = renderToStaticMarkup(createElement(Results, { data: { room: { kind: "class" }, ranking: tied, aggregate: { averageCorrectCount: 1, perfectCount: 0, completedCount: 3 } } }));
    const participant = renderToStaticMarkup(createElement(Results, { data: { room: { kind: "class" }, ranking: tied, own: { rank: 1, correctCount: 12, elapsedCs: 1000 } } }));
    expect(teacher.match(/podium-rank-1/g)).toHaveLength(2);
    expect(teacher).toContain("podium-rank-3");
    expect(participant.match(/podium-rank-1/g)).toHaveLength(3);
    expect(participant).not.toContain("podium-laurel");
    expect(teacher).not.toContain("podium-laurel");
    expect(participant).toContain("ホームへ戻る");
    expect(participant).not.toContain("もう一度");
  });
});

describe("exit controls", () => {
  it("renders accessible modal text for both exit actions", () => {
    const home = renderToStaticMarkup(createElement(ReturnHomeButton));
    expect(home).toContain("ホームへ戻る");
    expect(home).toContain("入力中の設定は保存されません。");
    expect(home).toContain("戻らない");
    const end = renderToStaticMarkup(createElement(EndRoomButton, { busy: false, onEnd: async () => {} }));
    expect(end).toContain("このルームを終了しますか？");
    expect(end).toContain("成績と順位は作成されません。");
    expect(end).toContain("終了する");
  });
});
