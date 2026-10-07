import {it,expect,vi,afterEach} from 'vitest';
const auth=vi.hoisted(()=>({refreshSession:vi.fn()}));
vi.mock('../../src/web/supabase',()=>({ensureSession:async()=>({access_token:'fixture'}),getSupabaseClient:()=>({auth})}));
import {apiFetch} from '../../src/web/api';
afterEach(()=>{vi.unstubAllGlobals();auth.refreshSession.mockReset();});
it('does not refresh or replay a POST on service failure',async()=>{
 const fetch=vi.fn(async()=>new Response('{}',{status:503}));vi.stubGlobal('fetch',fetch);
 expect((await apiFetch('/api/rooms/fixture/start',{method:'POST',body:'{}'})).status).toBe(503);
 expect(fetch).toHaveBeenCalledTimes(1);expect(auth.refreshSession).not.toHaveBeenCalled();
});
it('refreshes one time for simultaneous 401s and does not replay the mutations',async()=>{
 let release!:()=>void;auth.refreshSession.mockImplementation(()=>new Promise<void>(r=>release=r));
 const fetch=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',fetch);
 const responses=Promise.all(Array.from({length:3},()=>apiFetch('/api/rooms/fixture/start',{method:'POST',body:'{}'})));
 await new Promise(r=>setTimeout(r,0));expect(auth.refreshSession).toHaveBeenCalledTimes(1);release();
 expect((await responses).map(r=>r.status)).toEqual([401,401,401]);expect(fetch).toHaveBeenCalledTimes(3);
});
