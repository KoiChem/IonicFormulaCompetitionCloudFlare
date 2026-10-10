import {useEffect,useState} from 'react';
import {saveNickname} from '../../src/features/setup/saved-nickname';
export function NicknameEditor({nickname,disabled,onSave}:{nickname:string;disabled:boolean;onSave(value:string):Promise<unknown>}) {
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(nickname),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!editing)setDraft(nickname);saveNickname(localStorage,nickname);},[nickname,editing]);
  const save=async()=>{setBusy(true);setError('');try{await onSave(draft.trim());setEditing(false);}catch(e){setError(e instanceof Error?e.message:'名前を変更できませんでした');}finally{setBusy(false);}};
  return <div className="nickname-editor"><p>登録名：{nickname}</p>{editing?<><label htmlFor="lobby-nickname">名前を変更</label><input id="lobby-nickname" value={draft} maxLength={16} disabled={busy||disabled} onChange={e=>setDraft(e.target.value)}/><div className="nickname-actions"><button type="button" disabled={busy||disabled||!draft.trim()} onClick={()=>void save()}>保存</button><button type="button" disabled={busy} onClick={()=>{setEditing(false);setDraft(nickname);setError('');}}>キャンセル</button></div></>:<button type="button" disabled={disabled} onClick={()=>{setDraft(nickname);setEditing(true);}}>名前を変更</button>}{error&&<p role="alert" className="error">{error}</p>}</div>;
}
