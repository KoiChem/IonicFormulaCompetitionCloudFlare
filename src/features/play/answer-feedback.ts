export type AnswerFeedback = { requestId: string; kind: "correct" | "incorrect"; untilMs: number };

export class FeedbackGate {
  private readonly seen = new Set<string>();

  constructor(alreadyShown: readonly string[] = []) {
    for (const requestId of alreadyShown) this.seen.add(requestId);
  }

  accept(requestId: string, correct: boolean | null, nowMs: number): AnswerFeedback | null {
    if (correct === null || this.seen.has(requestId)) return null;
    this.seen.add(requestId);
    const kind = correct ? "correct" : "incorrect";
    return { requestId, kind, untilMs: nowMs + (correct ? 800 : 1_000) };
  }
}
