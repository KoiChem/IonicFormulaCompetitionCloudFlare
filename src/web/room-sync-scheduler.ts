import {retryPollDelay} from './realtime-policy';
type Trigger='host'|'control'|'resume';
/** One timer owns polls and invalidations. Network work never overlaps here. */
export function createRoomSyncScheduler<T>(options:{run:()=>Promise<T>;delay:()=>number;onError:(error:unknown)=>void;now?:()=>number}){
 const now=options.now??Date.now;
 let active=false;let running=false;let dirty=false;let dirtyAt=Infinity;let timer:ReturnType<typeof setTimeout>|undefined;
 let due=Infinity;let lastStarted=-Infinity;let failures=0;let blockedUntil=0;
 let waiters:Array<{resolve:(value:T)=>void;reject:(error:unknown)=>void}>=[];
 const schedule=(at:number)=>{
  if(!active)return;at=Math.max(at,blockedUntil);
  if(!Number.isFinite(at)){if(timer)clearTimeout(timer);timer=undefined;due=Infinity;return;}
  if(timer&&due<=at)return;if(timer)clearTimeout(timer);due=at;
  timer=setTimeout(()=>{timer=undefined;due=Infinity;void run();},Math.max(0,at-now()));
 };
 const run=async()=>{
  if(!active)return;if(running){dirty=true;dirtyAt=Math.min(dirtyAt,now()+100);return;}
  running=true;dirty=false;dirtyAt=Infinity;lastStarted=now();const readers=waiters;waiters=[];
  try{const result=await options.run();failures=0;blockedUntil=0;for(const reader of readers)reader.resolve(result);}
  catch(error){failures++;const retryAfter=(error as {retryAfterMs?:number}).retryAfterMs??null;
   blockedUntil=now()+retryPollDelay(Number.isFinite(options.delay())?options.delay():5000,failures,retryAfter);if(active)options.onError(error);for(const reader of readers)reader.reject(error);
  }finally{running=false;if(active)schedule(dirty?Math.max(now()+100,dirtyAt):now()+(failures?retryPollDelay(Number.isFinite(options.delay())?options.delay():5000,failures):retryPollDelay(options.delay(),0)));}
 };
 const request=(kind:Trigger)=>{
  if(!active)return;
  if(running){dirty=true;dirtyAt=Math.min(dirtyAt,kind==='host'?lastStarted+2000:now()+100);return;}
  schedule(kind==='host'?Math.max(now(),lastStarted+2000):now()+100);
 };
 return {
  start(){if(active)return;active=true;schedule(now());},
  request,
  refresh(){return new Promise<T>((resolve,reject)=>{if(!active){reject(new Error('Room synchronization stopped'));return;}
   waiters.push({resolve,reject});if(running){dirty=true;dirtyAt=Math.min(dirtyAt,now());}else schedule(now());});},
  stop(){active=false;if(timer)clearTimeout(timer);timer=undefined;due=Infinity;for(const reader of waiters)reader.reject(new Error('Room synchronization stopped'));waiters=[];}
 };
}
