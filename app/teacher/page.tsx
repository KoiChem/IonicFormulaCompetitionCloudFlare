import { useEffect, useState } from 'react';
import { TeacherClient } from './TeacherClient';
import { getSupabaseClient } from '../../src/web/supabase';
import { apiFetch } from '../../src/web/api';
import { appPath } from '../../src/web/routing';
export default function TeacherPage() {
  const [status, setStatus] = useState<'checking'|'signedout'|'allowed'|'forbidden'>('checking');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const { data } = await getSupabaseClient().auth.getSession();
        if (!data.session || data.session.user.is_anonymous) { if (active) setStatus('signedout'); return; }
        const response = await apiFetch('/api/teacher/session');
        const body = await response.json();
        if (active) { setStatus(response.ok ? 'allowed' : 'forbidden'); setError(response.ok ? '' : body.error?.message ?? '教員として登録されていません'); }
      } catch (reason) { if (active) { setStatus('signedout'); setError(reason instanceof Error ? reason.message : '認証を確認できません'); } }
    };
    void check();
    const { data } = getSupabaseClient().auth.onAuthStateChange(() => { setTimeout(() => void check(), 0); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  const login = async () => {
    setError('');
    sessionStorage.setItem('ionic-competition-github:return', '/teacher');
    const { error } = await getSupabaseClient().auth.signInWithOAuth({ provider: 'google', options: {
      redirectTo: new URL(import.meta.env.BASE_URL, location.origin).href,
      queryParams: { prompt: 'select_account' }, scopes: 'openid email profile',
    } });
    if (error) setError(error.message);
  };
  if (status === 'allowed') return <><TeacherClient/><div className="page-shell"><button onClick={() => void getSupabaseClient().auth.signOut()}>ログアウト</button></div></>;
  return <main className="page-shell"><section className="panel wide"><p className="eyebrow">TEACHER</p><h1>教員用</h1>
    {status === 'checking' ? <p role="status">教員資格を確認しています…</p> : <><p>登録されたGoogleアカウントでログインしてください。</p><button className="primary-action" onClick={() => void login()}>Googleでログイン</button></>}
    {error && <p role="alert" className="error">{error}</p>}<a href={appPath('/')}>ホームへ戻る</a></section></main>;
}
