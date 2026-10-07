import {it,expect} from 'vitest';
import {retryRoomDrain} from '../../src/platform/realtime-outbox';
it('retries a deferred drain with no further API traffic and bounds a permanent failure',async()=>{
 let now=1000;let calls=0;const sleeps:number[]=[];
 await retryRoomDrain(async()=>({nextEligibleAt:++calls===1?2000:null}),{now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
 expect(calls).toBe(2);expect(sleeps).toEqual([1025]);
 calls=0;await retryRoomDrain(async()=>{calls++;return {nextEligibleAt:now+1000};},{now:()=>now,sleep:async ms=>{now+=ms;},attempts:3});expect(calls).toBe(3);
});
