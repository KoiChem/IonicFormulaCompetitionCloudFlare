import {it,expect,vi,afterEach} from 'vitest';
import {apiFetch} from '../../src/web/api';
afterEach(()=>vi.unstubAllGlobals());
it('does not replay a POST on service failure',async()=>{const fetch=vi.fn(async()=>new Response('{}',{status:503}));vi.stubGlobal('fetch',fetch);expect((await apiFetch('/api/rooms/fixture/start',{method:'POST',headers:{authorization:'Bearer participant'},body:'{}'})).status).toBe(503);expect(fetch).toHaveBeenCalledTimes(1);});
it('does not refresh or replay simultaneous unauthorized mutations',async()=>{const fetch=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',fetch);const responses=await Promise.all(Array.from({length:3},()=>apiFetch('/api/rooms/fixture/start',{method:'POST',headers:{authorization:'Bearer participant'},body:'{}'})));expect(responses.map(r=>r.status)).toEqual([401,401,401]);expect(fetch).toHaveBeenCalledTimes(3);});
