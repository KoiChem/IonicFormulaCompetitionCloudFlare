import type { AnswerField, AnswerFieldId, GameMode, QuestionProgress } from "../../games/ionic-formula/shared/types";

export function fieldLabel(id: AnswerFieldId, mode: GameMode): string {
  return id === "formula" ? (mode === "ion" ? "イオン式" : "組成式") : (mode === "ion" ? "イオン名" : "化合物名");
}

export function AnswerFieldTabs({ fields, fieldStates, selectedFieldId, mode, onSelect }: {
  fields: readonly AnswerField[];
  fieldStates: NonNullable<QuestionProgress["fieldStates"]>;
  selectedFieldId: AnswerFieldId | undefined;
  mode: GameMode;
  onSelect(id: AnswerFieldId): void;
}) {
  if (fields.length <= 1) return null;
  return <div className="answer-tabs" role="group" aria-label="解答欄">{fields.map((field) => {
    const state = fieldStates[field.id] ?? "pending";
    return <button type="button" key={field.id} disabled={state !== "pending"} data-field-state={state} aria-pressed={selectedFieldId === field.id} onClick={() => onSelect(field.id)}>{fieldLabel(field.id, mode)}{state === "correct" ? " ✓ 正解済み" : state === "passed" ? " − パス済み" : selectedFieldId === field.id ? " 解答中" : ""}</button>;
  })}</div>;
}
