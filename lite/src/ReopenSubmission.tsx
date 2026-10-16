import {useEffect,useId,useRef,useState} from 'react';

const caution='差し戻すと提出済みの状態が解除されます。同点の場合の着順は、再提出の時刻で決まります。全員の提出が完了した後や、競技終了後は差し戻せません。';

export function ReopenSubmission({disabled,onConfirm}:{disabled:boolean;onConfirm():Promise<unknown>}) {
 const cautionId=useId(),titleId=useId();
 const [confirming,setConfirming]=useState(false),[sending,setSending]=useState(false);
 const trigger=useRef<HTMLButtonElement>(null),title=useRef<HTMLHeadingElement>(null),restoreFocus=useRef(false);
 useEffect(()=>{if(confirming)title.current?.focus();else if(restoreFocus.current){restoreFocus.current=false;trigger.current?.focus();}},[confirming]);
 const cancel=()=>{if(sending)return;restoreFocus.current=true;setConfirming(false);};
 async function confirm(){
  if(disabled||sending)return;
  setSending(true);
  try{await onConfirm();restoreFocus.current=true;setConfirming(false);}catch{/* The room screen displays the request error and latest server state. */}
  finally{setSending(false);}
 }
 return <section className="reopen-submission" aria-label="提出した解答の修正" onKeyDown={event=>{if(event.key==='Escape'&&confirming&&!sending){event.preventDefault();cancel();}}}>
  {confirming?<div className="reopen-confirmation" role="alertdialog" aria-labelledby={titleId} aria-describedby={cautionId} aria-busy={sending}>
   <h2 ref={title} id={titleId} tabIndex={-1}>提出を差し戻して修正しますか？</h2>
   <p id={cautionId} className="reopen-caution">{caution}</p>
   <div className="reopen-actions">
    <button type="button" className="primary-action reopen-confirm" disabled={disabled||sending} onClick={()=>void confirm()}>{sending?'差し戻しています…':'差し戻して修正する'}</button>
    <button type="button" className="secondary-button reopen-cancel" disabled={sending} onClick={cancel}>修正せずに戻る</button>
   </div>
  </div>:<>
   <button ref={trigger} type="button" className="primary-action reopen-request" aria-describedby={cautionId} aria-expanded={false} disabled={disabled} onClick={()=>setConfirming(true)}>解答を修正する</button>
   <p id={cautionId} className="reopen-caution">{caution}</p>
  </>}
 </section>;
}
