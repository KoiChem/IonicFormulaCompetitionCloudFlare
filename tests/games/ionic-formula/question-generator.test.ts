import { describe, expect, it } from "vitest";

import {
  generateQuestionSet,
  toPublicQuestion,
  validateGameSettings,
} from "../../../src/games/ionic-formula/server/question-generator";
import type {
  IonicFormulaGameSettings,
  QuestionProgress,
} from "../../../src/games/ionic-formula/shared/types";

function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

const baseSettings = (overrides: Partial<IonicFormulaGameSettings> = {}): IonicFormulaGameSettings => ({
  questionCount: 10,
  timeLimitMinutes: 5,
  mode: "ion",
  difficulty: "normal",
  ionAnswer: "random",
  compoundPrompts: { formula: true, name: true },
  compoundAnswer: "random",
  ...overrides,
});

const bothSettings = (overrides: Partial<IonicFormulaGameSettings> = {}) => baseSettings({
  mode: "compound",
  compoundAnswer: "both",
  ...overrides,
});

const emptyProgress = (): QuestionProgress => ({ resolvedFieldIds: [] });

describe("generateQuestionSet", () => {
  const ionSettings = ["formula", "name", "random"] as const;
  const promptSettings = [
    { formula: true, name: false },
    { formula: false, name: true },
    { formula: true, name: true },
  ] as const;
  const compoundAnswers = ["formula", "name", "random", "both"] as const;

  it.each([5, 10, 15] as const)("generates %i unique questions for every supported game setting", (questionCount) => {
    const settings: IonicFormulaGameSettings[] = [];
    for (const difficulty of ["normal", "hard"] as const) {
      for (const ionAnswer of ionSettings) settings.push(baseSettings({ questionCount, difficulty, ionAnswer }));
      for (const compoundPrompts of promptSettings) {
        for (const compoundAnswer of compoundAnswers) {
          settings.push(baseSettings({ questionCount, difficulty, mode: "compound", compoundPrompts, compoundAnswer }));
        }
      }
    }

    expect(settings).toHaveLength(30);
    settings.forEach((setting, index) => {
      const questions = generateQuestionSet(setting, seeded(index + questionCount));
      expect(questions, JSON.stringify(setting)).toHaveLength(questionCount);
      expect(new Set(questions.map((question) => question.itemId)).size, JSON.stringify(setting)).toBe(questionCount);
      expect(questions.map((question) => question.ordinal)).toEqual(Array.from({ length: questionCount }, (_, ordinal) => ordinal));
      expect(new Set(questions.map((question) => question.id)).size).toBe(questionCount);
    });
  });

  it("counts formula and name as two score fields in one question", () => {
    const [question] = generateQuestionSet(bothSettings({ questionCount: 5 }), seeded(1));
    expect(question.ordinal).toBe(0);
    expect(question.fields.map((field) => field.id)).toEqual(["formula", "name"]);
    expect(question.maxScore).toBe(2);
  });

  it("does not expose answers or server selection data in a public question", () => {
    const questions = generateQuestionSet(bothSettings({ questionCount: 5 }), seeded(2));
    const [question] = questions;
    expect(question.answer.type).toBe("both");
    if (question.answer.type !== "both") throw new Error("expected a two-field answer");
    const publicQuestion = toPublicQuestion(question, emptyProgress());
    const serialized = JSON.stringify(publicQuestion);
    expect(serialized).not.toContain(question.answer.formula.canonical);
    expect(serialized).not.toContain(question.answer.name.canonical);
    expect(serialized).not.toContain(question.itemId);
    expect(serialized).not.toContain("seed");
    expect(serialized).not.toContain(questions[1].id);
    expect(Object.keys(publicQuestion).sort()).toEqual(["fields", "id", "ordinal", "progress", "prompt"]);
  });

  it("returns detached frozen public DTOs that cannot mutate internal snapshots", () => {
    const [question] = generateQuestionSet(bothSettings({ questionCount: 5 }), seeded(22));
    const progress: QuestionProgress = { resolvedFieldIds: ["formula"] };
    const publicQuestion = toPublicQuestion(question, progress);

    expect(publicQuestion.prompt).not.toBe(question.prompt);
    expect(publicQuestion.prompt.values).not.toBe(question.prompt.values);
    expect(publicQuestion.fields).not.toBe(question.fields);
    expect(publicQuestion.fields[0]).not.toBe(question.fields[0]);
    expect(publicQuestion.progress).not.toBe(progress);
    expect(publicQuestion.progress.resolvedFieldIds).not.toBe(progress.resolvedFieldIds);
    expect(Object.isFrozen(publicQuestion)).toBe(true);
    expect(Object.isFrozen(publicQuestion.prompt.values)).toBe(true);
    expect(Object.isFrozen(publicQuestion.fields)).toBe(true);
    expect(Object.isFrozen(publicQuestion.progress.resolvedFieldIds)).toBe(true);

    const originalPromptValue = question.prompt.values[0].value;
    expect(Reflect.set(publicQuestion.prompt.values[0], "value", "mutated")).toBe(false);
    expect(() => (publicQuestion.fields as unknown[]).push({ id: "name", type: "name" })).toThrow();
    expect(() => (publicQuestion.progress.resolvedFieldIds as string[]).push("name")).toThrow();
    expect(question.prompt.values[0].value).toBe(originalPromptValue);
    expect(question.fields.map((field) => field.id)).toEqual(["formula", "name"]);
  });

  it("deep-freezes the generated internal question set", () => {
    const questions = generateQuestionSet(bothSettings({ questionCount: 5 }), seeded(23));
    const [question] = questions;
    expect(Object.isFrozen(questions)).toBe(true);
    expect(Object.isFrozen(question)).toBe(true);
    expect(Object.isFrozen(question.prompt)).toBe(true);
    expect(Object.isFrozen(question.prompt.values)).toBe(true);
    expect(Object.isFrozen(question.fields)).toBe(true);
    expect(Object.isFrozen(question.answer)).toBe(true);
    expect(() => (questions as unknown[]).pop()).toThrow();
    expect(Reflect.set(question, "ordinal", 99)).toBe(false);
  });

  it("balances compound ion order once across the requested set", () => {
    for (const questionCount of [5, 10, 15] as const) {
      const questions = generateQuestionSet(bothSettings({ questionCount }), seeded(questionCount));
      const cations = questions.filter((question) => question.prompt.order === "cationFirst").length;
      const anions = questions.filter((question) => question.prompt.order === "anionFirst").length;
      expect(Math.abs(cations - anions)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps zero-weight categories excluded without fixing positive-weight category quotas", () => {
    const questions = generateQuestionSet(baseSettings({
      questionCount: 10,
      mode: "compound",
      difficulty: "hard",
      compoundPrompts: { formula: true, name: false },
      compoundAnswer: "name",
    }), seeded(4));
    const categories = questions.reduce<Record<string, number>>((counts, question) => ({
      ...counts,
      [question.category]: (counts[question.category] ?? 0) + 1,
    }), {});
    expect(categories.simple11).toBeUndefined();
    expect(Object.values(categories).reduce((sum, count) => sum + count, 0)).toBe(10);
  });

  it("selects each eligible item at its equal per-item rate across supported modes and difficulties", () => {
    const batches = 10_000;
    for (const mode of ["ion", "compound"] as const) for (const difficulty of ["normal", "hard"] as const) {
      const settings = baseSettings({ mode, difficulty });
      const eligibleCount = validateGameSettings(settings).availableCount;
      const counts = new Map<string, number>();
      const random = seeded(mode === "ion" ? difficulty === "normal" ? 101 : 102 : difficulty === "normal" ? 103 : 104);
      for (let trial = 0; trial < batches; trial += 1) {
        const questions = generateQuestionSet(settings, random);
        for (const question of questions) counts.set(question.itemId, (counts.get(question.itemId) ?? 0) + 1);
      }
      expect(counts.size).toBe(eligibleCount);
      const probability = settings.questionCount / eligibleCount;
      const expected = batches * probability;
      const tolerance = 6 * Math.sqrt(batches * probability * (1 - probability));
      for (const [itemId, count] of counts) expect(Math.abs(count - expected), `${mode}/${difficulty}/${itemId}`).toBeLessThan(tolerance);
    }
  // Forty thousand generated sets take longer on shared CI runners.
  }, 90_000);

  it("balances ion answer directions after selecting the same eligible items", () => {
    for (const questionCount of [5, 10, 15] as const) {
      const mixed = generateQuestionSet(baseSettings({ questionCount, ionAnswer: "random" }), seeded(600 + questionCount));
      const fixed = generateQuestionSet(baseSettings({ questionCount, ionAnswer: "formula" }), seeded(600 + questionCount));
      expect(mixed.map(question => question.itemId)).toEqual(fixed.map(question => question.itemId));
      const formulaCount = mixed.filter(question => question.variant === "ionNameToFormula").length;
      expect(Math.abs(formulaCount - (mixed.length - formulaCount))).toBeLessThanOrEqual(1);
    }
  });

  it("rejects invalid prompt settings and reports candidate capacity", () => {
    expect(() => validateGameSettings(baseSettings({
      mode: "compound",
      compoundPrompts: { formula: false, name: false },
    }))).toThrow("出題");
    const validation = validateGameSettings(bothSettings({ questionCount: 15 }));
    expect(validation.availableCount).toBeGreaterThanOrEqual(15);
    expect(validation.maxScore).toBe(30);
  });

  it("never generates the excluded Fe(OH)3 formula", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const questions = generateQuestionSet(bothSettings({ questionCount: 15, difficulty: "hard" }), seeded(seed));
      expect(JSON.stringify(questions)).not.toContain("Fe(OH)3");
    }
  });
});
