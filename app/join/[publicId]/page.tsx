import { appPath } from '../../../src/web/routing';
"use client";

import { useEffect, useRef, useState } from "react";
import { rememberHistoryRoom } from "../../../src/features/results/history-index";
import { loadSavedNickname, saveNickname } from "../../../src/features/setup/saved-nickname";
import { clearPendingJoin, clearPreviousParticipantSession, beginPendingJoin, completePendingJoin, loadPendingJoin, reentryNicknameKey, type PendingJoin } from "../../../src/features/setup/join-draft";
import { fetchJsonWithTimeout, loadCredential, randomCredential } from "../../../src/features/play/useRoomSync";
import { submitPendingJoin } from "../../../src/features/setup/join-recovery";
import { recoveryDestination, type RecoveryDestination } from "../../../src/features/play/active-room-recovery";
import { settingsSummary } from "../../../src/features/setup/CompetitionSettingsForm";
import type { IonicFormulaGameSettings } from "../../../src/games/ionic-formula/shared/types";

type JoinInfo = { room: { kind: "class" | "mate"; state: string; settings: IonicFormulaGameSettings }; participantCount: number; capacity: number };

export default function JoinPage({ roomId }: { roomId: string }) {
  const [nickname, setNickname] = useState("");
  const [pending, setPending] = useState<PendingJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [recovery, setRecovery] = useState<{ destination: RecoveryDestination; state: string } | null>(null);
  const [recoveryChecking, setRecoveryChecking] = useState(true);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryRevision, setRecoveryRevision] = useState(0);

  useEffect(() => {
    let live = true;
    const credential = loadCredential(roomId);
    if (!credential?.token || !credential.participantId) { setRecoveryChecking(false); return; }
    setRecoveryChecking(true); setRecoveryError("");
    void fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/state`, {
      cache: "no-store", headers: { authorization: `Bearer ${credential.token}` },
    }, 10_000).then((body: { room?: { state?: string }; participant?: { id?: string } }) => {
      if (!live) return;
      if (body.participant?.id === credential.participantId && body.room?.state) {
        setRecovery({ state: body.room.state, destination: recoveryDestination(body.room.state) });
      } else setRecovery(null);
    }).catch((reason: { code?: string; message?: string; details?: { canRejoin?: boolean; nickname?: string } }) => {
      if (!live) return;
      if (reason.code === "participant_removed" && reason.details?.canRejoin) {
        setRecovery(null);
        if (reason.details.nickname) setNickname(reason.details.nickname);
        return;
      }
      if (["participant_removed", "expired", "not_found"].includes(reason.code ?? "")) {
        setRecovery({ destination: "none", state: reason.code ?? "" });
      } else setRecoveryError(reason.message ?? "参加状況を確認できませんでした");
    }).finally(() => { if (live) setRecoveryChecking(false); });
    return () => { live = false; };
  }, [roomId, recoveryRevision]);

  useEffect(() => {
    const draft = loadPendingJoin(localStorage, roomId);
    setPending(draft);
    if (draft) setNickname(draft.nickname);
    else {
      let reentryName = "";
      try { reentryName = sessionStorage.getItem(reentryNicknameKey(roomId)) ?? ""; } catch { /* no saved preset */ }
      setNickname(reentryName || loadSavedNickname(localStorage));
    }
  }, [roomId]);

  useEffect(() => {
    let active = true;
    fetchJsonWithTimeout(`/api/join-info?publicId=${encodeURIComponent(roomId)}`, { cache: "no-store" }, 10_000)
      .then(body => { if (active) setInfo(body); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "通信に失敗しました"); });
    return () => { active = false; };
  }, [roomId]);

  const join = async () => {
    if (busyRef.current || !info) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    let draft: PendingJoin;
    try {
      draft = beginPendingJoin(localStorage, roomId, nickname.trim(), randomCredential, () => crypto.randomUUID());
      setPending(draft);
    } catch {
      setError("この端末に参加要求を保存できません。空き容量やブラウザー設定を確認してください。");
      busyRef.current = false;
      setBusy(false);
      return;
    }
    try {
      const body = await submitPendingJoin(roomId, draft);
      if (!completePendingJoin(localStorage, roomId, draft, body.participant.id)) throw new Error("参加資格を保存できません。もう一度確認してください");
      saveNickname(localStorage, body.participant.nickname);
      try { clearPreviousParticipantSession(sessionStorage, roomId); sessionStorage.removeItem(reentryNicknameKey(roomId)); } catch { /* session data may be unavailable */ }
      rememberHistoryRoom(localStorage, { roomId, role: "participant", kind: info.room.kind, createdAtMs: Date.now(), settings: info.room.settings });
      location.href = appPath(`/rooms/${encodeURIComponent(roomId)}`);
    } catch (reason) {
      const failure = reason as { status?: number; code?: string; message?: string };
      if (failure.status && failure.status < 500 && failure.status !== 408 && failure.status !== 429 && failure.code !== "database_conflict") {
        clearPendingJoin(localStorage, roomId);
        setPending(null);
        if (failure.code === "invalid_state") setInfo(current => current ? { ...current, room: { ...current.room, state: "CLOSED" } } : current);
        if (failure.code === "capacity") setInfo(current => current ? { ...current, participantCount: current.capacity } : current);
      }
      setError(failure.code === "conflict" ? "このニックネームはすでに使われています" : failure.message ?? "通信に失敗しました。同じ参加要求でもう一度確認してください");
      busyRef.current = false;
      setBusy(false);
    }
  };

  const canSubmit = !!info && !recoveryChecking && !recoveryError && !recovery && !!nickname.trim() && (pending !== null || (info.room.state === "WAITING" && info.participantCount < info.capacity));
  return <main className="page-shell"><section className="panel"><p className="eyebrow">JOIN</p><h1>競技に参加</h1>
    {recoveryChecking && <p role="status">参加資格を確認しています…</p>}
    {recoveryError && <p role="alert">{recoveryError}<button type="button" onClick={() => setRecoveryRevision(value => value + 1)}>参加状況を再確認</button></p>}
    {recovery?.destination === "room" && <div className="recovery-panel"><h2>参加中の競技があります</h2><a className="primary-link" href={appPath(`/rooms/${encodeURIComponent(roomId)}`)}>参加中の競技に戻る</a></div>}
    {recovery?.destination === "results" && <div className="recovery-panel"><p>競技は終了しました。</p><a className="primary-link" href={appPath(`/rooms/${encodeURIComponent(roomId)}`)}>結果を見る</a></div>}
    {recovery?.destination === "none" && <p role="status">この参加資格では競技に戻れません。</p>}
    {!recovery && !recoveryChecking && !recoveryError && <>
    {info ? <div className="join-info"><p>{info.room.kind === "class" ? "クラスコンペ" : "メイトマッチ"}</p><p>{settingsSummary(info.room.settings)}</p><p>参加 {info.participantCount}人</p></div> : <p role="status">{error || "ルーム情報を確認しています…"}</p>}
    {!info && error && <button type="button" onClick={() => { setError(""); void fetchJsonWithTimeout(`/api/join-info?publicId=${encodeURIComponent(roomId)}`, { cache: "no-store" }, 10_000).then(body => setInfo(body as JoinInfo)).catch(reason => setError(reason instanceof Error ? reason.message : "通信に失敗しました")); }}>参加先を再確認</button>}
    {info && info.room.state !== "WAITING" ? <p role="status">参加受付は終了しました。</p> : null}
    {info && info.participantCount >= info.capacity ? <p role="status">定員に達しました。</p> : null}
    <p>ニックネームだけを使います。本名や個人情報は入力しないでください。</p>
    <label htmlFor="nickname">ニックネーム（1〜16文字）</label>
    <input id="nickname" value={nickname} maxLength={16} autoComplete="nickname" disabled={!!pending || busy} onChange={event => setNickname(event.target.value)} />
    {pending ? <p role="status">前回の参加要求を確認します。確認後に名前を変更できます。</p> : null}
    <button className="primary-action" disabled={busy || !canSubmit} onClick={() => void join()}>{busy ? "参加を確認中…" : pending ? "参加を再確認" : "参加する"}</button>
    {error ? <p className="error" role="alert">{error}</p> : null}
    </>}
    <a className="primary-link" href={appPath("/")}>ホームへ戻る</a>
  </section></main>;
}
