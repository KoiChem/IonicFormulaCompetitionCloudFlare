import { transactionPoolerUrl } from './database-url';
import { postgresTransactions } from './postgres-runtime';
import { createSupabaseGateway } from './supabase-gateway';
import { verifySupabaseUser } from './supabase-identity';
import { flushRoomEvents, coalescedRoomFlusher, retryRoomDrain } from './realtime-outbox';
import {priorityTransactions} from './priority-transactions';
import {createMaintenanceHandler} from './maintenance';
import { createSharedTeacherAuthority } from './shared-teacher-authority';
import { sharedTeacherStore } from './shared-teacher-store';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
declare const EdgeRuntime:{waitUntil(promise:Promise<unknown>):void};
const required=(name:string)=>{const value=Deno.env.get(name);if(!value)throw new Error(`Missing backend configuration: ${name}`);return value;};
const url=required('SUPABASE_URL');
const key=required('SUPABASE_ANON_KEY');
const serviceKey=required('SUPABASE_SERVICE_ROLE_KEY');
const databaseUrl=Deno.env.get('COMPETITION_DATABASE_URL')??transactionPoolerUrl(required('SUPABASE_DB_URL'),
  'slktkbpvvsfpflnmpuvr','aws-0-ap-northeast-2.pooler.supabase.com');
const transact=postgresTransactions(databaseUrl);
const inspect=priorityTransactions(postgresTransactions(databaseUrl));
const read=postgresTransactions(databaseUrl);
const flush=coalescedRoomFlusher(async(publicId:string)=>{
  await retryRoomDrain(()=>flushRoomEvents(transact,publicId,async(topic,event,payload)=>{
    const result=await fetch(`${url}/realtime/v1/api/broadcast`,{method:'POST',headers:{authorization:`Bearer ${serviceKey}`,apikey:serviceKey,'content-type':'application/json'},
      body:JSON.stringify({messages:[{topic,event,payload,private:true}]}),signal:AbortSignal.timeout(3000)});
    if(!result.ok)throw new Error('Broadcast delivery failed');
  }));
});
const gateway=createSupabaseGateway({transact,inspect,read,nativeJoin:Deno.env.get('COMPETITION_NATIVE_JOIN')==='true',nativeReady:Deno.env.get('COMPETITION_NATIVE_READY')==='true',snapshotReads:Deno.env.get('COMPETITION_SNAPSHOT_READS')!=='false',verifyUser:request=>verifySupabaseUser(request,url,key),masterEmail:required('MASTER_TEACHER_EMAIL'),
  allowedOrigins:required('ALLOWED_ORIGINS').split(',').map(x=>x.trim()).filter(Boolean),flush:async id=>{EdgeRuntime.waitUntil(flush(id));}});
// Keep auxiliary retention cleanup outside foreground requests and room locks.
const maintenance=createMaintenanceHandler({transact,flush,secret:Deno.env.get('COMPETITION_MAINTENANCE_KEY')});
const store=sharedTeacherStore(transact,required('MASTER_TEACHER_EMAIL').trim().toLowerCase());
const authority=createSharedTeacherAuthority({
  now:Date.now,masterEmail:required('MASTER_TEACHER_EMAIL'),
  lookupRegistry:store.lookupRegistry,readSecret:name=>Deno.env.get(name),claimRequest:store.claimRequest,
  verifyRemoteUser:(authUrl,publishableKey,bearerToken)=>verifySupabaseUser(
    new Request(`${authUrl}/auth/v1/user`,{headers:{authorization:`Bearer ${bearerToken}`}}),authUrl,publishableKey),
  readAllowlist:store.readAllowlist,mutateAllowlist:store.mutateAllowlist,
});
Deno.serve(async request=>{const path=new URL(request.url).pathname;return path.endsWith('/maintenance')?maintenance(request):path.endsWith('/shared-teacher')?authority(request):gateway(request);});
