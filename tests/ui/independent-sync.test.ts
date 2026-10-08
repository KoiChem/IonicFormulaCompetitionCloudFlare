import {afterEach,expect,it,vi} from 'vitest';
import {createRoomSyncScheduler} from '../../src/web/room-sync-scheduler';
afterEach(()=>vi.useRealTimers());
it('idles with connected WS for 60 seconds and still coalesces invalidations',async()=>{
 vi.useFakeTimers();const run=vi.fn(async()=>1),s=createRoomSyncScheduler({run,delay:()=>Infinity,onError:()=>{}});s.start();await vi.advanceTimersByTimeAsync(60000);expect(run).toHaveBeenCalledTimes(1);s.request('control');s.request('control');await vi.advanceTimersByTimeAsync(200);expect(run).toHaveBeenCalledTimes(2);s.stop();
});
it('retries a failed connected snapshot with finite bounded backoff',async()=>{
 vi.useFakeTimers();const run=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(1),s=createRoomSyncScheduler({run,delay:()=>Infinity,onError:()=>{}});s.start();await vi.advanceTimersByTimeAsync(31000);expect(run).toHaveBeenCalledTimes(2);s.stop();
});
