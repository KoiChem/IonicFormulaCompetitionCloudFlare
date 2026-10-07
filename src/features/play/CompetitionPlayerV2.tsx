import { appPath } from '../../web/routing';
"use client";

import { useEffect, useRef, useState } from "react";
import type { FormulaEntry, InternalQuestion, PublicQuestion } from "../../games/ionic-formula/shared/types";
import { EVALUATOR_VERSION, evaluateField } from "../../games/ionic-formula/shared/answer-evaluator";
import { createFormulaEntry } from "../../games/ionic-formula/client/formula-entry";
import { FormulaKeyboard } from "../../games/ionic-formula/client/FormulaKeyboard";
import { NameKeyboard } from "../../games/ionic-formula/client/NameKeyboard";
import { QuestionView } from "../../games/ionic-formula/client/QuestionView";
import { AnswerFieldTabs, fieldLabel } from "./AnswerFieldTabs";
import { ImmediateVerdict, type Verdict } from "./ImmediateVerdict";
import { fetchJsonWithTimeout, postJson, remainingSeconds, useRoomSync } from "./useRoomSync";
import { ParticipantSyncStatus } from "./ParticipantSyncStatus";
import { operationRetryDelay, retryableOperationFailure } from "./v2-send-policy";
import { deleteV2Local, isRestorableV2Local, pruneExpiredV2Local, readV2Local, writeV2Local, v2LocalKey, type V2LocalRecord } from "./v2-local";
import type { V2Operation } from "../../competition-core/v2-operations";
import { Results } from "../results/Results";
import { useResults } from "../results/useResults";
import { ResultLoadPanel } from "../results/ResultLoadPanel";
import { NicknameEditor } from "../lobby/NicknameEditor";
import { settingsSummary } from "../setup/CompetitionSettingsForm";
import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";
import { playAnswerSound, primeAudio, savedSoundLevel } from "./audio-feedback";
import { DeferredReviewQuestion } from "./DeferredReviewQuestion";
import { immediateReviewState, immediateResumeTarget } from "./immediate-review-state";
import { ImmediateReviewList } from "./ImmediateReviewList";

const fieldKey = (questionId: string, fieldId: string) => `${questionId}:${fieldId}`;
const emptyValue = (value: unknown) => typeof value === "string" ? !value.trim() : !value || typeof value !== "object" || !("tokens" in value) || !(value as FormulaEntry).tokens.length && !(value as FormulaEntry).charge;
const publicQuestion = (question: InternalQuestion | PublicQuestion, resolved: string[]): PublicQuestion => ({ id: question.id, ordinal: question.ordinal, prompt: question.prompt, fields: question.fields, progress: { resolvedFieldIds: resolved as ("formula" | "name")[] } });
function immediateScore(questions: (InternalQuestion | PublicQuestion)[], operations: V2Operation[], throughSeq = Number.POSITIVE_INFINITY) {
  return new Set(operations.filter(operation => {
    if (operation.seq > throughSeq || operation.type !== "answer" || !operation.questionId || !operation.fieldId) return false;
    const target = questions.find(item => item.id === operation.questionId) as InternalQuestion | undefined;
    return !!target && evaluateField(target, operation.fieldId, operation.value).correct;
  }).map(operation => fieldKey(operation.questionId!, operation.fieldId!))).size;
}

export function CompetitionPlayerV2({ roomId, token }: { roomId: string; token: string }) {
  const { data, error, connected, refresh, clockRef } = useRoomSync(roomId, token);
  const [session, setSession] = useState<V2LocalRecord | null>(null);
  const [message, setMessage] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const answerAreaRef = useRef<HTMLElement>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [localSaving, setLocalSaving] = useState(false);
  const [sendStatus, setSendStatus] = useState<"idle" | "sending" | "retry" | "blocked" | "confirmed">("idle");
  const [retryAt, setRetryAt] = useState(0);
  const retryNotBefore = useRef(0);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [readyEligible, setReadyEligible] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [hasWriteLock, setHasWriteLock] = useState(false);
  const [lockWaited, setLockWaited] = useState(false);
  const [selectedField, setSelectedField] = useState<"formula" | "name">("formula");
  const [reviewing, setReviewing] = useState(false);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [tick, setTick] = useState(0);
  const resultLoad = useResults(roomId, token, data?.room.state === "FINISHED", data?.room.expiresAtMs);
  const results = resultLoad.full;
  const sessionRef = useRef<V2LocalRecord | null>(null);
  const sending = useRef(false);
  const sessionGeneration = useRef(0);
  const saveVersion = useRef(0);
  const postCollectionProbes = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(1000);
  const readySent = useRef<string | null>(null);
  const readyInFlight = useRef(false);
  const nextReadyAt = useRef(0);
  const loading = useRef(false);
  const persistChain = useRef<Promise<unknown>>(Promise.resolve());
  const writeLockRef = useRef(false);
  const lockRelease = useRef<(() => void) | null>(null);
  const lockAcquire = useRef<(() => Promise<boolean>) | null>(null);
  const lockChannel = useRef<BroadcastChannel | null>(null);
  const tabId = useRef<string | null>(null);
  const lastCheckpoint = useRef<Record<string, number>>({});
  const checkpointRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sessionGeneration.current += 1; if (timer.current) clearTimeout(timer.current); }; }, [roomId, token]);
  const wallClock = useRef<{ serverNow: number; wallAt: number } | null>(null);
  const lastElapsed = useRef(0);
  const room = data?.room;
  const participantId = data?.participant?.id;
  const currentNow = () => Math.max(
    clockRef.current?.serverNowMs(performance.now()) ?? -Infinity,
    wallClock.current ? wallClock.current.serverNow + Date.now() - wallClock.current.wallAt : -Infinity,
    data?.serverNow ?? 0,
  );
  const now = currentNow();
  if (clockRef.current) wallClock.current = { serverNow: now, wallAt: Date.now() };
  const cutoffAtMs = data?.v2?.cutoffAtMs ?? room?.deadlineAtMs ?? null;
  const elapsedMs = () => {
    const at = currentNow();
    lastElapsed.current = Math.max(lastElapsed.current, Math.max(0, Math.round(at - (room?.startAtMs ?? at))));
    return lastElapsed.current;
  };
  const key = session && participantId ? v2LocalKey(roomId, participantId, session.manifestId) : null;
  useEffect(() => { void pruneExpiredV2Local().catch(() => undefined); }, []);
  useEffect(() => {
    if (!key || !(room?.state === "EXPIRED" || (room?.expiresAtMs && Date.now() >= room.expiresAtMs))) return;
    void persistChain.current.then(() => deleteV2Local(key)).catch(() => undefined);
  }, [key, room?.state, room?.expiresAtMs, tick]);

  useEffect(() => {
    if (!participantId) return;
    const owner = tabId.current ?? crypto.randomUUID(); tabId.current = owner;
    const name = `ionic-formula-competition:v2-writer:${roomId}:${participantId}`;
    let active = true;
    let leaseTimer: ReturnType<typeof setInterval> | null = null;
    let yielded = false;
    let attempting = false;
    const waitTimer = setTimeout(() => { if (active) setLockWaited(true); }, 2200);
    const setHeld = (held: boolean) => { writeLockRef.current = held; if (active) setHasWriteLock(held); };
    const lease = () => { try {
      const row = JSON.parse(localStorage.getItem(name) ?? "null") as { owner: string; until: number } | null;
      if (!row || row.owner === owner || row.until < Date.now()) {
        localStorage.setItem(name, JSON.stringify({ owner, until: Date.now() + 9000 }));
        if (JSON.parse(localStorage.getItem(name) ?? "null")?.owner === owner) { setHeld(true); return true; }
      }
    } catch { /* private browsing may disable localStorage */ }
      setHeld(false); return false;
    };
    const acquire = (explicit = false) => new Promise<boolean>(resolve => {
      if (!active || attempting || yielded && !explicit) { resolve(false); return; }
      if (explicit) yielded = false;
      attempting = true;
      if (navigator.locks?.request) {
        void navigator.locks.request(name, { ifAvailable: true }, async lock => {
          attempting = false;
          if (!lock || !active || yielded) { setHeld(false); resolve(false); return; }
          setHeld(true); resolve(true);
          await new Promise<void>(release => { lockRelease.current = release; });
          lockRelease.current = null; setHeld(false);
        }).catch(() => { attempting = false; setHeld(false); resolve(false); });
      } else { attempting = false; resolve(lease()); }
    });
    lockAcquire.current = () => acquire(true);
    void acquire();
    leaseTimer = setInterval(() => { if (writeLockRef.current && !navigator.locks?.request) lease(); else if (!writeLockRef.current) void acquire(); }, 1500);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);
    lockChannel.current = channel;
    if (channel) channel.onmessage = event => {
      if (event.data?.type !== "takeover" || event.data?.owner === owner) return;
      yielded = true;
      lockRelease.current?.();
      try { const current = JSON.parse(localStorage.getItem(name) ?? "null"); if (current?.owner === owner) localStorage.removeItem(name); } catch { /* ignore */ }
      setHeld(false);
    };
    return () => {
      active = false; lockRelease.current?.(); lockAcquire.current = null; channel?.close(); lockChannel.current = null;
      clearTimeout(waitTimer);
      if (leaseTimer) clearInterval(leaseTimer);
      try { const current = JSON.parse(localStorage.getItem(name) ?? "null"); if (current?.owner === owner) localStorage.removeItem(name); } catch { /* ignore */ }
    };
  }, [roomId, participantId]);

  useEffect(() => { const handle = setInterval(() => setTick(value => value + 1), 250); return () => clearInterval(handle); }, []);
  useEffect(() => {
    if (!verdict) return;
    const handle = setTimeout(() => setVerdict(current => current?.attemptId === verdict.attemptId ? null : current), verdict.correct ? 900 : 1400);
    return () => clearTimeout(handle);
  }, [verdict]);
  useEffect(() => {
    if (data?.room.state === "WAITING" && sessionRef.current) {
      sessionGeneration.current += 1; sessionRef.current = null; setSession(null); readySent.current = null; loading.current = false; setReadyEligible(false);
    }
    if (!data || !participantId || !["PREPARING", "COUNTDOWN", "RUNNING", "COLLECTING"].includes(data.room.state)) return;
    if (sessionRef.current && sessionRef.current.preparationGeneration !== data.v2?.preparationGeneration) {
      sessionGeneration.current += 1; sessionRef.current = null; setSession(null); readySent.current = null; loading.current = false; setReadyEligible(false);
    }
    if (loading.current || sessionRef.current) return;
    loading.current = true;
    void (async () => {
      try {
        const manifest = await fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/manifest`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }, 10_000) as { manifestId: string; evaluatorVersion: string; gradingMode: "immediate" | "deferred"; preparationGeneration: number; questions: (InternalQuestion | PublicQuestion)[] };
        if (manifest.evaluatorVersion !== EVALUATOR_VERSION) throw new Error("アプリを更新してから参加してください");
        if (data.v2?.manifestId && data.v2.manifestId !== manifest.manifestId) throw new Error("問題の版が切り替わりました。再接続しています");
        const localKey = v2LocalKey(roomId, participantId, manifest.manifestId);
        const stored = await readV2Local(localKey).catch(() => { throw new Error("保存した解答を読み込めませんでした"); });
        if (stored && (!isRestorableV2Local(stored, manifest.manifestId, manifest.evaluatorVersion, manifest.questions.map(question => question.id)) || stored.gradingMode !== manifest.gradingMode)) throw new Error("保存した解答を読み込めませんでした");
        if (!stored && data.room.state !== "PREPARING") throw new Error("保存した解答が見つかりませんでした");
        let next: V2LocalRecord = stored ? { ...stored, preparationGeneration: manifest.preparationGeneration, expiresAtMs: data.room.expiresAtMs } : {
          manifestId: manifest.manifestId, preparationGeneration: manifest.preparationGeneration, evaluatorVersion: manifest.evaluatorVersion, gradingMode: manifest.gradingMode,
          questions: manifest.questions, writerEpoch: 1, ackSeq: 0, operations: [], ordinal: 0, drafts: {}, finished: false, expiresAtMs: data.room.expiresAtMs,
        };
        if (next.gradingMode === "immediate" && !next.finished) {
          const progress = immediateReviewState(next.questions, next.operations);
          const activeReview = next.reviewTarget && progress.fields[fieldKey(next.reviewTarget.questionId, next.reviewTarget.fieldId)] !== "correct";
          if (!activeReview) {
            const resume = immediateResumeTarget(next.questions, next.operations);
            next = { ...next, reviewTarget: undefined, ...(resume ? { ordinal: resume.ordinal } : {}) };
            if (resume) setSelectedField(resume.fieldId);
          }
        }
        try { persistChain.current = writeV2Local(localKey, next); await persistChain.current; } catch { throw new Error("保存した解答を読み込めませんでした"); }
        sessionRef.current = next; setSession({ ...next }); setRestoreFailed(false);
        if (next.reviewTarget) setSelectedField(next.reviewTarget.fieldId);
        if (next.gradingMode === "immediate" && !next.finished && !next.reviewTarget) {
          const progress = immediateReviewState(next.questions, next.operations);
          setReviewing(progress.frontier === next.questions.length && progress.correctCount < next.questions.reduce((sum, item) => sum + item.fields.length, 0));
        }
        lastCheckpoint.current = Object.fromEntries(next.operations
          .filter(operation => operation.type === "draft" && operation.questionId && operation.fieldId)
          .map(operation => [fieldKey(operation.questionId!, operation.fieldId!), operation.editedElapsedMs ?? operation.elapsedMs]));
        setReadyEligible(true);
      } catch (reason) { const detail = reason instanceof Error ? reason.message : "準備を確認できませんでした。再確認してください"; setMessage(detail); setRestoreFailed(detail.startsWith("保存した解答")); loading.current = false; }
    })();
  }, [roomId, token, participantId, data?.room.state, data?.v2?.preparationGeneration, data?.serverNow, refresh]);
  useEffect(() => {
    if (data?.room.state !== "FINISHED" || !participantId || !data.v2?.manifestId || sessionRef.current || loading.current) return;
    loading.current = true;
    const localKey = v2LocalKey(roomId, participantId, data.v2.manifestId);
    void readV2Local(localKey).then(stored => {
      if (!mounted.current || !stored || stored.manifestId !== data.v2?.manifestId) return;
      sessionRef.current = stored; setSession(stored);
      if (stored.operations.length > stored.ackSeq && stored.inflight) scheduleFlush(0);
    }).catch(() => setStorageFailed(true)).finally(() => { loading.current = false; });
  }, [roomId, participantId, data?.room.state, data?.v2?.manifestId]);
  useEffect(() => {
    if (!readyEligible || !session || data?.room.state !== "PREPARING" || readyInFlight.current || Date.now() < nextReadyAt.current) return;
    const readyKey = `${session.manifestId}:${session.preparationGeneration}`;
    if (readySent.current === readyKey) return;
    readyInFlight.current = true;
    void postJson(`/api/rooms/${encodeURIComponent(roomId)}/ready`, {
      manifestId: session.manifestId, evaluatorVersion: session.evaluatorVersion,
      preparationGeneration: session.preparationGeneration,
    }, { token }).then(() => { readySent.current = readyKey; setMessage(""); void refresh(); })
      .catch((reason: Error) => { nextReadyAt.current = Date.now() + 2000; setMessage(reason.message); })
      .finally(() => { readyInFlight.current = false; });
  }, [readyEligible, session?.manifestId, session?.preparationGeneration, data?.room.state, tick, roomId, token, refresh]);
  const persist = (next: V2LocalRecord): Promise<boolean> => {
    if (room?.expiresAtMs) next = { ...next, expiresAtMs: room.expiresAtMs };
    sessionRef.current = next; setSession(next);
    if (!participantId) return Promise.resolve(false);
    const version = ++saveVersion.current;
    setLocalSaving(true);
    const saved = persistChain.current.catch(() => undefined)
      .then(() => writeV2Local(v2LocalKey(roomId, participantId, next.manifestId), next))
      .then(() => { if (mounted.current && version === saveVersion.current) { setStorageFailed(false); setLocalSaving(false); } return true; })
      .catch(() => { if (mounted.current && version === saveVersion.current) { setStorageFailed(true); setLocalSaving(false); } return false; });
    persistChain.current = saved;
    return saved;
  };
  const scheduleFlush = (delayMs: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void flushRef.current?.(); }, Math.max(0, delayMs, retryNotBefore.current - Date.now()));
  };
  const flush = async () => {
    const current = sessionRef.current;
    if (!current || sending.current || !participantId || !writeLockRef.current) return;
    if (Date.now() < retryNotBefore.current) { scheduleFlush(retryNotBefore.current - Date.now()); return; }
    const pending = current.inflight?.operations ?? current.operations.filter(operation => operation.seq > current.ackSeq).slice(0, 128);
    if (!pending.length) { setSendStatus("confirmed"); return; }
    const collectionUntil = data?.v2?.collectionUntilMs ?? (cutoffAtMs == null ? null : cutoffAtMs + 10_000);
    const afterCollection = collectionUntil != null && currentNow() >= collectionUntil;
    if (afterCollection && (!current.inflight || postCollectionProbes.current >= 2)) {
      setSendStatus("blocked"); setMessage("受付時間が終了しました。一部の解答記録の送信を確認できませんでした。主催者にお知らせください");
      return;
    }
    if (afterCollection) postCollectionProbes.current += 1;
    sending.current = true;
    const requestId = current.inflight?.requestId ?? `${current.manifestId}-${participantId}-${pending[0].seq}-${pending[pending.length - 1].seq}`;
    const inflight = current.inflight ?? { requestId, operations: pending, writerEpoch: current.writerEpoch, manifestId: current.manifestId, evaluatorVersion: current.evaluatorVersion };
    const body = { requestId: inflight.requestId, writerEpoch: inflight.writerEpoch ?? current.writerEpoch,
      manifestId: inflight.manifestId ?? current.manifestId, evaluatorVersion: inflight.evaluatorVersion ?? current.evaluatorVersion, operations: inflight.operations };
    const generation = sessionGeneration.current;
    if (!current.inflight) void persist({ ...current, inflight });
    setSendStatus("sending");
    try {
      await persistChain.current;
      if (!mounted.current || generation !== sessionGeneration.current || !writeLockRef.current) return;
      const remainingCollectionMs = collectionUntil == null ? 5000 : Math.max(1000, collectionUntil - currentNow());
      const response = await postJson(`/api/rooms/${encodeURIComponent(roomId)}/operations`, body,
        { token, timeoutMs: Math.min(5000, remainingCollectionMs) }) as { ackSeq: number; acceptedSeq: number; correctCount: number };
      if (!mounted.current || generation !== sessionGeneration.current) return;
      const latest = sessionRef.current;
      if (latest) persist({ ...latest, ackSeq: Math.max(latest.ackSeq, response.ackSeq), inflight: undefined });
      retryDelay.current = 1000;
      postCollectionProbes.current = 0;
      retryNotBefore.current = 0;
      setRetryAt(0);
      setSendStatus("confirmed");
      if (latest?.gradingMode === "immediate" && response.correctCount !== immediateScore(latest.questions, latest.operations, response.acceptedSeq)) {
        setNeedsReview(true); setMessage("保存内容を確認しています。解答を保持したまま再接続してください");
      } else setMessage("");
      if (sessionRef.current?.operations.some(operation => operation.seq > response.ackSeq)) scheduleFlush(0);
    } catch (reason: any) {
      if (!mounted.current || generation !== sessionGeneration.current) return;
      if (retryableOperationFailure(reason) && (!afterCollection || postCollectionProbes.current < 2)) {
        const delay = operationRetryDelay(reason, retryDelay.current, room?.state === "COLLECTING");
        retryDelay.current = Math.min(8000, retryDelay.current * 2);
        retryNotBefore.current = Date.now() + delay;
        setRetryAt(Date.now() + delay);
        setSendStatus("retry");
        setMessage("");
        scheduleFlush(delay);
      } else {
        setSendStatus("blocked");
        setMessage(reason.code === "deadline" ? "受付時間が終了しました。一部の解答記録の送信を確認できませんでした。主催者にお知らせください"
          : reason.code === "stale_participant_revision" || reason.code === "invalid_state" ? "サーバーの状態が変わりました。解答記録を保持したまま再確認してください"
          : reason.message === "入力内容を確認してください" ? "解答の送信を確認できませんでした" : reason.message ?? "解答の送信を確認できませんでした");
      }
    } finally { sending.current = false; }
  };
  flushRef.current = flush;
  const queue = (operation: Omit<V2Operation, "seq" | "operationId">, immediate = false) => {
    const current = sessionRef.current; if (!current) return;
    const nextOperation: V2Operation = { ...operation, seq: (current.operations.at(-1)?.seq ?? 0) + 1, operationId: crypto.randomUUID() };
    persist({ ...current, operations: [...current.operations, nextOperation] });
    if (immediate || !timer.current) scheduleFlush(immediate ? 0 : 1000);
  };
  const finishAtCutoff = () => {
    const current = sessionRef.current;
    if (!current || current.finished || !cutoffAtMs) return;
    const cutoffElapsed = Math.max(0, cutoffAtMs - (room?.startAtMs ?? cutoffAtMs));
    if (room?.endReason !== "interrupted" && current.gradingMode === "deferred") {
      for (const [composite, draft] of Object.entries(current.drafts)) {
        const separator = composite.lastIndexOf(":");
        if (separator < 0 || draft.editedElapsedMs >= cutoffElapsed) continue;
        queue({ type: "draft", questionId: composite.slice(0, separator), fieldId: composite.slice(separator + 1) as "formula" | "name", value: draft.value,
          elapsedMs: cutoffElapsed, editedElapsedMs: draft.editedElapsedMs });
      }
    }
    queue({ type: "finish", elapsedMs: Math.max(elapsedMs(), cutoffElapsed), reason: room?.endReason === "interrupted" ? "interrupted" : "timeout", boundaryAtMs: cutoffAtMs }, true);
    const latest = sessionRef.current; if (latest) persist({ ...latest, finished: true });
  };
  useEffect(() => {
    const listener = () => { if (!document.hidden) { void refresh().catch(() => undefined); void flushRef.current?.(); } };
    const online = () => { void refresh().catch(() => undefined); void flushRef.current?.(); };
    const pagehide = () => { void flushRef.current?.(); };
    document.addEventListener("visibilitychange", listener);
    window.addEventListener("online", online); window.addEventListener("pagehide", pagehide);
    return () => { document.removeEventListener("visibilitychange", listener); window.removeEventListener("online", online); window.removeEventListener("pagehide", pagehide); };
  }, [refresh]);
  useEffect(() => { if (session?.gradingMode !== "deferred" || room?.state !== "RUNNING") return;
    const interval = setInterval(() => checkpointRef.current?.(), 5000);
    return () => clearInterval(interval);
  }, [session?.gradingMode, room?.state]);
  useEffect(() => { if (hasWriteLock && session && session.operations.some(operation => operation.seq > session.ackSeq)) void flush(); }, [session?.manifestId, hasWriteLock]);
  useEffect(() => {
    if (!session || !room || !cutoffAtMs || session.finished || !hasWriteLock) return;
    if (room.state !== "COLLECTING" && (room.state !== "RUNNING" || now < cutoffAtMs)) return;
    finishAtCutoff();
  }, [tick, room?.state, cutoffAtMs, session?.finished, hasWriteLock]);

  const pendingCount = session ? session.operations.length - session.ackSeq : 0;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const syncText = storageFailed ? "この端末への保存を確認できません。画面を閉じずにお待ちください"
    : localSaving ? "この端末に解答を保存しています…"
    : sendStatus === "blocked" ? message
    : sendStatus === "sending" ? "解答記録を送信しています…"
    : sendStatus === "retry" ? offline ? "通信が戻ると自動で再送信します。この画面を開いたままお待ちください"
      : "解答はこの端末に保存しました。通信を再確認しています"
    : pendingCount === 0 && session?.operations.length ? room?.state === "FINISHED" ? "解答記録の送信を確認しました" : "解答記録の送信を確認しました。結果を待っています" : "解答をこの端末に保存しました";
  const syncPanel = session ? <ParticipantSyncStatus text={syncText}
    action={storageFailed ? "保存を再試行" : sendStatus === "retry" ? offline ? "接続を再確認" : "今すぐ再送信" : sendStatus === "blocked" ? "状態を再確認" : undefined}
    disabled={sendStatus === "sending" || sendStatus === "retry" && Date.now() < retryAt}
    onAction={() => { if (storageFailed && sessionRef.current) void persist(sessionRef.current);
      else if (sendStatus === "blocked") void refresh().catch(() => undefined);
      else { if (timer.current) clearTimeout(timer.current); timer.current = null; void flushRef.current?.(); } }}/>: null;
  if (results) return <>{syncPanel}<ImmediateVerdict verdict={verdict?.fullScore ? verdict : null}/><Results data={results}/></>;
  if (!data) return <main className="page-shell"><section className="panel"><h1>競技に接続しています</h1><ParticipantSyncStatus text={error ?? "時刻を同期しています…"} action={error ? "接続を再確認" : undefined} onAction={() => void refresh().catch(() => undefined)}/></section></main>;
  if (!room) return null;
  if (room?.state === "FINISHED") return <>{syncPanel}<ImmediateVerdict verdict={verdict?.fullScore ? verdict : null}/><ResultLoadPanel state={resultLoad} retry={resultLoad.retry}/></>;
  if (room?.state === "CANCELLED") return <main className="page-shell"><section className="panel"><h1>ルームは終了しました</h1><a href={appPath("/")}>ホームへ戻る</a></section></main>;
  if (room?.state === "WAITING") return <main className="page-shell"><section className="panel"><h1>開始を待っています</h1>{data.participant && <NicknameEditor roomId={roomId} token={token} nickname={data.participant.nickname} revision={data.participant.revision} onSaved={async () => { await refresh(); }}/>}<p>{settingsSummary(room.settings as IonicFormulaGameSettings)}</p></section></main>;
  if (restoreFailed) return <main className="page-shell"><section className="panel"><h1>競技に戻れませんでした</h1><p role="alert">{message}</p><p>端末内の記録は保持しています。再読み込み後も続く場合はブラウザの保存設定を確認してください。</p><button type="button" onClick={() => { loading.current = false; setRestoreFailed(false); void refresh(); }}>再試行</button></section></main>;
  if (!session || room?.state === "PREPARING") return <main className="page-shell"><section className="panel"><h1>{room?.state === "PREPARING" ? "READY TO ROLL?" : "競技に戻っています…"}</h1><p role="status">{message || "まもなく始まります"}</p>{message && <button type="button" onClick={() => { loading.current = false; void refresh(); }}>再確認</button>}</section></main>;
  if (room?.state === "COUNTDOWN") return <main className="countdown"><p>まもなく開始</p><strong>{Math.max(0, Math.ceil(((room.startAtMs ?? now) - now) / 1000))}</strong></main>;
  if (!hasWriteLock && room?.state === "RUNNING") return <main className="page-shell"><section className="panel">{lockWaited ? <><h1>別のタブで解答中です</h1><p>このタブで続ける場合、別タブの未送信記録が失われることがあります。</p><button type="button" onClick={() => void (async () => {
    if (!confirm("このタブで解答を続けますか？別タブの未送信記録は引き継げない場合があります。")) return;
    lockChannel.current?.postMessage({ type: "takeover", owner: tabId.current });
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!await lockAcquire.current?.()) { setMessage("別のタブが解答中です。もう一度お試しください"); return; }
    try {
      const current = sessionRef.current; if (!current) return;
      const response = await postJson(`/api/rooms/${encodeURIComponent(roomId)}/writer`, { expectedEpoch: current.writerEpoch }, { token }) as { writerEpoch: number };
      persist({ ...current, writerEpoch: response.writerEpoch }); setMessage("");
    } catch (reason: any) { lockRelease.current?.(); setMessage(reason.message ?? "書き手を変更できませんでした"); }
  })()}>このタブで続ける</button></> : <h1>競技に戻っています…</h1>}<p role="status">{message}</p></section></main>;
  if (room?.state === "COLLECTING" || session.finished) return <main className="page-shell"><ImmediateVerdict verdict={verdict?.fullScore ? verdict : null}/><section className="panel"><h1>記録を確認しています</h1>{syncPanel}</section></main>;
  const question = session.questions[session.ordinal];
  if (!question) return <main className="page-shell"><section className="panel"><h1>記録を確認しています</h1></section></main>;
  const immediate = session.gradingMode === "immediate" ? immediateReviewState(session.questions, session.operations) : null;
  const resolved = question.fields.filter(item => ["correct", "passed", "passedRetry"].includes(immediate?.fields[fieldKey(question.id, item.id)] ?? "")).map(item => item.id);
  const publicCurrent = publicQuestion(question, resolved);
  const reviewTarget = session.reviewTarget?.questionId === question.id ? session.reviewTarget : null;
  const field = reviewTarget ? question.fields.find(item => item.id === reviewTarget.fieldId) ?? question.fields[0]
    : question.fields.find(item => item.id === selectedField && !resolved.includes(item.id)) ?? question.fields.find(item => !resolved.includes(item.id)) ?? question.fields[0];
  const value = session.drafts[fieldKey(question.id, field.id)]?.value;
  const setValue = (next: FormulaEntry | string) => {
    const current = sessionRef.current; if (!current) return;
    if (cutoffAtMs && currentNow() >= cutoffAtMs) return;
    const edited = elapsedMs();
    persist({ ...current, drafts: { ...current.drafts, [fieldKey(question.id, field.id)]: { value: next, editedElapsedMs: edited } } });
  };
  const checkpoint = () => {
    if (session.gradingMode !== "deferred") return;
    if (cutoffAtMs && currentNow() >= cutoffAtMs) return;
    for (const [composite, draft] of Object.entries(sessionRef.current?.drafts ?? {})) {
      if (lastCheckpoint.current[composite] === draft.editedElapsedMs) continue;
      const separator = composite.lastIndexOf(":");
      if (separator < 0) continue;
      lastCheckpoint.current[composite] = draft.editedElapsedMs;
      queue({ type: "draft", questionId: composite.slice(0, separator), fieldId: composite.slice(separator + 1) as "formula" | "name", value: draft.value,
        elapsedMs: elapsedMs(), editedElapsedMs: draft.editedElapsedMs });
    }
  };
  checkpointRef.current = checkpoint;
  const check = () => {
    if (session.gradingMode !== "immediate" || !field || emptyValue(value)) return;
    if (immediate?.fields[fieldKey(question.id, field.id)] === "correct") return;
    if (["passed", "passedRetry"].includes(immediate?.fields[fieldKey(question.id, field.id)] ?? "") && !reviewTarget) return;
    if (question.ordinal > (immediate?.frontier ?? 0)) return;
    if (cutoffAtMs && currentNow() >= cutoffAtMs) { finishAtCutoff(); return; }
    const correct = evaluateField(question as InternalQuestion, field.id, value).correct;
    primeAudio(savedSoundLevel());
    queue({ type: "answer", questionId: question.id, fieldId: field.id, value, elapsedMs: elapsedMs() });
    playAnswerSound(correct ? "correct" : "incorrect", savedSoundLevel());
    const currentAfterAnswer = sessionRef.current;
    const nextState = currentAfterAnswer ? immediateReviewState(currentAfterAnswer.questions, currentAfterAnswer.operations) : null;
    const total = currentAfterAnswer?.questions.reduce((sum, item) => sum + item.fields.length, 0) ?? 0;
    setVerdict({ attemptId: crypto.randomUUID(), correct, questionNumber: question.ordinal + 1,
      fieldLabel: fieldLabel(field.id, (room.settings as IonicFormulaGameSettings).mode),
      fullScore: correct && !!nextState && nextState.correctCount === total });
    if (!correct && typeof window !== "undefined" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      answerAreaRef.current?.animate?.([
        { transform: "translateX(0)" }, { transform: "translateX(-2px)" },
        { transform: "translateX(2px)" }, { transform: "translateX(0)" },
      ], { duration: 180, easing: "ease-out" });
    }
    if (correct) {
      const current = sessionRef.current;
      if (current) {
        if (nextState?.correctCount === total) {
          queue({ type: "finish", elapsedMs: elapsedMs(), reason: "completed" }, true);
          persist({ ...sessionRef.current!, finished: true });
        } else if (reviewTarget) {
          const resume = immediateResumeTarget(current.questions, current.operations);
          persist({ ...current, reviewTarget: undefined, ...(resume ? { ordinal: resume.ordinal } : {}) });
          setReviewing(true);
        }
        else if (nextState && question.fields.every(item => ["correct", "passed", "passedRetry"].includes(nextState.fields[fieldKey(question.id, item.id)] ?? ""))) {
          if (nextState.frontier >= current.questions.length) setReviewing(true);
          else persist({ ...current, ordinal: nextState.frontier });
        }
      }
    }
  };
  const pass = () => {
    if (session.gradingMode !== "immediate" || reviewTarget || resolved.includes(field.id) || question.ordinal !== immediate?.frontier) return;
    if (cutoffAtMs && currentNow() >= cutoffAtMs) { finishAtCutoff(); return; }
    queue({ type: "pass", questionId: question.id, fieldId: field.id, elapsedMs: elapsedMs() });
    setVerdict(null);
    const current = sessionRef.current;
    if (current) {
      const nextState = immediateReviewState(current.questions, current.operations);
      if (nextState.frontier >= current.questions.length) setReviewing(true);
      else if (nextState.frontier > current.ordinal) persist({ ...current, ordinal: nextState.frontier });
    }
  };
  const submit = () => {
    if (sessionRef.current?.finished) return;
    if (cutoffAtMs && currentNow() >= cutoffAtMs) { finishAtCutoff(); return; }
    checkpoint();
    queue({ type: "finish", elapsedMs: elapsedMs(), reason: "submitted" }, true);
    const current = sessionRef.current; if (current) persist({ ...current, finished: true });
    setConfirmSubmitting(false);
  };
  const remaining = remainingSeconds(cutoffAtMs ?? now, now);
  const canEdit = remaining > 0 && !needsReview && hasWriteLock && wallClock.current !== null;
  const resumeTarget = immediate ? immediateResumeTarget(session.questions, session.operations) : null;
  const resumeAnswer = () => {
    const current = sessionRef.current;
    if (!canEdit || !current) return;
    const target = immediateResumeTarget(current.questions, current.operations);
    if (!target) return;
    setSelectedField(target.fieldId); setReviewing(false); setConfirmSubmitting(false); setVerdict(null);
    persist({ ...current, ordinal: target.ordinal, reviewTarget: undefined });
  };
  const localCorrect = session.gradingMode === "immediate" ? immediateScore(session.questions, session.operations) : 0;
  const totalFields = session.questions.reduce((count, item) => count + item.fields.length, 0);
  const filledFields = session.questions.reduce((count, item) => count + item.fields.filter(f => !emptyValue(session.drafts[fieldKey(item.id, f.id)]?.value)).length, 0);
  if (reviewing && session.gradingMode === "immediate" && immediate) return <main className="play-shell play-active" data-tick={tick}>
    <header className="scorebar"><span>全解答確認</span><span>正解 {immediate.correctCount} / {room.maxScore}</span><span>残り {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</span></header>
    {syncPanel}<ImmediateVerdict verdict={verdict}/><section className="panel"><h1>全解答確認</h1><p>パスした問題は、時間内なら後から解答できます。</p>
      <ImmediateReviewList questions={session.questions} frontier={immediate.frontier} fields={immediate.fields} disabled={!canEdit} onContinue={resumeAnswer} onRetry={(index, fieldId) => {
        setSelectedField(fieldId); setReviewing(false); setConfirmSubmitting(false); setVerdict(null);
        persist({ ...sessionRef.current!, ordinal: index, reviewTarget: { questionId: session.questions[index].id, fieldId } });
      }}/>
      <button className="secondary-button" type="button" disabled={!canEdit || !resumeTarget} onClick={resumeAnswer}>{resumeTarget ? `続きの問題へ（第${resumeTarget.ordinal + 1}問）` : "続きの問題はありません"}</button>
      {confirmSubmitting ? <div className="immediate-submit-confirm" role="alertdialog" aria-label="提出の最終確認"><p>正解 {immediate.correctCount} / {totalFields}、未正解 {totalFields - immediate.correctCount}。提出後は解答に戻れません。</p><div><button type="button" onClick={() => setConfirmSubmitting(false)}>取り消す</button><button type="button" disabled={!canEdit || storageFailed || localSaving} onClick={submit}>提出を確定する</button></div></div> : <button className="primary-action" type="button" disabled={!canEdit || storageFailed || localSaving} onClick={() => setConfirmSubmitting(true)}>このまま提出</button>}
    </section></main>;
  if (reviewing && session.gradingMode === "deferred") return <main className="play-shell play-active" data-tick={tick}>
    <header className="scorebar"><span>解答の確認</span><span>入力済み {filledFields} / {totalFields}</span><span>残り {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</span></header>
    {syncPanel}<section className="panel"><h1>全解答確認</h1><p>各解答を確認し、必要なら問題へ戻って修正できます。</p>
      <div className="review-question-list">{session.questions.map((item, index) => {
        return <DeferredReviewQuestion key={item.id} number={index + 1} prompt={item.prompt} fields={item.fields.map(answerField => ({ id: answerField.id, value: session.drafts[fieldKey(item.id, answerField.id)]?.value }))} disabled={!canEdit} onSelect={() => { setReviewing(false); persist({ ...sessionRef.current!, ordinal: index }); }}/>;
      })}</div><p className="submit-note">提出後は変更できません。</p>
      <button className="primary-action" type="button" disabled={!canEdit} onClick={submit}>提出する</button>
    </section></main>;
  return <main className="play-shell play-active play-answering" data-tick={tick}>
    <header className="scorebar"><span>第{question.ordinal + 1}問 / 全{session.questions.length}問</span><span>{session.gradingMode === "immediate" ? `正解 ${localCorrect} / ${room.maxScore}` : `入力済み ${filledFields} / ${totalFields}`}</span><span>残り {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</span></header>
    {syncPanel}<ImmediateVerdict verdict={verdict}/>
    <QuestionView question={publicCurrent}/>
    <section className="answer-area" ref={answerAreaRef}><AnswerFieldTabs fields={question.fields} fieldStates={Object.fromEntries(question.fields.map(item => [item.id, reviewTarget?.fieldId === item.id ? "pending" : immediate?.fields[fieldKey(question.id, item.id)] === "correct" ? "correct" : ["passed", "passedRetry"].includes(immediate?.fields[fieldKey(question.id, item.id)] ?? "") ? "passed" : "pending"]))} selectedFieldId={field.id} mode={(room.settings as IonicFormulaGameSettings).mode} onSelect={next => { if (reviewTarget) return; checkpoint(); setSelectedField(next); }}/>
    {field.id === "formula" ? <FormulaKeyboard value={(value as FormulaEntry | undefined) ?? createFormulaEntry()} onChange={setValue} onSubmit={check} showSubmit={session.gradingMode === "immediate"} kind={(room.settings as IonicFormulaGameSettings).mode} disabled={!canEdit} resetKey={question.id}/> : <NameKeyboard complexEnabled={(room.settings as IonicFormulaGameSettings).complexEnabled} difficulty={(room.settings as IonicFormulaGameSettings).difficulty} value={typeof value === "string" ? value : ""} onChange={setValue} onSubmit={check} showSubmit={session.gradingMode === "immediate"} kind={(room.settings as IonicFormulaGameSettings).mode} disabled={!canEdit} focusKey={`${question.id}:${field.id}`}/>}
    {session.gradingMode === "immediate" ? <div className="immediate-actions">{reviewTarget ? <button className="pass-action" type="button" onClick={() => { setConfirmSubmitting(false); setReviewing(true); }}>確認一覧へ戻る</button> : <button className="pass-action" type="button" disabled={!canEdit || resolved.includes(field.id)} onClick={pass}>パス</button>}<button className="review-action" type="button" onClick={() => { setConfirmSubmitting(false); setReviewing(true); }}>全解答確認</button></div> : null}
    </section>
    {session.gradingMode === "deferred" && <nav className="question-navigation" aria-label="問題の移動"><button type="button" disabled={!canEdit || session.ordinal === 0} onClick={() => { checkpoint(); persist({ ...sessionRef.current!, ordinal: session.ordinal - 1 }); }}>前の問題</button><button type="button" className={session.ordinal < session.questions.length - 1 ? "is-emphasized" : ""} disabled={!canEdit || session.ordinal >= session.questions.length - 1} onClick={() => { checkpoint(); persist({ ...sessionRef.current!, ordinal: session.ordinal + 1 }); }}>次の問題</button><button type="button" className={session.ordinal === session.questions.length - 1 ? "is-emphasized" : ""} disabled={!canEdit} onClick={() => { checkpoint(); setReviewing(true); }}>全解答確認</button></nav>}
  </main>;
}
