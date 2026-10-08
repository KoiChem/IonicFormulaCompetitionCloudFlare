import { appPath } from '../../web/routing';
"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import {useStartRoom,StartStatusPanel} from "./useStartRoom";
import { Lobby } from "./Lobby";
import { RemovedParticipantNotice } from "./RemovedParticipantNotice";
import { reentryNicknameKey } from "../setup/join-draft";
import { useHostCountdownSound } from "./host-countdown-sound";
import { NicknameEditor } from "./NicknameEditor";
import { EndRoomButton } from "./EndRoomButton";
import { InterruptRoomButton } from "./InterruptRoomButton";
import { CompetitionPlayer } from "../play/CompetitionPlayer";
import { CompetitionPlayerV2 } from "../play/CompetitionPlayerV2";
import { countdownSeconds, patchJson, postJson, loadCredential, RoomSyncProvider, useRoomSync, type ParticipantState, type RoomStateResponse } from "../play/useRoomSync";
import { Results } from "../results/Results";
import { useResults } from "../results/useResults";
import { ResultLoadPanel } from "../results/ResultLoadPanel";
import { CompetitionSettingsForm } from "../setup/CompetitionSettingsForm";
import { HostRace } from "./HostRace";
import { racePace } from "./host-race-model";
import { shouldWarnBeforeLeaving } from "../play/active-room-recovery";
import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";

async function retryExact(path: string, body: unknown, token?: string) {
  try { return await postJson(path, body, token ? { token } : {}); }
  catch (error: any) {
    if (error.status && error.status < 500 && error.code !== "database_conflict") throw error;
    return postJson(path, body, token ? { token } : {});
  }
}

const EMPTY_PARTICIPANTS: ParticipantState[] = [];

function ClassRunning({ data, clockRef, busy, onInterrupt }: { data: RoomStateResponse; clockRef: RefObject<{ serverNowMs(now: number): number | null } | null>; busy: boolean; onInterrupt(): Promise<void> }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setTick(value => value + 1), data.room.state === "COUNTDOWN" ? 100 : 1000); return () => window.clearInterval(timer); }, [data.room.state]);
  const now = clockRef.current?.serverNowMs(performance.now()) ?? data.serverNow;
  const start = data.room.startAtMs ?? now;
  const deadline = data.room.deadlineAtMs ?? now;
  const remaining = Math.max(0, deadline - now);
  const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  const countingDown = now < start && data.room.state === "COUNTDOWN";
  return <main className="class-host-page running-host race-host-page" data-tick={tick}>
    {countingDown && <div className="race-countdown">まもなく開始 <strong aria-live="off">{countdownSeconds(start, now)}</strong></div>}
    <HostRace roomId={data.room.id} participants={data.participants ?? EMPTY_PARTICIPANTS} mode={data.room.gradingMode ?? "immediate"} maxScore={data.room.maxScore} questionCount={(data.room.settings as IonicFormulaGameSettings).questionCount} active={!countingDown && remaining > 0} pace={racePace(remaining, deadline - start)} remainingText={mmss(remaining)} interruptButton={now >= start && remaining > 0 ? <InterruptRoomButton busy={busy} onInterrupt={onInterrupt}/> : null}/>
  </main>;
}

export function Progress({ participants = [], gradingMode = "immediate" }: { participants?: ParticipantState[]; gradingMode?: "immediate" | "deferred" }) {
  return <section className="panel progress-panel" aria-label="参加者の進捗"><h2>参加者の進捗</h2><p>{gradingMode === "deferred" ? "提出" : "完了"} {participants.filter((p) => gradingMode === "deferred" ? p.submitted === true : p.status === "FINISHED").length} / {participants.length}人</p><ul className="participant-list">{participants.map((p) => <li key={p.id}><span>{p.nickname}</span><span>{gradingMode === "deferred" ? `入力済み ${p.answeredCount ?? 0}欄・${p.submitted ? "提出済み" : "解答中"}` : `正解 ${p.correctCount}・${p.status === "FINISHED" ? "完了" : `${p.resolvedQuestionCount}問`}`}</span></li>)}</ul></section>;
}

export function CollectingProgress({ participants, gradingMode }: { participants?: ParticipantState[]; gradingMode?: "immediate" | "deferred" }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="progress-toggle" aria-expanded={open} aria-controls="collecting-participant-progress" onClick={() => setOpen(value => !value)}>{open ? "参加者の進捗を閉じる" : "参加者の進捗を表示"}</button>{open && <div id="collecting-participant-progress"><Progress participants={participants} gradingMode={gradingMode}/></div>}</>;
}

function PreparingStatus({ data, busy, onCancel, onRefresh }: { data: RoomStateResponse; busy: boolean; onCancel(): Promise<void>; onRefresh(): Promise<unknown> }) {
  const pending = data.v2?.notReadyNicknames ?? [];
  return <section className="panel wide"><h1>READY TO ROLL?</h1><p role="status">準備完了 {data.v2?.readyCount ?? 0} / {data.v2?.participantCount ?? data.participants?.length ?? 0}人</p>
    {pending.length > 0 && <p>準備待ち: {pending.join("、")}</p>}
    {data.v2?.preparationTimedOut && <p role="alert">問題の準備が揃いませんでした。通信状態を確認し、準備を取り消して再度開始してください。</p>}
    <div className="nickname-actions"><button type="button" disabled={busy} onClick={() => void onRefresh()}>準備を再確認</button><button type="button" disabled={busy} onClick={() => void onCancel()}>準備を取り消す</button></div>
  </section>;
}

export function RoomScreen({ roomId }: { roomId: string }) {
  const [credential, setCredential] = useState<{ token: string } | null | undefined>(undefined);
  useEffect(() => setCredential(loadCredential(roomId)), [roomId]);
  if (credential === undefined) return <main className="page-shell"><section className="panel"><p>参加資格を確認しています…</p></section></main>;
  return <RoomSyncProvider key={`${roomId}:${credential?.token??"teacher"}`} roomId={roomId} token={credential?.token}>{credential?<ParticipantRoom roomId={roomId} token={credential.token}/>:<ManagedRoom roomId={roomId}/>}</RoomSyncProvider>;
}

function MateRunning({ roomId, token, participants, protocolVersion, gradingMode }: { roomId: string; token: string; participants?: ParticipantState[]; protocolVersion?: number; gradingMode?: "immediate" | "deferred" }) {
  const [open, setOpen] = useState(false);
  return <div className="mate-host-running">{protocolVersion === 2 ? <CompetitionPlayerV2 roomId={roomId} token={token}/> : <CompetitionPlayer roomId={roomId} token={token}/>}<button type="button" className="progress-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "進捗を閉じる" : "参加者の進捗"}</button>{open && <div className="progress-sheet"><Progress participants={participants} gradingMode={gradingMode}/></div>}</div>;
}

function ParticipantRoom({ roomId, token }: { roomId: string; token: string }) {
  const { data, error, removed, terminalError, refresh, clockRef } = useRoomSync(roomId, token); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!shouldWarnBeforeLeaving(data?.room.state) || removed || terminalError) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [data?.room.state, removed, terminalError]);
  const startControl = useStartRoom(roomId, token, data?.room, refresh);
  const pendingCancel = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  const [settings, setSettings] = useState<IonicFormulaGameSettings | null>(null);
  const cancelPreparation = async () => { if (!data) return; setBusy(true); try { await postJson(`/api/rooms/${encodeURIComponent(roomId)}/cancel-preparation`, { expectedRevision: data.room.revision }, { token }); await refresh(); } catch (reason: any) { alert(reason.message); } finally { setBusy(false); } };
  const [meta, setMeta] = useState<{ joinCode?: string; host?: boolean }>(() => { try { return JSON.parse(localStorage.getItem(`ionic-formula-competition:meta:${roomId}`) ?? "{}"); } catch { return {}; } });
  useHostCountdownSound(!!meta.host && data?.room.state === "COUNTDOWN", data?.room.startAtMs, clockRef, data?.serverNow);
  if (removed) return <RemovedParticipantNotice roomState={removed.roomState} canRejoin={removed.canRejoin} onRejoin={() => {
    try { sessionStorage.setItem(reentryNicknameKey(roomId), removed.nickname); } catch { /* use the join form without a preset */ }
    location.href = appPath(`/join/${encodeURIComponent(roomId)}`);
  }} />;
  if (terminalError) return <main className="page-shell"><section className="panel"><h1>ルームを利用できません</h1><p role="status">{terminalError}</p><a className="primary-link" href={appPath("/")}>ホームへ戻る</a></section></main>;
  if (!data) return <main className="page-shell"><section className="panel"><h1>ルームへ接続中</h1><p role="status">{error ?? "読み込み中…"}</p></section></main>;
  if (data.room.state === "CANCELLED") return <CancelledRoom />;
  if (!meta.host) return data.room.playProtocolVersion === 2 ? <CompetitionPlayerV2 roomId={roomId} token={token}/> : <CompetitionPlayer roomId={roomId} token={token} />;
  if (data.room.state !== "WAITING") return <>{data.room.state === "PREPARING" && <PreparingStatus data={data} busy={busy||startControl.busy} onCancel={cancelPreparation} onRefresh={refresh}/>}<MateRunning roomId={roomId} token={token} participants={data.participants} protocolVersion={data.room.playProtocolVersion} gradingMode={data.room.gradingMode}/></>;
  const activeSettings = settings ?? data.room.settings as IonicFormulaGameSettings;
  const start = () => void startControl.begin();
  const remove = async (participant: ParticipantState) => { setBusy(true); const body = { requestId: crypto.randomUUID(), participantId: participant.id, expectedRoomRevision: data.room.revision, expectedParticipantRevision: participant.revision }; try { await retryExact(`/api/rooms/${encodeURIComponent(roomId)}/remove`, body, token); await refresh(); } catch (e: any) { if (e.status === 409) await refresh(); alert(e.message); } finally { setBusy(false); } };
  const saveSettings = async () => { setBusy(true); try { await patchJson(`/api/rooms/${encodeURIComponent(roomId)}/settings`, { requestId: crypto.randomUUID(), expectedRevision: data.room.revision, settings: activeSettings }, { token }); setSettings(null); await refresh(); } catch (e: any) { if (e.status === 409) await refresh(); alert(e.message); } finally { setBusy(false); } };
  const end = async () => { setBusy(true); const body = pendingCancel.current ?? { requestId: crypto.randomUUID(), expectedRevision: data.room.revision }; pendingCancel.current = body; try { await retryExact(`/api/rooms/${encodeURIComponent(roomId)}/cancel`, body, token); pendingCancel.current = null; location.href = appPath("/"); } catch (e: any) { if (e.status === 409) { pendingCancel.current = null; await refresh(); } throw e; } finally { setBusy(false); } };
  return <main className="mate-host-page"><Lobby room={data.room} participants={data.participants} joinCode={meta.joinCode} canStart={(data.participants?.length ?? 0) >= 2 && !settings} onStart={start} onRemove={remove} ownerParticipantId={data.participant?.id} busy={busy||startControl.busy} /><StartStatusPanel start={startControl}/>{data.participant && <NicknameEditor roomId={roomId} token={token} nickname={data.participant.nickname} revision={data.participant.revision} onSaved={async () => { await refresh(); }}/>}<EndRoomButton busy={busy||startControl.busy} onEnd={end}/><details className="panel settings-editor"><summary>競技設定を変更</summary><CompetitionSettingsForm value={activeSettings} onChange={setSettings} disabled={busy||startControl.busy}/><button className="primary-action" type="button" disabled={busy || startControl.busy || !settings} onClick={saveSettings}>設定を保存</button></details></main>;
}

function CancelledRoom() { return <main className="page-shell"><section className="panel"><h1>ルームは終了しました</h1><p>主催者がルームを終了しました。</p><a className="primary-link" href={appPath("/")}>ホームへ戻る</a></section></main>; }

function ManagedRoom({ roomId }: { roomId: string }) {
  const { data, error, refresh, clockRef } = useRoomSync(roomId); const [busy, setBusy] = useState(false);
  const resultLoad = useResults(roomId, undefined, data?.room.state === "FINISHED", data?.room.expiresAtMs);
  const results = resultLoad.full;
  const startControl = useStartRoom(roomId, undefined, data?.room, refresh);
  const pendingCancel = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  const pendingInterrupt = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  const cancelPreparation = async () => { if (!data) return; setBusy(true); try { await postJson(`/api/rooms/${encodeURIComponent(roomId)}/cancel-preparation`, { expectedRevision: data.room.revision }); await refresh(); } catch (reason: any) { alert(reason.message); } finally { setBusy(false); } };
  const [settings, setSettings] = useState<IonicFormulaGameSettings | null>(null);
  useHostCountdownSound(data?.room.state === "COUNTDOWN", data?.room.startAtMs, clockRef, data?.serverNow);
  let meta: { joinCode?: string; host?: boolean } = {};
  try { if (typeof localStorage !== "undefined") meta = JSON.parse(localStorage.getItem(`ionic-formula-competition:meta:${roomId}`) ?? "{}"); } catch { /* a damaged local hint must not prevent room recovery */ }
  if (results) return <Results data={results} />;
  if (!data) return <main className="page-shell"><section className="panel"><h1>管理画面へ接続中</h1><p role="status">{error ?? "読み込み中…"}</p></section></main>;
  if (data.room.state === "CANCELLED") return <CancelledRoom />;
  if (data.room.state === "FINISHED") return <ResultLoadPanel state={resultLoad} retry={resultLoad.retry}/>;
  const start = () => void startControl.begin();
  const remove = async (participant: ParticipantState) => { setBusy(true); const body = { requestId: crypto.randomUUID(), participantId: participant.id, expectedRoomRevision: data.room.revision, expectedParticipantRevision: participant.revision }; try { await retryExact(`/api/rooms/${encodeURIComponent(roomId)}/remove`, body); await refresh(); } catch (e: any) { if (e.status === 409) await refresh(); alert(e.message); } finally { setBusy(false); } };
  const activeSettings = settings ?? data.room.settings as IonicFormulaGameSettings;
  const saveSettings = async () => { setBusy(true); try { await patchJson(`/api/rooms/${encodeURIComponent(roomId)}/settings`, { requestId: crypto.randomUUID(), expectedRevision: data.room.revision, settings: activeSettings }); setSettings(null); await refresh(); } catch (e: any) { if (e.status === 409) await refresh(); alert(e.message); } finally { setBusy(false); } };
  const end = async () => { setBusy(true); const body = pendingCancel.current ?? { requestId: crypto.randomUUID(), expectedRevision: data.room.revision }; pendingCancel.current = body; try { await retryExact(`/api/rooms/${encodeURIComponent(roomId)}/cancel`, body); pendingCancel.current = null; location.href = appPath("/"); } catch (e: any) { if (e.status === 409) { pendingCancel.current = null; await refresh(); } throw e; } finally { setBusy(false); } };
  const interrupt = async () => { setBusy(true); const body = pendingInterrupt.current ?? { requestId: crypto.randomUUID(), expectedRevision: data.room.revision }; pendingInterrupt.current = body; try { await retryExact(`/api/rooms/${encodeURIComponent(roomId)}/interrupt`, body); await refresh(); pendingInterrupt.current = null; } catch (e: any) { if (e.status && e.status < 500 && e.code !== "database_conflict") { pendingInterrupt.current = null; await refresh(); } throw e; } finally { setBusy(false); } };
  if (data.room.state === "WAITING") return <main className="class-host-page"><Lobby room={data.room} participants={data.participants} joinCode={meta.joinCode} canStart={(data.participants?.length ?? 0) >= 1 && !settings} onStart={start} onRemove={remove} busy={busy||startControl.busy}/><StartStatusPanel start={startControl}/><EndRoomButton busy={busy||startControl.busy} onEnd={end}/><details className="panel settings-editor"><summary>競技設定を変更</summary><CompetitionSettingsForm value={activeSettings} onChange={setSettings} disabled={busy||startControl.busy}/><button className="primary-action" type="button" disabled={busy || startControl.busy || !settings} onClick={saveSettings}>設定を保存</button></details></main>;
  if (data.room.state === "PREPARING") return <main className="class-host-page"><PreparingStatus data={data} busy={busy||startControl.busy} onCancel={cancelPreparation} onRefresh={refresh}/></main>;
  if (data.room.state === "COLLECTING") return <main className="class-host-page"><section className="panel wide"><h1>記録を確認しています</h1><p>参加者からの解答記録を回収しています。</p><CollectingProgress participants={data.participants} gradingMode={data.room.gradingMode}/></section></main>;
  return <ClassRunning data={data} clockRef={clockRef} busy={busy} onInterrupt={interrupt}/>;
}
