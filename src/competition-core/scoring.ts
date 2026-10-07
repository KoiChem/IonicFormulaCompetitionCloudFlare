import type { AnswerFieldId } from "../games/ionic-formula/shared/types";
import type { FieldProgress, QuestionScore } from "./types";

function withFields(
  score: QuestionScore,
  fields: QuestionScore["fields"],
): QuestionScore {
  const values = Object.values(fields);
  return {
    ...score,
    fields,
    correctCount: values.filter((field) => field?.state === "correct").length,
    resolved: values.length > 0
      && values.every((field) => field?.state === "correct" || field?.state === "passed"),
  };
}

export function applyFieldResult(
  score: QuestionScore,
  fieldId: AnswerFieldId,
  correct: boolean,
  elapsedMs: number,
): QuestionScore {
  const field = score.fields[fieldId];
  if (!field) throw new TypeError(`Unknown answer field: ${fieldId}`);
  if (field.state !== "pending") return score;

  const updated: FieldProgress = correct
    ? { state: "correct", attemptCount: field.attemptCount + 1, resolvedAtMs: elapsedMs }
    : { state: "pending", attemptCount: field.attemptCount + 1 };
  return withFields(score, { ...score.fields, [fieldId]: updated });
}

export function applyPass(score: QuestionScore, fieldId: AnswerFieldId, elapsedMs: number): QuestionScore {
  if (!score.fields[fieldId]) throw new TypeError(`Unknown answer field: ${fieldId}`);
  const fields = Object.fromEntries(
    Object.entries(score.fields).map(([currentId, field]) => [
      currentId,
      currentId === fieldId && field?.state === "pending"
        ? { ...field, state: "passed" as const, resolvedAtMs: elapsedMs }
        : field,
    ]),
  ) as QuestionScore["fields"];
  return withFields(score, fields);
}

export function markUnansweredAtTimeout(score: QuestionScore): QuestionScore {
  const fields = Object.fromEntries(
    Object.entries(score.fields).map(([fieldId, field]) => [
      fieldId,
      field?.state === "pending" ? { ...field, state: "unanswered" as const } : field,
    ]),
  ) as QuestionScore["fields"];
  return withFields(score, fields);
}
