import {it,expect,vi} from 'vitest';
import {createRoomSyncScheduler} from '../../src/web/room-sync-scheduler';
it('combines polling and host invalidation, preserves prompt control and cancels timers',async()=>{
 vi.useFakeTimers();let calls=0;
 const scheduler=createRoomSyncScheduler({run:async()=>{calls++;},delay:()=>2000,onError:()=>{}});
 scheduler.start();await vi.advanceTimersByTimeAsync(1);expect(calls).toBe(1);
 await vi.advanceTimersByTimeAsync(1000);scheduler.request('host');
 await vi.advanceTimersByTimeAsync(999);expect(calls).toBe(2);
 scheduler.request('control');await vi.advanceTimersByTimeAsync(100);expect(calls).toBe(3);
 scheduler.stop();await vi.advanceTimersByTimeAsync(5000);expect(calls).toBe(3);vi.useRealTimers();
});
it('keeps one trailing control read and honors Retry-After while preserving stop',async()=>{
 vi.useFakeTimers();let calls=0;let release!:()=>void;
 const scheduler=createRoomSyncScheduler({run:async()=>{calls++;if(calls===1)await new Promise<void>(r=>release=r);},delay:()=>2000,onError:()=>{}});
 scheduler.start();await vi.advanceTimersByTimeAsync(0);scheduler.request('control');scheduler.request('control');release();await vi.advanceTimersByTimeAsync(100);expect(calls).toBe(2);
 scheduler.stop();vi.useRealTimers();
});
it('does not shorten Retry-After on repeated notifications or refreshes',async()=>{
 vi.useFakeTimers();let calls=0;
 const scheduler=createRoomSyncScheduler({run:async()=>{calls++;if(calls===1)throw {retryAfterMs:10000};},delay:()=>2000,onError:()=>{}});
 scheduler.start();await vi.advanceTimersByTimeAsync(0);scheduler.request('control');
 await vi.advanceTimersByTimeAsync(9999);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(calls).toBe(2);
 scheduler.stop();vi.useRealTimers();
});
it('does not lose a host update received during an older request',async()=>{
 vi.useFakeTimers();let calls=0;let release!:()=>void;
 const scheduler=createRoomSyncScheduler({run:async()=>{calls++;if(calls===1)await new Promise<void>(r=>release=r);},delay:()=>5000,onError:()=>{}});
 scheduler.start();await vi.advanceTimersByTimeAsync(0);scheduler.request('host');release();
 await vi.advanceTimersByTimeAsync(1999);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(calls).toBe(2);
 scheduler.stop();vi.useRealTimers();
});
