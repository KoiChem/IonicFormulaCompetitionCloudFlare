import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { generateQuestionSet, validateGameSettings } from "../../../src/games/ionic-formula/server/question-generator";
import { evaluateField } from "../../../src/games/ionic-formula/shared/answer-evaluator";
import { FormulaKeyboard, FORMULA_TOKENS, CHARGE_OPTIONS } from "../../../src/games/ionic-formula/client/FormulaKeyboard";
import { NameKeyboard } from "../../../src/games/ionic-formula/client/NameKeyboard";
import * as gestures from "../../../src/games/ionic-formula/client/formula-keyboard-gesture";
import { DEFAULT_SETTINGS, CompetitionSettingsForm, settingsSummary } from "../../../src/features/setup/CompetitionSettingsForm";
import type { IonicFormulaGameSettings, InternalQuestion } from "../../../src/games/ionic-formula/shared/types";

const settings = (overrides = {}) => ({ ...DEFAULT_SETTINGS, ...overrides } as IonicFormulaGameSettings);
function collect(value: IonicFormulaGameSettings) {
  let seed = 17;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const questions = new Map<string, InternalQuestion>();
  for (let i = 0; i < 200; i++) for (const q of generateQuestionSet(value, random)) questions.set(q.itemId, q);
  return questions;
}

describe("IonicFormula complex curriculum port", () => {
  it.each(["ion", "compound"] as const)("adds only initially enabled standard %s items when switched on", mode => {
    const off = collect(settings({ mode }));
    const on = collect(settings({ mode, complexEnabled: true }));
    const added = [...on.keys()].filter(id => !off.has(id));
    expect(added).toHaveLength(mode === "ion" ? 10 : 4);
    expect(added).not.toContain("complex_ag_cn_2");
    expect(added).not.toContain("acid_h_au_cl_4");
    expect(added).not.toContain("acid_h2_pt_cl_6");
    expect(validateGameSettings(settings({ mode, complexEnabled: true })).availableCount).toBe(off.size + added.length);
  });
  it("keeps default and old rooms free of complex items", () => {
    expect([...collect(settings()).keys()].some(id => id.startsWith("complex_"))).toBe(false);
    expect([...collect(settings({ mode: "compound" })).keys()].some(id => id.startsWith("salt_"))).toBe(false);
  });
  it("grades Fe(II) and Fe(III) as separate charges and rejects legacy ligand names", () => {
    const formula = collect(settings({ complexEnabled: true, ionAnswer: "formula" }));
    const ii = formula.get("complex_fe_cn_6_ii")!;
    const iii = formula.get("complex_fe_cn_6_iii")!;
    expect(ii).toBeDefined(); expect(iii).toBeDefined();
    if (!ii || !iii) return;
    const value = { tokens: [..."[Fe(CN)6]"], cursor: 9, charge: { magnitude: 4, sign: "-", source: "chargeButton" } };
    expect(evaluateField(ii, "formula", value).correct).toBe(true);
    expect(evaluateField(iii, "formula", value).correct).toBe(false);
    expect(evaluateField(ii, "formula", { ...value, tokens: [..."[Fe(CN)6)"] }).correct).toBe(false);
    const named = collect(settings({ complexEnabled: true, ionAnswer: "name" })).get("complex_fe_cn_6_ii")!;
    expect(evaluateField(named, "name", "ヘキサシアニド鉄(Ⅱ)酸イオン").correct).toBe(true);
    expect(evaluateField(named, "name", "ヘキサシアノ鉄(Ⅱ)酸イオン").correct).toBe(false);
  });
  it("offers bracket tokens, both vertical bracket flicks, and the 4− charge", () => {
    expect(FORMULA_TOKENS).toContain("["); expect(FORMULA_TOKENS).toContain("]");
    expect(CHARGE_OPTIONS).toContainEqual({ magnitude: 4, sign: "-", source: "chargeButton" });
    const flick = (gestures as unknown as { classifyBracketFlick?: (x: number, y: number) => string }).classifyBracketFlick;
    expect(flick).toBeTypeOf("function");
    if (!flick) return;
    expect(flick(0, 20)).toBe("alternate"); expect(flick(0, -20)).toBe("alternate");
    expect(flick(0, 0)).toBe("tap"); expect(flick(30, 20)).toBe("cancel");
    const html = renderToStaticMarkup(createElement(FormulaKeyboard, { value: { tokens: [], cursor: 0, charge: null }, onChange() {} }));
    expect(html).toContain('aria-label="電荷 4-"');
  });
  it("shows the switch beside difficulty and includes it in the room summary", () => {
    const value = settings({ complexEnabled: true });
    const html = renderToStaticMarkup(createElement(CompetitionSettingsForm, { value, onChange() {} }));
    expect(html).toContain("錯イオン"); expect(html).toContain("ON");
    expect(settingsSummary(value)).toContain("錯イオンあり");
  });
  it("shows eight ligand shortcuts only for normal difficulty with complex questions enabled", () => {
    const render = (props = {}) => renderToStaticMarkup(createElement(NameKeyboard, { value: "", onChange() {}, kind: "ion", ...props } as Parameters<typeof NameKeyboard>[0]));
    const normal = render({ complexEnabled: true, difficulty: "normal" });
    for (const word of ["ジ", "トリ", "テトラ", "ヘキサ", "アンミン", "シアニド", "クロリド", "ヒドロキシド"]) expect(normal).toContain(`>${word}</button>`);
    expect(render()).not.toContain("ヒドロキシド");
    expect(render({ complexEnabled: true, difficulty: "hard" })).not.toContain("ヒドロキシド");
  });
});
