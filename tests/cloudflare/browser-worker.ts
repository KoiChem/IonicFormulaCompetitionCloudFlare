// Test bundle only: loopback HTTP transport shim and fixture identity. Never deployed.
import worker from '../../worker/index';
import {createSession} from '../../worker/auth/session';
import {authEnvironment,type IndependentEnv} from '../../worker/env';
export {RoomCoordinator} from '../../worker/room';
export default {async fetch(request:Request,env:IndependentEnv){
 const url=new URL(request.url),headers=new Headers(request.headers);if(headers.has('origin'))headers.set('origin','https://test');const translated=new Request('https://test'+url.pathname+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body});
 if(url.pathname==='/__fixture/teacher'){const session=await createSession(authEnvironment(env),{id:'master-sub',email:'master@example.com'});return new Response(null,{status:302,headers:{location:'/#/teacher','set-cookie':session.cookie}});}
 return worker.fetch(translated,env);
}};
