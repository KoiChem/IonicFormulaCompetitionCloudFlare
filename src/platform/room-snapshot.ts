import type {PersistenceDatabase} from '../persistence/db';
import type {RoomRow} from './http';
import {hashParticipantToken} from './participant-auth';

export type SnapshotRoom=RoomRow & {
  topic_epoch:number|null; participant_id:string|null; participant_status:'ACTIVE'|'FINISHED'|'REMOVED';
  participant_nickname:string; membership_uid:string|null; token_hash:string;
  collection_until_ms:number|null; all_finished:boolean; boundary_ready:boolean;
};
/** One MVCC snapshot includes the room, credential binding, and transition guards. */
export async function readSnapshotRoom(db:PersistenceDatabase,publicId:string,uid:string,credential:string|null){
  const token=credential? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(credential)?.[1]:undefined;
  const hash=token?await hashParticipantToken(token):'';
  return db.prepare(`SELECT r.*, v.state AS v2_phase, v.collection_until_ms, t.epoch AS topic_epoch,
      p.id AS participant_id,p.status AS participant_status,p.nickname AS participant_nickname,p.token_hash,
      b.uid AS membership_uid,
      EXISTS(SELECT 1 FROM participants a WHERE a.room_id=r.id AND a.status<>'REMOVED') AND
      NOT EXISTS(SELECT 1 FROM participants a LEFT JOIN v2_participant_progress g ON g.room_id=a.room_id AND g.participant_id=a.id
        WHERE a.room_id=r.id AND a.status<>'REMOVED' AND g.finished_elapsed_ms IS NULL) AS all_finished,
      NOT EXISTS(SELECT 1 FROM participants a LEFT JOIN v2_participant_progress g ON g.room_id=a.room_id AND g.participant_id=a.id
        WHERE a.room_id=r.id AND a.status<>'REMOVED' AND g.finished_elapsed_ms IS NULL AND g.boundary_ack_at_ms IS NULL) AS boundary_ready
    FROM rooms r LEFT JOIN v2_room_manifests v ON v.room_id=r.id
    LEFT JOIN app_room_topics t ON t.room_id=r.id
    LEFT JOIN participants p ON p.room_id=r.id AND p.token_hash=?
    LEFT JOIN app_memberships b ON b.room_id=p.room_id AND b.participant_id=p.id
    WHERE r.public_id=?`).bind(hash,publicId).first<SnapshotRoom>();
}
export function snapshotNeedsTransition(room:SnapshotRoom,now:number){
  if(room.expires_at_ms<=now||['CANCELLED','EXPIRED','FINISHED'].includes(room.state))return false;
  if(room.game_version!=='2')return room.deadline_at_ms!=null&&now>=room.deadline_at_ms;
  if(room.v2_phase==='COUNTDOWN')return room.all_finished||room.deadline_at_ms!=null&&now>=room.deadline_at_ms;
  if(room.v2_phase==='COLLECTING')return room.boundary_ready||now>=(room.collection_until_ms??(room.deadline_at_ms??Infinity)+10000);
  return false;
}
