import { appPath, routeSearch } from '../../src/web/routing';
"use client";
import { useEffect, useRef, useState } from "react";
import { isValidJoinCode, normalizeJoinCode } from "../../src/features/setup/join-code";
import { fetchJsonWithTimeout } from "../../src/features/play/useRoomSync";

export default function CodeJoinPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const resolving = useRef(false);
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const supplied = new URLSearchParams(routeSearch()).get("code");
    if (!supplied) return;
    const normalized = normalizeJoinCode(supplied);
    setCode(normalized);
    if (isValidJoinCode(normalized)) void resolve(normalized);
    else setError("参加コードは6文字で入力してください");
  }, []);
  const resolve = async (value = code) => {
    if (resolving.current) return;
    resolving.current = true;
    const current = ++sequence.current;
    setBusy(true); setError("");
    try {
      const body = await fetchJsonWithTimeout(`/api/join-info?code=${encodeURIComponent(normalizeJoinCode(value))}`, { cache: "no-store" }, 10_000) as { room?: { id: string } };
      if (current !== sequence.current) return;
      if (!body.room?.id) throw new Error("参加先を確認できません");
      window.location.replace(appPath(`/join/${encodeURIComponent(body.room.id)}`));
    } catch (reason) { if (current === sequence.current) setError(reason instanceof Error ? reason.message : "通信に失敗しました。もう一度お試しください"); }
    finally { if (current === sequence.current) { resolving.current = false; setBusy(false); } }
  };
  return <main className="page-shell"><section className="panel"><h1>参加コードを入力</h1><label htmlFor="join-code">6文字の参加コード</label><input id="join-code" value={code} onChange={(event) => { sequence.current += 1; resolving.current = false; setBusy(false); setError(""); setCode(normalizeJoinCode(event.target.value)); }} /><button className="primary-action" disabled={busy || !isValidJoinCode(code)} onClick={() => void resolve()}>{busy ? "確認中…" : "ルームを確認"}</button>{error ? <p role="alert" className="error">{error}</p> : null}</section></main>;
}
