import {createApiHandlers,jsonResponse,safe,ApiError} from '../src/platform/http';
import {resolveCompetitionRoute} from '../src/platform/api-routes';
import {createTeacherIdentityProvider,readAuthSession,requireCsrf,handleSessionRequest} from './auth/session';
import {handleGoogleAuth} from './auth/google';
import {authEnvironment,type IndependentEnv} from './env';
import {normalizeTeacherEmail} from '../src/platform/teacher-identity';
export function dependencies(env:IndependentEnv,request:Request){const auth=authEnvironment(env);return {skipLazyCleanup:true,database:auth.DB,teacherIdentity:createTeacherIdentityProvider(request,auth),serverConfig:{teacherAllowedEmails:[],masterTeacherEmail:normalizeTeacherEmail(env.MASTER_TEACHER_EMAIL??'')},now:Date.now,random:()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296,randomUUID:()=>crypto.randomUUID()};}
async function validateMutation(request:Request,env:IndependentEnv,teacher:boolean){
 if(['GET','HEAD'].includes(request.method))return;
 const origin=new URL(request.url).origin;
 if(origin!==env.APP_ORIGIN||request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'origin_forbidden','別のサイトからの操作は受け付けません');
 if(teacher){const auth=authEnvironment(env);if(!(await readAuthSession(request,auth)).identity)throw new ApiError(401,'authentication_required','ログインが必要です');await requireCsrf(request,auth);}
 else if(request.headers.get('x-competition-csrf')!=='1')throw new ApiError(403,'csrf_forbidden','操作の確認情報がありません');
}
function coreRequest(request:Request){const headers=new Headers(request.headers);headers.set('x-competition-csrf','1');return new Request(request,{headers});}
export async function executeRoomRequest(env:IndependentEnv,request:Request):Promise<Response>{return safe(async()=>{
 const route=resolveCompetitionRoute(new URL(request.url).pathname,request.method);if('status' in route||route.kind!=='room')return jsonResponse({error:{code:'not_found'}},'status' in route?route.status:404);
 await validateMutation(request,env,!request.headers.has('authorization'));
 const handlers=createApiHandlers(dependencies(env,request));return (handlers[route.name] as (r:Request,p:{id:string})=>Promise<Response>)(coreRequest(request),{id:route.publicId!});
 });}
export function createWorkerApi(env:IndependentEnv){return (request:Request):Promise<Response>=>safe(async()=>{
 const url=new URL(request.url);const auth=authEnvironment(env);
 const authentication=await handleGoogleAuth(request,auth)??await handleSessionRequest(request,auth);if(authentication)return authentication;
 const headers=new Headers(request.headers);for(const name of [...headers.keys()])if(name.startsWith('x-ionic-internal-')||name==='x-participant-authorization')headers.delete(name);
 request=new Request(request,{headers});
 const route=resolveCompetitionRoute(url.pathname,request.method);
 if('status' in route)return jsonResponse({error:{code:route.status===405?'method_not_allowed':'not_found'}},route.status);
 if(route.kind==='room')return env.ROOMS.getByName(route.publicId!).fetch(request);
 const teacher=route.name==='createClassRoom'||url.pathname.startsWith('/api/teacher/');
 await validateMutation(request,env,teacher);
 const handlers=createApiHandlers(dependencies(env,request));return (handlers[route.name] as (r:Request)=>Promise<Response>)(coreRequest(request));
 });}
