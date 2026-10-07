import type { PersistenceDatabase } from '../persistence/db';
import type { TransactionRunner } from './supabase-gateway';
import type { SharedTeacherAllowlist, SharedTeacherMutation, SharedTeacherRegistry } from './shared-teacher-authority';

export function sharedTeacherStore(transact:TransactionRunner,masterEmail:string){
  return {
    lookupRegistry:(appId:string):Promise<SharedTeacherRegistry|null>=>transact(`shared-registry:${appId}`,async db=>{
      const row=await db.prepare('SELECT app_id,auth_url,publishable_key,secret_env_name FROM shared_teacher_callers WHERE app_id=? AND enabled=true')
        .bind(appId).first<{app_id:string;auth_url:string;publishable_key:string;secret_env_name:string}>();
      return row?{appId:row.app_id,authUrl:row.auth_url,publishableKey:row.publishable_key,secretName:row.secret_env_name}:null;
    }),
    claimRequest:(appId:string,requestId:string,issuedAtMs:number):Promise<boolean>=>transact(`shared-request:${appId}:${requestId}`,async db=>{
      const row=await db.prepare('INSERT INTO shared_teacher_requests(app_id,request_id,issued_at_ms) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING request_id')
        .bind(appId,requestId,issuedAtMs).first<{request_id:string}>();
      if(crypto.getRandomValues(new Uint32Array(1))[0]%200===0){
        await db.prepare('DELETE FROM shared_teacher_requests WHERE issued_at_ms<?').bind(Date.now()-120_000).run();
      }
      return !!row;
    }),
    readAllowlist:():Promise<SharedTeacherAllowlist>=>transact('shared-allowlist-read',async db=>{
      await ensureMasterConfig(db,masterEmail);return readAllowlist(db);
    }),
    mutateAllowlist:(value:SharedTeacherMutation & {bodyHash:string}):Promise<boolean>=>transact('shared-allowlist',async db=>{
      await ensureMasterConfig(db,masterEmail);
      await db.prepare('INSERT INTO teacher_allowlist(id) VALUES(1) ON CONFLICT DO NOTHING').run();
      const current=await readAllowlist(db);
      if(current.revision!==value.expectedRevision)return false;
      const emails=new Set(current.emails);
      value.enabled?emails.add(value.email):emails.delete(value.email);
      if(emails.size>100)return false;
      const updated=await db.prepare('UPDATE teacher_allowlist SET emails_json=?,revision=revision+1,last_request_id=?,last_body_hash=? WHERE id=1 AND revision=? RETURNING revision')
        .bind(JSON.stringify([...emails].sort()),value.requestId,value.bodyHash,value.expectedRevision).first<{revision:number}>();
      return !!updated;
    }),
  };
}
async function ensureMasterConfig(db:PersistenceDatabase,masterEmail:string){
  await db.prepare('INSERT INTO app_auth_config(id,master_email) VALUES(1,?) ON CONFLICT DO NOTHING').bind(masterEmail).run();
  const configured=await db.prepare('SELECT master_email FROM app_auth_config WHERE id=1').first<{master_email:string}>();
  if(configured?.master_email!==masterEmail)throw new Error('Master identity configuration differs');
}
async function readAllowlist(db:PersistenceDatabase):Promise<SharedTeacherAllowlist>{
  const row=await db.prepare('SELECT emails_json,revision,last_request_id,last_body_hash FROM teacher_allowlist WHERE id=1')
    .first<{emails_json:string;revision:number;last_request_id:string|null;last_body_hash:string|null}>();
  return row?{emails:JSON.parse(row.emails_json),revision:row.revision,
    lastOperation:row.last_request_id&&row.last_body_hash?{requestId:row.last_request_id,bodyHash:row.last_body_hash}:null}
    :{emails:[],revision:0,lastOperation:null};
}
