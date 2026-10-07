import { describe, expect, it } from "vitest";

import {
  claimPendingAction,
  confirmedPlayerState,
  createPlayerState,
  parseStoredPendingAction,
  playerReducer,
  prepareAction,
  serializeStoredPendingAction,
} from "../../src/features/play/player-state";
import { createFormulaEntry } from "../../src/games/ionic-formula/client/formula-entry";

describe("player recovery state", () => {
  it("keeps a confirmed formula point while the name answer is still pending", () => {
    const state = playerReducer(createPlayerState(), {
      type: "server-state",
      state: { revision: 2, correctCount: 1, fields: { formula: "correct", name: "pending" } },
    });
    expect(state.correctCount).toBe(1);
    expect(state.fields).toEqual({ formula: "correct", name: "pending" });
  });

  it("reuses the exact request after an uncertain failure and blocks another action", () => {
    const request = prepareAction({ questionId: "q1", revision: 2, clientElapsedMs: 1234, action: { type: "pass", fieldId: "formula" } }, () => "request-1");
    const uncertain = playerReducer(createPlayerState(), { type: "send", request });
    const retrying = playerReducer(uncertain, { type: "uncertain" });
    expect(retrying.pendingRequest).toBe(request);
    expect(retrying.canSubmit).toBe(false);
  });

  it("ignores stale responses and refreshes after a revision conflict", () => {
    const request = prepareAction({ questionId: "q1", revision: 2, clientElapsedMs: 1234, action: { type: "pass", fieldId: "formula" } }, () => "request-1");
    const sending = playerReducer(createPlayerState(), { type: "send", request });
    expect(playerReducer(sending, { type: "ack", requestId: "old", state: { revision: 9, correctCount: 9, fields: {} } })).toBe(sending);
    const conflict = playerReducer(sending, { type: "revision-conflict" });
    expect(conflict.needsRefresh).toBe(true);
    expect(conflict.pendingRequest).toBe(request);
  });

  it("releases a confirmed request using a newer snapshot from another tab", () => {
    const request = prepareAction({ questionId: "q1", revision: 2, clientElapsedMs: 1234, action: { type: "pass", fieldId: "formula" } }, () => "request-1");
    const sending = playerReducer(createPlayerState(), { type: "send", request });
    const newer = { revision: 4, correctCount: 1, fields: { formula: "passed" as const, name: "correct" as const } };
    const refreshed = playerReducer(sending, { type: "server-state", state: newer });
    const acknowledged = playerReducer(refreshed, { type: "ack", requestId: "request-1", state: newer });
    expect(acknowledged.pendingRequest).toBeNull();
    expect(acknowledged.canSubmit).toBe(true);
    expect(acknowledged.revision).toBe(4);
    expect(acknowledged.fields).toEqual(newer.fields);
  });

  it("builds the acknowledgement from the refreshed question and revision", () => {
    const state = confirmedPlayerState({
      participant: { revision: 4, correctCount: 1 },
      question: { fields: [{ id: "formula" }, { id: "name" }], progress: { fieldStates: { formula: "passed", name: "correct" } } },
    });
    expect(state).toEqual({ revision: 4, correctCount: 1, fields: { formula: "passed", name: "correct" } });
  });

  it("discards a rejected request so the user can correct it", () => {
    const request = prepareAction({ questionId: "q1", revision: 2, clientElapsedMs: 1234, action: { type: "pass", fieldId: "formula" } }, () => "request-1");
    const sending = playerReducer(createPlayerState(), { type: "send", request });
    const rejected = playerReducer(sending, { type: "rejected", requestId: "request-1" });
    expect(rejected.pendingRequest).toBeNull();
    expect(rejected.canSubmit).toBe(true);
  });

  it("disables input at the authoritative deadline", () => {
    const state = playerReducer(createPlayerState(), { type: "deadline" });
    expect(state.canSubmit).toBe(false);
    expect(state.statusMessage).toContain("終了");
  });

  it("shows server fallback without changing confirmed score", () => {
    const state = playerReducer(createPlayerState(), { type: "timing-source", source: "server_fallback" });
    expect(state.timingNotice).toBe("サーバー時刻で計測");
    expect(state.correctCount).toBe(0);
  });

  it("claims the first same-tick action synchronously and never overwrites it", () => {
    const first = prepareAction({ questionId: "q1", revision: 2, clientElapsedMs: 100, action: { type: "pass", fieldId: "formula" } }, () => "first");
    const second = prepareAction({ questionId: "q1", revision: 2, clientElapsedMs: 101, action: { type: "pass", fieldId: "formula" } }, () => "second");
    const slot: { current: typeof first | null } = { current: null };
    expect(claimPendingAction(slot, first)).toBe(true);
    expect(claimPendingAction(slot, second)).toBe(false);
    expect(slot.current).toBe(first);
  });

  it("persists and restores the controlled input draft with the exact pending action", () => {
    const formula = { ...createFormulaEntry(), tokens: ["Na"], cursor: 1 };
    const request = prepareAction({
      questionId: "q1",
      revision: 2,
      clientElapsedMs: 123,
      action: { type: "answer", fieldId: "formula", value: formula },
    }, () => "request-1");
    expect(parseStoredPendingAction(serializeStoredPendingAction(request, { formula, name: "入力中" }))).toEqual({
      request,
      draft: { formula, name: "入力中" },
    });
  });
});
