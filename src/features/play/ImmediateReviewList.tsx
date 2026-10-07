import type { InternalQuestion, PublicQuestion } from "../../games/ionic-formula/shared/types";
import { Formula } from "../results/Results";
import type { ImmediateFieldStatus } from "./immediate-review-state";

export function ImmediateReviewList({ questions, frontier, fields, disabled, onRetry, onContinue }: {
  questions: readonly (InternalQuestion | PublicQuestion)[];
  frontier: number;
  fields: Record<string, ImmediateFieldStatus>;
  disabled: boolean;
  onContinue?(): void;
  onRetry(index: number, fieldId: "formula" | "name"): void;
}) {
  return <div className="review-question-list">{questions.map((item, index) => {
    if (index > frontier) return <div className="immediate-review-card is-unreached" key={item.id}><strong>第{index + 1}問：未着手</strong></div>;
    return <div className="immediate-review-card" key={item.id}><strong>第{index + 1}問：</strong>
      {item.prompt.values.map((part, partIndex) => <span key={partIndex}>{partIndex > 0 ? " ＋ " : ""}{part.type === "formula" ? <Formula value={part.value} charge={part.charge}/> : part.value}</span>)}
      <div className="immediate-review-fields">{item.fields.map(answerField => {
        const state = fields[`${item.id}:${answerField.id}`];
        const label = answerField.id === "name" ? "名称" : "式";
        return state === "passed" || state === "passedRetry" ? <button className="is-pending" key={answerField.id} type="button" disabled={disabled} onClick={() => onRetry(index, answerField.id)}>{label}：{state === "passedRetry" ? "再挑戦中・" : ""}パス・再解答する</button>
          : <span className={state === "correct" ? "is-correct" : "is-pending"} key={answerField.id}>{label}：{state === "correct" ? "正解" : state === "retry" ? "再挑戦中" : "未解答"}</span>;
      })}</div>{index === frontier && onContinue && <button className="review-continue" type="button" disabled={disabled} aria-label={`第${index + 1}問の解答に進む`} onClick={onContinue}>この問題を解く</button>}</div>;
  })}</div>;
}
