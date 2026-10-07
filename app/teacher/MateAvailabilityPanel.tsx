import { apiFetch } from '../../src/web/api';
"use client";
import { useEffect, useState } from "react";
import { patchJson } from "../../src/features/play/useRoomSync";
type Settings = { enabled: boolean; revision: number };
export function MateAvailabilityPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const reload = async () => {
    const response = await apiFetch("/api/teacher/site-settings", { cache: "no-store" });
    if (!response.ok) throw new Error("設定を取得できませんでした");
    setSettings(await response.json() as Settings);
  };
  useEffect(() => { void reload().catch(() => setMessage("設定を取得できませんでした")); }, []);
  const update = async () => {
    if (!settings || busy) return;
    setBusy(true); setMessage("保存しています…");
    try { const next = await patchJson("/api/teacher/site-settings", { enabled: !settings.enabled, expectedRevision: settings.revision, requestId: crypto.randomUUID() }); setSettings(next); setMessage("設定を保存しました"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存できませんでした"); try { await reload(); } catch { /* Show the original failure. */ } }
    finally { setBusy(false); }
  };
  return <section className="teacher-admin-card mate-availability-card" aria-labelledby="mate-availability-title">
    <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">⇄</span><div><p className="teacher-card-kicker">参加の管理</p><h2 id="mate-availability-title">メイトマッチの作成</h2></div></div>
    <p>生徒が新しいメイトマッチを作れるかを設定します。</p>
    <div className="teacher-availability-control"><div><strong>{settings ? settings.enabled ? "新規作成を許可中" : "新規作成を停止中" : "設定を確認中…"}</strong><span>既存のルームはそのまま続行できます。</span></div><button type="button" className="teacher-switch" role="switch" aria-label="メイトマッチの新規作成を許可" aria-checked={settings?.enabled ?? false} disabled={busy || !settings} onClick={() => void update()}><span className="teacher-switch-track" aria-hidden="true"><span className="teacher-switch-thumb"/></span><span>{settings?.enabled ? "ON" : "OFF"}</span></button></div>
    {message && <p className="teacher-feedback" role="status">{message}</p>}
    {!settings && <button type="button" className="teacher-text-action" disabled={busy} onClick={() => void reload().catch(() => setMessage("設定を取得できませんでした"))}>もう一度読み込む</button>}
  </section>;
}
