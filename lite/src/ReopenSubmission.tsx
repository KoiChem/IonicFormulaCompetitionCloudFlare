import {useId,useRef,useState} from 'react';
export function ReopenSubmission({disabled,onConfirm}:{disabled:boolean;onConfirm():Promise<unknown>}) {
 const cautionId=useId(),confirmationId=useId();
 const [confirm,setConfirm]=useState(false);const trigger=useRef<HTMLButtonElement>(null);
 const cancel=()=>{setConfirm(false);trigger.current?.focus();};
 return <div><button ref={trigger} type="button" aria-describedby={cautionId} aria-expanded={confirm} disabled={disabled} onClick={()=>setConfirm(true)}>差し戻しを希望する</button><p id={cautionId}>差し戻すと提出済みの状態が解除されます。同点の場合の着順は、再提出の時刻で決まります。全員の提出が完了した後や、競技終了後は差し戻せません。</p>{confirm&&<div role="alertdialog" aria-label="差し戻しの確認" aria-describedby={confirmationId} onKeyDown={event=>{if(event.key==='Escape')cancel();}}><p id={confirmationId}>提出済みの状態を解除して解答に戻りますか？</p><button autoFocus type="button" onClick={cancel}>取り消す</button><button type="button" disabled={disabled} onClick={()=>{void onConfirm().then(()=>setConfirm(false)).catch(()=>{});}}>差し戻して解答に戻る</button></div>}</div>;
}
