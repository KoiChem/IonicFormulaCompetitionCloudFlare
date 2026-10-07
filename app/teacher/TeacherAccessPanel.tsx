import { apiFetch } from '../../src/web/api';
"use client";
import { useEffect, useState } from "react";
import { postJson } from "../../src/features/play/useRoomSync";

type Allowlist = { masterEmail: string; emails: string[]; revision: number };
export function TeacherAccessPanel() {
  const [list, setList] = useState<Allowlist | null>(null);
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => {
    const response = await apiFetch("/api/teacher/allowlist", { cache: "no-store" });
    const body = await response.json() as Allowlist & { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "一覧を取得できませんでした");
    setList(body);
  };
  useEffect(() => { void refresh().catch(error => setMessage(error.message)); }, []);
  const update = async (address: string, enabled: boolean) => {
    if (!list || busy) return;
    setBusy(true); setMessage("");
    try {
      const body = await postJson("/api/teacher/allowlist", { email: address, enabled, expectedRevision: list.revision, requestId: crypto.randomUUID() });
      setList(body);
      if (enabled) setEmail("");
      setMessage(enabled ? "教員を登録しました。" : "教員の許可を解除しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新できませんでした");
      try { await refresh(); } catch { /* Preserve the error and permit explicit refresh. */ }
    } finally { setBusy(false); }
  };
  const visibleEmails = list?.emails.filter(address => address.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <section className="teacher-admin-card teacher-access-card" aria-labelledby="teacher-access-title">
    <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">＋</span><div><p className="teacher-card-kicker">アクセスの管理</p><h2 id="teacher-access-title">許可教員の管理</h2></div><span className="teacher-count-badge">{list ? `${list.emails.length} / 100人` : "確認中"}</span></div>
    <p>登録したGoogleアカウントで、クラスコンペを作成できます。</p>
    <form className="teacher-invite-form" onSubmit={event => { event.preventDefault(); void update(email, true); }}>
      <label htmlFor="teacher-email">教員のメールアドレス</label><div className="teacher-invite-row"><input id="teacher-email" type="email" autoComplete="email" placeholder="teacher@example.com" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} disabled={busy || !list}/><button type="submit" className="teacher-add-action" disabled={busy || !list}>登録する</button></div>
    </form>
    <div className="teacher-roster-heading"><h3>登録済みの教員</h3><button type="button" className="teacher-text-action" disabled={busy} onClick={() => { setBusy(true); void refresh().catch(error => setMessage(error.message)).finally(() => setBusy(false)); }}>再読み込み</button></div>
    {list && (list.emails.length > 5 || search.length > 0) && <label className="teacher-roster-search">メールアドレスで検索<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>}
    <div className="teacher-roster" aria-busy={busy}>
      {list ? visibleEmails.length ? <ul>{visibleEmails.map(address => <li key={address}><span className="teacher-avatar" aria-hidden="true">{address[0]?.toUpperCase()}</span><span className="teacher-roster-email">{address}</span><button type="button" className="teacher-revoke-action" disabled={busy} aria-label={`${address}の許可を解除`} onClick={() => { if (window.confirm(`${address} の教員権限を解除しますか？作成済みのルームも操作できなくなります。`)) void update(address, false); }}>解除</button></li>)}</ul> : <p className="teacher-empty-state">{search ? "一致する教員はいません。" : "許可教員はまだ登録されていません。"}</p> : <p className="teacher-empty-state">一覧を取得中…</p>}
    </div>
    {list && <p className="teacher-master-identity">管理者教員<span>{list.masterEmail}</span></p>}
    {message && <p className="teacher-feedback" role="status">{message}</p>}
  </section>;
}
