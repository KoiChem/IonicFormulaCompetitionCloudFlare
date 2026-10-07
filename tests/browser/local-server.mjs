// Test-only real Postgres engine harness. Never included in either deployment.
import { createServer } from 'node:http';
import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createSupabaseGateway } from '../../src/platform/supabase-gateway.ts';
import { PostgresDatabase } from '../../src/platform/postgres-database.ts';
const pg=new PGlite();
await pg.exec(readFileSync('supabase/migrations/202610010001_core.sql','utf8'));
await pg.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;CREATE SCHEMA realtime;CREATE TABLE realtime.messages(extension text);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;`);
for(const file of readdirSync('supabase/migrations').sort().slice(1))await pg.exec(readFileSync('supabase/migrations/'+file,'utf8'));
const users=new Map();
function session(teacher=false){
 const id=teacher?'11111111-1111-4111-8111-111111111111':crypto.randomUUID();const user={id,aud:'authenticated',role:'authenticated',email:teacher?'teacher@example.com':undefined,email_confirmed_at:teacher?'2026-10-01':undefined,is_anonymous:!teacher,identities:teacher?[{provider:'google'}]:[],app_metadata:{provider:teacher?'google':'anonymous',providers:[teacher?'google':'anonymous']},user_metadata:{},created_at:new Date().toISOString()};
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),is_anonymous:!teacher})+'.local-test-signature';
 users.set(token,user);
 return {access_token:token,refresh_token:'test-refresh-'+id,expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user};
}
let preflights=0;
const gateway=createSupabaseGateway({nativeJoin:process.env.NATIVE_COMMANDS==='1',nativeReady:process.env.NATIVE_COMMANDS==='1',transact:async(scope,run)=>pg.transaction(tx=>run(new PostgresDatabase((q,v)=>tx.query(q,v)))),verifyUser:async request=>users.get(request.headers.get('authorization')?.slice(7))??null,
 masterEmail:'teacher@example.com',allowedOrigins:['http://127.0.0.1:5173','http://127.0.0.1:5174'],flush:async()=>{}});
createServer(async(req,res)=>{
 const origin=req.headers.origin??'http://127.0.0.1:5173';
 res.setHeader('access-control-allow-origin',origin);res.setHeader('access-control-allow-headers','*');res.setHeader('access-control-allow-methods','*');
 if(req.method==='OPTIONS'&&!req.url.includes('/api/')){res.writeHead(204);res.end();return;}
 if(req.method==='OPTIONS')preflights++;
 let result;
 if(req.url==='/__test/metrics')result=Response.json({preflights});
 else if(req.url.startsWith('/__test/session'))result=Response.json(session(req.url.includes('teacher')));
 else if(req.url==='/auth/v1/signup')result=Response.json(session());
 else if(req.url==='/auth/v1/user')result=Response.json(users.get(req.headers.authorization?.slice(7))??{}, {status:users.has(req.headers.authorization?.slice(7))?200:401});
 else if(req.url==='/auth/v1/logout'){result=new Response(null,{status:204});}
 else {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
  const request=new Request('http://127.0.0.1:8787'+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
  result=await gateway(request);
 }
 for(const[key,value]of result.headers)res.setHeader(key,value);res.writeHead(result.status);res.end(await result.text());
}).listen(Number(process.env.PORT ?? 8787),'127.0.0.1',()=>console.log('LOCAL POSTGRES TEST API; Google and Realtime cloud services not simulated as verified.'));
