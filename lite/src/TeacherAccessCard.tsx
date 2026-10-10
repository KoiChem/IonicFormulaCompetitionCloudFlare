import {useEffect, useState} from 'react';
import {teacherMutation, type TeacherSession} from './teacher-auth';
type Allowlist = {emails: string[]; masterEmail: string};
export function TeacherAccessCard({session, onExpired}: {session: TeacherSession; onExpired(): void}) {
  const [list, setList] = useState<Allowlist | null>(null), [email, setEmail] = useState(''), [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const failure = (e: unknown) => {if ((e as {status?: number}).status === 401) onExpired(); else setError(e instanceof Error ? e.message : '教員を確認できません');};
  useEffect(() => {
    let live = true;
    void fetch('/api/teacher/allowlist', {cache: 'no-store'}).then(async response => {
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error), {status: response.status});
      if (live) {setList(data); setError('');}
    }).catch(e => {if (live) failure(e);});
    return () => {live = false;};
  }, [retry]);
  const update = async (method: 'POST' | 'DELETE', target: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {setList(await teacherMutation<Allowlist>('/api/teacher/allowlist', method, session, {email: target})); if (method === 'POST') setEmail('');}
    catch (e) {failure(e);} finally {setBusy(false);}
  };
  const filtered = list?.emails.filter(value => value.includes(search.trim().toLowerCase())) ?? [];
  return <section className="teacher-admin-card teacher-access-card" aria-labelledby="teacher-access-title">
    <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">＋</span><div><p className="teacher-card-kicker">アクセスの管理</p><h2 id="teacher-access-title">許可教員の管理</h2></div><span className="teacher-count-badge">{list?.emails.length ?? '—'} / 100人</span></div>
    <p>登録したGoogleアカウントで、クラスコンペを作成できます。</p>
    <form className="teacher-invite-form" onSubmit={e => {e.preventDefault(); void update('POST', email);}}><label htmlFor="teacher-email">教員のメールアドレス</label><div className="teacher-invite-row"><input id="teacher-email" type="email" autoComplete="email" placeholder="teacher@example.com" maxLength={254} required value={email} disabled={busy || !list} onChange={e => setEmail(e.target.value)}/><button type="submit" className="teacher-add-action" disabled={busy || !list || !email.trim()}>登録する</button></div></form>
    <div className="teacher-roster-heading"><h3>登録済みの教員</h3><button type="button" className="teacher-text-action" disabled={busy} onClick={() => setRetry(value => value + 1)}>再読み込み</button></div>
    {list && list.emails.length > 0 && <label className="lite-teacher-search">教員を検索<input type="search" value={search} onChange={e => setSearch(e.target.value)}/></label>}
    <div className="teacher-roster" aria-busy={!list || busy}>{!list ? <p role="status">教員を確認しています…</p> : filtered.length === 0 ? <p className="teacher-empty-state">{search.trim() ? '該当する教員はいません。' : '許可教員はまだ登録されていません。'}</p> : <ul className="lite-teacher-list">{filtered.map(value => <li key={value}><span>{value}</span><button type="button" className="teacher-text-action" aria-label={`${value}の登録を解除`} disabled={busy} onClick={() => {if (window.confirm(`${value} の教員登録を解除しますか？`)) void update('DELETE', value);}}>解除</button></li>)}</ul>}</div>
    {error && <p role="alert" className="error">{error}</p>}
    <p className="teacher-master-identity">マスター教員<span>{list?.masterEmail ?? session.identity?.email}</span></p>
  </section>;
}
