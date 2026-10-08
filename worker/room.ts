import {DurableObject} from 'cloudflare:workers';
import type {IndependentEnv} from './env';
import {executeRoomRequest} from './api';
export class RoomCoordinator extends DurableObject<IndependentEnv>{
 private tail:Promise<void>=Promise.resolve();
 fetch(request:Request):Promise<Response>{const result=this.tail.then(()=>executeRoomRequest(this.env,request));this.tail=result.then(()=>undefined,()=>undefined);return result;}
}
