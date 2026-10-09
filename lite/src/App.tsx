import {useEffect,useRef,useState} from 'react';
import {QRCodeSVG} from 'qrcode.react';
import {JoinCodeForm} from '../../src/features/setup/JoinCodeForm';
import {DEFAULT_SETTINGS,settingsSummary} from '../../src/features/setup/CompetitionSettingsForm';
import {HostRace} from '../../src/features/lobby/HostRace';
import type {ParticipantState} from '../../src/features/play/useRoomSync';
import type {IonicFormulaGameSettings} from '../../src/games/ionic-formula/shared/types';
import {Settings} from './Settings';
import {QuestionProfileDialog} from './QuestionProfileDialog';
import {readProfile} from './question-profile';
import {Player} from './Player';
import {Results} from './Results';
import {RoomConnection} from './socket';
import type {Credential,Snapshot,Verdict,ClientMessage} from './protocol';
import {readCredential,saveCredential,recent} from './credentials';
function requireStorage(){const key='ionic-lite:storage-check';localStorage.setItem(key,'1');localStorage.removeItem(key);}
const roomLink=(c:Credential)=>`#/${c.role==='teacher'?'teacher':'join'}/${c.code}`;
function Home(){return <main><section className="home-card" aria-labelledby="home-title">
  <header><p className="eyebrow">IONIC FORMULA</p><h1 id="home-title">Competition</h1><div id="home-participation-status" className="home-participation-status"/></header>
  <JoinCodeForm/>
  <nav aria-label="ルームを作成・管理する"><a className="secondary-link" href="#/create">クラスコンペ</a><button className="secondary-link" type="button" disabled>メイトマッチ</button></nav>
  <nav className="home-utility-actions" aria-label="履歴と関連アプリ"><a className="secondary-link" href="#/history">過去の結果</a><a className="secondary-link" href="https://koichem.github.io/IonicFormula/" target="_blank" rel="noopener noreferrer" aria-label="IonicFormula（新しいタブで開く）">IonicFormula</a></nav>
</section></main>;}
function History(){return <main className="page-shell"><section className="panel wide"><h1>過去の結果</h1><p>このブラウザで作成・参加したコンペに戻れます。</p><div className="ranking-cards">{recent().map(c=><article className="ranking-card" key={`${c.role}:${c.code}`}><strong>クラスコンペ・{c.code}</strong><p>{c.role==='teacher'?'教員':'生徒'}</p><a className="secondary-link" href={roomLink(c)}>コンペに戻る</a></article>)}</div>{!recent().length&&<p>このブラウザのコンペはありません。</p>}<a className="secondary-button" href="#/">ホームへ戻る</a></section></main>;}
function Create(){
  const [settings,setSettings]=useState<IonicFormulaGameSettings>({...DEFAULT_SETTINGS,gradingMode:'immediate'});const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [showProfile,setShowProfile]=useState(false);
  const create=async()=>{if(busy)return;setBusy(true);setError('');try{requireStorage();const response=await fetch('/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({settings,profile:readProfile()})});const data=await response.json();if(!response.ok)throw new Error(data.error);const c:Credential={...data,role:'teacher'};saveCredential(c);location.hash=`/teacher/${c.code}`;}catch(e){setError(e instanceof Error?e.message:'作成できませんでした');}finally{setBusy(false);}};
  return <main className="page-shell teacher-setup"><section className="panel wide teacher-workspace">
    <header className="teacher-workspace-header"><div className="teacher-workspace-heading"><p className="eyebrow">TEACHER</p><h1>クラスコンペを作る</h1><p className="teacher-workspace-intro">条件を選んで、クラスのコンペを始めましょう。</p></div><div className="teacher-workspace-navigation"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setShowProfile(true)}>難易度調整</button></div></header>
    <div className="teacher-class-content"><Settings value={settings} onChange={setSettings} disabled={busy}/><div className="teacher-setup-actions"><button type="button" className="primary-action" disabled={busy} onClick={()=>void create()}>{busy?'作成を確認中…':'クラスルームを作る'}</button><a className="secondary-button" href="#/">ホームへ戻る</a></div>{error&&<p role="alert" className="error">{error}</p>}</div>
    {showProfile&&<QuestionProfileDialog onClose={()=>setShowProfile(false)}/>}
  </section></main>;
}
function Join({code}:{code:string}){
  const [credential,setCredential]=useState(()=>readCredential(code,'participant'));const [nickname,setNickname]=useState('');const [error,setError]=useState('');
  if(credential)return <Room credential={credential}/>;
  return <main className="page-shell"><section className="panel"><h1>クラスコンペに参加</h1><p>参加コード：{code}</p><form onSubmit={e=>{e.preventDefault();try{requireStorage();const c:Credential={code,role:'participant',participantId:crypto.randomUUID(),token:Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''),nickname:nickname.trim(),expiresAtMs:Date.now()+2*60*60*1000};saveCredential(c);setCredential(c);}catch{setError('ブラウザに参加情報を保存できません。保存設定を確認してください');}}}><label htmlFor="nickname">ニックネーム</label><input id="nickname" autoComplete="nickname" maxLength={30} required value={nickname} onChange={e=>setNickname(e.target.value)}/><button type="submit" className="primary-action" disabled={!nickname.trim()}>参加する</button></form>{error&&<p className="error" role="alert">{error}</p>}<a className="secondary-link" href="#/">ホームへ戻る</a></section></main>;
}
function Room({credential}:{credential:Credential}){
  const [state,setState]=useState<Snapshot|null>(null);const [status,setStatus]=useState('接続中');const [error,setError]=useState('');const [verdict,setVerdict]=useState<Verdict|null>(null);const [busy,setBusy]=useState(false);const [confirmFinish,setConfirmFinish]=useState(false);const [tick,setTick]=useState(0);
  const connection=useRef<RoomConnection|null>(null);const clock=useRef({serverNow:Date.now(),at:performance.now()});
  useEffect(()=>{
    const client=new RoomConnection(credential,{onState:next=>{clock.current={serverNow:next.serverNow,at:performance.now()};setState(next);setError('');if(next.room.expiresAtMs!==credential.expiresAtMs){credential.expiresAtMs=next.room.expiresAtMs;try{saveCredential(credential);}catch{}}},onStatus:setStatus,onVerdict:setVerdict});connection.current=client;
    return ()=>{client.dispose();connection.current=null;};
  },[credential]);
  useEffect(()=>{if(!state||!['COUNTDOWN','RUNNING'].includes(state.room.state)||state.own?.finished)return;const timer=setInterval(()=>setTick(v=>v+1),250);return ()=>clearInterval(timer);},[state?.room.state,state?.own?.finished]);
  useEffect(()=>{if(!verdict)return;const timer=setTimeout(()=>setVerdict(null),verdict.correct?1200:2500);return ()=>clearTimeout(timer);},[verdict]);
  void tick;const now=clock.current.serverNow+performance.now()-clock.current.at;
  const enabled=status==='接続済み'&&!busy&&!connection.current?.pending;
  const send=async(message:ClientMessage)=>{if(busy)return;setBusy(true);setError('');try{await connection.current!.send(message);}catch(e){setError(e instanceof Error?e.message:'操作を確認できませんでした');}finally{setBusy(false);}};
  const banner=<div className="lite-status" role="status"><span>{status}</span>{error&&<span className="error">{error}</span>}</div>;
  if(state?.results)return <>{banner}<Results state={state}/></>;
  if(!state)return <main className="page-shell"><section className="panel"><h1>コンペに接続</h1>{banner}<a className="secondary-link" href="#/">ホームへ戻る</a></section></main>;
  const room=state.room;
  if(credential.role==='participant'){
    if(room.state==='WAITING')return <>{banner}<main className="page-shell"><section className="panel"><h1>先生の開始を待っています</h1><p>{state.own!.nickname} さん</p><p>参加者 {room.participantCount} / 50人</p><p className="settings-summary">{settingsSummary(room.settings)}</p><a className="secondary-link" href="#/">ホームへ戻る</a></section></main></>;
    if(room.state==='COUNTDOWN'||(room.state==='RUNNING'&&!state.own!.finished))return <Player state={state} enabled={enabled} now={now} verdict={verdict} status={status} error={error} send={send}/>;
    return <>{banner}<main className="page-shell"><section className="panel"><h1>回答が終わりました</h1><p>正解 {state.own!.correctCount} / {room.maxScore}</p><p>コンペの終了後に、結果と復習が表示されます。</p><a className="secondary-link" href="#/">ホームへ戻る</a></section></main></>;
  }
  const countdown=Math.max(0,Math.ceil((room.startAtMs!-now)/1000));
  const remaining=Math.max(0,Math.ceil((room.deadlineAtMs!-now)/1000));
  const interrupt=<div><button type="button" className="secondary-button" disabled={!enabled} onClick={()=>setConfirmFinish(true)}>コンペを終了</button>{confirmFinish&&<div className="lite-confirm" role="group" aria-label="コンペ終了の確認"><p>現在の成績でコンペを終了します。</p><button type="button" className="primary-action" disabled={!enabled} onClick={()=>{setConfirmFinish(false);void send({type:'finish'});}}>終了する</button><button type="button" className="secondary-button" onClick={()=>setConfirmFinish(false)}>戻る</button></div>}</div>;
  const participants:ParticipantState[]=(state.participants??[]).map(p=>({...p,status:p.finished?'FINISHED':'ACTIVE',currentOrdinal:p.questionIndex,resolvedQuestionCount:p.questionIndex,revision:p.lastSeq,timingSource:'server'}));
  return <>{banner}<main className={`page-shell lite-host ${room.state==='WAITING'?'':'is-running'}`}><section className="panel wide"><p className="eyebrow">CLASS COMPETITION</p><h1>{room.state==='WAITING'?'参加を待っています':countdown>0?`${countdown}秒後に開始`:'クラスコンペ'}</h1><p className="settings-summary">{settingsSummary(room.settings)}</p>
    {room.state==='WAITING'?<><div className="join-share"><div className="code"><span>参加コード</span><strong data-testid="join-code">{room.code}</strong></div><QRCodeSVG value={`${location.origin}/#/join/${room.code}`} size={300} level="M" marginSize={2} role="img" aria-label="参加用QRコード"/><a href={`/#/join/${room.code}`}>{`${location.origin}/#/join/${room.code}`}</a></div><p className="participant-count"><strong>{room.participantCount} / 50人</strong>が参加中</p><ul className="participant-list">{state.participants?.map(p=><li key={p.id}>{p.nickname}</li>)}</ul><button type="button" className="primary-action" disabled={!enabled||!room.participantCount} onClick={()=>void send({type:'start'})}>5秒後に開始</button></>:<HostRace roomId={room.code} participants={participants} mode="immediate" maxScore={room.maxScore} questionCount={room.settings.questionCount} active={countdown===0&&remaining>0} pace={remaining>room.settings.timeLimitMinutes*60*.6?0:remaining>60?1:remaining>20?2:3} remainingText={`残り ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`} interruptButton={interrupt}/>}
    <a className="secondary-link" href="#/">ホームへ戻る</a>
  </section></main></>;
}
export default function App(){
  const [route,setRoute]=useState(()=>location.hash.slice(1)||'/');useEffect(()=>{const change=()=>setRoute(location.hash.slice(1)||'/');window.addEventListener('hashchange',change);return ()=>window.removeEventListener('hashchange',change);},[]);
  if(route==='/')return <Home/>;if(route==='/history')return <History/>;if(route==='/create')return <Create/>;
  const [path,query]=route.split('?');const parts=path.split('/').filter(Boolean);const code=(parts[1]??new URLSearchParams(query).get('code')??'').trim().toUpperCase();
  if(/^[A-Z2-9]{6}$/.test(code)){
    if(parts[0]==='join')return <Join key={code} code={code}/>;
    if(parts[0]==='teacher'){const c=readCredential(code,'teacher');if(c)return <Room key={`teacher:${code}`} credential={c}/>;}
  }
  return <main className="page-shell"><section className="panel"><h1>参加情報を確認してください</h1><p>参加コード、またはこのブラウザのコンペ一覧から開いてください。</p><a className="primary-link" href="#/">ホームへ戻る</a></section></main>;
}
