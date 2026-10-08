import {DurableObject} from 'cloudflare:workers';
import type {IndependentEnv} from './env';
import {authEnvironment} from './env';
import {executeRoomRequest} from './api';
import {ensureAuthConfig} from './auth/session';
import {authorizeRoomConnection,type RoomPrincipal} from './room-authority';
import {eventRoom,reconcileRoomEvents,acknowledgeRoomEvent,type EventRoom} from './room-events';
import {safe,jsonResponse,ApiError} from '../src/platform/http';
import {maybeFinalizeV2Room} from '../src/persistence/v2-results';
import {finalizeRoom} from '../src/persistence/results';
type Attachment={publicId:string;pendingUntil?:number;principal?:RoomPrincipal};
export class RoomCoordinator extends DurableObject<IndependentEnv>{
 async status():Promise<boolean>{return true;}
 private tail:Promise<void>=Promise.resolve();
 private publicId:string|null=null;
 constructor(ctx:DurableObjectState,env:IndependentEnv){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{this.publicId=await ctx.storage.get<string>('publicId')??null;});ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));}
 private enqueue<T>(action:()=>Promise<T>):Promise<T>{const result=this.tail.then(action);this.tail=result.then(()=>undefined,()=>undefined);return result;}
 fetch(request:Request):Promise<Response>{const receivedAtMs=Date.now();return this.enqueue(()=>safe(async()=>{
  const match=/^\/api\/rooms\/([A-Za-z0-9_-]{1,128})\//.exec(new URL(request.url).pathname);if(!match)return jsonResponse({error:{code:'not_found'}},404);
  const publicId=match[1];if(this.publicId&&this.publicId!==publicId)throw new ApiError(400,'invalid_room','ルームが一致しません');if(!this.publicId){await this.ctx.storage.put('publicId',publicId);this.publicId=publicId;}
  // Persist a recovery alarm before executing a D1 command. D1 remains authoritative after eviction.
  await this.ctx.storage.setAlarm(Date.now()+1000);
  if(new URL(request.url).pathname.endsWith('/realtime'))return this.upgrade(request,publicId);
  const response=await executeRoomRequest(this.env,request);
  await this.synchronize();
  if(response.ok&&new URL(request.url).pathname.endsWith('/state')){
   const payload=await response.json() as Record<string,unknown>;const p=await authorizeRoomConnection(authEnvironment(this.env).DB,request,publicId,Date.now(),authEnvironment(this.env));
   payload.serverTiming={receivedAtMs,sentAtMs:Date.now()};
   payload.realtime={epoch:1,role:p.role,control:`room:${publicId}:control:1`,...(p.role!=='participant'?{host:`room:${publicId}:host:1`}:{})};return jsonResponse(payload,response.status);
  }
  return response;
 }));}
 private async upgrade(request:Request,publicId:string){
  if(request.method!=='GET'||request.headers.get('upgrade')?.toLowerCase()!=='websocket')return jsonResponse({error:{code:'upgrade_required'}},426);
  if(new URL(request.url).origin!==this.env.APP_ORIGIN||request.headers.get('origin')!==this.env.APP_ORIGIN)throw new ApiError(403,'origin_forbidden','別のサイトからの接続は受け付けません');
  const db=authEnvironment(this.env).DB,room=await eventRoom(db,publicId);if(!room)throw new ApiError(404,'not_found','ルームが見つかりません');if(room.expires_at_ms<=Date.now())throw new ApiError(410,'expired','閲覧期限を過ぎています');
  const principal=request.headers.has('cookie')&&new URL(request.url).searchParams.get('mode')!=='participant'?await authorizeRoomConnection(db,request,publicId,Date.now(),authEnvironment(this.env)):undefined;
  if(this.ctx.getWebSockets().length>=110)throw new ApiError(429,'connection_limit','接続数の上限です');
  await this.synchronize();
  await this.ctx.storage.setAlarm(Date.now()+1000);
  const pair=new WebSocketPair();const [client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);server.serializeAttachment({publicId,...(principal?{principal}:{pendingUntil:Date.now()+5000})} satisfies Attachment);
  return new Response(null,{status:101,webSocket:client});
 }
 webSocketMessage(ws:WebSocket,message:string|ArrayBuffer):Promise<void>{return this.enqueue(async()=>{
  const a=ws.deserializeAttachment() as Attachment;
  if(typeof message!=='string'||new TextEncoder().encode(message).byteLength>4096){ws.close(1008,'invalid message');return;}
  if(a.principal){try{if(JSON.parse(message).type!=='authenticate')throw new Error();const room=await eventRoom(authEnvironment(this.env).DB,a.publicId);if(!room||!(await this.validSockets(room,Date.now())).some(x=>x.ws===ws))return;ws.send(JSON.stringify({type:'authenticated',role:a.principal.role,epoch:1}));}catch{ws.close(1008,'unexpected message');}return;}
  if(!a.pendingUntil||Date.now()>=a.pendingUntil){ws.close(1008,'authentication expired');return;}
  try{const data=JSON.parse(message);if(data.type!=='authenticate'||typeof data.token!=='string')throw new Error();
   const request=new Request(this.env.APP_ORIGIN+'/api/rooms/'+a.publicId+'/state',{headers:{authorization:'Bearer '+data.token}});
   a.principal=await authorizeRoomConnection(authEnvironment(this.env).DB,request,a.publicId,Date.now(),authEnvironment(this.env));delete a.pendingUntil;ws.serializeAttachment(a);ws.send(JSON.stringify({type:'authenticated',role:a.principal.role,epoch:1}));await this.synchronize();
  }catch{ws.close(1008,'authentication rejected');}
 });}
 webSocketClose(ws:WebSocket,code:number):void{ws.close(code===1005?1000:code);}
 webSocketError(ws:WebSocket):void{ws.close(1011,'connection error');}
 private async validSockets(room:EventRoom,now:number){
  const db=authEnvironment(this.env).DB;
  const people=(await db.prepare('SELECT id,token_hash,status FROM participants WHERE room_id=?').bind(room.id).all<{id:string;token_hash:string;status:string}>()).results;
  const sessions=(await db.prepare(`SELECT s.token_hash,s.sub,s.expires_at_ms,i.email FROM cf_sessions s JOIN cf_google_identities i ON i.sub=s.sub WHERE s.sub=? AND s.expires_at_ms>?`).bind(room.owner_teacher_id??'',now).all<{token_hash:string;sub:string;expires_at_ms:number;email:string}>()).results;
  const list=await db.prepare('SELECT emails_json FROM teacher_allowlist WHERE id=1').first<{emails_json:string}>();const emails=new Set<string>(JSON.parse(list?.emails_json??'[]'));emails.add((this.env.MASTER_TEACHER_EMAIL??'').trim().toLowerCase());
  let teachersReady=false;try{await ensureAuthConfig(authEnvironment(this.env));teachersReady=true;}catch{}
  const valid:Array<{ws:WebSocket;p:RoomPrincipal}>=[];
  for(const ws of this.ctx.getWebSockets()){
   const a=ws.deserializeAttachment() as Attachment,p=a?.principal;
   if(!p){if(!a?.pendingUntil||a.pendingUntil<=now||room.expires_at_ms<=now)ws.close(1008,'authentication expired');continue;}
   const ok=p.expiresAtMs>now&&room.expires_at_ms>now&&(p.role==='teacher'?teachersReady&&p.id===room.owner_teacher_id&&sessions.some(s=>s.sub===p.id&&s.token_hash===p.sessionHash&&emails.has(s.email)):people.some(x=>x.id===p.id&&x.token_hash===p.tokenHash&&x.status!=='REMOVED'));
   if(ok)valid.push({ws,p});else ws.close(1008,'authorization expired');
  }
  return valid;
 }
 private async synchronize(){
  if(!this.publicId)return;const now=Date.now(),db=authEnvironment(this.env).DB;const room=await eventRoom(db,this.publicId);
  if(!room){for(const ws of this.ctx.getWebSockets())ws.close(1008,'room expired');await this.ctx.storage.deleteAlarm();return;}
  const events=await reconcileRoomEvents(db,this.publicId,now),sockets=await this.validSockets(room,now);
  let hostNext=await this.ctx.storage.get<number>('hostNext')??0;let pendingHost=false;
  for(const event of events){if(event.kind==='host'&&now<hostNext){pendingHost=true;continue;}for(const {ws,p} of sockets)if(event.kind==='control'||p.role!=='participant'){try{ws.send(JSON.stringify(event));}catch{/* Revision remains recoverable via authoritative HTTP snapshot. */}}
   await acknowledgeRoomEvent(db,room.id,event);if(event.kind==='host'){hostNext=now+2000;await this.ctx.storage.put('hostNext',hostNext);}
  }
  const due=[room.expires_at_ms];if(pendingHost)due.push(hostNext);
  if(room.phase==='PREPARING'&&room.prepared_at_ms!=null&&room.prepared_at_ms+30000>now)due.push(room.prepared_at_ms+30000);
  if(room.phase==='COUNTDOWN'){if(room.start_at_ms!=null&&room.start_at_ms>now)due.push(room.start_at_ms);if(room.deadline_at_ms!=null)due.push(room.deadline_at_ms);}
  if(room.phase==='COLLECTING'&&room.collection_until_ms!=null)due.push(room.collection_until_ms);
  for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment() as Attachment;if(a.pendingUntil)due.push(a.pendingUntil);if(a.principal)due.push(a.principal.expiresAtMs);}
  const future=due.filter(x=>x>now);if(future.length)await this.ctx.storage.setAlarm(Math.min(...future));else await this.ctx.storage.deleteAlarm();
 }
 alarm():Promise<void>{return this.enqueue(async()=>{
  if(!this.publicId)return;const db=authEnvironment(this.env).DB,room=await eventRoom(db,this.publicId);if(room&&room.expires_at_ms>Date.now()){
   if(room.game_version==='2'&&['COUNTDOWN','COLLECTING'].includes(room.phase??''))await maybeFinalizeV2Room(db,{roomId:room.id,nowMs:Date.now()});
   else if(room.game_version!=='2'&&['COUNTDOWN','RUNNING'].includes(room.state)&&room.deadline_at_ms!=null&&Date.now()>=room.deadline_at_ms)await finalizeRoom(db,{roomId:room.id,requestId:'alarm-'+room.deadline_at_ms,bodyHash:'alarm-'+room.deadline_at_ms,nowMs:Date.now()});
  }
  await this.synchronize();
 });}
}
