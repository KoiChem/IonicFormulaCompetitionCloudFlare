import {topRoutes,roomRoutes} from './api-routes';
import {nativeRoomCommand} from './postgres-room-commands';
import { createApiHandlers, jsonResponse } from './http';
import { hashParticipantToken } from './participant-auth';
import { googleIdentity, type VerifiedUser } from './supabase-identity';
import type { PersistenceDatabase } from '../persistence/db';
import { queueRoomEvents, roomFingerprint } from './realtime-outbox';
import {readSnapshotRoom,snapshotNeedsTransition} from './room-snapshot';

export type TransactionMetrics = {poolWaitMs:number;roomLockWaitMs:number;dbWorkMs:number;queryCount:number;controlQueryCount?:number;commandPath?:'legacy'|'native';retryCount?:number};
export type TransactionRunner = <T>(scope: string, run: (db: PersistenceDatabase) => Promise<T>, metrics?:TransactionMetrics) => Promise<T>;
export type GatewayOptions = {
  transact: TransactionRunner;
  inspect?: TransactionRunner;
  read?: TransactionRunner;
  snapshotReads?: boolean;
  nativeJoin?: boolean;
  nativeReady?: boolean;
  metricSampleRate?: number;
  verifyUser(request: Request): Promise<VerifiedUser | null>;
  masterEmail: string;
  allowedOrigins: readonly string[];
  flush(roomId: string): Promise<void>;
  now?: () => number;
};
function failure(status:number,code:string,message:string) { return jsonResponse({error:{code,message}},status); }
function withCors(response: Response, origin: string, preflight=false) {
  const headers=new Headers(response.headers);
  headers.set('access-control-allow-origin',origin);
  const vary=headers.get('vary');
  if(!vary?.split(',').some(value=>value.trim().toLowerCase()==='origin'))headers.set('vary',vary?`${vary}, Origin`:'Origin');
  if(preflight)headers.set('access-control-max-age','600');
  headers.set('access-control-allow-methods','GET,POST,PATCH,OPTIONS');
  headers.set('access-control-allow-headers','authorization,apikey,content-type,x-region,x-participant-authorization,x-competition-csrf,x-creation-key');
  headers.set('access-control-expose-headers','retry-after,x-request-id');
  return new Response(response.body,{status:response.status,headers});
}

async function teacherProvider(db: PersistenceDatabase,user:VerifiedUser,masterEmail:string,readOnly=false) {
  const identity=googleIdentity(user);
  if (!identity) return {getVerifiedIdentity:async()=>null};
  const master=masterEmail.trim().toLowerCase();
  if (!master) return {getVerifiedIdentity:async()=>null};
  if(!readOnly)await db.prepare('INSERT OR IGNORE INTO app_auth_config(id,master_email) VALUES(1,?)').bind(master).run();
  const settings=await db.prepare('SELECT master_email FROM app_auth_config WHERE id=1').first<{master_email:string}>();
  if(settings?.master_email!==master) throw new Error('Master identity configuration differs');
  const list=await db.prepare('SELECT emails_json FROM teacher_allowlist WHERE id=1').first<{emails_json:string}>();
  const permitted=identity.email===master||(JSON.parse(list?.emails_json??'[]') as string[]).includes(identity.email);
  const byUid=await db.prepare('SELECT email,active FROM app_teacher_bindings WHERE uid=?').bind(user.id).first<{email:string;active:boolean}>();
  const byEmail=await db.prepare('SELECT uid FROM app_teacher_bindings WHERE email=?').bind(identity.email).first<{uid:string}>();
  if(!permitted || (byUid && byUid.email!==identity.email) || (byEmail && byEmail.uid!==user.id)) return {getVerifiedIdentity:async()=>null};
  if(readOnly)return {getVerifiedIdentity:async()=>byUid?.active?identity:null};
  if(!byUid) await db.prepare('INSERT INTO app_teacher_bindings(uid,email) VALUES(?,?)').bind(user.id,identity.email).run();
  else if(!byUid.active) await db.prepare('UPDATE app_teacher_bindings SET active=true WHERE uid=?').bind(user.id).run();
  return {getVerifiedIdentity:async()=>identity};
}
async function associateParticipant(db:PersistenceDatabase,user:VerifiedUser,request:Request,publicId:string) {
  const authorization=request.headers.get('authorization');
  const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization??'');
  if(!match)return;
  const hash=await hashParticipantToken(match[1]);
  const participant=await db.prepare(`SELECT p.room_id,p.id,m.uid FROM participants p JOIN rooms r ON r.id=p.room_id LEFT JOIN app_memberships m ON m.room_id=p.room_id AND m.participant_id=p.id
    WHERE r.public_id=? AND p.token_hash=? AND p.status<>'REMOVED'`).bind(publicId,hash).first<{room_id:string;id:string;uid:string|null}>();
  if(!participant)return;
  if(participant.uid===user.id)return;
  const old=participant.uid;
  await db.prepare(`INSERT INTO app_memberships(room_id,participant_id,uid) VALUES(?,?,?)
    ON CONFLICT(room_id,participant_id) DO UPDATE SET uid=excluded.uid WHERE app_memberships.uid<>excluded.uid`)
    .bind(participant.room_id,participant.id,user.id).run();
  if(old&&old!==user.id) await db.prepare('INSERT INTO app_audit(actor_uid,event,room_id) VALUES(?,?,?)').bind(user.id,'participant_rebound',participant.room_id).run();
}
async function topicsFor(db:PersistenceDatabase,user:VerifiedUser,publicId:string,now:number) {
  const room=await db.prepare(`SELECT r.owner_teacher_id,r.mate_host_id,t.epoch,m.participant_id,b.uid AS teacher_uid
    FROM rooms r JOIN app_room_topics t ON t.room_id=r.id
    LEFT JOIN app_memberships m ON m.room_id=r.id AND m.uid=?
      AND EXISTS(SELECT 1 FROM participants p WHERE p.room_id=m.room_id AND p.id=m.participant_id AND p.status<>'REMOVED')
    LEFT JOIN app_teacher_bindings b ON b.uid=? AND b.active=true
    WHERE r.public_id=? AND r.expires_at_ms>? LIMIT 1`).bind(user.id,user.id,publicId,now)
    .first<{owner_teacher_id:string|null;mate_host_id:string|null;epoch:number;participant_id:string|null;teacher_uid:string|null}>();
  if(!room)return null;
  const owner=room.teacher_uid!=null&&room.teacher_uid===room.owner_teacher_id;
  if(!room.participant_id&&!owner)return null;
  const epoch=room.epoch;
  return {control:`room:${publicId}:control:${epoch}`,host:owner||room.participant_id===room.mate_host_id?`room:${publicId}:host:${epoch}`:null,epoch,role:owner?'teacher':room.participant_id===room.mate_host_id?'host':'participant'};
}

export function createSupabaseGateway(options:GatewayOptions) {
  return async (incoming:Request):Promise<Response> => {
    const wallStarted=Date.now();
    const receivedAtMs=(options.now??Date.now)();
    const origin=incoming.headers.get('origin');
    if(!origin||!options.allowedOrigins.includes(origin))return failure(403,'origin_forbidden','許可されたアプリから利用してください');
    if(incoming.method==='OPTIONS')return withCors(new Response(null,{status:204}),origin,true);
    const url=new URL(incoming.url);const marker=url.pathname.indexOf('/api/');
    if(marker<0)return withCors(failure(404,'not_found','APIが見つかりません'),origin);
    const path=url.pathname.slice(marker);const match=/^\/api\/rooms\/([A-Za-z0-9_-]{1,128})\/([a-z-]+)$/.exec(path);
    const route=topRoutes[path]??(match?roomRoutes[match[2]]:undefined);
    const realtime=match?.[2]==='realtime';
    if(!route&&!realtime)return withCors(failure(404,'not_found','APIが見つかりません'),origin);
    if(!(realtime?['GET']:route!.method).includes(incoming.method))return withCors(failure(405,'method_not_allowed','操作方法を確認してください'),origin);
    const requestId=crypto.randomUUID();
    const metrics:TransactionMetrics={poolWaitMs:0,roomLockWaitMs:0,dbWorkMs:0,queryCount:0,controlQueryCount:0,...(route?.name==='joinRoom'||route?.name==='ready'?{commandPath:'legacy' as const}:{})};
    let authMs=0;let quotaMs=0;
    const finish=(response:Response)=>{response.headers.set('x-request-id',requestId);
      if(route?.name==='startRoom'||!response.ok||Math.random()<(options.metricSampleRate??.02))console.info(JSON.stringify({event:'api_request',requestId,route:match?.[2]??path,totalMs:Date.now()-wallStarted,authMs,quotaMs,...metrics,responseStatus:response.status}));
      return withCors(response,origin);};
    try {
      const authStarted=Date.now();
      const user=await options.verifyUser(incoming);authMs=Date.now()-authStarted;
      if(!user)return finish(failure(401,'authentication_required','参加資格を確認できません'));
      const headers=new Headers(incoming.headers);
      const participant=headers.get('x-participant-authorization');headers.delete('authorization');
      if(participant)headers.set('authorization',participant);
      // Same-origin guard is still applied by the core after trusted CORS validation.
      headers.set('origin','https://competition.internal');headers.delete('sec-fetch-site');
      const request=new Request(`https://competition.internal${path}${url.search}`,{method:incoming.method,headers,body:['GET','HEAD'].includes(incoming.method)?undefined:incoming.body,duplex:'half'} as RequestInit);
      let publicId=match?.[1]??'';
      const scope=path.startsWith('/api/teacher/')?'teacher-configuration':(publicId?`room:${publicId}`:`creation:${user.id}`);
      const inspect=options.inspect??options.transact;
      const now=(options.now??Date.now)();
      const quotaStarted=Date.now();
      const limit=await inspect(`quota:${route?.name==='startStatus'||route?.name==='startRoom'?'critical:':''}${user.id}`,async db=>db.prepare(`INSERT INTO app_request_limits(bucket,window_ms,count) VALUES(?,?,1)
        ON CONFLICT(bucket) DO UPDATE SET count=app_request_limits.count+1 RETURNING count`)
        .bind(`${user.id}:${Math.floor(now/60000)}`,now).first<{count:number}>(),metrics);
      quotaMs=Date.now()-quotaStarted;
      if((limit?.count??0)>180){const limited=failure(429,'rate_limited','通信が集中しています。少し待って再試行してください');limited.headers.set('retry-after',String(Math.ceil((60000-now%60000)/1000)));return finish(limited);}
      if(route?.name==='startStatus'){
        const response=await inspect(`snapshot:${publicId}`,async db=>{
          const provider=await teacherProvider(db,user,options.masterEmail,true);
          if(participant){
            const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(participant)?.[1];
            const hash=token?await hashParticipantToken(token):'';
            const membership=await db.prepare(`SELECT m.uid FROM app_memberships m JOIN participants p ON p.room_id=m.room_id AND p.id=m.participant_id
              JOIN rooms r ON r.id=p.room_id WHERE r.public_id=? AND p.token_hash=? AND p.status<>'REMOVED' AND m.uid=?`).bind(publicId,hash,user.id).first();
            if(!membership)return failure(403,'not_authorized','参加資格を再確認してください');
          }
          const handlers=createApiHandlers({database:db,teacherIdentity:provider,serverConfig:{teacherAllowedEmails:[],masterTeacherEmail:options.masterEmail.trim().toLowerCase()},now:options.now??Date.now,random:Math.random,randomUUID:()=>crypto.randomUUID()});
          return handlers.startStatus(request,{id:publicId});
        },metrics);
        return finish(response);
      }
      if(options.snapshotReads!==false&&(realtime||route?.name==='state'||route?.name==='manifest')){
        const snapshot=await (options.read??inspect)(`snapshot:${publicId}`,async db=>{
          const room=await readSnapshotRoom(db,publicId,user.id,participant);
          if(!room)return failure(404,'not_found','ルームが見つかりません');
          // Only a legitimate credential can enter the command recovery path.
          if(participant&&room.participant_id&&room.participant_status!=='REMOVED'&&room.membership_uid!==user.id)return null;
          const provider=await teacherProvider(db,user,options.masterEmail,true);
          if(!participant&&googleIdentity(user)&&!(await provider.getVerifiedIdentity()))return null;
          const handlers=createApiHandlers({database:db,teacherIdentity:provider,serverConfig:{teacherAllowedEmails:[],masterTeacherEmail:options.masterEmail.trim().toLowerCase()},now:options.now??Date.now,random:Math.random,randomUUID:()=>crypto.randomUUID(),snapshotRoom:room,
            ...(participant&&room.participant_id&&(!request.headers.has('x-participant-id')||request.headers.get('x-participant-id')===room.participant_id)?{snapshotParticipant:{participantId:room.participant_id,tokenHash:room.token_hash,status:room.participant_status,nickname:room.participant_nickname}}:{})});
          const result=await handlers[route?.name==='manifest'?'manifest':'state'](request,{id:publicId});
          if(!result.ok)return result;
          if(route?.name!=='manifest'&&snapshotNeedsTransition(room,(options.now??Date.now)()))return null;
          const body=await result.json();
          const identity=await provider.getVerifiedIdentity();
          const owner=identity?.id===room.owner_teacher_id;
          const member=room.participant_id&&room.membership_uid===user.id&&room.participant_status!=='REMOVED';
          const topics=room.topic_epoch!=null&&room.expires_at_ms>(options.now??Date.now)()&&(owner||member)?{
            control:`room:${publicId}:control:${room.topic_epoch}`,host:owner||room.participant_id===room.mate_host_id?`room:${publicId}:host:${room.topic_epoch}`:null,
            epoch:room.topic_epoch,role:owner?'teacher':room.participant_id===room.mate_host_id?'host':'participant'}:null;
          if(realtime)return topics?jsonResponse(topics):failure(403,'not_authorized','通知を購読する権限がありません');
          return jsonResponse({...body,...(route?.name==='state'?{...(topics?{realtime:topics}:{}),serverTiming:{receivedAtMs,sentAtMs:(options.now??Date.now)()}}:{})});
        },metrics);
        if(snapshot)return finish(snapshot);
      }
      const response=await options.transact(scope,async db=>{
        const now=(options.now??Date.now)();
        const provider=await teacherProvider(db,user,options.masterEmail);
        const handlers=createApiHandlers({database:db,teacherIdentity:provider,serverConfig:{teacherAllowedEmails:[],masterTeacherEmail:options.masterEmail.trim().toLowerCase()},now:options.now??Date.now,random:()=>crypto.getRandomValues(new Uint32Array(1))[0]/0x100000000,randomUUID:()=>crypto.randomUUID()});
        if((route?.name==='joinRoom'&&options.nativeJoin)||(route?.name==='ready'&&options.nativeReady)){
          const native=await nativeRoomCommand(db,request.clone(),publicId,user.id,route.name==='joinRoom'?'join':'ready');
          if(native){metrics.commandPath='native';return native;}
        }
        const includeProgress=route?.name!=='state'&&route?.name!=='ready'&&!realtime;
        const before=publicId?await roomFingerprint(db,publicId,includeProgress):null;
        const result=await (handlers[realtime?'state':route!.name] as (r:Request,p:{id:string})=>Promise<Response>)(request.clone(),{id:publicId});
        if(!result.ok)return result;
        const body=await result.clone().json() as {room?:{id:string}};
        publicId=publicId||body.room?.id||'';
        if(publicId){
          const room=await db.prepare('SELECT id FROM rooms WHERE public_id=?').bind(publicId).first<{id:string}>();
          if(room){
            if(incoming.method!=='GET')await db.prepare('INSERT OR IGNORE INTO app_room_topics(room_id) VALUES(?)').bind(room.id).run();
            await associateParticipant(db,user,request,publicId);
            await queueRoomEvents(db,publicId,before,now,includeProgress,route?.name==='ready');
          }
          const topics=realtime||route?.name==='state'?await topicsFor(db,user,publicId,now):null;
          if(realtime)return topics?jsonResponse(topics):failure(403,'not_authorized','通知を購読する権限がありません');
          if(route?.name==='state'&&topics)return jsonResponse({...body,realtime:topics});
        }
        return result;
      },metrics);
      if(publicId)void options.flush(publicId).catch(()=>{});
      const timedResponse=route?.name==='state'&&response.ok
        ? jsonResponse({...await response.clone().json(),serverTiming:{receivedAtMs,sentAtMs:(options.now??Date.now)()}})
        : response;
      return finish(timedResponse);
    } catch(error) {
      console.error(JSON.stringify({event:'gateway_failed',category:error instanceof Error?error.name:'Unknown',code:typeof (error as {code?:unknown})?.code==='string'&&/^[A-Z0-9]{5}$/.test((error as {code:string}).code)?(error as {code:string}).code:undefined}));
      const code=(error as {code?:string}).code;
      const unavailable=failure(503,code==='55P03'?'database_busy':code==='57014'?'database_timeout':error instanceof Error&&['TimeoutError','AuthenticationUnavailableError'].includes(error.name)?'authentication_unavailable':'service_unavailable','サービスを利用できません。再試行してください');
      unavailable.headers.set('retry-after','2');return finish(unavailable);
    }
  };
}
