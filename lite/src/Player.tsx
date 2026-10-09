import {useEffect,useState} from 'react';
import {QuestionView} from '../../src/games/ionic-formula/client/QuestionView';
import {FormulaKeyboard} from '../../src/games/ionic-formula/client/FormulaKeyboard';
import {NameKeyboard} from '../../src/games/ionic-formula/client/NameKeyboard';
import {createFormulaEntry} from '../../src/games/ionic-formula/client/formula-entry';
import {AnswerFieldTabs,fieldLabel} from '../../src/features/play/AnswerFieldTabs';
import type {AnswerFieldId,FormulaEntry} from '../../src/games/ionic-formula/shared/types';
import type {ClientMessage,Snapshot,Verdict} from './protocol';
type Props={state:Snapshot;enabled:boolean;now:number;verdict:Verdict|null;send(message:ClientMessage):Promise<void>};
export function Player({state,enabled,now,verdict,send}:Props){
  const q=state.question!,settings=state.room.settings;
  const key=`ionic-lite:draft:${state.room.code}:${state.own!.id}:${q.id}`;
  const [draft,setDraft]=useState<{name:string;formula:FormulaEntry}>(()=>{try{return JSON.parse(localStorage.getItem(key)??'null')??{name:'',formula:createFormulaEntry()};}catch{return {name:'',formula:createFormulaEntry()};}});
  const fieldStates=q.progress.fieldStates??{};
  const pendingFields=q.fields.filter(f=>!q.progress.resolvedFieldIds.includes(f.id));
  const [selected,setSelected]=useState<AnswerFieldId>(pendingFields[0]?.id??q.fields[0].id);
  useEffect(()=>{if(q.progress.resolvedFieldIds.includes(selected)&&pendingFields[0])setSelected(pendingFields[0].id);},[q.progress.resolvedFieldIds.join(','),selected]);
  useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(draft));}catch{}},[draft,key]);
  const waiting=Math.max(0,Math.ceil((state.room.startAtMs!-now)/1000));
  const remaining=Math.max(0,Math.ceil((state.room.deadlineAtMs!-now)/1000));
  const disabled=!enabled||waiting>0||remaining===0;
  const submit=()=>send({type:'answer',seq:state.own!.lastSeq+1,questionId:q.id,fieldId:selected,value:selected==='name'?draft.name:draft.formula});
  return <main className="play-shell lite-play"><section className="panel wide">
    <div className="lite-player-top"><strong>{state.own!.nickname}</strong><span>正解 {state.own!.correctCount} / {state.room.maxScore}</span><span>残り {Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</span></div>
    {waiting>0&&<p className="lite-countdown" role="status">{waiting}秒後に開始</p>}
    <h1>第{q.ordinal+1}問 / {settings.questionCount}問</h1><QuestionView question={q}/>
    <AnswerFieldTabs fields={q.fields} fieldStates={fieldStates} selectedFieldId={selected} mode={settings.mode} onSelect={setSelected}/>
    <section className="answer-card" aria-label={fieldLabel(selected,settings.mode)}>
      {selected==='formula'?<FormulaKeyboard value={draft.formula} onChange={formula=>setDraft({...draft,formula})} onSubmit={()=>void submit()} disabled={disabled} kind={settings.mode} resetKey={`${q.id}:${selected}`}/>:<NameKeyboard value={draft.name} onChange={name=>setDraft({...draft,name})} onSubmit={()=>void submit()} disabled={disabled} kind={settings.mode} focusKey={`${q.id}:${selected}`} complexEnabled={settings.complexOnly||settings.complexEnabled} difficulty={settings.difficulty}/>}
      <div className="lite-answer-footer"><button type="button" className="secondary-button" data-testid="pass" disabled={disabled} onClick={()=>void send({type:'pass',seq:state.own!.lastSeq+1,questionId:q.id,fieldId:selected})}>パス</button><p aria-live="polite" className={`verdict ${verdict?.correct?'correct':'incorrect'}`}>{verdict?(verdict.passed?'パスしました':verdict.correct?'○ 正解':'× 不正解。もう一度回答できます'):' '}</p></div>
    </section>
    {!remaining&&<p role="status">制限時間になりました。結果を受信しています。</p>}
    <a className="secondary-link" href="#/">ホームへ戻る</a>
  </section></main>;
}
