import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {JoinCodeForm} from '../../src/features/setup/JoinCodeForm';
import {DEFAULT_SETTINGS,settingsSummary} from '../../src/features/setup/CompetitionSettingsForm';
import {ReturnHomeButton} from '../../src/features/setup/ReturnHomeButton';
import {HostRace} from '../../src/features/lobby/HostRace';
import {Lobby} from '../../src/features/lobby/Lobby';
import {EndRoomButton} from '../../src/features/lobby/EndRoomButton';
import {InterruptRoomButton} from '../../src/features/lobby/InterruptRoomButton';
import {RemovedParticipantNotice} from '../../src/features/lobby/RemovedParticipantNotice';
import {racePace} from '../../src/features/lobby/host-race-model';
import {useHostCountdownSound} from '../../src/features/lobby/host-countdown-sound';
import {ImmediateVerdict} from '../../src/features/play/ImmediateVerdict';
import {fieldLabel} from '../../src/features/play/AnswerFieldTabs';
import {playAnswerSound,savedSoundLevel} from '../../src/features/play/audio-feedback';
import {ParticipantSyncStatus} from '../../src/features/play/ParticipantSyncStatus';
import {loadSavedNickname} from '../../src/features/setup/saved-nickname';
import type {ParticipantState,RoomView} from '../../src/features/play/useRoomSync';
import type {IonicFormulaGameSettings} from '../../src/games/ionic-formula/shared/types';
import {Settings} from './Settings';
import {TeacherAccessCard,MateAvailabilityCard} from './DisabledManagementCards';
import {NicknameEditor} from './NicknameEditor';
import {QuestionProfileDialog} from './QuestionProfileDialog';
import {readProfile} from './question-profile';
import {Player} from './Player';
import {DeferredPlayer} from './DeferredPlayer';
import {Results} from './Results';
import {RoomConnection} from './socket';
import type {Credential,Snapshot,Verdict,ClientMessage} from './protocol';
import {readCredential,saveCredential,recent} from './credentials';
function requireStorage(){const key='ionic-lite:storage-check';localStorage.setItem(key,'1');localStorage.removeItem(key);}
const roomLink=(c:Credential)=>`#/rooms/${c.code}?role=${c.role}`;
async function storedState(c:Credential):Promise<Snapshot>{const r=await fetch(`/api/rooms/${c.code}/state`,{headers:{authorization:`Bearer ${c.token}`,...(c.participantId?{'x-participant-id':c.participantId}:{})}});const body=await r.json();if(!r.ok)throw Object.assign(new Error(r.status===410?'閲覧期限が切れました':r.status===403?'参加資格を確認できません':'結果を取得できません。再試行してください'),{status:r.status});return body;}
function ActiveRooms(){const [rooms,setRooms]=useState<Credential[]>([]),[checking,setChecking]=useState(false),[failed,setFailed]=useState(false),[revision,setRevision]=useState(0);useEffect(()=>{let live=true;const candidates=recent().filter(c=>c.role==='participant');setRooms([]);setFailed(false);setChecking(candidates.length>0);void Promise.all(candidates.map(async c=>{try{const s=await storedState(c);return ['WAITING','COUNTDOWN','RUNNING','COLLECTING'].includes(s.room.state)?c:null;}catch(e){if(live&&![403,404,410].includes((e as {status?:number}).status??0))setFailed(true);return null;}})).then(found=>{if(live){setRooms(found.filter((c):c is Credential=>!!c));setChecking(false);}});return()=>{live=false;};},[revision]);const target=checking?document.getElementById('home-participation-status'):null;return <>{target&&createPortal(<p role="status">参加状況を確認しています…</p>,target)}{(rooms.length>0||(failed&&!checking))&&<section className="active-room-links" aria-label="参加中の競技">{rooms.length>0&&<><h2>参加中の競技</h2><ul>{rooms.map(c=><li key={c.code}><span>クラスコンペ</span><a className="primary-link" href={roomLink(c)}>参加中の競技に戻る</a></li>)}</ul></>}{failed&&!checking&&<button type="button" onClick={()=>setRevision(v=>v+1)}>参加状況を再確認</button>}</section>}</>;}
function Home(){return <main><section className="home-card" aria-labelledby="home-title">
  <header><p className="eyebrow">IONIC FORMULA</p><h1 id="home-title">Competition</h1><div id="home-participation-status" className="home-participation-status"/></header>
  <JoinCodeForm/><ActiveRooms/>
  <nav aria-label="ルームを作成・管理する"><a className="secondary-link" href="#/teacher">クラスコンペ</a><button className="secondary-link" type="button" disabled>メイトマッチ</button></nav>
  <nav className="home-utility-actions" aria-label="履歴と関連アプリ"><a className="secondary-link" href="#/history">過去の結果</a><a className="secondary-link" href="https://koichem.github.io/IonicFormula/" target="_blank" rel="noopener noreferrer" aria-label="IonicFormula（新しいタブで開く）">IonicFormula</a></nav>
</section></main>;}
function History(){
  const [rows,setRows]=useState<{credential:Credential;state?:Snapshot;message?:string}[]>([]),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
  useEffect(()=>{let live=true;void Promise.all(recent().map(async (credential):Promise<{credential:Credential;state?:Snapshot;message?:string}>=>{try{const state=await storedState(credential);return {credential,...(state.results?{state}:{state,message:'競技中・結果確定待ち'})};}catch(e){return {credential,message:e instanceof Error?e.message:'通信できません。再試行してください'};}})).then(next=>{if(live){setRows(next.sort((a,b)=>(b.state?.room.createdAtMs??0)-(a.state?.room.createdAtMs??0)));setLoading(false);}});return()=>{live=false;};},[retry]);
  const render=(role:Credential['role'])=>rows.filter(r=>r.credential.role===role).map(({credential:c,state:s,message})=><li key={c.code} className="review-card">{s?.results?<><strong>クラスコンペ・{new Date(s.room.createdAtMs).toLocaleString('ja-JP')}</strong><p>{settingsSummary(s.room.settings)}</p><p>{s.room.endReason==='interrupted'?'中断終了':'終了'}{s.results?.own?`・${s.results.own.rank}位・正解${s.results.own.correctCount}`:''}</p><p>閲覧期限：{new Date(s.room.expiresAtMs).toLocaleString('ja-JP')}</p><a className="secondary-link" href={roomLink(c)}>結果を見る</a></>:<><strong>クラスコンペ</strong><p>{message}</p>{s&&['WAITING','COUNTDOWN','RUNNING','COLLECTING'].includes(s.room.state)&&<a className="secondary-link" href={roomLink(c)}>参加中の競技に戻る</a>}</>}</li>);
  return <main className="page-shell"><section className="panel wide"><h1>過去の結果</h1><p>このブラウザで参加・作成した競技を、閲覧期限内に確認できます。</p>{loading?<p role="status">結果を確認しています…</p>:<>{rows.length===0&&<p>閲覧できる結果はありません。</p>}<h2>参加した競技</h2><ul className="review-list">{render('participant')}</ul><h2>主催した競技</h2><ul className="review-list">{render('teacher')}</ul><button type="button" className="secondary-button" onClick={()=>{setLoading(true);setRetry(v=>v+1);}}>再確認する</button></>}<p><a href="#/">ホームへ戻る</a></p></section></main>;
}
function Create(){
  const [view,setView]=useState<'class'|'management'>('class');const [settings,setSettings]=useState<IonicFormulaGameSettings>({...DEFAULT_SETTINGS});const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [showProfile,setShowProfile]=useState(false);
  const create=async()=>{if(busy)return;setBusy(true);setError('');try{requireStorage();const response=await fetch('/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({settings,profile:readProfile()})});const data=await response.json();if(!response.ok)throw new Error(data.error);const c:Credential={...data,role:'teacher'};saveCredential(c);location.hash=`/rooms/${c.code}?role=teacher`;}catch(e){setError(e instanceof Error?e.message:'作成できませんでした');}finally{setBusy(false);}};
  return <main className="page-shell teacher-setup"><section className="panel wide teacher-workspace">
    <header className="teacher-workspace-header"><div className="teacher-workspace-heading"><p className="eyebrow">TEACHER</p><h1>{view==='class'?'クラスコンペを作る':'教員用の管理設定'}</h1><p className="teacher-workspace-intro">{view==='class'?'条件を選んで、クラスのコンペを始めましょう。':'教員のアクセスと、アプリ全体の出題を管理します。'}</p></div><div className="teacher-workspace-navigation"><span className="teacher-role-badge">管理者教員</span><div className="teacher-view-switch" role="group" aria-label="教員ページの表示"><button type="button" disabled={busy} aria-pressed={view==='class'} onClick={()=>setView('class')}>クラスコンペ</button><button type="button" disabled={busy} aria-pressed={view==='management'} onClick={()=>setView('management')}>管理設定</button></div></div></header>
    <div hidden={view!=='class'} className="teacher-class-content"><Settings value={settings} onChange={setSettings} disabled={busy}/><div className="teacher-setup-actions"><button type="button" className="primary-action" disabled={busy} onClick={()=>void create()}>{busy?'作成を確認中…':'クラスルームを作る'}</button><ReturnHomeButton disabled={busy}/></div>{error&&<p role="alert" className="error">{error}</p>}</div>
    <div hidden={view!=='management'} className="teacher-admin-content"><div className="teacher-management-grid"><TeacherAccessCard/><div className="teacher-management-tools"><MateAvailabilityCard/><section className="teacher-admin-card difficulty-management-card" aria-labelledby="difficulty-management-title"><div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">≋</span><div><p className="teacher-card-kicker">出題設定</p><h2 id="difficulty-management-title">出題の難易度</h2></div></div><p>錯イオンの割合と、各イオン・化合物の出題対象を調整します。</p><div className="teacher-card-foot"><span>新しく作るルームに反映</span><button type="button" className="teacher-open-action" onClick={()=>setShowProfile(true)}>難易度を調整<span aria-hidden="true">→</span></button></div></section></div>{showProfile&&<QuestionProfileDialog onClose={()=>setShowProfile(false)}/>}</div><div className="teacher-management-footer"><button type="button" className="secondary-button" onClick={()=>setView('class')}>クラスコンペの設定に戻る</button></div></div>
  </section></main>;
}
function Join({code}:{code:string}) {
  const saved=useRef(readCredential(code,'participant'));
  const [credential,setCredential]=useState<Credential|null>(null),[nickname,setNickname]=useState(()=>saved.current?.pending?saved.current.nickname??'':loadSavedNickname(localStorage)),[info,setInfo]=useState<{room:{state:string;settings:IonicFormulaGameSettings};participantCount:number;capacity:number}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const pending=saved.current?.pending?saved.current:null,recovery=saved.current&&!pending?saved.current:null;
  useEffect(()=>{let live=true;void fetch(`/api/rooms/${code}/info`).then(async r=>{const body=await r.json();if(!r.ok)throw new Error(body.error);if(live)setInfo(body);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[code,retry]);
  const join=()=>{if(credential)return;setError('');try{requireStorage();const c:Credential=pending??{code,role:'participant',participantId:crypto.randomUUID(),token:Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''),nickname:nickname.trim(),expiresAtMs:Date.now()+2*60*60*1000,pending:true};saveCredential(c);setCredential(c);}catch{setError('ブラウザに参加情報を保存できません。保存設定を確認してください');}};
  const form=<main className="page-shell"><section className="panel"><p className="eyebrow">JOIN</p><h1>競技に参加</h1>
    {recovery?<div className="recovery-panel">{info?.room.state==='FINISHED'?<><p>競技は終了しました。</p><a className="primary-link" href={roomLink(recovery)}>結果を見る</a></>:info?.room.state==='CANCELLED'?<p role="status">この参加資格では競技に戻れません。</p>:<><h2>参加中の競技があります</h2><a className="primary-link" href={roomLink(recovery)}>参加中の競技に戻る</a></>}</div>:<>
    {info?<div className="join-info"><p>クラスコンペ</p><p>{settingsSummary(info.room.settings)}</p><p>参加 {info.participantCount}人</p></div>:<p role="status">{error||'ルーム情報を確認しています…'}</p>}
    {!info&&error&&<button type="button" onClick={()=>{setError('');setRetry(v=>v+1);}}>参加先を再確認</button>}
    {info&&info.room.state!=='WAITING'&&<p role="status">参加受付は終了しました。</p>}{info&&info.participantCount>=info.capacity&&<p role="status">定員に達しました。</p>}
    <p>ニックネームだけを使います。本名や個人情報は入力しないでください。</p><label htmlFor="nickname">ニックネーム（1〜16文字）</label><input id="nickname" autoComplete="nickname" maxLength={16} disabled={!!credential||!!pending} value={nickname} onChange={e=>setNickname(e.target.value)}/>
    {pending&&<p role="status">前回の参加要求を確認します。確認後に名前を変更できます。</p>}
    <button type="button" className="primary-action" disabled={!!credential||!info||!nickname.trim()||(!pending&&(info.room.state!=='WAITING'||info.participantCount>=50))} onClick={join}>{credential?'参加を確認中…':pending?'参加を再確認':'参加する'}</button>{error&&<p className="error" role="alert">{error}</p>}
    </>}<a className="primary-link" href="#/">ホームへ戻る</a></section></main>;
  return credential?<Room credential={credential} joiningForm={form} onJoinError={message=>{localStorage.removeItem(`ionic-lite:participant:${code}`);saved.current=null;setCredential(null);setError(message);}} onJoinReentry={()=>{history.replaceState(null,'',`#/join/${code}`);saved.current=null;setCredential(null);setError('');}}/>:form;
}

function Room({credential,joiningForm,onJoinError,onJoinReentry}:{credential:Credential;joiningForm?:ReactNode;onJoinError?(message:string):void;onJoinReentry?():void}){
  const [state,setState]=useState<Snapshot|null>(null),[status,setStatus]=useState('接続中'),[error,setError]=useState(''),[terminal,setTerminal]=useState(''),[removed,setRemoved]=useState(false),[removedState,setRemovedState]=useState(''),[verdict,setVerdict]=useState<Verdict|null>(null),[busy,setBusy]=useState(false),[tick,setTick]=useState(0),[settings,setSettings]=useState<IonicFormulaGameSettings|null>(null);
  const authenticated=useRef(false);
  const connection=useRef<RoomConnection|null>(null),clock=useRef({serverNow:Date.now(),at:performance.now()});const audioClock=useRef({serverNowMs:()=>clock.current.serverNow+performance.now()-clock.current.at});
  useEffect(()=>{const client=new RoomConnection(credential,{onState:next=>{if(!authenticated.current&&joiningForm)history.replaceState(null,'',roomLink(credential));authenticated.current=true;clock.current={serverNow:next.serverNow,at:performance.now()};setState(next);setError('');credential.expiresAtMs=next.room.expiresAtMs;if(next.own){credential.nickname=next.own.nickname;credential.pending=false;}try{saveCredential(credential);}catch{}},onStatus:setStatus,onVerdict:setVerdict,onError:(code,message)=>{if(onJoinError&&!authenticated.current){onJoinError(message);return;}if(code==='participant_removed')setRemoved(true);else if(['unauthorized','expired','not_found'].includes(code))setTerminal(message);else setError(message);}});connection.current=client;return()=>{client.dispose();connection.current=null;};},[credential]);
  useEffect(()=>{if(!state||!['COUNTDOWN','RUNNING'].includes(state.room.state)||state.own?.finished)return;const timer=setInterval(()=>setTick(v=>v+1),250);return()=>clearInterval(timer);},[state?.room.state,state?.own?.finished]);
  useEffect(()=>{if(!verdict)return;if(!verdict.passed)playAnswerSound(verdict.correct?'correct':'incorrect',savedSoundLevel());const timer=setTimeout(()=>setVerdict(null),verdict.correct?1200:2500);return()=>clearTimeout(timer);},[verdict]);
  useEffect(()=>{if(!['COUNTDOWN','RUNNING'].includes(state?.room.state??''))return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[state?.room.state]);
  useEffect(()=>{if(!removed)return;let live=true;void fetch(`/api/rooms/${credential.code}/info`).then(r=>r.json()).then(info=>{if(live)setRemovedState(info.room?.state??'EXPIRED');}).catch(()=>{});return()=>{live=false;};},[removed]);
  useHostCountdownSound(credential.role==='teacher'&&state?.room.state==='COUNTDOWN',state?.room.startAtMs,audioClock,state?.serverNow);
  void tick;const now=audioClock.current.serverNowMs(),enabled=status==='接続済み'&&!busy&&!connection.current?.pending;
  const send=async(message:ClientMessage):Promise<Snapshot>=>{if(busy)throw new Error('送信中です');setBusy(true);setError('');try{const reply=await connection.current!.send(message);return reply.state!;}catch(e){setError(e instanceof Error?e.message:'操作を確認できませんでした');throw e;}finally{setBusy(false);}};
  const act=(message:ClientMessage)=>{void send(message).catch(()=>{});};
  const syncText=error||(status.startsWith('別のタブ')?status:status==='送信中'?'解答記録を送信しています…':status==='接続済み'?(state?.own?.lastSeq?'解答記録の送信を確認しました。結果を待っています':'解答をこの端末に保存しました'):'解答はこの端末に保存しました。通信を再確認しています');
  if(removed)return <RemovedParticipantNotice roomState={removedState||state?.room.state||'WAITING'} canRejoin={(removedState||state?.room.state)==='WAITING'} onRejoin={()=>{localStorage.removeItem(`ionic-lite:participant:${credential.code}`);if(onJoinReentry)onJoinReentry();else location.hash=`/join/${credential.code}`;}}/>;
  if(terminal)return <main className="page-shell"><section className="panel"><h1>ルームを利用できません</h1><p role="status">{terminal}</p><a className="primary-link" href="#/">ホームへ戻る</a></section></main>;
  if(!state)return joiningForm??<main className="page-shell"><section className="panel"><h1>{credential.role==='teacher'?'管理画面へ接続中':'ルームへ接続中'}</h1><p role="status">{status==='接続中'?'読み込み中…':status}</p></section></main>;
  const room=state.room;
  if(room.state==='CANCELLED')return <main className="page-shell"><section className="panel"><h1>ルームは終了しました</h1><p>主催者がルームを終了しました。</p><a className="primary-link" href="#/">ホームへ戻る</a></section></main>;
  const perfect=<ImmediateVerdict verdict={verdict?.correct&&state.own?.correctCount===room.maxScore?{attemptId:String(state.own.lastSeq),correct:true,questionNumber:verdict.questionNumber??room.settings.questionCount,fieldLabel:fieldLabel(verdict.fieldId,room.settings.mode),fullScore:true}:null}/>;
  if(state.results)return <>{credential.role==='participant'&&<ParticipantSyncStatus text={state.results.own?.finalSyncUnconfirmed?'解答はこの端末に保存しました。通信を再確認しています':'解答記録の送信を確認しました'}/>}{perfect}<Results state={state}/></>;
  if(credential.role==='participant'){
    if(room.state==='WAITING')return <main className="page-shell"><section className="panel"><h1>開始を待っています</h1><NicknameEditor nickname={state.own!.nickname} disabled={!enabled} onSave={nickname=>send({type:'nickname',nickname})}/><p>{settingsSummary(room.settings)}</p></section></main>;
    if(room.state==='COUNTDOWN'||!state.own!.finished)return room.settings.gradingMode==='deferred'?<DeferredPlayer state={state} enabled={enabled} now={now} status={syncText} editable={!status.startsWith('別のタブ')} serverNow={audioClock.current.serverNowMs} send={send}/>:<Player state={state} enabled={enabled} now={now} verdict={verdict} status={syncText} error={error} send={send}/>;
    return <main className="page-shell">{perfect}<section className="panel"><h1>記録を確認しています</h1><ParticipantSyncStatus text="解答記録の送信を確認しました。結果を待っています"/></section></main>;
  }
  const participants:ParticipantState[]=(state.participants??[]).map(p=>({...p,status:p.finished?'FINISHED':'ACTIVE',submitted:p.finished,currentOrdinal:p.questionIndex,resolvedQuestionCount:p.questionIndex,revision:p.lastSeq,timingSource:'server'}));
  if(room.state==='WAITING')return <main className="class-host-page"><Lobby room={{...room,id:room.code,kind:'class',revision:0,playProtocolVersion:2,settings:room.settings as unknown as Record<string,unknown>} satisfies RoomView} participants={participants} joinCode={room.code} canStart={room.participantCount>=1&&!settings} onStart={()=>act({type:'start'})} onRemove={p=>act({type:'remove',participantId:p.id})} busy={!enabled}/>{error&&<p role="alert" className="error">{error}</p>}<EndRoomButton busy={!enabled} onEnd={async()=>{await send({type:'cancel'});location.hash='/';}}/><details className="panel settings-editor"><summary>競技設定を変更</summary><Settings value={settings??room.settings} onChange={setSettings} disabled={!enabled}/><button className="primary-action" type="button" disabled={!enabled||!settings} onClick={()=>{void send({type:'settings',settings:settings!}).then(()=>setSettings(null)).catch(()=>{});}}>設定を保存</button></details></main>;
  if(room.state==='COLLECTING')return <main className="class-host-page"><section className="panel wide"><h1>記録を確認しています</h1><p>参加者からの解答記録を回収しています。</p><CollectingProgress participants={participants} mode={room.settings.gradingMode??'immediate'}/></section></main>;
  const start=room.startAtMs!,deadline=room.deadlineAtMs!,remaining=Math.max(0,deadline-now),countingDown=now<start;
  return <main className="class-host-page running-host race-host-page" data-tick={tick}>{countingDown&&<div className="race-countdown">まもなく開始 <strong aria-live="off">{Math.max(0,Math.ceil((start-now)/1000))}</strong></div>}<HostRace roomId={room.code} participants={participants} mode={room.settings.gradingMode??'immediate'} maxScore={room.maxScore} questionCount={room.settings.questionCount} active={!countingDown&&remaining>0} pace={racePace(remaining,deadline-start)} remainingText={`${String(Math.floor(remaining/60000)).padStart(2,'0')}:${String(Math.floor(remaining/1000)%60).padStart(2,'0')}`} interruptButton={!countingDown&&remaining>0?<InterruptRoomButton busy={!enabled} onInterrupt={async()=>{await send({type:'finish'});}}/>:null}/>{error&&<p role="alert" className="error">{error}</p>}</main>;
}
function CollectingProgress({participants,mode}:{participants:ParticipantState[];mode:'immediate'|'deferred'}) {
  const [open,setOpen]=useState(false);
  return <><button type="button" className="progress-toggle" aria-expanded={open} aria-controls="collecting-participant-progress" onClick={()=>setOpen(v=>!v)}>{open?'参加者の進捗を閉じる':'参加者の進捗を表示'}</button>{open&&<div id="collecting-participant-progress"><section className="panel progress-panel" aria-label="参加者の進捗"><h2>参加者の進捗</h2><p>{mode==='deferred'?'提出':'完了'} {participants.filter(p=>p.submitted).length} / {participants.length}人</p><ul className="participant-list">{participants.map(p=><li key={p.id}><span>{p.nickname}</span><span>{mode==='deferred'?`入力済み ${p.answeredCount??0}欄・${p.submitted?'提出済み':'解答中'}`:`正解 ${p.correctCount}・${p.status==='FINISHED'?'完了':`${p.resolvedQuestionCount}問`}`}</span></li>)}</ul></section></div>}</>;
}
export default function App(){
  const [route,setRoute]=useState(()=>location.hash.slice(1)||'/');useEffect(()=>{const change=()=>setRoute(location.hash.slice(1)||'/');window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  if(route==='/')return <Home/>;if(route==='/history')return <History/>;if(route==='/create'||route==='/teacher')return <Create/>;
  const [path,query]=route.split('?'),parts=path.split('/').filter(Boolean),params=new URLSearchParams(query);const code=(parts[1]??params.get('code')??'').trim().toUpperCase();
  if(/^[A-Z2-9]{6}$/.test(code)){if(parts[0]==='join')return <Join key={code} code={code}/>;if(parts[0]==='teacher'||parts[0]==='rooms'){const role=parts[0]==='teacher'?'teacher':params.get('role')??(readCredential(code,'participant')?'participant':'teacher');const c=readCredential(code,role);if(c)return <Room key={`${role}:${code}`} credential={c}/>;}}
  return <main className="page-shell"><section className="panel"><h1>参加情報を確認してください</h1><p>参加コード、またはこのブラウザのコンペ一覧から開いてください。</p><a className="primary-link" href="#/">ホームへ戻る</a></section></main>;
}
