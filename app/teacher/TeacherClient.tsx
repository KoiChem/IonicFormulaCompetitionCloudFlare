import { appPath } from '../../src/web/routing';
import { apiFetch } from '../../src/web/api';
"use client";
import { rememberHistoryRoom } from "../../src/features/results/history-index";
import { useEffect, useState } from "react";
import { CompetitionSettingsForm, DEFAULT_SETTINGS } from "../../src/features/setup/CompetitionSettingsForm";
import { postJson } from "../../src/features/play/useRoomSync";
import { ReturnHomeButton } from "../../src/features/setup/ReturnHomeButton";

import { TeacherManagement } from "./TeacherManagement";

const DRAFT_KEY = "ionic-formula-competition:class-create-request";
export function TeacherClient() {
  const [view, setView] = useState<"class" | "management">("class");
  const [master, setMaster] = useState(false);
  useEffect(() => { let active = true; void apiFetch("/api/teacher/session", { cache: "no-store" }).then(async response => response.ok ? await response.json() as { role?: string } : null).then(session => { if (active) setMaster(session?.role === "master"); }).catch(() => {}); return () => { active = false; }; }, []);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [pendingDraft, setPendingDraft] = useState(false);
  useEffect(() => { try { const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null"); if (draft?.settings) { setSettings(draft.settings); setPendingDraft(true); } } catch {} }, []);
  const create = async () => { setBusy(true); setError(""); const fresh = { requestId: crypto.randomUUID(), settings }; let draft: typeof fresh; try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") ?? fresh; } catch { draft = fresh; } localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); try { const body = await postJson("/api/class-rooms", draft); const id = body.room.id; localStorage.setItem(`ionic-formula-competition:meta:${id}`, JSON.stringify({ joinCode: body.room.joinCode })); rememberHistoryRoom(localStorage, { roomId: id, role: "teacher", kind: "class", createdAtMs: Date.now(), settings: draft.settings }); localStorage.removeItem(DRAFT_KEY); location.href = appPath(`/rooms/${encodeURIComponent(id)}`); } catch (e: any) { if (e.status && e.status < 500 && e.code !== "database_conflict") { localStorage.removeItem(DRAFT_KEY); setPendingDraft(false); } else { setSettings(draft.settings); setPendingDraft(true); } setError(e.message); setBusy(false); } };
  return <main className="page-shell teacher-setup">
    <section className="panel wide teacher-workspace">
      <header className="teacher-workspace-header">
        <div className="teacher-workspace-heading"><p className="eyebrow">TEACHER</p><h1>{view === "class" ? "クラスコンペを作る" : "教員用の管理設定"}</h1><p className="teacher-workspace-intro">{view === "class" ? "条件を選んで、クラスのコンペを始めましょう。" : "教員のアクセスと、アプリ全体の出題を管理します。"}</p></div>
        {master && <div className="teacher-workspace-navigation"><span className="teacher-role-badge">管理者教員</span><div className="teacher-view-switch" role="group" aria-label="教員ページの表示"><button type="button" disabled={busy} aria-pressed={view === "class"} onClick={() => setView("class")}>クラスコンペ</button><button type="button" disabled={busy} aria-pressed={view === "management"} onClick={() => setView("management")}>管理設定</button></div></div>}
      </header>
      <div hidden={view !== "class"} className="teacher-class-content">
        {pendingDraft && <p className="notice">前回の作成結果を確認します。設定は変更できません。</p>}
        <CompetitionSettingsForm value={settings} onChange={setSettings} disabled={busy || pendingDraft}/>
        <div className="teacher-setup-actions"><button className="primary-action" disabled={busy} onClick={create}>{busy ? "作成を確認中…" : pendingDraft ? "作成結果を再確認" : "クラスルームを作る"}</button><ReturnHomeButton disabled={busy}/></div>
        {error ? <p role="alert" className="error">{error}</p> : null}
      </div>
      {master && <div hidden={view !== "management"} className="teacher-admin-content"><TeacherManagement/><div className="teacher-management-footer"><button type="button" className="secondary-button" onClick={() => setView("class")}>クラスコンペの設定に戻る</button></div></div>}
    </section>
  </main>;
}
