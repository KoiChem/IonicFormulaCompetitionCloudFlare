import { it, expect } from 'vitest';
import { eventCost, reservedEventCost, retryPollDelay, acceptEvent, pollInterval } from '../../src/web/realtime-policy';
it('counts fanout and ignores duplicated/stale events', () => {
  expect(eventCost(43)).toBe(44);
  expect(acceptEvent({epoch:2,revision:8},{epoch:2,revision:7})).toBe(false);
  expect(acceptEvent({epoch:2,revision:8},{epoch:1,revision:99})).toBe(false);
  expect(acceptEvent({epoch:2,revision:8},{epoch:2,revision:9})).toBe(true);
});
it('reserves two tabs and backs off with jitter without shortening Retry-After',()=>{
  expect(reservedEventCost(43)).toBe(87);
  expect(retryPollDelay(5000,1,null,0.5)).toBe(10000);
  expect(retryPollDelay(5000,10,null,0.5)).toBe(30000);
  expect(retryPollDelay(5000,0,60000,0.5)).toBe(60000);
});
it('keeps safety confirmation for teacher and faster fallback for disconnected participants', () => {
  expect(pollInterval('teacher','RUNNING',true,false)).toBe(2000);
  expect(pollInterval('participant','RUNNING',true,false)).toBe(30000);
  expect(pollInterval('participant','RUNNING',false,false)).toBe(5000);
});
it('recovers a missed start notification even while the channel remains subscribed',()=>{
 expect(pollInterval('participant','WAITING',true,false)).toBeLessThanOrEqual(4500);
 expect(pollInterval('participant','PREPARING',true,false)).toBeLessThanOrEqual(2500);
});
