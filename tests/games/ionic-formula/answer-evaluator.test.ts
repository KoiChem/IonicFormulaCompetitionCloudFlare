import { describe, expect, it } from "vitest";

import { evaluateField } from "../../../src/games/ionic-formula/server/answer-evaluator";
import { generateQuestionSet } from "../../../src/games/ionic-formula/server/question-generator";
import {
  createFormulaEntry,
  formulaEntryValue,
  setFormulaCharge,
  setFormulaTokens,
} from "../../../src/games/ionic-formula/client/formula-entry";
import { normalizeFormula, normalizeName } from "../../../src/games/ionic-formula/server/answer-evaluator";
import type { InternalQuestion, IonicFormulaGameSettings } from "../../../src/games/ionic-formula/shared/types";

const settings: IonicFormulaGameSettings = {
  questionCount: 15,
  timeLimitMinutes: 5,
  mode: "ion",
  difficulty: "normal",
  ionAnswer: "formula",
  compoundPrompts: { formula: true, name: true },
  compoundAnswer: "random",
};

function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => ((value = (1664525 * value + 1013904223) >>> 0) / 2 ** 32);
}

function findQuestion(predicate: (question: InternalQuestion) => boolean): InternalQuestion {
  for (let seed = 1; seed <= 200; seed += 1) {
    const question = generateQuestionSet(settings, seeded(seed)).find(predicate);
    if (question) return question;
  }
  throw new Error("fixture question was not generated");
}

describe("normalization", () => {
  it("accepts width, subscript, superscript and parenthesis variants without ignoring element case", () => {
    expect(normalizeFormula(" ＣａＣｌ₂ ")).toBe("CaCl2");
    expect(normalizeFormula("Ａｌ₂（ＳＯ₄）₃")).toBe("Al2(SO4)3");
    expect(normalizeFormula("N³⁻")).toBe("N3-");
    expect(normalizeFormula("Nacl")).not.toBe(normalizeFormula("NaCl"));
    expect(normalizeFormula("CaOH2")).not.toBe(normalizeFormula("Ca(OH)2"));
  });

  it("normalizes Japanese names and Roman numerals", () => {
    expect(normalizeName("硫酸銅（Ⅱ）")).toBe(normalizeName("硫酸銅(II)"));
    expect(normalizeName(" 酸化鉄（Ⅲ） ")).toBe("酸化鉄(III)");
  });
});

describe("evaluateField", () => {
  it("requires ion charge to be entered separately with a charge control", () => {
    const nitrate = findQuestion((question) => question.itemId === "nitrate");
    let entry = createFormulaEntry();
    entry = setFormulaTokens(entry, ["N", "O", "3"]);
    entry = setFormulaCharge(entry, { magnitude: 1, sign: "-", source: "chargeButton" });
    expect(formulaEntryValue(entry)).toBe("NO3-");
    expect(evaluateField(nitrate, "formula", entry)).toMatchObject({ correct: true, empty: false });
    expect(evaluateField(nitrate, "formula", { ...entry, charge: { ...entry.charge!, source: "typed" } })).toMatchObject({ correct: false });
    expect(evaluateField(nitrate, "formula", setFormulaTokens(createFormulaEntry(), ["N", "O", "3", "-"]))).toMatchObject({ correct: false });
  });

  it("judges the structured payload actually sent by the formula UI", () => {
    const compound: InternalQuestion = {
      id: "calcium-chloride", ordinal: 0, itemId: "calcium_chloride", category: "compound", variant: "formula",
      prompt: { kind: "compoundIons", values: [] }, fields: [{ id: "formula", type: "formula" }], maxScore: 1,
      answer: { type: "formula", canonical: "CaCl2", accepted: [] },
    };
    expect(evaluateField(compound, "formula", { tokens: ["C", "a", "C", "l", "2"], cursor: 5, charge: null }).correct).toBe(true);
    expect(evaluateField(compound, "formula", { tokens: ["C", "a", "C", "l", "2"], cursor: 5, charge: { magnitude: 1, sign: "+", source: "chargeButton" } }).correct).toBe(false);
  });

  it("accepts curated acetate alternatives but rejects an unlisted empirical rewrite", () => {
    const compoundSettings: IonicFormulaGameSettings = {
      ...settings,
      mode: "compound",
      difficulty: "normal",
      compoundPrompts: { formula: true, name: true },
      compoundAnswer: "formula",
    };
    let acetate: InternalQuestion | undefined;
    for (let seed = 1; seed <= 300 && !acetate; seed += 1) {
      acetate = generateQuestionSet(compoundSettings, seeded(seed)).find((question) => question.itemId === "lithium_acetate");
    }
    expect(acetate).toBeDefined();
    expect(evaluateField(acetate!, "formula", "CH3COOLi")).toMatchObject({ correct: true, matchedAnswerKind: "canonical" });
    expect(evaluateField(acetate!, "formula", "LiCH3COO")).toMatchObject({ correct: true, matchedAnswerKind: "acceptedAlternative" });
    expect(evaluateField(acetate!, "formula", "LiC2H3O2")).toMatchObject({ correct: false });
  });

  it("rejects an unknown field id", () => {
    const question = generateQuestionSet(settings, seeded(9))[0];
    expect(() => evaluateField(question, "name", "anything")).toThrow("解答欄");
  });
});
