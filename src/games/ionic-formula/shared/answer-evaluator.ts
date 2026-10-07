import type {
  AnswerSpecification,
  FieldEvaluation,
  FormulaEntry,
  InternalQuestion,
} from "./types";

export const EVALUATOR_VERSION = "ionic-formula-evaluator-1";

const SUBSCRIPT_DIGITS: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
};
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};

export function normalizeFormula(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (digit) => SUBSCRIPT_DIGITS[digit])
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (digit) => SUPERSCRIPT_DIGITS[digit])
    .replace(/[＋﹢]/g, "+")
    .replace(/[−ー―‐‑‒–—－﹣]/g, "-")
    .replace(/[（）]/g, (character) => character === "（" ? "(" : ")")
    .replace(/[\s\u3000]/g, "")
    .replace("^", "");
}

export function normalizeName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[（）]/g, (character) => character === "（" ? "(" : ")")
    .replace(/[\s\u3000]/g, "");
}

function evaluateAnswer(value: unknown, specification: AnswerSpecification): FieldEvaluation {
  const normalize = specification.type === "formula" ? normalizeFormula : normalizeName;
  const actual = normalize(value);
  if (!actual) return { correct: false, empty: true, matchedAnswerKind: null, note: null };
  if (actual === normalize(specification.canonical)) {
    return { correct: true, empty: false, matchedAnswerKind: "canonical", note: null };
  }
  const alternative = specification.accepted.find((entry) => actual === normalize(typeof entry === "string" ? entry : entry.formula));
  return alternative
    ? {
        correct: true,
        empty: false,
        matchedAnswerKind: "acceptedAlternative",
        note: typeof alternative === "string" ? null : alternative.note ?? null,
      }
    : { correct: false, empty: false, matchedAnswerKind: null, note: null };
}

function isFormulaEntry(value: unknown): value is FormulaEntry {
  return typeof value === "object" && value !== null && Array.isArray((value as FormulaEntry).tokens);
}

export function evaluateField(question: InternalQuestion, fieldId: string, value: unknown): FieldEvaluation {
  if (!question.fields.some((field) => field.id === fieldId)) throw new TypeError("この問題に存在しない解答欄です");
  const specification = question.answer.type === "both"
    ? question.answer[fieldId as "formula" | "name"]
    : question.answer;

  if (question.ionCharge !== undefined && fieldId === "formula") {
    if (!isFormulaEntry(value)) return { correct: false, empty: !normalizeFormula(value), matchedAnswerKind: null, note: null };
    const formula = normalizeFormula(value.tokens.join(""));
    const charge = value.charge;
    const expectedMagnitude = Math.abs(question.ionCharge);
    const expectedSign = question.ionCharge > 0 ? "+" : "-";
    const empty = !formula && !charge;
    const correct = charge?.source === "chargeButton"
      && formula === normalizeFormula(question.ionFormula)
      && charge.magnitude === expectedMagnitude
      && charge.sign === expectedSign;
    return { correct, empty, matchedAnswerKind: correct ? "canonical" : null, note: null };
  }
  if (fieldId === "formula" && isFormulaEntry(value)) {
    const formula = value.tokens.join("");
    if (value.charge) return { correct: false, empty: false, matchedAnswerKind: null, note: null };
    return evaluateAnswer(formula, specification);
  }
  return evaluateAnswer(value, specification);
}
