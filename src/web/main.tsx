import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../../app/page';
import CodeJoinPage from '../../app/join/page';
import JoinPage from '../../app/join/[publicId]/page';
import MateNewPage from '../../app/mate/new/page';
import TeacherPage from '../../app/teacher/page';
import HistoryPage from '../../app/history/page';
import { HistoryResult } from '../features/results/HistoryResult';
import { RoomScreen } from '../features/lobby/RoomScreen';
import { parseRoute, appPath } from './routing';
import { completeOAuth, isConfigured } from './supabase';
import '../../app/globals.css';
function Application() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', changed);
    void completeOAuth().catch(reason => setError(reason.message)).finally(() => { changed(); setReady(true); });
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  if (!ready) return <main className="page-shell"><p role="status">読み込み中…</p></main>;
  if (error) return <main className="page-shell"><p role="alert">{error}</p><a href={appPath('/teacher')}>教員ログインへ</a></main>;
  if (!isConfigured()) return <main className="page-shell"><section className="panel"><h1>Ionic Formula Competition</h1><p role="status">接続設定を準備中です。</p></section></main>;
  const parts = route.path.split('/').filter(Boolean);
  if (!parts.length) return <Home/>;
  if (route.path === '/teacher') return <TeacherPage/>;
  if (route.path === '/join') return <CodeJoinPage/>;
  if (parts[0] === 'join' && parts.length === 2) return <JoinPage key={parts[1]} roomId={decodeURIComponent(parts[1])}/>;
  if (route.path === '/mate/new') return <MateNewPage/>;
  if (parts[0] === 'rooms' && parts.length === 2) return <RoomScreen key={parts[1]} roomId={decodeURIComponent(parts[1])}/>;
  if (route.path === '/history') return <HistoryPage/>;
  if (parts[0] === 'history' && parts.length === 2) return <HistoryResult key={parts[1]} roomId={decodeURIComponent(parts[1])} role={new URLSearchParams(route.search).get('role') === 'teacher' ? 'teacher' : 'participant'}/>;
  return <main className="page-shell"><h1>ページが見つかりません</h1><a href={appPath('/')}>ホームへ戻る</a></main>;
}
createRoot(document.getElementById('root')!).render(<Application/>);
