import { useRoomRealtime, type RoomTopics, type RoomEvent } from '../../web/realtime';
import { pollInterval } from '../../web/realtime-policy';
import { apiFetch, type ApiFetchOptions } from '../../web/api';
import { coalesceRequest } from '../../web/coalesce-request';
import {createRoomSyncScheduler} from '../../web/room-sync-scheduler';
"use client";

import { createContext, createElement, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CompetitionClock, type ClockSample } from "./clock";

export type RoomView = { id: string; kind: "class" | "mate"; state: "WAITING" | "PREPARING" | "COUNTDOWN" | "RUNNING" | "COLLECTING" | "FINISHED" | "CANCELLED" | "EXPIRED"; revision: number; playProtocolVersion?: number; gradingMode?: "immediate" | "deferred"; endReason?: "normal" | "interrupted"; settings: Record<string, unknown>; maxScore: number; startAtMs: number | null; deadlineAtMs: number | null; expiresAtMs: number };
export type ParticipantState = { id: string; joinedOrder?: number; nickname: string; status: string; currentOrdinal: number; correctCount: number; resolvedQuestionCount: number; answeredCount?: number; advancedQuestionCount?: number; submitted?: boolean; revision: number; elapsedCs: number | null; rawElapsedMs?: number; waitCreditMs?: number; timingSource: string | null };
export type RoomStateResponse = { realtime?: RoomTopics; serverNow: number; serverTiming?: {receivedAtMs:number;sentAtMs:number}; room: RoomView; participant?: ParticipantState; participants?: ParticipantState[]; question?: any; v2?: { state: string; manifestId: string; preparationGeneration: number; preparationTimedOut: boolean; readyCount: number | null; participantCount: number | null; notReadyNicknames: string[]; cutoffAtMs: number | null; collectionUntilMs: number | null } };
export type RemovedParticipantStatus = { nickname: string; roomState: string; canRejoin: boolean };

type SnapshotRevision = { room: { revision: number }; participant?: { revision: number } };
export function chooseFreshSnapshot<T extends SnapshotRevision>(current: T | null, next: T, currentSequence: number, nextSequence: number): T | null {
  if (!current) return next;
  if (next.room.revision !== current.room.revision) return next.room.revision > current.room.revision ? next : current;
  const currentParticipantRevision = current.participant?.revision ?? -1;
  const nextParticipantRevision = next.participant?.revision ?? -1;
  if (nextParticipantRevision !== currentParticipantRevision) return nextParticipantRevision > currentParticipantRevision ? next : current;
  return nextSequence >= currentSequence ? next : current;
}
export const countdownSeconds = (startAtMs: number, nowMs: number) => Math.max(0, Math.ceil((startAtMs - nowMs) / 1_000));
export const remainingSeconds = (deadlineAtMs: number, nowMs: number) => Math.max(0, Math.ceil((deadlineAtMs - nowMs) / 1_000));

export function randomCredential(byteLength = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...values)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export const credentialKey = (roomId: string) => `ionic-formula-competition:room:${roomId}`;
export function loadCredential(roomId: string): { token: string; participantId?: string } | null {
  try { const value = localStorage.getItem(credentialKey(roomId)); return value ? JSON.parse(value) : null; } catch { return null; }
}
export function saveCredential(roomId: string, value: { token: string; participantId?: string }) { localStorage.setItem(credentialKey(roomId), JSON.stringify(value)); }

async function responseJson(response: Response): Promise<any> {
  const body: any = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `通信に失敗しました（HTTP ${response.status}）`), {
    status: response.status, code: body?.error?.code, details: body?.error,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
  });
  if (body === null) throw new Error("応答を読み取れませんでした");
  return body;
}

export function retryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

export async function fetchJsonWithTimeout(path: string, init: ApiFetchOptions, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("通信が時間内に完了しませんでした"), { code: "timeout" }));
    }, timeoutMs);
  });
  try { return await Promise.race([apiFetch(path, { ...init, signal: controller.signal }).then(responseJson), expired]); }
  finally { if (timer) clearTimeout(timer); }
}

function useOwnedRoomSync(roomId: string, token?: string | null) {
  const [data, setData] = useState<RoomStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [removed, setRemoved] = useState<RemovedParticipantStatus | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const stopped = useRef(false);
  const clockRef = useRef<CompetitionClock | null>(null);
  const requestSequence = useRef(0);
  const appliedSequence = useRef(0);
  const latestData = useRef<RoomStateResponse | null>(null);
  const identity = useRef(`${roomId}:${token ?? ""}`);
  useEffect(() => {
    const nextIdentity = `${roomId}:${token ?? ""}`;
    if (identity.current === nextIdentity) return;
    identity.current = nextIdentity;
    stopped.current = false; latestData.current = null; clockRef.current = null;
    setData(null); setError(null); setConnected(false); setRemoved(null); setTerminalError(null);
  }, [roomId, token]);
  const sync = useMemo(() => coalesceRequest(async () => {
    if (stopped.current) throw new Error("この参加資格は使用できません");
    const requestIdentity = `${roomId}:${token ?? ""}`;
    const sequence = ++requestSequence.current;
    let sentAt = performance.now();
    let next: RoomStateResponse;
    try { next = await fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/state`, { cache: "no-store", onDispatch:()=>{sentAt=performance.now();}, headers: token ? { authorization: `Bearer ${token}` } : undefined }, 10_000) as RoomStateResponse; }
    catch (reason) {
      if (requestIdentity !== identity.current) throw reason;
      const failure = reason as { code?: string; details?: Partial<RemovedParticipantStatus>; message?: string };
      if (failure.code === "participant_removed" && typeof failure.details?.nickname === "string") {
        stopped.current = true;
        setRemoved({ nickname: failure.details.nickname, roomState: failure.details.roomState ?? "WAITING", canRejoin: failure.details.canRejoin === true });
      } else if (failure.code === "expired" || failure.code === "not_found") {
        stopped.current = true;
        setTerminalError(failure.message ?? "このルームを利用できません");
      }
      throw reason;
    }
    if (stopped.current || requestIdentity !== identity.current) throw new Error("この参加資格は使用できません");
    const selected = chooseFreshSnapshot(latestData.current, next, appliedSequence.current, sequence) as RoomStateResponse | null;
    const actualReceivedAt = performance.now();
    if (selected === next && next.room.startAtMs != null) {
      if (!clockRef.current || clockRef.current.startAtMs !== next.room.startAtMs) clockRef.current = new CompetitionClock(next.room.startAtMs);
      clockRef.current.synchronize({ sentAt, receivedAt: actualReceivedAt, serverNow: next.serverNow, serverTiming:next.serverTiming });
      if (next.participant?.rawElapsedMs != null) clockRef.current.confirm(next.participant.rawElapsedMs);
    }
    if (selected === next) { appliedSequence.current = sequence; latestData.current = next; setData(next); }
    setConnected(true); setError(null);
    return { next, sample: { sentAt, receivedAt: actualReceivedAt, serverNow: next.serverNow, serverTiming:next.serverTiming } satisfies ClockSample };
  }), [roomId, token]);

  const schedulerRef = useRef<ReturnType<typeof createRoomSyncScheduler<Awaited<ReturnType<typeof sync>>>> | null>(null);
  const resync = useCallback(() => { if (!stopped.current) schedulerRef.current?.request('control'); }, []);
  const onEvent = useCallback((_event:RoomEvent,kind:'control'|'host')=>{if(!stopped.current)schedulerRef.current?.request(kind);},[]);
  const realtimeConnected = useRoomRealtime(data?.realtime, !!data && !['FINISHED','CANCELLED','EXPIRED'].includes(data.room.state), onEvent, resync, token);
  const realtimeStatus = useRef(false);
  realtimeStatus.current = realtimeConnected;

  const syncThree = useCallback(async () => {
    const samples: ClockSample[] = [];
    let latest!:Awaited<ReturnType<typeof sync>>;
    for (let index = 0; index < 3; index += 1) {latest=await sync();samples.push(latest.sample);}
    clockRef.current?.synchronizeBest(samples);
    return latest;
  }, [sync]);

  useEffect(() => {
    let sampleClock = false;let sampledStart:number|null=null;
    const scheduler=createRoomSyncScheduler({
      run:async()=>{if(stopped.current)throw new Error('この参加資格は使用できません');
        if(sampleClock){sampleClock=false;sampledStart=latestData.current?.room.startAtMs??null;return syncThree();}
        const result=await sync();
        if(result.next.room.state==='COUNTDOWN'&&result.next.room.startAtMs!==sampledStart){sampleClock=true;schedulerRef.current?.request('control');}
        return result;},
      delay:()=>realtimeStatus.current?Infinity:pollInterval(latestData.current?.realtime?.role??(token?'participant':'teacher'),latestData.current?.room.state??'WAITING',realtimeStatus.current,document.hidden),
      onError:reason=>{setConnected(false);setError(reason instanceof Error?reason.message:'再接続しています');if(stopped.current)scheduler.stop();},
    });
    schedulerRef.current=scheduler;scheduler.start();
    const visibility=()=>{if(!document.hidden&&!stopped.current){clockRef.current?.requireResync();sampleClock=!!clockRef.current;scheduler.request('resume');}};
    document.addEventListener('visibilitychange',visibility);
    return ()=>{scheduler.stop();if(schedulerRef.current===scheduler)schedulerRef.current=null;document.removeEventListener('visibilitychange',visibility);};
  }, [sync, syncThree]);
  useEffect(() => {
    if (!data || ['FINISHED','CANCELLED','EXPIRED'].includes(data.room.state)) return;
    const now = clockRef.current?.serverNowMs(performance.now()) ?? data.serverNow;
    const boundary = [data.room.startAtMs, data.room.deadlineAtMs, data.v2?.cutoffAtMs, data.v2?.collectionUntilMs]
      .filter((time): time is number => typeof time === 'number' && time > now).sort((a,b) => a-b)[0];
    if (boundary == null) return;
    const timer = setTimeout(resync, Math.max(0, boundary-now+50));
    return () => clearTimeout(timer);
  }, [data?.room.state, data?.room.startAtMs, data?.room.deadlineAtMs, data?.v2?.cutoffAtMs, data?.v2?.collectionUntilMs, resync]);
  const refresh = useCallback(() => schedulerRef.current?.refresh()??Promise.reject(new Error('同期を準備しています')), []);
  return { data, error, connected, removed, terminalError, refresh, clockRef };
}

type SharedSync = ReturnType<typeof useOwnedRoomSync>;
const RoomSyncContext = createContext<{roomId:string;token:string|null;value:SharedSync}|null>(null);
export function RoomSyncProvider({roomId,token,children}:{roomId:string;token?:string|null;children:ReactNode}) {
  const value=useOwnedRoomSync(roomId,token);
  return createElement(RoomSyncContext.Provider,{value:{roomId,token:token??null,value}},children);
}
export function useRoomSync(roomId:string,token?:string|null):SharedSync {
  const shared=useContext(RoomSyncContext);
  if(!shared||shared.roomId!==roomId||shared.token!==(token??null))throw new Error('Room synchronization provider differs');
  return shared.value;
}

export async function postJson(path: string, body: unknown, options: { token?: string; creationKey?: string; timeoutMs?: number } = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-competition-csrf": "1" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.creationKey) headers["x-creation-key"] = options.creationKey;
  return fetchJsonWithTimeout(path, { method: "POST", headers, body: JSON.stringify(body) }, options.timeoutMs ?? 10_000);
}

export async function patchJson(path: string, body: unknown, options: { token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-competition-csrf": "1" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return fetchJsonWithTimeout(path, { method: "PATCH", headers, body: JSON.stringify(body) }, 10_000);
}
