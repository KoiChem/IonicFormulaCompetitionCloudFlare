import {it,expect} from 'vitest';
import {priorityTransactions} from '../../src/platform/priority-transactions';
it('lets waiting status reads precede queued quotas without interrupting the active transaction',async()=>{
 const order:string[]=[];let release!:()=>void;
 const queued=priorityTransactions(async(scope,run)=>{order.push(scope);if(scope==='quota:active')await new Promise<void>(r=>{release=r;});return run({} as any);});
 const first=queued('quota:active',async()=>1);await Promise.resolve();
 const quota=queued('quota:next',async()=>2);const status=queued('snapshot:status',async()=>3);
 release();await Promise.all([first,quota,status]);expect(order).toEqual(['quota:active','snapshot:status','quota:next']);
});
it('prioritizes the quota needed to admit a status read as well as the snapshot itself',async()=>{
 const order:string[]=[];let release!:()=>void;
 const queued=priorityTransactions(async(scope,run)=>{order.push(scope);if(scope==='quota:active')await new Promise<void>(r=>{release=r;});return run({} as any);});
 const active=queued('quota:active',async()=>1);await Promise.resolve();
 const ordinary=queued('quota:ordinary',async()=>2);const admission=queued('quota:critical:user',async()=>3);
 release();await Promise.all([active,ordinary,admission]);expect(order).toEqual(['quota:active','quota:critical:user','quota:ordinary']);
});
it('admits gateway start-status ahead of a 42-participant quota burst',async()=>{
 const {createSupabaseGateway}=await import('../../src/platform/supabase-gateway');
 const {PostgresDatabase}=await import('../../src/platform/postgres-database');
 const order:string[]=[];let release!:()=>void;
 const db=new PostgresDatabase(async q=>({rows:q.startsWith('INSERT INTO app_request_limits')?[{count:1}]:[]}));
 const queued=priorityTransactions(async(scope,run)=>{order.push(scope);if(scope==='quota:active')await new Promise<void>(r=>release=r);return run(db);});
 const active=queued('quota:active',async()=>1);await Promise.resolve();
 const burst=Array.from({length:42},(_,i)=>queued(`quota:student-${i}`,async()=>1));
 const gateway=createSupabaseGateway({transact:queued,inspect:queued,verifyUser:async()=>({id:'host',is_anonymous:true}),masterEmail:'teacher@example.com',allowedOrigins:['https://koichem.github.io'],flush:async()=>{}});
 const status=gateway(new Request('https://p/functions/v1/competition/api/rooms/test/start-status?requestId='+crypto.randomUUID(),{headers:{origin:'https://koichem.github.io',authorization:'Bearer auth'}}));
 await new Promise(r=>setTimeout(r,0));release();await Promise.all([active,...burst,status]);
 expect(order.indexOf('snapshot:test')).toBeLessThanOrEqual(3);
});
it('admits start POST quota ahead of 42 waiting quotas while retaining the shared bucket',async()=>{
 const {createSupabaseGateway}=await import('../../src/platform/supabase-gateway');
 const {PostgresDatabase}=await import('../../src/platform/postgres-database');
 const order:string[]=[];const buckets:unknown[]=[];let release!:()=>void;
 const db=new PostgresDatabase(async(q,v)=>{if(q.startsWith('INSERT INTO app_request_limits')){buckets.push(v[0]);return {rows:[{count:181}]};}return {rows:[]};});
 const queued=priorityTransactions(async(scope,run)=>{order.push(scope);if(scope==='quota:active')await new Promise<void>(r=>release=r);return run(db);});
 const active=queued('quota:active',async()=>1);
 const burst=Array.from({length:42},(_,i)=>queued(`quota:student-${i}`,async()=>1));
 const gateway=createSupabaseGateway({transact:queued,inspect:queued,verifyUser:async()=>({id:'host',is_anonymous:true}),masterEmail:'teacher@example.com',allowedOrigins:['https://koichem.github.io'],now:()=>120000,flush:async()=>{}});
 const start=gateway(new Request('https://p/functions/v1/competition/api/rooms/test/start',{method:'POST',headers:{origin:'https://koichem.github.io',authorization:'Bearer auth','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:1})}));
 await new Promise(r=>setTimeout(r,0));release();const result=await start;await Promise.all([active,...burst]);
 expect(result.status).toBe(429);expect(buckets).toEqual(['host:2']);expect(order.indexOf('quota:critical:host')).toBeGreaterThan(0);expect(order.indexOf('quota:critical:host')).toBeLessThanOrEqual(3);
});
it('caches only trusted preflight responses for 600 seconds',async()=>{
 const {createSupabaseGateway}=await import('../../src/platform/supabase-gateway');
 const gateway=createSupabaseGateway({transact:async()=>{throw new Error('Unexpected DB access')},verifyUser:async()=>{throw new Error('Unexpected Auth access')},masterEmail:'teacher@example.com',allowedOrigins:['https://koichem.github.io'],flush:async()=>{}});
 const allowed=await gateway(new Request('https://p/api/rooms/test/join',{method:'OPTIONS',headers:{origin:'https://koichem.github.io'}}));
 expect(allowed.status).toBe(204);expect(await allowed.text()).toBe('');expect(allowed.headers.get('access-control-max-age')).toBe('600');expect(allowed.headers.get('vary')).toBe('Origin');
 for(const origin of ['https://evil.example','']){const response=await gateway(new Request('https://p/api/rooms/test/join',{method:'OPTIONS',headers:origin?{origin}:{}}));expect(response.status).toBe(403);expect(response.headers.has('access-control-max-age')).toBe(false);expect(response.headers.has('access-control-allow-origin')).toBe(false);}
});
