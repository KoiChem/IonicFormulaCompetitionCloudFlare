import {createWorkerApi} from './api';
import {authEnvironment,type IndependentEnv} from './env';
import {ensureAuthConfig} from './auth/session';
import {cleanupIndependentStorage} from './maintenance';
export {RoomCoordinator} from './room';
import {PUBLIC_CONFIG} from '../src/config/public';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
export default {
 async fetch(request:Request,env:IndependentEnv):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path==='/api/health'){
   if(request.method!=='GET')return json({error:'method_not_allowed'},405);
   let d1Ready=false,authReady=false,roomCoordinatorReady=false;
   try{const row=await env.DB.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('rooms','participants','v2_operations','v2_batch_receipts','cf_auth_config','cf_google_identities','cf_sessions','cf_oauth_transactions','cf_room_notifications')").first<{count:number}>();d1Ready=row?.count===9;}catch{/* Never expose SQL or secret configuration. */}
   if(d1Ready){try{await ensureAuthConfig(authEnvironment(env));authReady=true;}catch{}}
   try{roomCoordinatorReady=await (env.ROOMS.getByName('__health__') as unknown as {status:()=>Promise<boolean>}).status();}catch{}
   return json({phase:'independent',d1Ready,authReady,roomCoordinatorReady,build:env.RELEASE_SHA,competitionBackend:'cloudflare',capacities:{class:PUBLIC_CONFIG.participantLimits.classCompetition,mate:PUBLIC_CONFIG.participantLimits.mateMatch}},d1Ready&&authReady&&roomCoordinatorReady?200:503);
  }
  if(path==='/api'||path.startsWith('/api/'))return createWorkerApi(env)(request);
  return env.ASSETS.fetch(request);
 },
 async scheduled(_controller:ScheduledController,env:IndependentEnv):Promise<void>{await cleanupIndependentStorage(env);},
} satisfies ExportedHandler<IndependentEnv>;
