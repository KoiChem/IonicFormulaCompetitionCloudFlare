import { googleIdentity, type VerifiedUser } from './supabase-identity';
import { normalizeTeacherEmail } from './teacher-identity';

export type SharedTeacherAction = 'authorize' | 'allowlist.get' | 'allowlist.mutate';
export type SharedTeacherMutation = { email:string; enabled:boolean; expectedRevision:number; requestId:string };
export type SharedTeacherEnvelope = { appId:string; requestId:string; issuedAtMs:number; action:SharedTeacherAction; bearerToken:string; mutation?:SharedTeacherMutation };
export type SharedTeacherRegistry = { appId:string; authUrl:string; publishableKey:string; secretName:string };
export type SharedTeacherAllowlist = { emails:string[]; revision:number; lastOperation:{requestId:string;bodyHash:string}|null };
export type SharedTeacherAuthorityOptions = {
  now():number;
  masterEmail:string;
  lookupRegistry(appId:string):Promise<SharedTeacherRegistry|null>;
  readSecret(name:string):string|undefined;
  claimRequest(appId:string,requestId:string,issuedAtMs:number):Promise<boolean>;
  verifyRemoteUser(authUrl:string,publishableKey:string,bearerToken:string):Promise<VerifiedUser|null>;
  readAllowlist():Promise<SharedTeacherAllowlist>;
  mutateAllowlist(value:SharedTeacherMutation & {bodyHash:string}):Promise<boolean>;
};
const encoder=new TextEncoder();
const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
function reply(status:number,body:unknown){return new Response(JSON.stringify(body),{status,headers:JSON_HEADERS});}
function hex(bytes:Uint8Array){return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
export async function signSharedTeacherRequest(secret:string,body:string):Promise<string>{
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(body))));
}
async function validSignature(secret:string,body:string,signature:string|null){
  if(!signature||!/^[a-f0-9]{64}$/.test(signature))return false;
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g)!,part=>parseInt(part,16)),encoder.encode(body));
}
async function sha256(value:string){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
function validEnvelope(value:any):value is SharedTeacherEnvelope{
  return value&&typeof value==='object'&&/^[a-z0-9-]{3,64}$/.test(value.appId)&&
    /^[A-Za-z0-9_-]{16,128}$/.test(value.requestId)&&Number.isSafeInteger(value.issuedAtMs)&&
    ['authorize','allowlist.get','allowlist.mutate'].includes(value.action)&&
    typeof value.bearerToken==='string'&&value.bearerToken.length>0&&value.bearerToken.length<=8192;
}
function validMutation(value:any):value is SharedTeacherMutation{
  return value&&typeof value==='object'&&typeof value.email==='string'&&typeof value.enabled==='boolean'&&
    Number.isSafeInteger(value.expectedRevision)&&value.expectedRevision>=0&&
    typeof value.requestId==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(value.requestId);
}

/** Only a configured caller may ask this service to check a verified user in its fixed Auth project. */
export function createSharedTeacherAuthority(options:SharedTeacherAuthorityOptions){
  return async(request:Request):Promise<Response>=>{
    if(request.method!=='POST')return reply(405,{error:{code:'method_not_allowed'}});
    let body:string;
    try{body=await request.text();if(encoder.encode(body).length>12_000)return reply(413,{error:{code:'body_too_large'}});}
    catch{return reply(400,{error:{code:'invalid_request'}});}
    let envelope:unknown;
    try{envelope=JSON.parse(body);}catch{return reply(400,{error:{code:'invalid_request'}});}
    if(!validEnvelope(envelope))return reply(400,{error:{code:'invalid_request'}});
    try{
      const registry=await options.lookupRegistry(envelope.appId);
      if(!registry||registry.appId!==envelope.appId||!/^https:\/\/[^/?#]+$/.test(registry.authUrl))return reply(401,{error:{code:'caller_forbidden'}});
      const secret=options.readSecret(registry.secretName);
      if(!secret||secret.length<32||!(await validSignature(secret,body,request.headers.get('x-shared-teacher-signature'))))return reply(401,{error:{code:'caller_forbidden'}});
      if(Math.abs(options.now()-envelope.issuedAtMs)>30_000)return reply(401,{error:{code:'request_expired'}});
      if(!(await options.claimRequest(envelope.appId,envelope.requestId,envelope.issuedAtMs)))return reply(409,{error:{code:'request_replayed'}});
      const remote=await options.verifyRemoteUser(registry.authUrl,registry.publishableKey,envelope.bearerToken);
      const identity=remote&&googleIdentity(remote);
      if(!identity)return reply(403,{error:{code:'teacher_forbidden'}});
      const master=normalizeTeacherEmail(options.masterEmail);
      if(!master)return reply(503,{error:{code:'authority_unavailable'}});
      const list=await options.readAllowlist();
      const isMaster=identity.email===master;
      const allowed=isMaster||list.emails.includes(identity.email);
      if(envelope.action==='authorize')return allowed?reply(200,{allowed:true,master:isMaster,email:identity.email,revision:list.revision}):reply(403,{error:{code:'teacher_forbidden'}});
      if(!isMaster)return reply(403,{error:{code:'master_required'}});
      const view=(value:SharedTeacherAllowlist)=>({masterEmail:master,emails:value.emails,revision:value.revision});
      if(envelope.action==='allowlist.get')return reply(200,view(list));
      if(!validMutation(envelope.mutation))return reply(400,{error:{code:'invalid_request'}});
      const mutation={...envelope.mutation,email:normalizeTeacherEmail(envelope.mutation.email)};
      if(mutation.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mutation.email))return reply(400,{error:{code:'invalid_email'}});
      if(mutation.email===master)return reply(400,{error:{code:'master_fixed'}});
      const bodyHash=await sha256(JSON.stringify(mutation));
      if(list.lastOperation?.requestId===mutation.requestId){
        return list.lastOperation.bodyHash===bodyHash?reply(200,view(list)):reply(409,{error:{code:'request_id_reused'}});
      }
      if(list.revision!==mutation.expectedRevision)return reply(409,{error:{code:'stale_allowlist'}});
      if(mutation.enabled&&!list.emails.includes(mutation.email)&&list.emails.length>=100)return reply(400,{error:{code:'allowlist_limit'}});
      if(!(await options.mutateAllowlist({...mutation,bodyHash})))return reply(409,{error:{code:'stale_allowlist'}});
      return reply(200,view(await options.readAllowlist()));
    }catch{return reply(503,{error:{code:'authority_unavailable'}});}
  };
}
