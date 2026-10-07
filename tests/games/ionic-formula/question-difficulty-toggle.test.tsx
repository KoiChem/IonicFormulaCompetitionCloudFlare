import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionDifficultyToggle, toggleItemDifficulty } from "../../../app/teacher/QuestionDifficultyToggle";
import { CompetitionSettingsForm, DEFAULT_SETTINGS, settingsSummary } from "../../../src/features/setup/CompetitionSettingsForm";

describe("item difficulty assignment", () => {
  it.each([
    ["off", "normal", "normal"], ["off", "hard", "hard"],
    ["normal", "normal", "off"], ["normal", "hard", "both"],
    ["hard", "normal", "both"], ["hard", "hard", "off"],
    ["both", "normal", "hard"], ["both", "hard", "normal"],
  ] as const)("toggles %s membership in %s to %s", (value, level, next) => {
    expect(toggleItemDifficulty(value, level)).toBe(next);
    expect(toggleItemDifficulty(next, level)).toBe(value);
  });

  it.each([
    ["off", false, false, "出題しない"],
    ["normal", true, false, "やさしめ"],
    ["hard", false, true, "ややむず"],
    ["both", true, true, "両方"],
  ] as const)("renders %s with a named group and independent button states", (value, normal, hard, status) => {
    const html = renderToStaticMarkup(createElement(QuestionDifficultyToggle, { name: "ナトリウムイオン", value, onChange() {} }));
    expect(html).toContain('role="group" aria-label="ナトリウムイオンの出題難易度"');
    expect(html).toContain(`aria-pressed="${normal}" aria-label="やさしめ"`);
    expect(html).toContain(`aria-pressed="${hard}" aria-label="ややむず"`);
    expect(html).toContain(`>${status}</span>`);
    expect(html.match(/type="button"/g)).toHaveLength(2);
  });

  it("disables both controls while saving or after a conflict", () => {
    const html = renderToStaticMarkup(createElement(QuestionDifficultyToggle, { name: "塩化ナトリウム", value: "both", onChange() {}, disabled: true }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it.each([ ["normal", "やさしめ"], ["hard", "ややむず"] ] as const)("uses the same %s label in room controls and summaries", (difficulty, label) => {
    const value = { ...DEFAULT_SETTINGS, difficulty };
    expect(settingsSummary(value)).toContain(`・${label}・`);
    const html = renderToStaticMarkup(createElement(CompetitionSettingsForm, { value, onChange() {} }));
    expect(html).toContain(`>${label}</button>`);
    expect(html).not.toMatch(/標準|難しい/);
  });
});
