import type { AnswerFeedback } from "./answer-feedback";

export function AnswerFeedbackBanner({ feedback, floating = false }: { feedback: AnswerFeedback | null; floating?: boolean }) {
  return <div className={`answer-feedback ${feedback?.kind ?? "idle"}${floating ? " floating" : ""}`} role="status" aria-live="polite" aria-atomic="true">
    {feedback?.kind === "correct" ? "○ 正解" : feedback?.kind === "incorrect" ? "× 不正解・もう一度" : ""}
  </div>;
}
