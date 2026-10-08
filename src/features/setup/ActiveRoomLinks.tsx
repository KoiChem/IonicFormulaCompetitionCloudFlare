import { appPath } from '../../web/routing';
"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { discoverHistoryCandidates } from "../results/history-index";
import { recoveryDestination } from "../play/active-room-recovery";
import { fetchJsonWithTimeout, loadCredential } from "../play/useRoomSync";

type ActiveRoom = { id: string; kind: "class" | "mate"; state: string; createdAtMs?: number };

export function ActiveRoomLinks() {
  const [rooms, setRooms] = useState<ActiveRoom[]>([]);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    let candidates: ReturnType<typeof discoverHistoryCandidates> = [];
    try { candidates = discoverHistoryCandidates(localStorage).filter(candidate => candidate.role === "participant"); } catch { /* storage unavailable */ }
    setRooms([]); setFailed(false);
    if (!candidates.length) return;
    setChecking(true);
    const queue = [...candidates];
    const found: ActiveRoom[] = [];
    let anyFailure = false;
    const worker = async () => {
      while (queue.length && live) {
        const candidate = queue.shift()!;
        const credential = loadCredential(candidate.roomId);
        if (!credential?.token || !credential.participantId) continue;
        try {
          const body = await fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(candidate.roomId)}/state`, {
            cache: "no-store", headers: { authorization: `Bearer ${credential.token}` },
          }, 10_000) as { room?: { state?: string; kind?: "class" | "mate" }; participant?: { id?: string } };
          if (body.participant?.id !== credential.participantId || !body.room?.state || recoveryDestination(body.room.state) !== "room") continue;
          found.push({ id: candidate.roomId, kind: body.room.kind === "mate" ? "mate" : "class", state: body.room.state, createdAtMs: candidate.createdAtMs });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (!code || !["participant_removed", "expired", "not_found"].includes(code)) anyFailure = true;
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker)).then(() => {
      if (!live) return;
      setRooms(found.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)));
      setFailed(anyFailure); setChecking(false);
    });
    return () => { live = false; };
  }, [revision]);
  const statusTarget = checking ? document.getElementById("home-participation-status") : null;
  return <>
    {checking && statusTarget && createPortal(<p role="status">参加状況を確認しています…</p>, statusTarget)}
    {(rooms.length > 0 || (failed && !checking)) && <section className="active-room-links" aria-label="参加中の競技">
    {rooms.length > 0 && <><h2>参加中の競技</h2><ul>{rooms.map(room => <li key={room.id}><span>{room.kind === "mate" ? "メイトマッチ" : "クラスコンペ"}</span><a className="primary-link" href={appPath(`/rooms/${encodeURIComponent(room.id)}`)}>参加中の競技に戻る</a></li>)}</ul></>}
    {failed && !checking && <button type="button" onClick={() => setRevision(value => value + 1)}>参加状況を再確認</button>}
  </section>}
  </>;
}
