import type {Credential} from './protocol';
const key=(code:string,role:string)=>`ionic-lite:${role}:${code}`;
const retentionMs=7*24*60*60*1000;
const rememberedUntil=(c:Credential)=>c.rememberUntilMs??c.expiresAtMs+retentionMs;
export function readCredential(code:string,role:string):Credential|null {
  try{const c=JSON.parse(localStorage.getItem(key(code,role))??'null') as Credential|null;return c&&c.code===code&&c.role===role&&rememberedUntil(c)>Date.now()?c:null;}catch{return null;}
}
export function saveCredential(c:Credential){
  // Waiting-room expiry can be extended while this browser is offline. Keep the
  // original identity through that possible extension; the server validates it.
  c.rememberUntilMs??=c.expiresAtMs+retentionMs;
  localStorage.setItem(key(c.code,c.role),JSON.stringify(c));
}
export function recent(){
  try{return Object.keys(localStorage).filter(k=>/^ionic-lite:(teacher|participant):/.test(k)).map(k=>JSON.parse(localStorage.getItem(k)!)).filter((c:Credential)=>rememberedUntil(c)>Date.now()).sort((a:Credential,b:Credential)=>rememberedUntil(b)-rememberedUntil(a)).slice(0,8) as Credential[];}catch{return [];}
}
