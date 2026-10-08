import {createRemoteJWKSet,jwtVerify,type JWTVerifyGetKey} from 'jose';
import type {AuthEnvironment} from './types';
import {createOAuthTransaction,consumeOAuthTransaction,readCookie,cookie,hash} from './store';
import {createSession,ensureAuthConfig} from './session';
import {normalizeTeacherEmail,TeacherIdentityError} from '../../src/platform/teacher-identity';
import {jsonResponse} from '../../src/platform/http';
const keys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:5000});
export async function verifyGoogleIdToken(encoded:string,clientId:string,nonceHash:string,jwks:JWTVerifyGetKey=keys,now=Date.now()){
 const {payload}=await jwtVerify(encoded,jwks,{issuer:['https://accounts.google.com','accounts.google.com'],audience:clientId,algorithms:['RS256'],currentDate:new Date(now),requiredClaims:['sub','exp','iat','email','email_verified','nonce']});
 if(typeof payload.iat!=='number'||payload.iat>Math.floor(now/1000)+60||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255||typeof payload.email!=='string'||payload.email.length>254||payload.email_verified!==true||typeof payload.nonce!=='string'||await hash(payload.nonce)!==nonceHash)throw new TeacherIdentityError(403,'teacher_forbidden','Googleアカウントを確認できません');
 return {id:payload.sub,email:normalizeTeacherEmail(payload.email)};
}
function base64url(bytes:Uint8Array){let s='';for(const n of bytes)s+=String.fromCharCode(n);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export async function handleGoogleAuth(request:Request,env:AuthEnvironment):Promise<Response|null>{
 const url=new URL(request.url);if(!['/api/auth/google/start','/api/auth/google/callback'].includes(url.pathname))return null;
 if(request.method!=='GET')return jsonResponse({error:{code:'method_not_allowed'}},405);
 await ensureAuthConfig(env);if(url.origin!==env.APP_ORIGIN)return jsonResponse({error:{code:'origin_forbidden'}},403);
 const callback=env.APP_ORIGIN+'/api/auth/google/callback';
 if(url.pathname.endsWith('/start')){
  const tx=await createOAuthTransaction(env);const target=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(tx.verifier))));
  target.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID!,redirect_uri:callback,response_type:'code',scope:'openid email',state:tx.state,nonce:tx.nonce,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
  return new Response(null,{status:302,headers:{location:target.href,'set-cookie':cookie('__Host-ionic-oauth',tx.browserToken,600),'cache-control':'no-store'}});
 }
 const headers=new Headers({'cache-control':'no-store','set-cookie':cookie('__Host-ionic-oauth','',0)});
 try{
  const tx=await consumeOAuthTransaction(env,url.searchParams.get('state')??'',readCookie(request,'__Host-ionic-oauth')??'');
  const code=url.searchParams.get('code');if(!tx||url.searchParams.has('error')||!code||code.length>2048)throw new Error('oauth rejected');
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID!,client_secret:env.GOOGLE_CLIENT_SECRET!,redirect_uri:callback,grant_type:'authorization_code',code_verifier:tx.verifier}),signal:AbortSignal.timeout(10000)});
  const text=await response.text();if(!response.ok||text.length>16384)throw new Error('oauth rejected');
  const payload=JSON.parse(text);if(typeof payload.id_token!=='string'||payload.id_token.length>12000)throw new Error('oauth rejected');
  const identity=await verifyGoogleIdToken(payload.id_token,env.GOOGLE_CLIENT_ID!,tx.nonce_hash);const session=await createSession(env,identity);
  headers.append('set-cookie',session.cookie);headers.set('location',env.APP_ORIGIN+'/#/teacher');
 }catch{headers.set('location',env.APP_ORIGIN+'/#/teacher?authError=google');}
 return new Response(null,{status:302,headers});
}
