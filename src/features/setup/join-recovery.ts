import {postJson,fetchJsonWithTimeout} from '../play/useRoomSync';
import type {PendingJoin} from './join-draft';
export async function submitPendingJoin(roomId:string,draft:PendingJoin):Promise<{participant:{id:string;nickname:string}}> {
 const path=`/api/rooms/${encodeURIComponent(roomId)}`;
 try {
  return await postJson(`${path}/join`,{requestId:draft.requestId,nickname:draft.nickname},{token:draft.token});
 } catch(error) {
  const failure=error as {status?:number;code?:string};
  if(failure.status && failure.status<500 && ![408,429].includes(failure.status) && failure.code!=='database_conflict')throw error;
  // A timed-out response does not imply rollback. Confirm using the saved
  // credential, including when the host has already started preparation.
  try {
   const state=await fetchJsonWithTimeout(`${path}/state`,{cache:'no-store',headers:{authorization:`Bearer ${draft.token}`}},10000);
   if(typeof state.participant?.id==='string' && typeof state.participant?.nickname==='string')return {participant:state.participant};
  } catch { /* Keep the original uncertain result and its exact retry draft. */ }
  throw error;
 }
}
