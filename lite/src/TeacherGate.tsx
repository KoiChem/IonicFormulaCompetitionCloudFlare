import {useEffect, useState, type ReactNode} from 'react';
import {readTeacherSession, teacherMutation, type TeacherSession} from './teacher-auth';

export function TeacherGate({children}: {children(session: TeacherSession, refresh: () => void, logout: () => Promise<void>): ReactNode}) {
  const [session, setSession] = useState<TeacherSession | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const refresh = () => {setSession(null); setError(''); setRetry(value => value + 1);};
  useEffect(() => {
    let live = true;
    void readTeacherSession().then(value => {if (live) setSession(value);}).catch(e => {if (live) setError(e.message);});
    return () => {live = false;};
  }, [retry]);
  const logout = async () => {
    if (!session) return;
    try {await teacherMutation('/api/auth/logout', 'POST', session); refresh();}
    catch (e) {if ((e as {status?: number}).status === 401) refresh(); else throw e;}
  };
  if (session?.identity) return children(session, refresh, logout);
  const authError = new URLSearchParams(location.hash.split('?')[1]).get('authError');
  return <main className="page-shell teacher-setup"><section className="panel teacher-login-panel">
    <p className="eyebrow">TEACHER</p><h1>教員ログイン</h1>
    {!session && !error ? <p role="status">ログイン状況を確認しています…</p> : <>
      <p>クラスコンペの設定には、許可されたGoogleアカウントでログインしてください。</p>
      {authError && <p role="alert" className="error">{authError === 'forbidden' ? 'このGoogleアカウントは教員として登録されていません。マスター教員に登録を依頼してください。' : 'Google認証を確認できませんでした。もう一度ログインしてください。'}</p>}
      {error ? <><p role="alert" className="error">{error}</p><button className="secondary-button" onClick={refresh}>再確認する</button></> : session?.ready ? <a className="primary-link" href="/api/auth/google/start">Googleでログイン</a> : <p role="status">教員認証の設定を準備中です。</p>}
    </>}
    <p><a href="#/">ホームへ戻る</a></p>
  </section></main>;
}
