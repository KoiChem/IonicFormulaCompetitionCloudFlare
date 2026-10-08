import { evaluateField } from "../games/ionic-formula/server/answer-evaluator";
import type { InternalQuestion } from "../games/ionic-formula/shared/types";

export type V2GradingMode = "immediate" | "deferred";
export type V2Operation = {
  readonly seq: number;
  readonly operationId: string;
  readonly type: "answer" | "pass" | "draft" | "advance" | "finish";
  readonly questionId?: string;
  readonly fieldId?: "formula" | "name";
  readonly value?: unknown;
  readonly elapsedMs: number;
  readonly editedElapsedMs?: number;
  readonly reason?: "completed" | "submitted" | "timeout" | "interrupted";
  readonly boundaryAtMs?: number;
};

export type V2FieldState = {
  readonly state: "unanswered" | "correct" | "incorrect" | "passed";
  readonly value: unknown;
  readonly editedElapsedMs: number | null;
};
export type V2Replay = {
  readonly fields: Record<string, V2FieldState>;
  readonly correctCount: number;
  readonly answeredCount: number;
  readonly resolvedQuestionCount: number;
  readonly finishedElapsedMs: number | null;
  readonly finishReason: "completed" | "submitted" | "timeout" | "interrupted" | null;
  readonly boundaryAcknowledged: boolean;
};

export function emptyV2Replay(): V2Replay {
  return { fields: {}, correctCount: 0, answeredCount: 0, resolvedQuestionCount: 0,
    finishedElapsedMs: null, finishReason: null, boundaryAcknowledged: false };
}

function fieldKey(questionId: string, fieldId: string) { return `${questionId}:${fieldId}`; }
function nonempty(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object" && value !== null && "tokens" in value) {
    const entry = value as { tokens?: unknown; charge?: unknown };
    return (Array.isArray(entry.tokens) && entry.tokens.some((token) => String(token).trim())) || entry.charge != null;
  }
  return false;
}

export function replayV2Operations(
  questions: readonly InternalQuestion[],
  gradingMode: V2GradingMode,
  operations: readonly V2Operation[],
  startAtMs: number,
  cutoffAtMs: number,
  interruption = false,
  gradeDeferred = true,
): V2Replay {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const fields: Record<string, V2FieldState> = {};
  let finishedElapsedMs: number | null = null;
  let finishReason: V2Replay["finishReason"] = null;
  let boundaryAcknowledged = false;
  let previousElapsed = -1;
  let currentOrdinal = 0;
  const advancedQuestions = new Set<string>();
  for (const operation of operations) {
    if (!Number.isSafeInteger(operation.seq) || operation.seq < 1
      || !Number.isFinite(operation.elapsedMs) || operation.elapsedMs < previousElapsed) throw new TypeError("invalid operation order");
    previousElapsed = operation.elapsedMs;
    if (operation.type === "finish") {
      if (finishedElapsedMs !== null) throw new TypeError("duplicate finish");
      if (operation.reason === "completed" && gradingMode !== "immediate") throw new TypeError("completed finish requires immediate mode");
      if (operation.reason === "completed" && currentOrdinal !== questions.length && startAtMs + operation.elapsedMs < cutoffAtMs)
        throw new TypeError("questions are not complete");
      if (operation.reason === "timeout" || operation.reason === "interrupted") {
        if (operation.boundaryAtMs === cutoffAtMs) boundaryAcknowledged = true;
      }
      if (operation.reason === "submitted" && startAtMs + operation.elapsedMs < cutoffAtMs) {
        finishedElapsedMs = operation.elapsedMs;
        finishReason = "submitted";
      } else if (operation.reason === "completed" && startAtMs + operation.elapsedMs < cutoffAtMs) {
        finishedElapsedMs = operation.elapsedMs;
        finishReason = "completed";
      }
      continue;
    }
    if (finishedElapsedMs !== null) {
      if (startAtMs + operation.elapsedMs < cutoffAtMs) throw new TypeError("operation after finish");
      continue;
    }
    const question = questionById.get(operation.questionId ?? "");
    if (operation.type === "advance") {
      if (gradingMode !== "deferred") throw new TypeError("invalid immediate operation");
      if (!question || operation.fieldId !== undefined || operation.value !== undefined) throw new TypeError("invalid question transition");
      if (startAtMs + operation.elapsedMs < cutoffAtMs && question.fields.some(field => nonempty(fields[fieldKey(question.id, field.id)]?.value))) {
        advancedQuestions.add(question.id);
      }
      continue;
    }
    if (!question || !operation.fieldId || !question.fields.some((field) => field.id === operation.fieldId)) throw new TypeError("invalid question or field");
    const fieldId = operation.fieldId;
    const key = fieldKey(question.id, fieldId);
    const previous = fields[key];
    const eventAtMs = startAtMs + operation.elapsedMs;
    const editAtMs = startAtMs + (operation.editedElapsedMs ?? operation.elapsedMs);
    const beforeCutoff = eventAtMs < cutoffAtMs || (
      !interruption && operation.type === "draft" && eventAtMs === cutoffAtMs && editAtMs < cutoffAtMs
    );
    if (!beforeCutoff) continue;
    if (gradingMode === "immediate") {
      if (operation.type === "draft" || question.ordinal > currentOrdinal || question.ordinal < currentOrdinal && previous?.state !== "passed") throw new TypeError("invalid immediate operation");
      if (previous?.state === "correct" || operation.type === "pass" && previous?.state === "passed") throw new TypeError("field already resolved");
      if (operation.type === "pass") {
        fields[key] = { state: "passed", value: previous?.value ?? null, editedElapsedMs: operation.elapsedMs };
      } else {
        const evaluation = evaluateField(question, fieldId, operation.value);
        fields[key] = { state: evaluation.correct ? "correct" : previous?.state === "passed" ? "passed" : "unanswered", value: operation.value,
          editedElapsedMs: operation.elapsedMs };
      }
      if (question.ordinal === currentOrdinal && question.fields.every((field) => ["correct", "passed"].includes(fields[fieldKey(question.id, field.id)]?.state ?? ""))) {
        currentOrdinal += 1;
      }
    } else {
      if (operation.type !== "draft") throw new TypeError("invalid deferred operation");
      if (!Number.isFinite(operation.editedElapsedMs ?? operation.elapsedMs)
        || (operation.editedElapsedMs ?? operation.elapsedMs) > operation.elapsedMs
        || editAtMs >= cutoffAtMs) continue;
      fields[key] = { state: nonempty(operation.value) ? "incorrect" : "unanswered", value: operation.value,
        editedElapsedMs: operation.editedElapsedMs ?? operation.elapsedMs };
    }
  }
  if (gradingMode === "deferred" && gradeDeferred) {
    for (const question of questions) for (const field of question.fields) {
      const key = fieldKey(question.id, field.id);
      const current = fields[key];
      if (!current || current.state === "unanswered") continue;
      fields[key] = { ...current, state: evaluateField(question, field.id, current.value).correct ? "correct" : "incorrect" };
    }
  }
  const correctCount = Object.values(fields).filter((field) => field.state === "correct").length;
  const answeredCount = Object.values(fields).filter((field) => nonempty(field.value)).length;
  const resolvedQuestionCount = gradingMode === "immediate" ? currentOrdinal : advancedQuestions.size;
  return { fields, correctCount, answeredCount, resolvedQuestionCount,
    finishedElapsedMs, finishReason, boundaryAcknowledged };
}
