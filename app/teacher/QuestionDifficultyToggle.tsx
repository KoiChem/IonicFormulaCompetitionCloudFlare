"use client";

import type { ItemDifficulty } from "../../src/games/ionic-formula/shared/question-profile";
import "./question-difficulty-toggle.css";

export const itemDifficultyLabels: Record<ItemDifficulty, string> = {
  normal: "やさしめ", hard: "ややむず", both: "両方", off: "出題しない",
};

export function toggleItemDifficulty(value: ItemDifficulty, level: "normal" | "hard"): ItemDifficulty {
  const normal = (value === "normal" || value === "both") !== (level === "normal");
  const hard = (value === "hard" || value === "both") !== (level === "hard");
  return normal ? (hard ? "both" : "normal") : (hard ? "hard" : "off");
}

export function QuestionDifficultyToggle({ name, value, onChange, disabled = false }: {
  name: string; value: ItemDifficulty; onChange(value: ItemDifficulty): void; disabled?: boolean;
}) {
  return <div className="question-difficulty-toggle" role="group" aria-label={`${name}の出題難易度`}>
    <div className="question-difficulty-buttons">{(["normal", "hard"] as const).map(level => {
      const selected = value === level || value === "both";
      return <button key={level} type="button" className="question-difficulty-button" aria-pressed={selected} aria-label={itemDifficultyLabels[level]} disabled={disabled} onClick={() => onChange(toggleItemDifficulty(value, level))}>
        <span className="question-difficulty-check" aria-hidden="true">{selected ? "✓" : ""}</span>{itemDifficultyLabels[level]}
      </button>;
    })}</div>
    <span className={`question-difficulty-status${value === "off" ? " is-off" : ""}`} aria-live="polite">{itemDifficultyLabels[value]}</span>
  </div>;
}
