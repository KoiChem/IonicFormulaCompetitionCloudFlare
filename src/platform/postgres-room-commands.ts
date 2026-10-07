import type {PersistenceDatabase} from '../persistence/db';
import {PersistenceConflictError} from '../persistence/db';
import {assertKeys,integerValue,jsonResponse,normalizeNickname,readMutationBody,requestId,safe,stringValue} from './http';
import {hashParticipantToken,readParticipantBearerToken} from './participant-auth';
type Envelope={unsupported?:boolean;status?:number;code?:string;message?:string|null;body?:unknown};
/** Runs inside the room transaction. Unsupported is the only legacy fallback. */
export async function nativeRoomCommand(db:PersistenceDatabase,request:Request,publicId:string,uid:string,kind:'join'|'ready'):Promise<Response|null>{
 let unsupported=false;
 const response=await safe(async()=>{
  const {value,bodyHash}=await readMutationBody(request);
  const tokenHash=await hashParticipantToken(readParticipantBearerToken(request));
  let row:{result:Envelope}|null;
  if(kind==='join'){
   assertKeys(value,['requestId','nickname']);const nickname=normalizeNickname(value.nickname);
   row=await db.prepare('SELECT competition_private.join_room_v1(?,?,?,?,?,?,?,?) AS result')
    .bind(publicId,uid,tokenHash,crypto.randomUUID(),requestId(value.requestId),bodyHash,nickname.nickname,nickname.nicknameKey).first<{result:Envelope}>();
  }else{
   assertKeys(value,['manifestId','preparationGeneration','evaluatorVersion']);
   row=await db.prepare('SELECT competition_private.mark_ready_v1(?,?,?,?,?,?,?) AS result')
    .bind(publicId,uid,tokenHash,request.headers.get('x-participant-id'),stringValue(value.manifestId,'manifestId',128),stringValue(value.evaluatorVersion,'evaluatorVersion',128),integerValue(value.preparationGeneration,'preparationGeneration',1)).first<{result:Envelope}>();
  }
  const result=row?.result;
  if(result?.unsupported){unsupported=true;return jsonResponse({});}
  if(!result||!result.status)throw new Error('Invalid native command envelope');
  if(result.code){
   if(result.message)return jsonResponse({error:{code:result.code,message:result.message}},result.status);
   throw new PersistenceConflictError(result.code as ConstructorParameters<typeof PersistenceConflictError>[0],'Native command rejected',result.status);
  }
  return jsonResponse(result.body,result.status);
 },true);
 return unsupported?null:response;
}
