import type {PersistenceDatabase} from '../src/persistence/db';
import {requireParticipant,hashParticipantToken} from '../src/platform/participant-auth';
import {readAuthSession} from './auth/session';
import type {AuthEnvironment} from './auth/types';
import {readCookie} from './auth/store';
import {ApiError} from '../src/platform/http';
export type RoomPrincipal={role:'teacher'|'host'|'participant';id:string;roomId:string;publicId:string;expiresAtMs:number;sessionHash?:string;tokenHash?:string};
export async function authorizeRoomConnection(db:PersistenceDatabase,request:Request,publicId:string,now:number,auth:AuthEnvironment):Promise<RoomPrincipal>{
 const room=await db.prepare('SELECT id,expires_at_ms,owner_teacher_id,mate_host_id FROM rooms WHERE public_id=?').bind(publicId).first<{id:string;expires_at_ms:number;owner_teacher_id:string|null;mate_host_id:string|null}>();
 if(!room)throw new ApiError(404,'not_found','ルームが見つかりません');if(room.expires_at_ms<=now)throw new ApiError(410,'expired','閲覧期限を過ぎています');
 if(request.headers.has('authorization')){const p=await requireParticipant(db,request,room.id);return {role:p.participantId===room.mate_host_id?'host':'participant',id:p.participantId,tokenHash:p.tokenHash,roomId:room.id,publicId,expiresAtMs:room.expires_at_ms};}
 const session=await readAuthSession(request,auth,now);if(!session.identity)throw new ApiError(401,'authentication_required','ログインが必要です');if(room.owner_teacher_id!==session.identity.id)throw new ApiError(403,'room_owner_forbidden','このルームの教員ではありません');
 return {role:'teacher',id:session.identity.id,roomId:room.id,publicId,expiresAtMs:Math.min(room.expires_at_ms,session.expiresAtMs!),sessionHash:await hashParticipantToken(readCookie(request,'__Host-ionic-session')!)};
}
