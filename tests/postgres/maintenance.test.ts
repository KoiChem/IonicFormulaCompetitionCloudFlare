import {it,expect,beforeAll,afterAll} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {PostgresDatabase} from '../../src/platform/postgres-database';
import {createMaintenanceHandler} from '../../src/platform/maintenance';
let pg:PGlite;
beforeAll(async()=>{
 pg=new PGlite();await pg.exec(readFileSync('supabase/migrations/202610010001_core.sql','utf8'));
 await pg.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;CREATE SCHEMA realtime;CREATE TABLE realtime.messages(extension text);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;`);
 for(const file of readdirSync('supabase/migrations').sort().slice(1))await pg.exec(readFileSync('supabase/migrations/'+file,'utf8'));
});
afterAll(async()=>pg.close());
it('protects maintenance and prevents concurrent periodic workers from running twice',async()=>{
 const transact=async<T>(_scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>pg.transaction(tx=>run(new PostgresDatabase((q,v)=>tx.query(q,v))));
 const handler=createMaintenanceHandler({transact,flush:async()=>{},secret:'private-key',now:()=>Date.now()});
 expect((await handler(new Request('https://api/maintenance',{method:'POST'}))).status).toBe(403);
 const request=()=>new Request('https://api/maintenance',{method:'POST',headers:{authorization:'Bearer private-key'}});
 const responses=await Promise.all([handler(request()),handler(request())]);expect(responses.map(r=>r.status).sort()).toEqual([200,202]);
 const row=(await pg.query<any>('SELECT last_success_ms FROM app_maintenance WHERE id=1')).rows[0];expect(Number(row.last_success_ms)).toBeGreaterThan(0);
});
it('rotates periodic recovery fairly when more than eight rooms remain pending',async()=>{
 const {createSupabaseGateway}=await import('../../src/platform/supabase-gateway');
 const transact=async<T>(_scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>pg.transaction(tx=>run(new PostgresDatabase((q,v)=>tx.query(q,v))));
 const user={id:crypto.randomUUID(),email:'teacher@example.com',email_confirmed_at:'2026-10-01',is_anonymous:false,identities:[{provider:'google'}]};
 let now=Date.now()+60000;const gateway=createSupabaseGateway({transact,verifyUser:async()=>user,masterEmail:user.email,allowedOrigins:['https://koichem.github.io'],flush:async()=>{},now:()=>now});
 const settings={questionCount:5,timeLimitMinutes:3,mode:'ion',difficulty:'normal',ionAnswer:'formula',compoundPrompts:{formula:true,name:false},compoundAnswer:'formula',gradingMode:'immediate'};
 for(let i=0;i<12;i++){const created=await gateway(new Request('https://p/functions/v1/competition/api/class-rooms',{method:'POST',headers:{origin:'https://koichem.github.io','content-type':'application/json','x-competition-csrf':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),settings})}));expect(created.status).toBe(201);}
 const attempted=new Set<string>();const handler=createMaintenanceHandler({transact,flush:async id=>{attempted.add(id);},secret:'key',now:()=>now});
 const request=()=>new Request('https://p/maintenance',{method:'POST',headers:{authorization:'Bearer key'}});
 expect((await handler(request())).status).toBe(200);expect(attempted.size).toBe(8);now+=60000;
 expect((await handler(request())).status).toBe(200);expect(attempted.size).toBe(12);
});
