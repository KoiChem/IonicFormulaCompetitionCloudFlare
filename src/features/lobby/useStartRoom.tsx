import {useEffect,useRef,useState} from 'react';
import {ownerIdentity} from '../../web/auth';
import {fetchJsonWithTimeout,postJson,type RoomView} from '../play/useRoomSync';
import {StartController,type StartStatus,type StartView} from './start-controller';
export function useStartRoom(roomId:string,token:string|undefined,room:RoomView|undefined,refresh:()=>Promise<unknown>){
 const [view,setView]=useState<StartView>({phase:'idle',message:''});
 const controller=useRef<StartController|null>(null);const refreshRef=useRef(refresh);refreshRef.current=refresh;
 useEffect(()=>{
  let live=true;
  void ownerIdentity(token).then(ownerKey=>{
   if(!live)return;
   const assertOwner=async()=>{const latest=await ownerIdentity(token);if(latest!==ownerKey)throw Object.assign(new Error('参加資格が変わりました。ページを再読み込みしてください。'),{status:403});};
   const current=new StartController({storage:localStorage,roomId,ownerKey,now:Date.now,uuid:()=>crypto.randomUUID(),onChange:setView,visible:()=>!document.hidden,online:()=>navigator.onLine,
    post:async body=>{await assertOwner();return postJson(`/api/rooms/${encodeURIComponent(roomId)}/start`,body,{token});},
    status:async requestId=>{
     await assertOwner();
     try{return await fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/start-status?requestId=${encodeURIComponent(requestId)}`,{cache:'no-store',headers:token?{authorization:`Bearer ${token}`}:undefined},5000) as StartStatus;}
     catch(error){if((error as {status?:number}).status!==404)throw error;
      const state=await fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/state`,{cache:'no-store',headers:token?{authorization:`Bearer ${token}`}:undefined},5000);
      return {requestId,receipt:null,room:{...state.room,...state.v2}} as StartStatus;
     }
    },refresh:()=>refreshRef.current()});
   controller.current=current;void current.resume();
  }).catch(()=>{if(live)setView({phase:'rejected',message:'参加資格を確認できません。再接続してください。'});});
  const wake=()=>{if(!document.hidden)void controller.current?.check();};
  const auth=()=>{void ownerIdentity(token).then(ownerKey=>{const current=controller.current;if(current&&current.key!==`ionic-formula-competition:start:${roomId}:${ownerKey}`){current.dispose();controller.current=null;setView({phase:'rejected',message:'参加資格が変わりました。ページを再読み込みしてください。'});}}).catch(()=>{});};
  document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);window.addEventListener('storage',auth);window.addEventListener('ionic-auth-change',auth);
  return()=>{live=false;controller.current?.dispose();controller.current=null;document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);window.removeEventListener('storage',auth);window.removeEventListener('ionic-auth-change',auth);};
 },[roomId,token]);
 useEffect(()=>{if(room)controller.current?.observe(room.state,room.revision);},[room?.state,room?.revision]);
 const begin=async()=>{
  if(!room||!controller.current)return;
  const current=controller.current;
  const run=async()=>{const saved=localStorage.getItem(current.key);if(saved&&!current.pending){await current.resume();return;}await current.begin(room.revision,room.playProtocolVersion===2?2:1);};
  try{if(navigator.locks?.request)await navigator.locks.request(current.key,{ifAvailable:true},async lock=>{if(lock)await run();else{await current.resume();await refreshRef.current().catch(()=>{});}});else await run();}catch{setView({phase:'rejected',message:'開始要求を保存できません。ページを再読み込みしてください。'});}
 };
 return {view,begin,busy:['submitting','checking','unresolved'].includes(view.phase)||(view.phase==='confirmed'&&room?.state==='WAITING'),check:()=>controller.current?.check()};
}
export function StartStatusPanel({start}:{start:ReturnType<typeof useStartRoom>}){
 if(!start.view.message)return null;
 return <section className="panel" aria-label="開始状況"><p role={start.view.phase==='rejected'?'alert':'status'}>{start.view.message}</p>{start.busy&&<button type="button" onClick={()=>void start.check()}>開始状況を再確認</button>}</section>;
}
