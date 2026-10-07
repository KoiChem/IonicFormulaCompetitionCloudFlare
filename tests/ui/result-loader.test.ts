import { afterEach, expect, it, vi } from 'vitest';
import { ResultLoader } from '../../src/features/results/result-loader';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const full = { room: { id: 'room', kind: 'class', state: 'FINISHED' }, ranking: [], own: { rank: 1, correctCount: 2, elapsedCs: 100 }, questions: [] };
const summary = { room: full.room, own: full.own };
const response = (status: number, body: unknown, headers?: Record<string,string>) => new Response(JSON.stringify(body), { status, headers });
const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };

it('retries a transient failure and stops after one success', async () => {
 vi.useFakeTimers();
 const fetcher=vi.fn().mockResolvedValueOnce(response(503,{error:{code:'service_unavailable'}})).mockResolvedValueOnce(response(200,full));
 const loader=new ResultLoader({roomId:'room',token:'token',fetcher,random:()=>0.5,isAvailable:()=>true});
 void loader.start(); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1000); await flush();
 expect(loader.state.full).toEqual(full); expect(fetcher).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(20_000); expect(fetcher).toHaveBeenCalledTimes(2); loader.dispose();
});

it('shows summary after two failures, then upgrades to full results', async () => {
 vi.useFakeTimers();
 const fetcher=vi.fn().mockResolvedValueOnce(response(503,{})).mockResolvedValueOnce(response(503,{}))
  .mockResolvedValueOnce(response(200,summary)).mockResolvedValueOnce(response(200,full));
 const loader=new ResultLoader({roomId:'room',token:'token',fetcher,random:()=>0.5,isAvailable:()=>true});
 void loader.start(); await flush(); await vi.advanceTimersByTimeAsync(1000); await flush();
 expect(loader.state.summary).toEqual(summary); expect(loader.state.full).toBeNull();
 await vi.advanceTimersByTimeAsync(2000); await flush();
 expect(loader.state.full).toEqual(full); expect(fetcher.mock.calls.map(([path])=>String(path).endsWith('/result-summary')?'summary':'full')).toEqual(['full','full','summary','full']); loader.dispose();
});

it('stops on terminal authorization errors and does not fetch summary', async () => {
 const fetcher=vi.fn().mockResolvedValue(response(403,{error:{code:'not_authorized'}}));
 const loader=new ResultLoader({roomId:'room',token:'token',fetcher,random:()=>0.5,isAvailable:()=>true});
 await loader.start(); expect(fetcher).toHaveBeenCalledTimes(1); expect(loader.state.terminal).toBe(true); loader.dispose();
});

it('bounds retries, keeps one request in flight, and allows manual retry', async () => {
 vi.useFakeTimers();
 const fetcher=vi.fn().mockResolvedValue(response(503,{}));
 const loader=new ResultLoader({roomId:'room',token:undefined,fetcher,random:()=>0.5,isAvailable:()=>true});
 void loader.start(); void loader.start(); await flush();
 for (const wait of [1000,2000,4000,8000]) { await vi.advanceTimersByTimeAsync(wait); await flush(); }
 expect(fetcher).toHaveBeenCalledTimes(5); expect(loader.state.canRetry).toBe(true);
 await vi.advanceTimersByTimeAsync(30_000); expect(fetcher).toHaveBeenCalledTimes(5);
 void loader.retry(); await flush(); expect(fetcher).toHaveBeenCalledTimes(6); loader.dispose();
});

it('waits for result readiness and honors Retry-After', async () => {
 vi.useFakeTimers();
 const fetcher=vi.fn().mockResolvedValueOnce(response(409,{error:{code:'results_not_ready'}}))
  .mockResolvedValueOnce(response(429,{error:{code:'rate_limited'}},{'retry-after':'5'}))
  .mockResolvedValueOnce(response(200,{room:full.room,ranking:[]}));
 const loader=new ResultLoader({roomId:'room',fetcher,random:()=>0.5,isAvailable:()=>true});
 void loader.start(); await flush(); await vi.advanceTimersByTimeAsync(1000); await flush();
 await vi.advanceTimersByTimeAsync(4999); expect(fetcher).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(3); loader.dispose();
});

it('pauses while unavailable and ignores an old response after dispose', async () => {
 vi.useFakeTimers(); let available=false;
 let resolveFetch!: (value: Response)=>void;
 const fetcher=vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{resolveFetch=resolve;}));
 const loader=new ResultLoader({roomId:'room',fetcher,random:()=>0.5,isAvailable:()=>available});
 void loader.start(); await vi.advanceTimersByTimeAsync(0); expect(fetcher).not.toHaveBeenCalled();
 available=true; loader.availabilityChanged(); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
 loader.dispose(); resolveFetch(response(200,full)); await flush(); expect(loader.state.full).toBeNull();
});

it('stops on expiry and rejects malformed successful payloads', async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
 const fetcher=vi.fn().mockResolvedValue(response(200,{room:full.room,ranking:'broken'}));
 const loader=new ResultLoader({roomId:'room',fetcher,random:()=>0.5,isAvailable:()=>true,expiresAtMs:Date.now()+500});
 void loader.start(); await flush(); expect(loader.state.full).toBeNull();
 await vi.advanceTimersByTimeAsync(500); await flush();
 expect(loader.state.terminal).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1); loader.dispose();
});

it('loads successful results with exactly one request and no summary call', async () => {
 const fetcher=vi.fn().mockResolvedValue(response(200,full));
 const loader=new ResultLoader({roomId:'room',token:'token',fetcher,isAvailable:()=>true});
 await loader.start();
 expect(loader.state.full).toEqual(full); expect(fetcher).toHaveBeenCalledTimes(1);
 expect(String(fetcher.mock.calls[0][0])).toMatch(/\/results$/); loader.dispose();
});
