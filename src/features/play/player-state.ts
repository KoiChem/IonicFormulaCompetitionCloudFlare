import type { TimingSource } from "../../competition-core/types";
import type { FormulaEntry } from "../../games/ionic-formula/shared/types";
export type FieldDisplayState = "pending" | "correct" | "passed" | "unanswered";
export type PlayerServerState = { readonly revision: number; readonly correctCount: number; readonly fields: Readonly<Record<string, FieldDisplayState>> };
export function confirmedPlayerState(snapshot: {
  readonly participant: { readonly revision: number; readonly correctCount: number };
  readonly question?: { readonly fields: readonly { readonly id: string }[]; readonly progress: { readonly fieldStates?: Readonly<Record<string, FieldDisplayState>> } } | null;
}): PlayerServerState {
  return {
    revision: snapshot.participant.revision,
    correctCount: snapshot.participant.correctCount,
    fields: Object.fromEntries((snapshot.question?.fields ?? []).map(field => [field.id, snapshot.question?.progress.fieldStates?.[field.id] ?? "pending"])),
  };
}
export type ActionPayload = { readonly questionId: string; readonly revision: number; readonly clientElapsedMs: number | null; readonly waitCredit?: { readonly sourceRequestId: string; readonly waitMs: number }; readonly action: { readonly type: "pass"; readonly fieldId: "formula" | "name" } | { readonly type: "answer"; readonly fieldId: "formula" | "name"; readonly value: unknown } };
export type PendingAction = ActionPayload & { readonly requestId: string };
export type AnswerDraft = { readonly formula: FormulaEntry; readonly name: string };
export type StoredPendingAction = { readonly request: PendingAction; readonly draft: AnswerDraft };
export type PendingActionSlot = { current: PendingAction | null };

export function claimPendingAction(slot: PendingActionSlot, request: PendingAction): boolean {
  if (slot.current) return false;
  slot.current = request;
  return true;
}

export function serializeStoredPendingAction(request: PendingAction, draft: AnswerDraft): string {
  return JSON.stringify({ request, draft });
}

export function parseStoredPendingAction(serialized: string | null): StoredPendingAction | null {
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as Partial<StoredPendingAction>;
    if (
      !value.request
      || typeof value.request.requestId !== "string"
      || typeof value.request.questionId !== "string"
      || !value.request.action
      || !value.draft
      || typeof value.draft.name !== "string"
      || !value.draft.formula
      || !Array.isArray(value.draft.formula.tokens)
    ) return null;
    return value as StoredPendingAction;
  } catch {
    return null;
  }
}
export type PlayerState = { readonly revision: number; readonly correctCount: number; readonly fields: Readonly<Record<string, FieldDisplayState>>; readonly pendingRequest: PendingAction | null; readonly canSubmit: boolean; readonly needsRefresh: boolean; readonly statusMessage: string; readonly timingNotice: string | null };
export function createPlayerState(): PlayerState { return { revision: 0, correctCount: 0, fields: {}, pendingRequest: null, canSubmit: true, needsRefresh: false, statusMessage: "接続済み", timingNotice: null }; }
export function prepareAction(payload: ActionPayload, requestId: () => string = () => crypto.randomUUID()): PendingAction { return { ...payload, requestId: requestId() }; }
export type PlayerEvent = { type: "server-state"; state: PlayerServerState } | { type: "send"; request: PendingAction } | { type: "uncertain" } | { type: "ack"; requestId: string; state: PlayerServerState } | { type: "rejected"; requestId: string } | { type: "revision-conflict" } | { type: "deadline" } | { type: "timing-source"; source: TimingSource };
export function playerReducer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    case "server-state": return event.state.revision < state.revision ? state : { ...state, ...event.state, needsRefresh: false };
    case "send": return !state.canSubmit || state.pendingRequest ? state : { ...state, pendingRequest: event.request, canSubmit: false, statusMessage: "送信中" };
    case "uncertain": return state.pendingRequest ? { ...state, canSubmit: false, statusMessage: "送信を確認できません。再接続しています" } : state;
    case "ack": return state.pendingRequest?.requestId !== event.requestId || event.state.revision < state.revision ? state : { ...state, ...event.state, pendingRequest: null, canSubmit: true, needsRefresh: false, statusMessage: "接続済み" };
    case "rejected": return state.pendingRequest?.requestId !== event.requestId ? state : { ...state, pendingRequest: null, canSubmit: true, needsRefresh: false, statusMessage: "接続済み" };
    case "revision-conflict": return { ...state, canSubmit: false, needsRefresh: true, statusMessage: "最新の状態を取得しています" };
    case "deadline": return { ...state, canSubmit: false, statusMessage: "競技は終了しました" };
    case "timing-source": return { ...state, timingNotice: event.source === "server_fallback" ? "サーバー時刻で計測" : null };
  }
}
