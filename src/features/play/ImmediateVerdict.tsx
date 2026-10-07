export type Verdict = {
  attemptId: string;
  correct: boolean;
  questionNumber: number;
  fieldLabel: string;
  fullScore: boolean;
};

export function ImmediateVerdict({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null;
  return <div key={verdict.attemptId} className={`immediate-verdict ${verdict.correct ? "is-correct" : "is-incorrect"}`} role="status" aria-live="polite">
    <span className="immediate-verdict-context">第{verdict.questionNumber}問・{verdict.fieldLabel}</span>
    <strong>{verdict.correct ? "○ 正解" : "× 不正解"}</strong>
    {verdict.correct && <span className="immediate-verdict-score">＋1</span>}
    {verdict.fullScore && <span className="immediate-verdict-perfect">全問正解！</span>}
  </div>;
}
