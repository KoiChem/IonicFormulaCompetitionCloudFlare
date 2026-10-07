import type { AnswerFieldId, FormulaEntry, QuestionPrompt } from "../../games/ionic-formula/shared/types";
import { Formula } from "../results/Results";

type ReviewField = { id: AnswerFieldId; value: unknown };

function isEmpty(value: unknown): boolean {
  if (typeof value === "string") return !value.trim();
  if (!value || typeof value !== "object" || !("tokens" in value)) return true;
  const entry = value as FormulaEntry;
  return entry.tokens.length === 0 && !entry.charge;
}

function ReviewAnswer({ value }: { value: unknown }) {
  if (isEmpty(value)) return <>未解答</>;
  if (typeof value === "string") return <>{value}</>;
  const entry = value as FormulaEntry;
  return <Formula value={entry.tokens.join("")} charge={entry.charge ? entry.charge.magnitude * (entry.charge.sign === "+" ? 1 : -1) : null}/>;
}

export function DeferredReviewQuestion({ number, prompt, fields, disabled, onSelect }: {
  number: number;
  prompt: QuestionPrompt;
  fields: readonly ReviewField[];
  disabled: boolean;
  onSelect(): void;
}) {
  const questionNumber = String(number).replace(/[0-9]/g, digit => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));
  return <button type="button" disabled={disabled} onClick={onSelect}>
    <span className="review-question-line"><strong>第{questionNumber}問：</strong>{prompt.values.map((part, index) => <span key={index}>{index > 0 ? " ＋ " : ""}{part.type === "formula" ? <Formula value={part.value} charge={part.charge}/> : part.value}</span>)}</span>
    <span className={`review-answer-block ${fields.every(field => isEmpty(field.value)) ? "is-empty" : ""}`}>
      {fields.map((field, index) => <span key={field.id} className="review-answer-line">{index === 0 ? "解答：" : field.id === "name" ? "名称：" : "組成式："}<ReviewAnswer value={field.value}/></span>)}
    </span>
  </button>;
}
