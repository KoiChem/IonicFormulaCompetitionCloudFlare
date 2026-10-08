import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {SqliteD1} from '../persistence/helpers';
import {createSession,readAuthSession,requireCsrf,logoutSession,ensureAuthConfig} from '../../worker/auth/session';
import {verifyGoogleIdToken,handleGoogleAuth} from '../../worker/auth/google';
import {consumeOAuthTransaction,createOAuthTransaction} from '../../worker/auth/store';
import {generateKeyPair,SignJWT,exportJWK,createLocalJWKSet} from 'jose';
import {hashParticipantToken} from '../../src/platform/participant-auth';
const stores:SqliteD1[]=[];
function fixture(){const db=new SqliteD1();stores.push(db);db.sqlite.exec(readFileSync('migrations/d1/0002_independent_auth.sql','utf8'));return {DB:db as any,MASTER_TEACHER_EMAIL:'master@example.com',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',APP_ORIGIN:'https://test'};}
afterEach(()=>{vi.restoreAllMocks();for(const db of stores.splice(0))db.sqlite.close();});
it('issues only hashed eight-hour sessions and rejects csrf, expiry and logout',async()=>{
 const env=fixture();const made=await createSession(env,{id:'google-sub',email:'master@example.com'},1000);
 expect(made.cookie).toContain('__Host-ionic-session=');expect(made.cookie).toContain('HttpOnly');expect(made.cookie).toContain('Secure');expect(made.cookie).toContain('SameSite=Lax');
 const request=new Request('https://test/api/auth/session',{headers:{cookie:made.cookie.split(';')[0]}});
 const view=await readAuthSession(request,env,1001);expect(view.identity?.id).toBe('google-sub');expect(view.expiresAtMs).toBe(1000+8*60*60*1000);
 const rows=await env.DB.prepare('SELECT token_hash,csrf_hash FROM cf_sessions').all();expect(JSON.stringify(rows)).not.toContain(made.token);
 await expect(requireCsrf(request,env,1001)).rejects.toMatchObject({status:403});
 await requireCsrf(new Request(request,{method:'POST',headers:{cookie:request.headers.get('cookie')!,origin:'https://test','x-competition-csrf':view.csrfToken!}}),env,1001);
 expect((await readAuthSession(request,env,view.expiresAtMs!)).identity).toBeNull();
 await logoutSession(request,env);expect((await readAuthSession(request,env,1001)).identity).toBeNull();
});
it('enforces independent allowlist, fixed master and subject/email binding',async()=>{
 const env=fixture();await createSession(env,{id:'master-sub',email:'master@example.com'},1000);
 await expect(createSession(env,{id:'other-sub',email:'master@example.com'},1000)).rejects.toMatchObject({status:403});
 await expect(createSession(env,{id:'unallowed',email:'other@example.com'},1000)).rejects.toMatchObject({status:403});
 await env.DB.prepare("INSERT INTO teacher_allowlist(id,emails_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET emails_json=excluded.emails_json").bind('["teacher@example.com"]').run();
 const made=await createSession(env,{id:'teacher-sub',email:'teacher@example.com'},1000);const r=new Request('https://test',{headers:{cookie:made.cookie.split(';')[0]}});
 expect((await readAuthSession(r,env,1001)).identity?.email).toBe('teacher@example.com');
 await env.DB.prepare("UPDATE teacher_allowlist SET emails_json='[]' WHERE id=1").run();expect((await readAuthSession(r,env,1001)).identity).toBeNull();
 await expect(ensureAuthConfig({...env,MASTER_TEACHER_EMAIL:'changed@example.com'})).rejects.toMatchObject({status:503});
 await expect(ensureAuthConfig({...env,GOOGLE_CLIENT_SECRET:''})).rejects.toMatchObject({status:503});
});
it('consumes OAuth state only once with matching browser and expiry',async()=>{
 const env=fixture();const tx=await createOAuthTransaction(env,1000);
 expect(await consumeOAuthTransaction(env,tx.state,'wrong',1001)).toBeNull();
 expect(await consumeOAuthTransaction(env,tx.state,tx.browserToken,1001)).toMatchObject({verifier:tx.verifier});
 expect(await consumeOAuthTransaction(env,tx.state,tx.browserToken,1002)).toBeNull();
 const stale=await createOAuthTransaction(env,1000);expect(await consumeOAuthTransaction(env,stale.state,stale.browserToken,1000+10*60*1000)).toBeNull();
});
it('verifies actual Google-style JWT signatures and all identity claims',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');const key=await exportJWK(publicKey);key.kid='test';
 const jwks=createLocalJWKSet({keys:[key]});const nonceHash=await hashParticipantToken('nonce');
 async function sign(overrides:Record<string,unknown>={}){return new SignJWT({email:'master@example.com',email_verified:true,nonce:'nonce',iss:'https://accounts.google.com',aud:'client',sub:'sub',iat:1000,exp:1100,...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);}
 expect(await verifyGoogleIdToken(await sign(),'client',nonceHash,jwks,1001000)).toEqual({id:'sub',email:'master@example.com'});
 for(const changes of [{iss:'https://evil'},{aud:'other'},{exp:1000},{iat:1200},{nonce:'other'},{email_verified:false},{sub:''}])await expect(verifyGoogleIdToken(await sign(changes),'client',nonceHash,jwks,1001000)).rejects.toBeDefined();
 const bad=(await sign()).slice(0,-10)+'abcdefghij';await expect(verifyGoogleIdToken(bad,'client',nonceHash,jwks,1001000)).rejects.toBeDefined();
});

it('completes a real signed OAuth callback without exposing codes and rejects replay/cancellation',async()=>{
 const env=fixture();const start=await handleGoogleAuth(new Request('https://test/api/auth/google/start?returnTo=https://evil'),env);const url=new URL(start!.headers.get('location')!);
 expect(url.searchParams.get('redirect_uri')).toBe('https://test/api/auth/google/callback');expect(url.searchParams.get('scope')).toBe('openid email');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
 const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='flow';
 const encoded=await new SignJWT({email:'master@example.com',email_verified:true,nonce:url.searchParams.get('nonce')!}).setProtectedHeader({alg:'RS256',kid:'flow'}).setIssuer('https://accounts.google.com').setAudience('client').setSubject('flow-sub').setIssuedAt().setExpirationTime('1m').sign(privateKey);
 vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{const target=String(input);if(target.includes('/certs'))return Response.json({keys:[jwk]});if(target.includes('/token'))return Response.json({id_token:encoded});throw new Error('unexpected external request');});
 const callback=new Request('https://test/api/auth/google/callback?code=private-code&state='+url.searchParams.get('state'),{headers:{cookie:start!.headers.get('set-cookie')!.split(';')[0]}});
 const result=await handleGoogleAuth(callback,env);expect(result!.headers.get('location')).toBe('https://test/#/teacher');expect(result!.headers.get('set-cookie')).toContain('__Host-ionic-session=');expect(result!.headers.get('location')).not.toContain('private-code');
 const replay=await handleGoogleAuth(callback,env);expect(replay!.headers.get('location')).toContain('authError=google');
 const cancelledStart=await handleGoogleAuth(new Request('https://test/api/auth/google/start'),env);const cancelledState=new URL(cancelledStart!.headers.get('location')!).searchParams.get('state');
 const cancelled=await handleGoogleAuth(new Request('https://test/api/auth/google/callback?error=access_denied&state='+cancelledState,{headers:{cookie:cancelledStart!.headers.get('set-cookie')!.split(';')[0]}}),env);expect(cancelled!.headers.get('location')).toContain('authError=google');
});
