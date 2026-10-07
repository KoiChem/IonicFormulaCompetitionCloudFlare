import type {TransactionRunner} from './supabase-gateway';
import {cleanupExpired} from '../persistence/cleanup';
/** Scheduled recovery uses a dedicated server secret, not browser or participant credentials. */
export function createMaintenanceHandler(options:{transact:TransactionRunner;flush:(id:string)=>Promise<void>;secret?:string;now?:()=>number}){
 return async(request:Request)=>{
  if(request.method!=='POST')return Response.json({error:{code:'method_not_allowed'}},{status:405});
  if(!options.secret)return Response.json({error:{code:'maintenance_unavailable'}},{status:503});
  if(request.headers.get('authorization')!==`Bearer ${options.secret}`)return Response.json({error:{code:'forbidden'}},{status:403});
  const clock=options.now??Date.now;const now=clock();
  try{
   const pending=await options.transact('maintenance',async db=>{
    const lease=await db.prepare('UPDATE app_maintenance SET lease_until_ms=?,last_attempt_ms=? WHERE id=1 AND lease_until_ms<? RETURNING id').bind(now+55000,now,now).first();
    if(!lease)return null;
    await cleanupExpired(db,{nowMs:now,limit:40});
    await db.prepare('SELECT app_prune_auxiliary()').run();
    const rooms=(await db.prepare(`SELECT r.public_id,r.id AS room_id FROM app_outbox o JOIN rooms r ON r.id=o.room_id
      WHERE r.expires_at_ms>? GROUP BY r.public_id,r.id ORDER BY MIN(o.maintenance_attempt_ms),MIN(o.queued_at_ms),r.public_id LIMIT 8`).bind(now).all<{public_id:string;room_id:string}>()).results;
    if(rooms.length)await db.prepare(`UPDATE app_outbox SET maintenance_attempt_ms=? WHERE room_id IN (${rooms.map(()=>'?').join(',')})`).bind(now,...rooms.map(r=>r.room_id)).run();
    return rooms;
   });
   if(!pending)return Response.json({skipped:true},{status:202});
   await Promise.all(pending.map(room=>options.flush(room.public_id)));
   await options.transact('maintenance',db=>db.prepare('UPDATE app_maintenance SET last_success_ms=? WHERE id=1 AND last_attempt_ms=?').bind(clock(),now).run());
   return Response.json({checkedRooms:pending.length});
  }catch{console.error(JSON.stringify({event:'maintenance_failed'}));return Response.json({error:{code:'maintenance_unavailable'}},{status:503});}
 };
}
