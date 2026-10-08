export type AuthSessionView={identity:{id:string;email:string}|null;csrfToken:string|null;expiresAtMs:number|null};
export async function getAuthSession():Promise<AuthSessionView>{
 const response=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});if(!response.ok)throw new Error('教員認証を確認できません');return response.json();
}
export function beginGoogleLogin(_returnPath='/teacher'):void{location.assign('/api/auth/google/start');}
export async function logout():Promise<void>{const session=await getAuthSession();if(session.csrfToken){const response=await fetch('/api/auth/logout',{method:'POST',credentials:'include',headers:{'x-competition-csrf':session.csrfToken}});if(!response.ok)throw new Error('ログアウトできません');}window.dispatchEvent(new Event('ionic-auth-change'));localStorage.setItem('ionic-auth-change',String(Date.now()));}
export async function ownerIdentity(token?:string):Promise<string>{
 if(token){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return 'participant:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
 const session=await getAuthSession();if(!session.identity)throw Object.assign(new Error('教員ログインが必要です'),{status:401});return 'teacher:'+session.identity.id;
}
