import type {PersistenceDatabase} from '../src/persistence/db';
export type RoomNotification={type:'event';kind:'control'|'host';epoch:number;revision:number;eventId:string;roomId:string};
export type EventRoom={id:string;public_id:string;state:string;revision:number;settings_json:string;start_at_ms:number|null;deadline_at_ms:number|null;expires_at_ms:number;owner_teacher_id:string|null;mate_host_id:string|null;game_version:string;phase:string|null;prepared_at_ms:number|null;preparation_generation:number|null;collection_until_ms:number|null;cutoff_at_ms:number|null};
export async function eventRoom(db:PersistenceDatabase,publicId:string){return db.prepare(`SELECT r.*,m.state AS phase,m.prepared_at_ms,m.preparation_generation,m.collection_until_ms,m.cutoff_at_ms FROM rooms r LEFT JOIN v2_room_manifests m ON m.room_id=r.id WHERE r.public_id=?`).bind(publicId).first<EventRoom>();}
export async function reconcileRoomEvents(db:PersistenceDatabase,publicId:string,now:number):Promise<RoomNotification[]>{
 const room=await eventRoom(db,publicId);if(!room)return [];
 const phase=room.phase==='COUNTDOWN'&&room.start_at_ms!=null&&now>=room.start_at_ms?'RUNNING':room.phase??room.state;
 const control=JSON.stringify([room.state,phase,room.settings_json,room.start_at_ms,room.deadline_at_ms,room.cutoff_at_ms,room.collection_until_ms,room.preparation_generation,phase==='PREPARING'&&now>=(room.prepared_at_ms??now)+30000]);
 const participants=(await db.prepare(`SELECT p.id,p.nickname,p.status,p.current_ordinal,p.correct_count,p.revision,v.ready_generation,v.ack_seq,v.finished_elapsed_ms FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id=p.room_id AND v.participant_id=p.id WHERE p.room_id=? ORDER BY p.joined_order`).bind(room.id).all()).results;
 const host=JSON.stringify(participants);
 await db.prepare(`INSERT INTO cf_room_notifications(room_id,control_fingerprint,host_fingerprint) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET control_revision=control_revision+(control_fingerprint!=excluded.control_fingerprint),host_revision=host_revision+(host_fingerprint!=excluded.host_fingerprint),control_fingerprint=excluded.control_fingerprint,host_fingerprint=excluded.host_fingerprint`).bind(room.id,control,host).run();
 const row=await db.prepare('SELECT * FROM cf_room_notifications WHERE room_id=?').bind(room.id).first<{control_revision:number;host_revision:number;control_sent:number;host_sent:number}>();
 return (['control','host'] as const).filter(k=>row![`${k}_revision`]>row![`${k}_sent`]).map(kind=>({type:'event',kind,epoch:1,revision:row![`${kind}_revision`],eventId:`${publicId}:${kind}:${row![`${kind}_revision`]}`,roomId:publicId}));
}
export async function acknowledgeRoomEvent(db:PersistenceDatabase,roomId:string,event:RoomNotification){const kind=event.kind;await db.prepare(`UPDATE cf_room_notifications SET ${kind}_sent=MAX(${kind}_sent,?) WHERE room_id=? AND ${kind}_revision=?`).bind(event.revision,roomId,event.revision).run();}
