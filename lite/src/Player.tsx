import {useEffect,useRef,useState} from 'react';
import {QuestionView} from '../../src/games/ionic-formula/client/QuestionView';
import {FormulaKeyboard} from '../../src/games/ionic-formula/client/FormulaKeyboard';
import {NameKeyboard} from '../../src/games/ionic-formula/client/NameKeyboard';
import {createFormulaEntry} from '../../src/games/ionic-formula/client/formula-entry';
import {AnswerFieldTabs,fieldLabel} from '../../src/features/play/AnswerFieldTabs';
import {ImmediateVerdict} from '../../src/features/play/ImmediateVerdict';
import {ImmediateReviewList} from '../../src/features/play/ImmediateReviewList';
import {ParticipantSyncStatus} from '../../src/features/play/ParticipantSyncStatus';
import type {AnswerFieldId,FormulaEntry} from '../../src/games/ionic-formula/shared/types';
import type {ClientMessage,Snapshot,Verdict} from './protocol';
type Props={state:Snapshot;enabled:boolean;now:number;verdict:Verdict|null;status:string;error:string;send(message:ClientMessage):Promise<void>};
export function Player({state,enabled,now,verdict,status,error,send}:Props){
  const [review,setReview]=useState<Snapshot['review']>();const [reviewing,setReviewing]=useState(false);const [target,setTarget]=useState<{index:number;field:AnswerFieldId}|null>(null);const [confirmSubmitting,setConfirmSubmitting]=useState(false);
  const requested=useRef(false);const reviewSeq=useRef(-1);const composing=useRef(false);const compositionEndedAt=useRef(0);
  useEffect(()=>{if(state.review){reviewSeq.current=state.own!.lastSeq;setReview(state.review);requested.current=false;}},[state.review]);
  const openReview=()=>{setReviewing(true);setTarget(null);requested.current=true;void send({type:'review'});};
  useEffect(()=>{if(!target&&!state.question&&reviewSeq.current!==state.own!.lastSeq&&!requested.current&&enabled){requested.current=true;setReviewing(true);void send({type:'review'}).finally(()=>{requested.current=false;});}},[state.question,enabled,state.own!.lastSeq,target]);
  useEffect(()=>{if(target&&verdict?.correct){setTarget(null);setReviewing(true);requested.current=true;void send({type:'review'});}},[verdict]);
  useEffect(()=>{const apply=()=>document.documentElement.style.setProperty('--play-viewport-height',`${window.visualViewport?.height??innerHeight}px`);apply();window.visualViewport?.addEventListener('resize',apply);return()=>{window.visualViewport?.removeEventListener('resize',apply);document.documentElement.style.removeProperty('--play-viewport-height');};},[]);
  const settings=state.room.settings;const q=target?review?.questions[target.index]:state.question;
  const [draft,setDraft]=useState<{name:string;formula:FormulaEntry}>({name:'',formula:createFormulaEntry()});
  const key=q?`ionic-lite:draft:${state.room.code}:${state.own!.id}:${q.id}`:null;const loadedKey=useRef<string|null>(null);
  useEffect(()=>{if(!key)return;let saved;try{saved=JSON.parse(localStorage.getItem(key)??'null');}catch{}setDraft(saved??{name:'',formula:createFormulaEntry()});loadedKey.current=key;},[key]);
  const updateDraft=(next:typeof draft)=>{setDraft(next);if(key&&loadedKey.current===key)try{localStorage.setItem(key,JSON.stringify(next));}catch{}};
  const pendingFields=q?.fields.filter(f=>!q.progress.resolvedFieldIds.includes(f.id))??[];
  const [selected,setSelected]=useState<AnswerFieldId>('formula');
  useEffect(()=>{setSelected(target?.field??pendingFields[0]?.id??q?.fields[0]?.id??'formula');},[q?.id,q?.progress.resolvedFieldIds.join(','),target]);
  const field=target?.field??(pendingFields.some(f=>f.id===selected)?selected:pendingFields[0]?.id??q?.fields[0]?.id??'formula');
  const waiting=Math.max(0,Math.ceil((state.room.startAtMs!-now)/1000));const remaining=Math.max(0,Math.ceil((state.room.deadlineAtMs!-now)/1000));const disabled=!enabled||waiting>0||remaining===0;
  const answerReady=field==='name'?!!draft.name.trim():!!draft.formula.tokens.length&&(settings.mode!=='ion'||!!draft.formula.charge);
  const submit=()=>{if(!q||disabled||!answerReady||composing.current||Date.now()-compositionEndedAt.current<80)return;void send({type:'answer',seq:state.own!.lastSeq+1,questionId:q.id,fieldId:field,value:field==='name'?draft.name:draft.formula});};
  const scorebar=<header className="scorebar"><span>{reviewing?'全解答確認':`第${(q?.ordinal??0)+1}問 / 全${settings.questionCount}問`}</span><span>正解 {state.own!.correctCount} / {state.room.maxScore}</span><span>残り {String(Math.floor(remaining/60)).padStart(2,'0')}:{String(remaining%60).padStart(2,'0')}</span></header>;
  const sync=<ParticipantSyncStatus text={error||status}/>;
  const feedback=<ImmediateVerdict verdict={verdict&&!verdict.passed?{attemptId:`${state.own!.lastSeq}`,correct:verdict.correct,questionNumber:verdict.questionNumber??(q?.ordinal??0)+1,fieldLabel:fieldLabel(verdict.fieldId,settings.mode),fullScore:state.own!.correctCount===state.room.maxScore}:null}/>;
  if(waiting>0)return <main className="countdown"><p>まもなく開始</p><strong>{waiting}</strong></main>;
  if(reviewing||!q)return <main className="play-shell play-active">{scorebar}{sync}{feedback}<section className="panel"><h1>全解答確認</h1><p>パスした問題は、時間内なら後から解答できます。</p>{review&&<ImmediateReviewList questions={review.questions} frontier={review.frontier} fields={review.fields} disabled={disabled} onContinue={()=>{setReviewing(false);setTarget(null);}} onRetry={(index,field)=>{setTarget({index,field});setReviewing(false);setConfirmSubmitting(false);}}/>}<button className="secondary-button" type="button" disabled={disabled||!state.question} onClick={()=>{setTarget(null);setReviewing(false);}}>{state.question?`続きの問題へ（第${state.question.ordinal+1}問）`:'続きの問題はありません'}</button>{confirmSubmitting?<div className="immediate-submit-confirm" role="alertdialog" aria-label="提出の最終確認"><p>正解 {state.own!.correctCount} / {state.room.maxScore}、未正解 {state.room.maxScore-state.own!.correctCount}。提出後は解答に戻れません。</p><div><button type="button" onClick={()=>setConfirmSubmitting(false)}>取り消す</button><button type="button" disabled={disabled} onClick={()=>void send({type:'submit',seq:state.own!.lastSeq+1})}>提出を確定する</button></div></div>:<button className="primary-action" type="button" disabled={disabled} onClick={()=>setConfirmSubmitting(true)}>このまま提出</button>}</section></main>;
  return <main className="play-shell play-active play-answering">{scorebar}{sync}{feedback}<QuestionView question={q}/>
    <section className="answer-area" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;compositionEndedAt.current=Date.now();}}>
      <AnswerFieldTabs fields={q.fields} fieldStates={target?Object.fromEntries(q.fields.map(f=>[f.id,f.id===field?'pending':review?.fields[`${q.id}:${f.id}`]==='correct'?'correct':['passed','passedRetry'].includes(review?.fields[`${q.id}:${f.id}`]??'')?'passed':'pending'])):q.progress.fieldStates??{}} selectedFieldId={field} mode={settings.mode} onSelect={setSelected}/>
      {field==='formula'?<FormulaKeyboard value={draft.formula} onChange={formula=>updateDraft({...draft,formula})} onSubmit={submit} showSubmit={false} submitEnabled kind={settings.mode} disabled={disabled} resetKey={q.id}/>:<NameKeyboard value={draft.name} onChange={name=>updateDraft({...draft,name})} onSubmit={submit} showSubmit={false} submitEnabled kind={settings.mode} disabled={disabled} focusKey={`${q.id}:${field}`} complexEnabled={settings.complexOnly||settings.complexEnabled} difficulty={settings.complexOnly?'normal':settings.difficulty}/>}
      <div className="immediate-actions">{target?<button className="pass-action" type="button" aria-label="確認一覧へ戻る" onClick={openReview}>戻る</button>:<button className="pass-action" type="button" data-testid="pass" disabled={disabled} onClick={()=>void send({type:'pass',seq:state.own!.lastSeq+1,questionId:q.id,fieldId:field})}>パス</button>}<button className="check-action" type="button" aria-label="解答をチェック" disabled={disabled||!answerReady} onClick={submit}>チェック</button><button className="review-action" type="button" disabled={disabled} onClick={openReview}>全解答確認</button></div>
    </section>
  </main>;
}
