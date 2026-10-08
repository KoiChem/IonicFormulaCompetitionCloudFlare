import {cleanupExpired} from '../src/persistence/cleanup';
import {authEnvironment,type IndependentEnv} from './env';
export type CleanupSummary={deletedRooms:number;deletedSiteSettingReceipts:number;deletedOAuth:number;deletedSessions:number};
export async function cleanupIndependentStorage(env:IndependentEnv,now=Date.now()):Promise<CleanupSummary>{
 const db=authEnvironment(env).DB;const rooms=await cleanupExpired(db,{nowMs:now,limit:100});
 const results=await db.batch([
  db.prepare('DELETE FROM cf_oauth_transactions WHERE state_hash IN (SELECT state_hash FROM cf_oauth_transactions WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT 100) RETURNING state_hash').bind(now),
  db.prepare('DELETE FROM cf_sessions WHERE token_hash IN (SELECT token_hash FROM cf_sessions WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT 100) RETURNING token_hash').bind(now),
 ]);return {...rooms,deletedOAuth:results[0].results?.length??0,deletedSessions:results[1].results?.length??0};
}
