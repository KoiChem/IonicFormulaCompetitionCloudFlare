import { appPath } from '../../web/routing';
"use client";
import { useEffect, useReducer, useRef, useState } from "react";
import type { FormulaEntry, PublicQuestion } from "../../games/ionic-formula/shared/types";
import { createFormulaEntry } from "../../games/ionic-formula/client/formula-entry";
import { FormulaKeyboard } from "../../games/ionic-formula/client/FormulaKeyboard";
import { NameKeyboard } from "../../games/ionic-formula/client/NameKeyboard";
import { QuestionView } from "../../games/ionic-formula/client/QuestionView";
import { formatCentiseconds } from "./clock";
import { ForegroundWait } from "./foreground-wait";
import { AnswerFieldTabs, fieldLabel } from "./AnswerFieldTabs";
import { countdownSeconds, postJson, remainingSeconds, useRoomSync } from "./useRoomSync";
import { Results } from "../results/Results";
import { useResults } from "../results/useResults";
import { ResultLoadPanel } from "../results/ResultLoadPanel";
import { NicknameEditor } from "../lobby/NicknameEditor";
import {
  claimPendingAction,
  confirmedPlayerState,
  createPlayerState,
  parseStoredPendingAction,
  playerReducer,
  prepareAction,
  serializeStoredPendingAction,
  type PendingAction,
  type StoredPendingAction,
} from "./player-state";
import { settingsSummary } from "../setup/CompetitionSettingsForm";
import { AnswerFeedbackBanner } from "./AnswerFeedbackBanner";
import { ParticipantSyncStatus } from "./ParticipantSyncStatus";
import { FeedbackGate, type AnswerFeedback } from "./answer-feedback";
import { playAnswerSound, primeAudio, savedSoundLevel, saveSoundLevel, type SoundLevel } from "./audio-feedback";
import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";

export function CompetitionPlayer({ roomId, token }: { roomId: string; token: string }) {
  const { data, connected, error, refresh, clockRef } = useRoomSync(roomId, token);
  const pendingKey = `ionic-formula-competition:pending-action:${roomId}`;
  const feedbackSeenKey = `ionic-formula-competition:feedback-shown:${roomId}`;
  const waitKey = `ionic-formula-competition:wait-credit:${roomId}`;
  const observationKey = `ionic-formula-competition:wait-observation:${roomId}`;
  const restored = useRef<StoredPendingAction | null | undefined>(undefined);
  if (restored.current === undefined) {
    restored.current = typeof sessionStorage === "undefined"
      ? null
      : parseStoredPendingAction(sessionStorage.getItem(pendingKey));
  }
  const [formula, setFormula] = useState<FormulaEntry>(() => restored.current?.draft.formula ?? createFormulaEntry());
  const [name, setName] = useState(() => restored.current?.draft.name ?? "");
  const [activeField, setActiveField] = useState<"formula" | "name">("formula");
  const pendingSlot = useRef<PendingAction | null>(restored.current?.request ?? null);
  const waitTracker = useRef<ForegroundWait | null>(null);
  if (waitTracker.current === null && restored.current?.request && pendingSlot.current && typeof sessionStorage !== "undefined") {
    let measuredMs = 0;
    try {
      const observation = JSON.parse(sessionStorage.getItem(observationKey) ?? "null") as { requestId?: unknown; measuredMs?: unknown } | null;
      if (observation?.requestId === pendingSlot.current.requestId && typeof observation.measuredMs === "number"
        && Number.isSafeInteger(observation.measuredMs) && observation.measuredMs >= 0 && observation.measuredMs <= 600_000) {
        measuredMs = observation.measuredMs;
      }
    } catch { /* discard corrupt local observation */ }
    waitTracker.current = new ForegroundWait(performance.now(), !document.hidden, measuredMs);
  }
  const waitCreditRef = useRef<{ sourceRequestId: string; waitMs: number } | null>(null);
  if (waitCreditRef.current === null && typeof sessionStorage !== "undefined") {
    try {
      const stored = JSON.parse(sessionStorage.getItem(waitKey) ?? "null") as unknown;
      if (stored && typeof stored === "object" && "sourceRequestId" in stored && "waitMs" in stored
        && typeof stored.sourceRequestId === "string" && Number.isSafeInteger(stored.waitMs) && (stored.waitMs as number) > 0) {
        waitCreditRef.current = stored as { sourceRequestId: string; waitMs: number };
      }
    } catch { /* discard corrupt local credit */ }
  }
  const [player, dispatch] = useReducer(playerReducer, undefined, () => {
    const initial = createPlayerState();
    return restored.current ? playerReducer(initial, { type: "send", request: restored.current.request }) : initial;
  });
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const feedbackGate = useRef<FeedbackGate | null>(null);
  if (feedbackGate.current === null) {
    let lastShown: string | null = null;
    try { if (typeof sessionStorage !== "undefined") lastShown = sessionStorage.getItem(feedbackSeenKey); } catch { /* private browsing */ }
    feedbackGate.current = new FeedbackGate(lastShown ? [lastShown] : []);
  }
  const [soundLevel, setSoundLevel] = useState<SoundLevel>(savedSoundLevel);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(current => current?.requestId === feedback.requestId ? null : current), Math.max(0, feedback.untilMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    const applyHeight = () => document.documentElement.style.setProperty("--play-viewport-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    applyHeight(); window.visualViewport?.addEventListener("resize", applyHeight); window.addEventListener("resize", applyHeight);
    return () => { window.visualViewport?.removeEventListener("resize", applyHeight); window.removeEventListener("resize", applyHeight); document.documentElement.style.removeProperty("--play-viewport-height"); };
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) waitTracker.current?.hidden(performance.now());
      else waitTracker.current?.visible(performance.now());
      if (waitTracker.current && pendingSlot.current) sessionStorage.setItem(observationKey, JSON.stringify({ requestId: pendingSlot.current.requestId, measuredMs: waitTracker.current.measuredMs }));
    };
    document.addEventListener("visibilitychange", visibility);
    const pagehide = () => {
      waitTracker.current?.hidden(performance.now());
      if (waitTracker.current && pendingSlot.current) sessionStorage.setItem(observationKey, JSON.stringify({ requestId: pendingSlot.current.requestId, measuredMs: waitTracker.current.measuredMs }));
    };
    window.addEventListener("pagehide", pagehide);
    const interval = window.setInterval(() => {
      waitTracker.current?.sample(performance.now());
      if (waitTracker.current && pendingSlot.current) sessionStorage.setItem(observationKey, JSON.stringify({ requestId: pendingSlot.current.requestId, measuredMs: waitTracker.current.measuredMs }));
    }, 250);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); window.clearInterval(interval); };
  }, []);
  const [elapsedMs, setElapsedMs] = useState(0); const [serverNowMs, setServerNowMs] = useState(0);
  const resultLoad = useResults(roomId, token, data?.room.state === "FINISHED", data?.room.expiresAtMs);
  const results = resultLoad.full;
  const retrying = useRef(false);
  const retryNotBefore = useRef(0);
  const displayedQuestionId = useRef<string | null>(null);
  const transmitRef = useRef<((request: PendingAction) => Promise<void>) | null>(null);
  useEffect(() => { let frame = 0; const draw = () => { const now = performance.now(); setElapsedMs(clockRef.current?.elapsedMs(now) ?? 0); setServerNowMs(clockRef.current?.serverNowMs(now) ?? 0); frame = requestAnimationFrame(draw); }; frame = requestAnimationFrame(draw); return () => cancelAnimationFrame(frame); }, [clockRef]);
  useEffect(() => { if (!data?.participant) return; dispatch({ type: "server-state", state: confirmedPlayerState({ participant: data.participant, question: data.question }) }); }, [data?.participant?.revision, data?.participant?.correctCount, data?.question]);
  useEffect(() => { if (player.pendingRequest && pendingSlot.current?.requestId === player.pendingRequest.requestId && data && !retrying.current) void transmitRef.current?.(player.pendingRequest); }, [data?.serverNow, player.pendingRequest?.requestId]);
  useEffect(() => {
    const nextQuestionId = data?.question?.id ?? null;
    if (displayedQuestionId.current && nextQuestionId && displayedQuestionId.current !== nextQuestionId) {
      setFormula(createFormulaEntry()); setName(""); setActiveField("formula"); setMessage("");
    }
    if (nextQuestionId) displayedQuestionId.current = nextQuestionId;
  }, [data?.question?.id]);
  if (results) return <><Results data={results} /><AnswerFeedbackBanner feedback={feedback} floating/></>;
  if (!data) return <main className="page-shell"><section className="panel"><h1>競技に接続しています</h1><ParticipantSyncStatus text={error ?? "時刻を同期しています…"} action={error ? "接続を再確認" : undefined} onAction={() => void refresh().catch(() => undefined)}/></section></main>;
  const { room, question } = data;
  if (room.state === "FINISHED") return <><ResultLoadPanel state={resultLoad} retry={resultLoad.retry}/><AnswerFeedbackBanner feedback={feedback} floating/></>;
  if (room.state === "CANCELLED") return <main className="page-shell"><section className="panel"><h1>ルームは終了しました</h1><p>主催者がルームを終了しました。</p><a className="primary-link" href={appPath("/")}>ホームへ戻る</a></section></main>;
  const participant = data.participant ?? { id: "", nickname: "", status: "FINISHED", currentOrdinal: 0, correctCount: 0, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null };
  if (room.state === "WAITING") return <main className="page-shell"><section className="panel"><NicknameEditor roomId={roomId} token={token} nickname={participant.nickname} revision={participant.revision} onSaved={async () => { await refresh(); }}/><p className="settings-summary">{settingsSummary(room.settings as IonicFormulaGameSettings)}</p><p role="status">{connected ? "接続済み" : "再接続しています"}</p></section></main>;
  const synchronizedNow = serverNowMs || data.serverNow;
  if (room.state === "COUNTDOWN") { const remaining = countdownSeconds(room.startAtMs ?? 0, synchronizedNow); return <main className="countdown"><p>まもなく開始</p><strong aria-live="polite">{remaining}</strong></main>; }
  if (participant?.status === "FINISHED" || !question) return <><main className="page-shell"><section className="panel"><h1>解答は終了しました</h1><p>あなたの解答は終了しました。全員の終了を待っています。</p><p>正解 {participant?.correctCount ?? 0}／{room.maxScore}</p><p>記録 {participant?.elapsedCs == null ? "確定中" : formatCentiseconds(participant.elapsedCs)}</p></section></main><AnswerFeedbackBanner feedback={feedback} floating/></>;
  const publicQuestion = question as PublicQuestion; const activeParticipant = participant!; const fieldStates = publicQuestion.progress.fieldStates ?? {}; const resolved = new Set(publicQuestion.progress.resolvedFieldIds);
  const availableFields = publicQuestion.fields.filter(field => !resolved.has(field.id));
  const selectedField = availableFields.find(field => field.id === activeField) ?? availableFields[0];
  const mode = (room.settings as IonicFormulaGameSettings).mode;
  const transmit = async (request: PendingAction) => {
    if (retrying.current || Date.now() < retryNotBefore.current) return; retrying.current = true;
    const body = { requestId: request.requestId, questionId: request.questionId, expectedParticipantRevision: request.revision, clientElapsedMs: request.clientElapsedMs, waitCredit: request.waitCredit, action: request.action };
    try {
      const reply = await postJson(`/api/rooms/${encodeURIComponent(roomId)}/actions`, body, { token });
      retryNotBefore.current = 0;
      clockRef.current?.confirm(reply.rawElapsedMs ?? reply.elapsedCs * 10);
      const acceptedFeedback = feedbackGate.current!.accept(request.requestId, reply.correct, Date.now());
      if (acceptedFeedback) {
        try { sessionStorage.setItem(feedbackSeenKey, request.requestId); } catch { /* private browsing */ }
        setFeedback(acceptedFeedback); playAnswerSound(acceptedFeedback.kind, soundLevel);
      }
      setMessage(reply.correct === null ? "パスしました" : "");
      if (reply.correct !== false) { if (request.action.fieldId === "formula") setFormula(createFormulaEntry()); if (request.action.fieldId === "name") setName(""); }
      const refreshed = await refresh();
      if ((refreshed.next.participant?.revision ?? -1) < reply.participantRevision) throw new Error("最新状態を確認できません");
      const confirmedParticipant = refreshed.next.participant!;
      const waited = waitTracker.current?.stop(performance.now()) ?? 0;
      waitTracker.current = null;
      sessionStorage.removeItem(pendingKey); sessionStorage.removeItem(observationKey); pendingSlot.current = null;
      sessionStorage.removeItem(waitKey); waitCreditRef.current = null;
      if (!reply.finished && confirmedParticipant.status === "ACTIVE" && waited > 0) {
        waitCreditRef.current = { sourceRequestId: request.requestId, waitMs: waited };
        sessionStorage.setItem(waitKey, JSON.stringify(waitCreditRef.current));
      }
      dispatch({ type: "ack", requestId: request.requestId, state: confirmedPlayerState({ participant: confirmedParticipant, question: refreshed.next.question }) });
    } catch (reason: any) {
      if (reason.status === 409 && reason.code !== "database_conflict") {
        setMessage("別の画面で更新されました。最新状態を取得しています");
        try {
          const latest = await refresh();
          waitTracker.current = null; sessionStorage.removeItem(pendingKey); sessionStorage.removeItem(observationKey); pendingSlot.current = null;
          dispatch({ type: "ack", requestId: request.requestId, state: confirmedPlayerState({ participant: latest.next.participant ?? activeParticipant, question: latest.next.question }) });
        } catch { dispatch({ type: "uncertain" }); setMessage("最新状態を確認できません。再接続しています"); }
      }
      else if (typeof reason.status === "number" && reason.status >= 400 && reason.status < 500
        && reason.status !== 408 && reason.status !== 429 && reason.code !== "database_conflict") {
        waitTracker.current = null; sessionStorage.removeItem(pendingKey); sessionStorage.removeItem(observationKey); pendingSlot.current = null;
        dispatch({ type: "rejected", requestId: request.requestId });
        setMessage(reason.message ?? "操作を受け付けられませんでした");
      }
      else { retryNotBefore.current = reason.status === 429 ? Date.now() + Math.max(0, reason.retryAfterMs ?? 2000) : 0;
        dispatch({ type: "uncertain" }); setMessage("送信を確認できません。再接続しています"); }
    } finally { retrying.current = false; }
  };
  transmitRef.current = transmit;
  const submit = (action: PendingAction["action"]) => {
    if (!player.canSubmit || !clockRef.current?.isSynchronized) return;
    const request = prepareAction({ questionId: publicQuestion.id, revision: activeParticipant.revision, clientElapsedMs: clockRef.current.captureElapsedMs(performance.now()), ...(waitCreditRef.current ? { waitCredit: waitCreditRef.current } : {}), action });
    if (!claimPendingAction(pendingSlot, request)) return;
    primeAudio(soundLevel);
    waitTracker.current = new ForegroundWait(performance.now(), !document.hidden);
    sessionStorage.setItem(observationKey, JSON.stringify({ requestId: request.requestId, measuredMs: 0 }));
    sessionStorage.setItem(pendingKey, serializeStoredPendingAction(request, { formula, name })); dispatch({ type: "send", request }); void transmit(request);
  };
  const total = Number(room.settings.questionCount ?? 0); const deadlineReached = room.deadlineAtMs != null && remainingSeconds(room.deadlineAtMs, synchronizedNow) === 0; const busy = !player.canSubmit;
  const remaining = room.deadlineAtMs == null ? 0 : remainingSeconds(room.deadlineAtMs, synchronizedNow);
  return <main className="play-shell play-active play-answering"><header className="scorebar"><span>第{publicQuestion.ordinal + 1}問 / 全{total}問</span><span>正解 {participant.correctCount} / {room.maxScore}</span><span>残り {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}<small>経過 {formatCentiseconds(Math.floor(elapsedMs / 10))}</small></span><button type="button" className="sound-level-button" aria-label={`効果音：${soundLevel === "off" ? "なし" : soundLevel === "medium" ? "中" : "大"}。押すと切り替え`} onClick={() => { const next = soundLevel === "off" ? "medium" : soundLevel === "medium" ? "high" : "off"; setSoundLevel(next); saveSoundLevel(next); primeAudio(next); }}>音 {soundLevel === "off" ? "なし" : soundLevel === "medium" ? "中" : "大"}</button></header><ParticipantSyncStatus text={player.pendingRequest ? message || "解答を送信しています…" : connected ? "接続済み" : "再接続しています"} action={player.pendingRequest && !retrying.current ? "今すぐ再送信" : undefined} disabled={Date.now() < retryNotBefore.current} onAction={() => { if (player.pendingRequest) void transmitRef.current?.(player.pendingRequest); }}/><AnswerFeedbackBanner feedback={feedback}/><QuestionView question={publicQuestion}/><div className="question-progress" role="progressbar" aria-label="問題の進み具合" aria-valuemin={1} aria-valuemax={total} aria-valuenow={publicQuestion.ordinal + 1}><span style={{ width: `${Math.min(100, ((publicQuestion.ordinal + 1) / Math.max(1, total)) * 100)}%` }}/></div><section className="answer-area"><AnswerFieldTabs fields={publicQuestion.fields} fieldStates={fieldStates} selectedFieldId={selectedField?.id} mode={mode} onSelect={setActiveField}/>{selectedField?.id === "formula" ? <FormulaKeyboard value={formula} onChange={setFormula} onSubmit={() => submit({ type: "answer", fieldId: "formula", value: formula })} resetKey={`${publicQuestion.id}:${selectedField.id}`} kind={mode} disabled={busy || deadlineReached}/> : selectedField?.id === "name" ? <NameKeyboard complexEnabled={(room.settings as IonicFormulaGameSettings).complexEnabled} difficulty={(room.settings as IonicFormulaGameSettings).difficulty} value={name} onChange={setName} kind={mode} disabled={busy || deadlineReached} onSubmit={() => submit({ type: "answer", fieldId: "name", value: name })} focusKey={`${publicQuestion.id}:name`}/> : null}<button className="pass-action" disabled={busy || deadlineReached} onClick={() => selectedField && submit({ type: "pass", fieldId: selectedField.id })}>{selectedField ? `${fieldLabel(selectedField.id, mode)}をパス` : "パス"}</button></section></main>;
}
