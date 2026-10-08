import type {AuthEnvironment,AuthSessionView} from './types';
import {cookie,hash,readCookie,token} from './store';
import {normalizeTeacherEmail,TeacherIdentityError,type TeacherIdentity,type TeacherIdentityProvider} from '../../src/platform/teacher-identity';
import {jsonResponse} from '../../src/platform/http';
const SESSION_COOKIE='__Host-ionic-session';
export async function ensureAuthConfig(env:AuthEnvironment){
 const master=normalizeTeacherEmail(env.MASTER_TEACHER_EMAIL??'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(master)||!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET||!env.APP_ORIGIN||new URL(env.APP_ORIGIN).origin!==env.APP_ORIGIN||!env.APP_ORIGIN.startsWith('https://'))throw new TeacherIdentityError(503,'identity_unavailable','教員認証の設定を準備中です');
 let config=await env.DB.prepare('SELECT master_email FROM cf_auth_config WHERE id=1').first<{master_email:string}>();
 if(!config){await env.DB.prepare('INSERT OR IGNORE INTO cf_auth_config(id,master_email) VALUES(1,?)').bind(master).run();config=await env.DB.prepare('SELECT master_email FROM cf_auth_config WHERE id=1').first<{master_email:string}>();}
 if(config?.master_email!==master)throw new TeacherIdentityError(503,'identity_unavailable','教員認証の設定を確認してください');
 return master;
}
async function allowed(env:AuthEnvironment,email:string){
 const master=await ensureAuthConfig(env);if(email===master)return true;
 const list=await env.DB.prepare('SELECT emails_json FROM teacher_allowlist WHERE id=1').first<{emails_json:string}>();
 return (JSON.parse(list?.emails_json??'[]') as string[]).includes(email);
}
export async function createSession(env:AuthEnvironment,identity:TeacherIdentity,now=Date.now()){
 const email=normalizeTeacherEmail(identity.email);
 if(!identity.id||!await allowed(env,email))throw new TeacherIdentityError(403,'teacher_forbidden','教員として許可されていません');
 try{await env.DB.prepare('INSERT INTO cf_google_identities(sub,email,created_at_ms) VALUES(?,?,?) ON CONFLICT(sub) DO NOTHING').bind(identity.id,email,now).run();}catch{throw new TeacherIdentityError(403,'teacher_forbidden','Googleアカウントの登録を確認してください');}
 const bound=await env.DB.prepare('SELECT email FROM cf_google_identities WHERE sub=?').bind(identity.id).first<{email:string}>();
 if(bound?.email!==email)throw new TeacherIdentityError(403,'teacher_forbidden','Googleアカウントの登録を確認してください');
 const secret=token(),csrf=await hash(secret+':csrf'),expires=now+28800000;
 await env.DB.prepare('INSERT INTO cf_sessions(token_hash,sub,csrf_hash,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?)').bind(await hash(secret),identity.id,await hash(csrf),now,expires).run();
 return {token:secret,cookie:cookie(SESSION_COOKIE,secret,28800),csrfToken:csrf,expiresAtMs:expires};
}
export async function readAuthSession(request:Request,env:AuthEnvironment,now=Date.now()):Promise<AuthSessionView>{
 const empty={identity:null,csrfToken:null,expiresAtMs:null};const secret=readCookie(request,SESSION_COOKIE);
 if(!secret||!/^[A-Za-z0-9_-]{43}$/.test(secret))return empty;
 const row=await env.DB.prepare('SELECT i.sub,i.email,s.expires_at_ms FROM cf_sessions s JOIN cf_google_identities i ON i.sub=s.sub WHERE s.token_hash=? AND s.expires_at_ms>?').bind(await hash(secret),now).first<{sub:string;email:string;expires_at_ms:number}>();
 if(!row||!await allowed(env,row.email))return empty;
 return {identity:{id:row.sub,email:row.email},csrfToken:await hash(secret+':csrf'),expiresAtMs:row.expires_at_ms};
}
export function createTeacherIdentityProvider(request:Request,env:AuthEnvironment):TeacherIdentityProvider {return {getVerifiedIdentity:async()=>{await ensureAuthConfig(env);return (await readAuthSession(request,env)).identity;}};}
export async function requireCsrf(request:Request,env:AuthEnvironment,now=Date.now()){
 if(request.headers.get('origin')!==env.APP_ORIGIN||new URL(request.url).origin!==env.APP_ORIGIN)throw new TeacherIdentityError(403,'teacher_forbidden','許可されたアプリから操作してください');
 const session=await readAuthSession(request,env,now);const supplied=request.headers.get('x-competition-csrf');
 if(!session.identity||!supplied||supplied!==session.csrfToken)throw new TeacherIdentityError(403,'teacher_forbidden','操作資格を再確認してください');
 return session.identity;
}
export async function logoutSession(request:Request,env:AuthEnvironment){const secret=readCookie(request,SESSION_COOKIE);if(secret)await env.DB.prepare('DELETE FROM cf_sessions WHERE token_hash=?').bind(await hash(secret)).run();}
export async function handleSessionRequest(request:Request,env:AuthEnvironment):Promise<Response|null>{
 const path=new URL(request.url).pathname;
 if(path==='/api/auth/session'){if(request.method!=='GET')return jsonResponse({error:{code:'method_not_allowed'}},405);return jsonResponse(await readAuthSession(request,env));}
 if(path==='/api/auth/logout'){if(request.method!=='POST')return jsonResponse({error:{code:'method_not_allowed'}},405);await requireCsrf(request,env);await logoutSession(request,env);return jsonResponse({ok:true},200,{'set-cookie':cookie(SESSION_COOKIE,'',0)});}
 return null;
}
