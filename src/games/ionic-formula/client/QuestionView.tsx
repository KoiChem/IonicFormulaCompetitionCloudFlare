"use client";
import type { PublicQuestion } from "../shared/types";

function Formula({ value, charge }: { value: string; charge?: number }) {
  const parts = value.split(/(\d+)/u);
  return <span className="formula" aria-label={value}>{parts.map((part, index) => /^\d+$/u.test(part) ? <sub key={index}>{part}</sub> : part)}{charge ? <sup>{Math.abs(charge) === 1 ? "" : Math.abs(charge)}{charge > 0 ? "+" : "−"}</sup> : null}</span>;
}
export function QuestionView({ question }: { question: PublicQuestion }) {
  const hasName = question.prompt.values.some(item => item.type === "name");
  return <section className={`question-card ${hasName ? "has-name" : "formula-only"}`} aria-label="問題"><div className="prompt">{question.prompt.values.map((item, i) => <span className="prompt-item" key={i}>{item.type === "formula" ? <Formula value={item.value} charge={item.charge} /> : item.value}{i < question.prompt.values.length - 1 && <span className="ion-separator" aria-hidden="true">＆</span>}</span>)}</div></section>;
}
