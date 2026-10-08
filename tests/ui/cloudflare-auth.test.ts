import {afterEach,expect,it,vi} from 'vitest';
import {apiFetch} from '../../src/web/api';
afterEach(()=>vi.unstubAllGlobals());
it('uses same-origin cookie and preserves participant proof without Supabase headers',async()=>{
 const fetcher=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',fetcher);await apiFetch('/api/rooms/abc/state',{headers:{authorization:'Bearer student'}});
 expect(fetcher.mock.calls[0][0]).toBe('/api/rooms/abc/state');const init=fetcher.mock.calls[0][1] as RequestInit;expect(init.credentials).toBe('include');const h=new Headers(init.headers);expect(h.get('authorization')).toBe('Bearer student');expect(h.has('apikey')).toBe(false);expect(h.has('x-participant-authorization')).toBe(false);
});
it('uses the native session csrf token for teacher mutations',async()=>{
 const fetcher=vi.fn(async(path:string)=>new Response(JSON.stringify(path==='/api/auth/session'?{identity:{id:'teacher',email:'teacher@example.com'},csrfToken:'native-csrf',expiresAtMs:Date.now()+1000}:{})));vi.stubGlobal('fetch',fetcher);await apiFetch('/api/class-rooms',{method:'POST',headers:{'x-competition-csrf':'1'},body:'{}'});expect(fetcher.mock.calls[1][0]).toBe('/api/class-rooms');expect(new Headers((fetcher.mock.calls[1][1] as RequestInit).headers).get('x-competition-csrf')).toBe('native-csrf');
});
