"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ParticipantState } from "../play/useRoomSync";
import { effectiveRaceMotion, increasedRaceIds, isRaceGoal, raceCapacity, raceCount, raceFollowStart, raceProgress, raceRows, raceScale, raceVisibleRange, type RaceMode, type RaceMotionChoice, type RaceRow } from "./host-race-model";
import { colorForRunner } from "./host-race-colors";

export function Runner({ id, color = "#1763a6", goal, stopped, rest = false, dash = false }: { id: string; color?: string; goal: boolean; stopped: boolean; rest?: boolean; dash?: boolean }) {
  return <svg className={`race-runner ${goal ? "is-goal" : ""} ${stopped ? "is-stopped" : ""} ${rest ? "is-resting" : ""} ${dash ? "is-dashing" : ""}`} viewBox={rest ? "-38 -44 76 68" : "-36 -68 72 102"} aria-hidden="true" style={{ color, "--runner-phase": `${(id.charCodeAt(0) % 5) * -0.08}s` } as React.CSSProperties}>
    {rest ? <g className="runner-rest"><ellipse className="runner-shadow" cx="-2" cy="0" rx="27" ry="2"/><path className="runner-rest-left-leg" d="M-14 -9 L-19 -4 L-33 -6"/><path className="runner-rest-right-leg" d="M-15 -9 L-24 -18 L-25 -7"/><path className="runner-rest-body runner-rest-torso" d="M-13 -9 L-1 -9 L7 -15"/><path className="runner-rest-right-arm" d="M4 -13 L-1 -16 L-13 -13"/><path className="runner-rest-left-arm" d="M4 -12 L9 -4 L16 -9 L19 -8"/><circle className="runner-rest-head runner-head" cx="16" cy="-24" r="12"/><text className="runner-rest-sleep" x="27" y="-37">💤</text></g> : dash && !goal ? <g className="runner-dash"><ellipse className="runner-shadow" cx="0" cy="29" rx="20" ry="2"/><g className="runner-dash-speed"><path d="M-33 -13 h10 M-35 -5 h12 M-32 3 h9"/></g><circle className="runner-dash-head runner-head" cx="11" cy="-43" r="15"/><path d="M6 -28 L-4 -8"/><path className="runner-dash-arm" d="M4 -24 L-11 -26 L-21 -17 M2 -22 L16 -15 L22 -20"/><path className="runner-dash-leg" d="M-4 -8 L-17 11 L-27 7 M-4 -8 L11 8 L25 24"/></g> : <>
    {!goal && <ellipse className="runner-shadow" cx="3" cy="28" rx="19" ry="2"/>}
    <g className="runner-body">
      <g className="runner-head-motion"><circle className="runner-head" cx="0" cy="-43" r="17"/></g><line x1="0" y1="-26" x2="2" y2="-5"/>
      {goal ? <>
        <g className="runner-goal-arm-left"><path d="M0 -17 L-16.8 -16.3 L-27.945 -24.887"/></g>
        <g className="runner-goal-arm-right"><path d="M1 -17 L17.8 -16.3 L28.945 -24.887"/></g>
        <path className="runner-goal-grounded-leg" d="M2 -5 L-10 26"/>
        <path className="runner-goal-kicked-leg" d="M2 -5 L14 13 L24 5"/>
      </> : <>
        <g className="runner-arm runner-arm-left"><line x1="0" y1="-17" x2="-18" y2="-17"/></g>
        <g className="runner-arm runner-arm-right"><line x1="1" y1="-17" x2="19" y2="-17"/></g>
        <g className="runner-leg runner-leg-left"><line x1="2" y1="-5" x2="2" y2="25"/></g>
        <g className="runner-leg runner-leg-right"><line x1="2" y1="-5" x2="2" y2="25"/></g>
      </>}
    </g>
    {goal ? <g className="runner-joy-rays">
      {[-22, -13, 0, 13, 22].map((x, index) => <path key={x} className={`runner-joy-ray runner-joy-ray-${index + 1}`} d={index === 2 ? "M0 -63 v-3" : `M${x} ${index === 0 || index === 4 ? -58 : -62} l${x < 0 ? -3 : 3} ${index === 0 || index === 4 ? -2 : -3}`}/>)}
    </g> : <g className="runner-sweat">
      {[0, 1, 2].map(index => <path key={index} className="runner-sweat-drop" d="M-23,-55 C-20,-58 -17,-58 -14,-55 C-12,-52 -14,-49 -18,-49 C-21,-49 -24,-52 -23,-55 Z"/>)}
    </g>}
    </>}
  </svg>;
}

export const HostRace = memo(function HostRace({ roomId, participants, mode, maxScore, questionCount = maxScore, active, pace, remainingText, interruptButton }: { roomId: string; participants: ParticipantState[]; mode: RaceMode; maxScore: number; questionCount?: number; active: boolean; pace: 0 | 1 | 2 | 3; remainingText: string; interruptButton: ReactNode }) {
  const motionKey = "ionic-formula-competition:race-motion:v1";
  const previous = useRef<string[]>([]);
  const [motionChoice, setMotionChoice] = useState<RaceMotionChoice>("auto");
  const light = effectiveRaceMotion(motionChoice, false) === "light";
  const [mounted, setMounted] = useState(false);
  const [fieldHeight, setFieldHeight] = useState(560);
  const [visibleIndex, setVisibleIndex] = useState(0);
  const [manual, setManual] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dashIds, setDashIds] = useState<Set<string>>(() => new Set());
  const dashUntil = useRef(new Map<string, number>());
  const lastCounts = useRef(new Map<string, number>());
  const fieldRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  const autoTargetRef = useRef("");
  const capacity = raceCapacity(fieldHeight);
  const laneHeight = Math.max(54, Math.min(88, Math.floor((fieldHeight - 20) / capacity)));
  useEffect(() => {
    if (!dashIds.size) return;
    const next = Math.min(...dashUntil.current.values());
    const timer = setTimeout(() => {
      const now = performance.now();
      for (const [id, until] of dashUntil.current) if (until <= now) dashUntil.current.delete(id);
      setDashIds(new Set(dashUntil.current.keys()));
    }, Math.max(0, next - performance.now()));
    return () => clearTimeout(timer);
  }, [dashIds]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const resize = () => setFieldHeight(Math.max(1, field.clientHeight));
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(field);
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.visualViewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => {
    try { setMotionChoice(localStorage.getItem(motionKey) === "light" ? "light" : "normal"); } catch { setMotionChoice("normal"); }
    setMounted(true);
  }, []);
  const chooseMotion = (choice: "normal" | "light") => {
    setMotionChoice(choice);
    try { localStorage.setItem(motionKey, choice); } catch { /* optional preference */ }
  };
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const colors = useMemo(() => new Map(participants.map((participant, index) => [participant.id, colorForRunner(roomId, participant.joinedOrder ?? index + 1)])), [roomId, participants]);
  const rows = useMemo(() => raceRows(participants, mode, previous.current, participants.length), [participants, mode]);
  useEffect(() => {
    previous.current = rows.map(row => row.id);
    if (active && !hidden) {
      const increased = increasedRaceIds(participants, lastCounts.current, mode);
      if (increased.length) {
        const until = performance.now() + 650;
        for (const id of increased) dashUntil.current.set(id, until);
        setDashIds(new Set(dashUntil.current.keys()));
      }
    }
    lastCounts.current = new Map(participants.map(participant => [participant.id, raceCount(participant, mode)]));
  }, [rows, participants, mode, active, hidden]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (manual) {
      const anchor = anchorRef.current;
      const index = anchor ? rows.findIndex(row => row.id === anchor.id) : -1;
      if (index >= 0) field.scrollTop = Math.max(0, index * laneHeight + anchor!.offset);
      return;
    }
    const target = raceFollowStart(rows, mode, maxScore, capacity);
    const key = `${target}:${laneHeight}`;
    if (autoTargetRef.current === key) return;
    autoTargetRef.current = key;
    const top = target * laneHeight;
    const distance = Math.abs(field.scrollTop - top);
    field.scrollTo({ top, behavior: light || distance > fieldHeight ? "auto" : "smooth" });
  }, [rows, mode, maxScore, capacity, laneHeight, fieldHeight, manual, light]);

  useEffect(() => () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); }, []);

  const markManual = () => {
    if (manual) return;
    const field = fieldRef.current;
    if (field) {
      const index = Math.floor(field.scrollTop / laneHeight);
      anchorRef.current = rows[index] ? { id: rows[index].id, offset: field.scrollTop - index * laneHeight } : null;
    }
    setManual(true);
  };
  const onScroll = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const field = fieldRef.current;
      if (!field) return;
      const index = Math.min(Math.max(0, rows.length - 1), Math.floor(field.scrollTop / laneHeight));
      setVisibleIndex(old => old === index ? old : index);
      if (manual && rows[index]) anchorRef.current = { id: rows[index].id, offset: field.scrollTop - index * laneHeight };
    });
  };

  const total = rows.length;
  const range = raceVisibleRange(visibleIndex * laneHeight, laneHeight, fieldHeight, total);
  const draw = (row: RaceRow, index: number) => {
    const maximum = mode === "deferred" ? questionCount : maxScore;
    const progress = raceProgress(row, mode, maximum);
    const goal = isRaceGoal(row, mode, maxScore);
    const rest = mode === "deferred" && row.submitted === true;
    const dash = dashIds.has(row.id) && active && !hidden && !goal && !rest;
    const ended = mode === "immediate" && row.status === "FINISHED" && !goal;
    const stopped = !active || ended;
    const phase = `${mode === "deferred" ? "進捗" : "正解"} ${row.count} / ${maximum}`;
    return <div key={row.id} className="race-lane" style={{ height: laneHeight, transform: `translateY(${index * laneHeight}px)` }}>
      <div className="race-label" style={{ fontSize: `max(18px, ${24 * raceScale(row.rank)}px)` }}><strong>{row.rank}位</strong><span title={row.nickname}>{row.nickname}</span><small>{phase}{row.submitted && mode === "deferred" ? "・提出済み" : ended && active ? "・解答終了" : ""}</small></div>
      <div className="race-track"><div className="race-start"/><div className="race-goal"/><div className={`race-position ${dash && !light ? "is-accelerating" : ""}`} style={{ transform: `translateX(${progress * 100}%)` }}><div className="race-size" style={{ scale: raceScale(row.rank) }}>{goal && <span className="race-ground-shadow" aria-hidden="true"/>}<div className={`race-jump ${goal && !stopped && !light && !hidden ? "is-celebrating" : ""}`}><Runner id={row.id} color={colors.get(row.id)} goal={goal} rest={rest} dash={dash} stopped={stopped || light || hidden}/></div></div></div></div>
    </div>;
  };
  return <section className={`host-race race-pace-${pace} ${light ? "is-light" : ""} ${!mounted ? "is-initial" : ""}`} aria-label="参加者の進捗">
    <div className="race-topbar"><div className="race-note"><strong>{mode === "deferred" ? "解答進捗順" : "暫定順位"}</strong>{mode === "deferred" && <small>成績順位ではありません</small>}<span>表示 {total ? visibleIndex + 1 : 0}～{Math.min(total, visibleIndex + capacity)} / {total}人</span></div><div className="race-top-actions">{manual && <button type="button" className="race-follow-button" onClick={() => { autoTargetRef.current = ""; setManual(false); }}>手動表示中・自動追尾に戻る</button>}<span className="race-timer">残り <strong>{remainingText}</strong></span>{interruptButton}<span>表示：{light ? "軽量" : "通常"}</span><button className="race-motion-toggle" type="button" aria-pressed={light} title="軽量表示では棒人間と💤の動きが止まります" onClick={() => chooseMotion(light ? "normal" : "light")}>{light ? "通常表示にする" : "軽量表示にする"}</button></div></div>
    <div className="race-header"><span aria-hidden="true"/><span>START</span><span>GOAL</span></div>
    <div ref={fieldRef} className="race-field" tabIndex={0} aria-label="参加者の順位一覧。上下にスクロールできます" onScroll={onScroll} onWheel={markManual} onTouchMove={markManual} onPointerDown={event => { if (event.pointerType === "mouse") markManual(); }} onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) markManual(); }}>
      <div className="race-content" style={{ height: 20 + total * laneHeight }}>
        {rows.slice(range.start, range.end).map((row, index) => draw(row, range.start + index))}
      </div>
    </div>
  </section>;
});
