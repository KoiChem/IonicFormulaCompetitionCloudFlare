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
import '../../app/globals.css';
function Application() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const changed = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', changed);

    return () => window.removeEventListener('hashchange', changed);
  }, []);
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
