import {it,expect,vi,afterEach} from 'vitest';

import {ResultLoader} from '../../src/features/results/result-loader';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('uses the cloud API transport for results and forwards participant proof',async()=>{
 vi.stubEnv('VITE_SUPABASE_FUNCTION_REGION','ap-northeast-2');
 vi.stubEnv('VITE_SUPABASE_URL','https://project.supabase.co');vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','public-key');
 const fetch=vi.fn().mockResolvedValue(Response.json({room:{id:'room',state:'FINISHED'},ranking:[],own:{correctCount:0},questions:[]}));vi.stubGlobal('fetch',fetch);
 const loader=new ResultLoader({roomId:'room',token:'participant-token',isAvailable:()=>true});await loader.start();
 expect(loader.state.status).toBe('complete');expect(fetch).toHaveBeenCalledTimes(1);
 const [url,options]=fetch.mock.calls[0];expect(url).toBe('/api/rooms/room/results');
 expect(options.headers.has('x-region')).toBe(false);
 expect(options.headers.get('authorization')).toBe('Bearer participant-token');expect(options.headers.has('x-participant-authorization')).toBe(false);loader.dispose();
});
