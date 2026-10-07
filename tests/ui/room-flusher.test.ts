import {it,expect} from 'vitest';
import {coalescedRoomFlusher} from '../../src/platform/realtime-outbox';
it('coalesces concurrent drains and runs one trailing dirty drain',async()=>{
 let resolve!:()=>void;const held=new Promise<void>(r=>resolve=r);let calls=0;
 const flush=coalescedRoomFlusher(async()=>{calls++;if(calls===1)await held;});
 const first=flush('a');const second=flush('a');const third=flush('a');
 expect(first).toBe(second);expect(second).toBe(third);expect(calls).toBe(1);
 resolve();await first;expect(calls).toBe(2);
 await flush('a');expect(calls).toBe(3);
});
