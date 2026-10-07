import {it,expect} from 'vitest';
import {coalesceRequest} from '../../src/web/coalesce-request';
it('shares pending state fetches and allows a fresh fetch after completion',async()=>{
 let count=0;let release!:(value:number)=>void;
 const fetch=coalesceRequest(()=>{count++;return new Promise<number>(resolve=>{release=resolve})});
 const first=fetch();const burst=Array.from({length:20},()=>fetch());
 expect(count).toBe(1);release(7);
 expect(await Promise.all([first,...burst])).toEqual(Array(21).fill(7));
 const next=fetch();expect(count).toBe(2);release(8);expect(await next).toBe(8);
});
it('releases failed requests so reconnect can recover',async()=>{
 let count=0;
 const fetch=coalesceRequest(async()=>{if(++count===1)throw new Error('offline');return 9});
 await expect(fetch()).rejects.toThrow('offline');
 expect(await fetch()).toBe(9);
});
it('queues a fresh read after an in-flight read when a mutation invalidates its snapshot',async()=>{
 let count=0;let release!:(value:number)=>void;
 const fetch=coalesceRequest(()=>{count++;return new Promise<number>(resolve=>{release=resolve})});
 const stale=fetch();const refreshed=fetch(true);const duplicate=fetch(true);
 release(1);expect(await stale).toBe(1);
 await Promise.resolve();
 expect(count).toBe(2);release(2);
 expect(await refreshed).toBe(2);expect(await duplicate).toBe(2);
});
