import {getAuthSession} from './auth';
export function apiHeaders(_unused:string,supplied?:HeadersInit):Headers{return new Headers(supplied);}
export type ApiFetchOptions=RequestInit&{onDispatch?:()=>void};
export async function apiFetch(path:string,init:ApiFetchOptions={}):Promise<Response>{
 if(!/^\/api\//.test(path)||path.includes('\\'))throw new Error('Invalid API path');
 const headers=new Headers(init.headers),method=(init.method??'GET').toUpperCase();
 if(!['GET','HEAD'].includes(method)){
  if(!headers.has('authorization')||path.startsWith('/api/teacher/')||path==='/api/class-rooms'){
   const session=await getAuthSession();if(!session.identity||!session.csrfToken)throw Object.assign(new Error('教員ログインが必要です'),{status:401});headers.set('x-competition-csrf',session.csrfToken);
  }else headers.set('x-competition-csrf','1');
 }
 const {onDispatch,...requestInit}=init;onDispatch?.();return fetch(path,{...requestInit,headers,credentials:'include'});
}
