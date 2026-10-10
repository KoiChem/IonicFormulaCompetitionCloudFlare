import {useEffect,useRef,useState} from 'react';
import {QuestionView} from '../../src/games/ionic-formula/client/QuestionView';
import {FormulaKeyboard} from '../../src/games/ionic-formula/client/FormulaKeyboard';
import {NameKeyboard} from '../../src/games/ionic-formula/client/NameKeyboard';
import {createFormulaEntry} from '../../src/games/ionic-formula/client/formula-entry';
import {AnswerFieldTabs} from '../../src/features/play/AnswerFieldTabs';
import {DeferredReviewQuestion} from '../../src/features/play/DeferredReviewQuestion';
import {ParticipantSyncStatus} from '../../src/features/play/ParticipantSyncStatus';
import type {AnswerFieldId,FormulaEntry} from '../../src/games/ionic-formula/shared/types';
import type {ClientMessage,Snapshot} from './protocol';
type Value=string|FormulaEntry;
const empty=(value:Value|undefined)=>typeof value==='string'?!value.trim():!value||(!value.tokens.length&&!value.charge);
export function DeferredPlayer({state,enabled,now,status,editable,serverNow,send}:{state:Snapshot;enabled:boolean;editable:boolean;serverNow():number;now:number;status:string;send(message:ClientMessage):Promise<Snapshot>}) {
  const questions=state.deferred!.questions,settings=state.room.settings,key=`ionic-lite:deferred:${state.room.code}:${state.own!.id}`;
  const initial=useRef<{drafts:Record<string,Value>;ordinal:number;advanced:number;capturedAtMs:number}>(undefined);
  if(!initial.current){let saved;try{saved=JSON.parse(localStorage.getItem(key)??'null');}catch{}initial.current={drafts:{...state.deferred!.drafts,...saved?.drafts},ordinal:Math.max(0,Math.min(questions.length-1,saved?.ordinal??0)),advanced:Math.max(state.own!.advancedQuestionCount,saved?.advanced??0),capturedAtMs:saved?.capturedAtMs??Math.min(now,state.room.cutoffAtMs??now)};}
  const [drafts,setDrafts]=useState(initial.current.drafts),[ordinal,setOrdinal]=useState(initial.current.ordinal),[reviewing,setReviewing]=useState(false),[selected,setSelected]=useState<AnswerFieldId>('formula'),[storageFailed,setStorageFailed]=useState(false),[message,setMessage]=useState(''),[submitting,setSubmitting]=useState(false);
  const latest=useRef(drafts),capturedAt=useRef(initial.current.capturedAtMs),advanced=useRef(initial.current.advanced),seq=useRef(state.own!.lastSeq),server=useRef(state.deferred!.drafts),serverAdvanced=useRef(state.own!.advancedQuestionCount),saving=useRef<Promise<void>|null>(null),live=useRef(true);
  useEffect(()=>()=>{live.current=false;},[]);
  useEffect(()=>{seq.current=Math.max(seq.current,state.own!.lastSeq);server.current=state.deferred!.drafts;serverAdvanced.current=state.own!.advancedQuestionCount;},[state]);
  useEffect(()=>{const apply=()=>document.documentElement.style.setProperty('--play-viewport-height',`${window.visualViewport?.height??innerHeight}px`);apply();window.visualViewport?.addEventListener('resize',apply);return()=>{window.visualViewport?.removeEventListener('resize',apply);document.documentElement.style.removeProperty('--play-viewport-height');};},[]);
  const persist=(next=latest.current,nextOrdinal=ordinal)=>{try{localStorage.setItem(key,JSON.stringify({drafts:next,ordinal:nextOrdinal,advanced:advanced.current,capturedAtMs:capturedAt.current}));setStorageFailed(false);return true;}catch{setStorageFailed(true);return false;}};
  const flush=():Promise<void>=>{
    if(saving.current)return saving.current.then(()=>flush());
    const answers=questions.flatMap(q=>q.fields.filter(f=>JSON.stringify(latest.current[`${q.id}:${f.id}`])!==JSON.stringify(server.current[`${q.id}:${f.id}`])&&latest.current[`${q.id}:${f.id}`]!==undefined).map(f=>({questionId:q.id,fieldId:f.id,value:latest.current[`${q.id}:${f.id}`]})));
    if(!answers.length&&advanced.current<=serverAdvanced.current)return Promise.resolve();
    const operation=send({type:'draft',seq:seq.current+1,answers,capturedAtMs:capturedAt.current,advancedQuestionCount:advanced.current}).then(next=>{seq.current=next.own!.lastSeq;server.current=next.deferred!.drafts;serverAdvanced.current=next.own!.advancedQuestionCount;});
    saving.current=operation.finally(()=>{saving.current=null;});return saving.current;
  };
  const waiting=Math.max(0,Math.ceil((state.room.startAtMs!-now)/1000)),remaining=Math.max(0,Math.ceil(((state.room.cutoffAtMs??state.room.deadlineAtMs!)-now)/1000)),canEdit=remaining>0&&!storageFailed&&editable&&!submitting;
  // One replaceable draft per round trip. Keyboard edits stay local while it is sent.
  useEffect(()=>{if(!enabled||waiting||!canEdit)return;const timer=setTimeout(()=>{void flush().catch(e=>{if(live.current)setMessage(e.message);});},350);return()=>clearTimeout(timer);},[drafts,enabled,ordinal,canEdit]);
  const q=questions[ordinal],field=q.fields.find(f=>f.id===selected)?.id??q.fields[0].id,value=drafts[`${q.id}:${field}`];
  const setValue=(next:Value)=>{const time=serverNow();if(!canEdit||time>=(state.room.cutoffAtMs??state.room.deadlineAtMs!))return;capturedAt.current=time;const updated={...latest.current,[`${q.id}:${field}`]:next};latest.current=updated;persist(updated);setDrafts(updated);setMessage('');};
  const move=(next:number)=>{if(!canEdit)return;setOrdinal(next);persist(latest.current,next);setSelected(questions[next].fields[0].id);};
  const advance=()=>{advanced.current=Math.max(advanced.current,ordinal+1);persist();};
  const submit=async()=>{const time=serverNow();if(!enabled||!canEdit||time>=(state.room.cutoffAtMs??state.room.deadlineAtMs!))return;finalizing.current=true;setSubmitting(true);setMessage('');try{await flush();await send({type:'submit',seq:seq.current+1,capturedAtMs:time});}catch(e){finalizing.current=false;if(live.current)setSubmitting(false);if(live.current)setMessage(e instanceof Error?e.message:'提出を確認できませんでした');}};
  const collecting=state.room.state==='COLLECTING';
  const finalizing=useRef(false);
  useEffect(()=>{if(!collecting||!enabled||finalizing.current||!editable||storageFailed)return;finalizing.current=true;
    void flush().then(()=>send({type:'submit',seq:seq.current+1,final:true})).catch(e=>{if(live.current)setMessage(e.message);finalizing.current=false;});
  },[collecting,enabled]);
  const totalFields=questions.reduce((n,q)=>n+q.fields.length,0),filledFields=questions.reduce((n,q)=>n+q.fields.filter(f=>!empty(drafts[`${q.id}:${f.id}`])).length,0);
  const sync=<ParticipantSyncStatus text={storageFailed?'この端末への保存を確認できません。画面を閉じずにお待ちください':message||status} action={storageFailed?'保存を再試行':undefined} onAction={()=>persist()}/>;
  const scorebar=<header className="scorebar"><span>{reviewing?'解答の確認':`第${q.ordinal+1}問 / 全${questions.length}問`}</span><span>入力済み {filledFields} / {totalFields}</span><span>残り {String(Math.floor(remaining/60)).padStart(2,'0')}:{String(remaining%60).padStart(2,'0')}</span></header>;
  if(collecting||submitting)return <main className="page-shell"><section className="panel"><h1>記録を確認しています</h1>{sync}</section></main>;
  if(waiting>0)return <main className="countdown"><p>まもなく開始</p><strong>{waiting}</strong></main>;
  if(reviewing)return <main className="play-shell play-active">{scorebar}{sync}<section className="panel"><h1>全解答確認</h1><p>各解答を確認し、必要なら問題へ戻って修正できます。</p><div className="review-question-list">{questions.map((item,index)=><DeferredReviewQuestion key={item.id} number={index+1} prompt={item.prompt} fields={item.fields.map(f=>({id:f.id,value:drafts[`${item.id}:${f.id}`]}))} disabled={!canEdit} onSelect={()=>{setReviewing(false);move(index);}}/>)}</div><p className="submit-note">提出後は変更できません。</p><button className="primary-action" type="button" disabled={!enabled||!canEdit} onClick={()=>void submit()}>提出する</button></section></main>;
  return <main className="play-shell play-active play-answering">{scorebar}{sync}<QuestionView question={q}/><section className="answer-area"><AnswerFieldTabs fields={q.fields} fieldStates={Object.fromEntries(q.fields.map(f=>[f.id,'pending']))} selectedFieldId={field} mode={settings.mode} onSelect={setSelected}/>{field==='formula'?<FormulaKeyboard value={typeof value==='object'?value:createFormulaEntry()} onChange={setValue} onSubmit={()=>{}} showSubmit={false} submitEnabled={false} kind={settings.mode} disabled={!canEdit} resetKey={q.id}/>:<NameKeyboard complexEnabled={settings.complexOnly||settings.complexEnabled} difficulty={settings.complexOnly?'normal':settings.difficulty} value={typeof value==='string'?value:''} onChange={setValue} onSubmit={()=>{}} showSubmit={false} submitEnabled={false} kind={settings.mode} disabled={!canEdit} focusKey={`${q.id}:${field}`}/>}</section><nav className="question-navigation" aria-label="問題の移動"><button type="button" disabled={!canEdit||ordinal===0} onClick={()=>move(ordinal-1)}>前の問題</button><button type="button" className={ordinal<questions.length-1?'is-emphasized':''} disabled={!canEdit||ordinal>=questions.length-1} onClick={()=>{advance();move(ordinal+1);}}>次の問題</button><button type="button" className={ordinal===questions.length-1?'is-emphasized':''} disabled={!canEdit} onClick={()=>{if(ordinal===questions.length-1)advance();setReviewing(true);void flush().catch(e=>setMessage(e.message));}}>全解答確認</button></nav></main>;
}
