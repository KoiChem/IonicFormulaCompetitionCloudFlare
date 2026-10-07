import {it,expect} from 'vitest';
import {sessionRefresher} from '../../src/web/refresh-session';
it('shares one refresh across a concurrent unauthorized burst and permits later recovery',async()=>{
 let calls=0;let resolve!:()=>void;
 const refresh=sessionRefresher(()=>{calls++;return new Promise<void>(r=>{resolve=r;});});
 const first=refresh();const second=refresh();expect(calls).toBe(1);expect(second).toBe(first);
 resolve();await first;const third=refresh();expect(calls).toBe(2);resolve();await third;
});
