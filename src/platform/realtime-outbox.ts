import type { PersistenceDatabase } from '../persistence/db';
import { reservedEventCost } from '../web/realtime-policy';
export type RoomFingerprint = {control:string;progress:string};
async function readRoom(db:PersistenceDatabase,publicId:string){
  return db.prepare(`SELECT r.id,r.public_id,r.kind,r.state,r.revision,r.owner_teacher_id,r.mate_host_id,r.settings_json,r.start_at_ms,r.deadline_at_ms,r.expires_at_ms,
    m.state AS manifest_state,m.preparation_generation,m.cutoff_at_ms,m.collection_until_ms,t.epoch
    FROM rooms r LEFT JOIN v2_room_manifests m ON m.room_id=r.id
    LEFT JOIN app_room_topics t ON t.room_id=r.id WHERE r.public_id=?`).bind(publicId).first<Record<string,any>>();
}
async function readParticipants(db:PersistenceDatabase,id:string){
  return (await db.prepare(`SELECT p.id,p.nickname,p.status,p.joined_order,p.current_ordinal,p.correct_count,p.resolved_question_count,p.revision,p.elapsed_cs,p.timing_source,
    COALESCE(v.answered_count,0) AS answered_count,v.finished_elapsed_ms,v.ready_generation
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id=p.room_id AND v.participant_id=p.id
    WHERE p.room_id=? ORDER BY p.joined_order,p.id`).bind(id).all<Record<string,any>>()).results;
}
async function fingerprint(db:PersistenceDatabase,r:Record<string,any>,includeProgress:boolean):Promise<RoomFingerprint>{
  const participants=includeProgress?await readParticipants(db,r.id):[];
  // Roster/readiness updates concern the host. Broadcasting each join to every
  // student makes a classroom burst produce quadratic state-fetch traffic.
  // Epoch changes still invalidate credentials; phase changes reach everyone.
  return {control:JSON.stringify([r.state,r.manifest_state,r.preparation_generation,r.settings_json,r.start_at_ms,r.deadline_at_ms,r.cutoff_at_ms,r.collection_until_ms,r.epoch]),
    progress:JSON.stringify(participants.map(p=>[p.id,p.nickname,p.status,p.ready_generation,p.correct_count,p.answered_count,p.revision,p.finished_elapsed_ms]))};
}
export async function roomFingerprint(db:PersistenceDatabase,publicId:string,includeProgress=true):Promise<RoomFingerprint|null>{
  const r=await readRoom(db,publicId);return r?fingerprint(db,r,includeProgress):null;
}
export async function queueRoomEvents(db:PersistenceDatabase,publicId:string,before:RoomFingerprint|null,now:number,includeProgress=true,forceHost=false){
  const room=await readRoom(db,publicId);if(!room)return;
  const next=await fingerprint(db,room,includeProgress);
  const kinds:('control'|'host')[]=[];
  if(!before||before.control!==next.control)kinds.push('control');
  if(forceHost||!before||before.progress!==next.progress)kinds.push('host');
  if(!kinds.length)return;
  const topic=await db.prepare('UPDATE app_room_topics SET progress_revision=progress_revision+1,control_revision=control_revision+1 WHERE room_id=? RETURNING epoch,progress_revision,control_revision').bind(room.id).first<{epoch:number;progress_revision:number;control_revision:number}>();
  if(!topic)return;
  for(const kind of kinds){
    const event={eventId:crypto.randomUUID(),roomId:publicId,epoch:topic.epoch,revision:kind==='host'?topic.progress_revision:topic.control_revision,roomRevision:room.revision};
    await db.prepare(`INSERT INTO app_outbox(room_id,kind,revision,payload_json,event_id) VALUES(?,?,?,?,?)
      ON CONFLICT(room_id,kind) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,event_id=excluded.event_id,lease_id=NULL,lease_until_ms=0,queued_at_ms=excluded.queued_at_ms`)
      .bind(room.id,kind,event.revision,JSON.stringify(event),event.eventId).run();
  }
}
export type BroadcastSender=(topic:string,event:string,payload:unknown)=>Promise<void>;
export async function flushRoomEvents(transact:<T>(scope:string,run:(db:PersistenceDatabase)=>Promise<T>)=>Promise<T>,publicId:string,send:BroadcastSender,now=Date.now()){
  let nextEligibleAt:number|null=null;
  const defer=(at:number)=>{nextEligibleAt=Math.min(nextEligibleAt??Infinity,at);};
  const claimStarted=Date.now();
  const claimed=await transact(`broadcast:${publicId}`,async db=>{
    const room=await readRoom(db,publicId);if(!room||room.expires_at_ms<=now)return [];
    const topic=await db.prepare('SELECT epoch,sent_control_ms,sent_progress_ms FROM app_room_topics WHERE room_id=?').bind(room.id).first<any>();
    const pending=(await db.prepare(`SELECT * FROM app_outbox WHERE room_id=? ORDER BY CASE kind WHEN 'control' THEN 0 ELSE 1 END`).bind(room.id).all<any>()).results;
    const recipients=await db.prepare(`SELECT count(*) AS count FROM participants WHERE room_id=? AND status<>'REMOVED'`).bind(room.id).first<{count:number}>();
    const hosts=1;const result=[];
    for(const event of pending){
      if(event.lease_until_ms>=now){defer(Number(event.lease_until_ms)+1);continue;}
      const eligible=Number(event.kind==='host'?topic.sent_progress_ms:topic.sent_control_ms)+1000;
      if(now<eligible){defer(eligible);continue;}
      const cost=reservedEventCost(event.kind==='host'?hosts:Number(recipients?.count??0)+(room.kind==='mate'?0:1));
      // This singleton row serializes the project-wide weighted fanout budget.
      const budget=await db.prepare('SELECT window_ms,used FROM app_broadcast_budget WHERE id=1 FOR UPDATE').first<any>();
      const window=Math.floor(now/1000)*1000;const used=budget.window_ms===window?budget.used:0;
      if(used+cost>90){defer(window+1000);continue;}
      const lease=crypto.randomUUID();
      const leased=await db.prepare('UPDATE app_outbox SET lease_id=?,lease_until_ms=? WHERE room_id=? AND kind=? AND event_id=? AND lease_until_ms<? RETURNING *').bind(lease,now+5000,room.id,event.kind,event.event_id,now).first<any>();
      if(!leased){defer(now+1000);continue;}
      await db.prepare('UPDATE app_broadcast_budget SET window_ms=?,used=? WHERE id=1').bind(window,used+cost).run();
      result.push({...leased,lease,topic:`room:${publicId}:${event.kind==='host'?'host':'control'}:${topic.epoch}`,epoch:topic.epoch});
    }
    return result;
  });
  const claimMs=Date.now()-claimStarted;
  for(const event of claimed){
    let sendMs=0;let ackMs=0;
    try{
      const stored=JSON.parse(event.payload_json);
      // Old unsent rows may contain roster data. Always rebuild the public payload.
      const payload={eventId:event.event_id,roomId:publicId,epoch:event.epoch,revision:Number(event.revision),roomRevision:Number(stored.roomRevision)};
      const current=await transact(`broadcast:${publicId}`,db=>db.prepare('SELECT epoch FROM app_room_topics WHERE room_id=?').bind(event.room_id).first<{epoch:number}>());
      if(stored.epoch!==event.epoch||current?.epoch!==event.epoch){
        await transact(`broadcast:${publicId}`,db=>db.prepare('DELETE FROM app_outbox WHERE room_id=? AND kind=? AND event_id=? AND lease_id=?').bind(event.room_id,event.kind,event.event_id,event.lease).run());
        continue;
      }
      // No transaction or connection survives the external network wait. A revoke
      // may race this send, so these notifications contain no private room data.
      const sendingAt=Date.now();
      await send(event.topic,event.kind==='host'?'host.progress':'room.changed',payload);sendMs=Date.now()-sendingAt;
      const ackAt=Date.now();
      await transact(`broadcast:${publicId}`,async db=>{
        const removed=await db.prepare('DELETE FROM app_outbox WHERE room_id=? AND kind=? AND event_id=? AND lease_id=? RETURNING event_id').bind(event.room_id,event.kind,event.event_id,event.lease).first();
        if(removed)await db.prepare(`UPDATE app_room_topics SET ${event.kind==='host'?'sent_progress_ms':'sent_control_ms'}=? WHERE room_id=? AND epoch=?`).bind(now,event.room_id,event.epoch).run();
        else defer(now+1000);
      });ackMs=Date.now()-ackAt;
      console.info(JSON.stringify({event:'broadcast_delivery',claimMs,sendMs,ackMs,outcome:'sent'}));
    }catch{defer(now+1000);console.info(JSON.stringify({event:'broadcast_delivery',claimMs,sendMs,ackMs,outcome:'failed'}));await transact(`broadcast:${publicId}`,async db=>{await db.prepare('UPDATE app_outbox SET lease_until_ms=0 WHERE room_id=? AND kind=? AND event_id=? AND lease_id=?').bind(event.room_id,event.kind,event.event_id,event.lease).run();});}
  }
  return {nextEligibleAt};
}

/** Bounded foreground wake-up; durable outbox is also recovered by maintenance. */
export async function retryRoomDrain(drain:()=>Promise<{nextEligibleAt:number|null}>,options:{now?:()=>number;sleep?:(ms:number)=>Promise<void>;attempts?:number}={}){
  const clock=options.now??Date.now;const sleep=options.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
  for(let attempt=0;attempt<(options.attempts??8);attempt++){
    const result=await drain();if(result.nextEligibleAt==null)return;
    await sleep(Math.min(5000,Math.max(100,result.nextEligibleAt-clock()+25)));
  }
}

/** One in-flight drain per room in this isolate; a commit during a send marks it dirty. */
export function coalescedRoomFlusher(drain:(publicId:string)=>Promise<void>){
  const rooms=new Map<string,{dirty:boolean;promise:Promise<void>}>();
  return (id:string):Promise<void>=>{
    const existing=rooms.get(id);if(existing){existing.dirty=true;return existing.promise;}
    const entry={dirty:false,promise:Promise.resolve()};rooms.set(id,entry);
    entry.promise=(async()=>{try{do{entry.dirty=false;await drain(id);}while(entry.dirty);}finally{rooms.delete(id);}})();
    return entry.promise;
  };
}
