import { describe, expect, it } from "vitest";

import ions from "../../../src/games/ionic-formula/data/ions.json";
import compounds from "../../../src/games/ionic-formula/data/compounds.json";
import difficulty from "../../../src/games/ionic-formula/data/difficulty.json";
import { generateQuestionSet } from "../../../src/games/ionic-formula/server/question-generator";
import type { IonicFormulaGameSettings } from "../../../src/games/ionic-formula/shared/types";

function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => ((value = (1664525 * value + 1013904223) >>> 0) / 2 ** 32);
}

const settings = (overrides: Partial<IonicFormulaGameSettings> = {}): IonicFormulaGameSettings => ({
  questionCount: 10,
  timeLimitMinutes: 5,
  mode: "ion",
  difficulty: "normal",
  ionAnswer: "random",
  compoundPrompts: { formula: true, name: true },
  compoundAnswer: "random",
  ...overrides,
});

const counts = (values: readonly string[]) => values.reduce<Record<string, number>>((result, value) => ({
  ...result,
  [value]: (result[value] ?? 0) + 1,
}), {});

describe("vendored IonicFormula regression", () => {
  it("retains the verified dataset sizes and key chemistry records", () => {
    expect(ions).toHaveLength(47);
    expect(compounds).toHaveLength(158);
    expect(new Set(ions.map((ion) => ion.id)).size).toBe(47);
    expect(new Set(compounds.map((compound) => compound.id)).size).toBe(158);
    expect(ions.find((ion) => ion.id === "lithium")).toMatchObject({ formula: "Li", charge: 1, name: "リチウムイオン" });
    expect(ions.find((ion) => ion.id === "nitride")).toMatchObject({ formula: "N", charge: -3 });
    expect(compounds.find((compound) => compound.id === "calcium_nitride")).toMatchObject({ formula: "Ca3N2" });
    expect(compounds.find((compound) => compound.id === "lead4_oxide")).toMatchObject({ formula: "PbO2", name: "酸化鉛(Ⅳ)" });
  });

  it("keeps advanced ions out of normal mode and their compounds hard-only", () => {
    const advancedIonIds = ["chromium3", "manganese2", "tin2", "tin4", "gold3", "lead2", "lead4", "sulfite", "nitrite", "permanganate", "chromate", "dichromate"];
    for (const id of advancedIonIds) {
      expect(ions.find((ion) => ion.id === id), id).toMatchObject({ difficulty: "hard", ionQuestionEnabled: false, enabled: true });
    }
    for (const id of ["chromium3_chloride", "tin4_oxide", "lead2_nitrate", "potassium_permanganate"]) {
      expect(compounds.find((compound) => compound.id === id), id).toMatchObject({ difficulty: "hard", enabled: true });
    }
    const normalIds = new Set(generateQuestionSet(settings({ questionCount: 15 }), seeded(41)).map((question) => question.itemId));
    expect(advancedIonIds.some((id) => normalIds.has(id))).toBe(false);
  });

  it("keeps hydronium available only in hard ion questions", () => {
    expect(ions.find((ion) => ion.id === "hydronium")).toMatchObject({
      formula: "H3O", charge: 1, difficulty: "hard", ionQuestionEnabled: true,
    });
    for (let seed = 1; seed <= 80; seed += 1) {
      expect(generateQuestionSet(settings({ questionCount: 15 }), seeded(seed)).some((question) => question.itemId === "hydronium")).toBe(false);
    }
    const hardIds = new Set<string>();
    for (let seed = 1; seed <= 80; seed += 1) {
      for (const question of generateQuestionSet(settings({ questionCount: 15, difficulty: "hard" }), seeded(seed))) hardIds.add(question.itemId);
    }
    expect(hardIds.has("hydronium")).toBe(true);
  });

  it("preserves the category eligibility configuration without fixed question quotas", () => {
    expect(difficulty.categoryWeights).toEqual({
      ion: {
        normal: { ionSimple: 6, ionPolyatomic: 3, ionVariableOx: 1 },
        hard: { ionSimple: 2, ionPolyatomic: 6, ionVariableOx: 2 },
      },
      compound: {
        normal: { simple11: 3, simpleRatio: 4, polyatomic: 2, variableOx: 1 },
        hard: { simple11: 0, simpleRatio: 1, polyatomic: 5, variableOx: 4 },
      },
    });
    expect(generateQuestionSet(settings(), seeded(1))).toHaveLength(10);
    expect(generateQuestionSet(settings({ difficulty: "hard" }), seeded(2))).toHaveLength(10);
    expect(generateQuestionSet(settings({ mode: "compound" }), seeded(3))).toHaveLength(10);
    const hardCompounds = generateQuestionSet(settings({ mode: "compound", difficulty: "hard" }), seeded(4));
    expect(hardCompounds).toHaveLength(10);
    expect(hardCompounds.some((question) => question.category === "simple11")).toBe(false);
  });

  it("preserves ion answer presets and balanced random allocation", () => {
    expect(new Set(generateQuestionSet(settings({ ionAnswer: "formula" }), seeded(11)).map((question) => question.variant))).toEqual(new Set(["ionNameToFormula"]));
    expect(new Set(generateQuestionSet(settings({ ionAnswer: "name" }), seeded(12)).map((question) => question.variant))).toEqual(new Set(["ionFormulaToName"]));
    expect(counts(generateQuestionSet(settings({ ionAnswer: "random" }), seeded(13)).map((question) => question.variant))).toEqual({ ionNameToFormula: 5, ionFormulaToName: 5 });
  });

  it("preserves compound prompt and answer mode allocations", () => {
    const formulaPrompt = generateQuestionSet(settings({
      mode: "compound", compoundPrompts: { formula: true, name: false }, compoundAnswer: "random",
    }), seeded(20));
    expect(counts(formulaPrompt.map((question) => question.variant))).toEqual({ ionsToFormula: 5, ionsToName: 5 });

    const namePrompt = generateQuestionSet(settings({
      mode: "compound", compoundPrompts: { formula: false, name: true }, compoundAnswer: "both",
    }), seeded(21));
    expect(new Set(namePrompt.map((question) => question.variant))).toEqual(new Set(["ionNamesToBoth"]));

    const mixed = generateQuestionSet(settings({
      questionCount: 15, mode: "compound", compoundPrompts: { formula: true, name: true }, compoundAnswer: "random",
    }), seeded(22));
    const variantCounts = counts(mixed.map((question) => question.variant));
    expect(Object.keys(variantCounts).sort()).toEqual([
      "ionNamesToFormula", "ionNamesToName", "ionsToFormula", "ionsToName", "mixedIonsToFormula", "mixedIonsToName",
    ]);
    expect(Object.values(variantCounts).sort()).toEqual([2, 2, 2, 3, 3, 3]);
  });

  it("retains the Fe(OH)3 exclusion and name-only iron(III) hydroxide", () => {
    expect(JSON.stringify({ ions, compounds })).not.toContain("Fe(OH)3");
    expect(compounds.find((compound) => compound.id === "iron3_hydroxide")).toMatchObject({
      formula: null,
      questionModes: { ionsToFormula: false, ionsToName: true },
    });
    for (let seed = 1; seed <= 40; seed += 1) {
      const generated = generateQuestionSet(settings({
        questionCount: 15, mode: "compound", difficulty: "hard", compoundAnswer: "formula",
      }), seeded(seed));
      expect(generated.some((question) => question.itemId === "iron3_hydroxide")).toBe(false);
    }
  });
});
