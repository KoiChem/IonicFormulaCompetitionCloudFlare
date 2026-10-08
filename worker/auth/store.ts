import type {AuthEnvironment} from './types';
import {createParticipantToken,hashParticipantToken} from '../../src/platform/participant-auth';
export const token=createParticipantToken;
export const hash=hashParticipantToken;
export function readCookie(request:Request,name:string):string|null {
 const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
 return values.length===1?values[0].slice(name.length+1):null;
}
export function cookie(name:string,value:string,maxAge:number){return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;}
export async function createOAuthTransaction(env:AuthEnvironment,now=Date.now()){
 const state=token(),browserToken=token(),nonce=token(),verifier=token();
 await env.DB.prepare('INSERT INTO cf_oauth_transactions(state_hash,browser_hash,nonce_hash,verifier,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?)').bind(await hash(state),await hash(browserToken),await hash(nonce),verifier,now,now+600000).run();
 return {state,browserToken,nonce,verifier};
}
export async function consumeOAuthTransaction(env:AuthEnvironment,state:string,browserToken:string,now=Date.now()){
 if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{43}$/.test(browserToken))return null;
 return env.DB.prepare('DELETE FROM cf_oauth_transactions WHERE state_hash=? AND browser_hash=? AND expires_at_ms>? RETURNING nonce_hash,verifier').bind(await hash(state),await hash(browserToken),now).first<{nonce_hash:string;verifier:string}>();
}
