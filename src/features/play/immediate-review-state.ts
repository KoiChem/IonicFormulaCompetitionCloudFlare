import { evaluateField } from "../../games/ionic-formula/shared/answer-evaluator";
import type { InternalQuestion, PublicQuestion } from "../../games/ionic-formula/shared/types";
import type { V2Operation } from "../../competition-core/v2-operations";

export type ImmediateFieldStatus = "correct" | "passed" | "passedRetry" | "retry";

export function immediateReviewState(questions: readonly (InternalQuestion | PublicQuestion)[], operations: readonly V2Operation[]) {
  const fields: Record<string, ImmediateFieldStatus> = {};
  const byId = new Map(questions.map(question => [question.id, question]));
  for (const operation of operations) {
    if ((operation.type !== "answer" && operation.type !== "pass") || !operation.questionId || !operation.fieldId) continue;
    const question = byId.get(operation.questionId);
    if (!question) continue;
    const key = `${question.id}:${operation.fieldId}`;
    if (fields[key] === "correct") continue;
    if (operation.type === "pass") { fields[key] = "passed"; continue; }
    const correct = evaluateField(question as InternalQuestion, operation.fieldId, operation.value).correct;
    fields[key] = correct ? "correct" : fields[key] === "passed" || fields[key] === "passedRetry" ? "passedRetry" : "retry";
  }
  let frontier = 0;
  while (frontier < questions.length && questions[frontier].fields.every(field => ["correct", "passed", "passedRetry"].includes(fields[`${questions[frontier].id}:${field.id}`] ?? ""))) frontier += 1;
  return { fields, frontier, correctCount: Object.values(fields).filter(state => state === "correct").length };
}

// The normal continuation is independent of the question temporarily opened for review.
export function immediateResumeTarget(questions: readonly (InternalQuestion | PublicQuestion)[], operations: readonly V2Operation[]) {
  const progress = immediateReviewState(questions, operations);
  const question = questions[progress.frontier];
  const field = question?.fields.find(item => !['correct', 'passed', 'passedRetry'].includes(progress.fields[`${question.id}:${item.id}`] ?? ''));
  return question && field ? { ordinal: progress.frontier, fieldId: field.id } : null;
}
