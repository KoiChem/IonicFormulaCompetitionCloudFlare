import { appPath } from '../../web/routing';
"use client";
import { useCallback, useState } from "react";
import { isValidJoinCode, normalizeJoinCode } from "./join-code";

import { JoinQrScanner } from "./JoinQrScanner";
import type { JoinQrTarget } from "./join-qr";

export function JoinCodeForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const closeScanner = useCallback(() => setScanning(false), []);
  const readQr = useCallback((target: JoinQrTarget) => {
    setScanning(false); setError("");
    if ('code' in target) window.location.assign(appPath(`/join?code=${encodeURIComponent(target.code)}`));
    else window.location.assign(appPath(`/join/${encodeURIComponent(target.roomId)}`));
  }, []);
  return <form className="join-form" onSubmit={event => {
    event.preventDefault();
    if (!isValidJoinCode(code)) { setError("参加コードは6文字で入力してください"); return; }
    window.location.assign(appPath(`/join?code=${encodeURIComponent(normalizeJoinCode(code))}`));
  }}>
    <label htmlFor="code">参加コード</label>
    <div className="join-row"><div className="join-entry"><button type="button" className="qr-button" aria-label="参加用QRコードを読み取る" title="QRコードを読み取る" onClick={() => { setScanning(true); }}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 2H2v5M17 2h5v5M22 17v5h-5M7 22H2v-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path fill="currentColor" fillRule="evenodd" d="M5 5h6v6H5V5Zm2 2v2h2V7H7Zm6-2h6v6h-6V5Zm2 2v2h2V7h-2ZM5 13h6v6H5v-6Zm2 2v2h2v-2H7Z"/><path fill="currentColor" d="M13 13h2v2h-2zm4 0h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2z"/></svg></button><input id="code" name="code" inputMode="text" autoComplete="off" value={code} onChange={event => { setCode(event.target.value); setError(""); }} required /></div><button type="submit">参加する</button></div>
    {scanning && <JoinQrScanner onRead={readQr} onClose={closeScanner} />}
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
