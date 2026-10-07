export const eventCost=(recipients:number)=>1+recipients;
// Reserve two connections per authorized person, including a second browser tab.
// This is a conservative estimate, not a server-enforced connection limit.
export const reservedEventCost=(people:number)=>1+people*2;
export function retryPollDelay(base:number,failures:number,retryAfter:number|null=null,random=Math.random()){
  const backoff=failures?Math.min(30000,base*2**Math.min(failures,4)):base;
  return Math.max(retryAfter??0,Math.round(backoff*(0.9+0.2*random)));
}
export function acceptEvent(current:{epoch:number;revision:number},next:{epoch:number;revision:number}) {
  return next.epoch===current.epoch&&next.revision>current.revision;
}
export function pollInterval(role:string,state:string,subscribed:boolean,hidden:boolean){
  if(hidden)return 30000;
  if(role==='teacher'||role==='host')return ['PREPARING','COUNTDOWN','RUNNING','COLLECTING'].includes(state)?2000:5000;
  if(state==='WAITING')return 4500;
  if(state==='PREPARING')return 2500;
  return subscribed?30000:5000;
}
