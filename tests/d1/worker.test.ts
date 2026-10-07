import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let runtime:Miniflare;
beforeAll(async()=>{
 const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-07',script:bundle.outputFiles[0].text,
  d1Databases:{DB:'worker-test'},bindings:{RELEASE_SHA:'test-release'},serviceBindings:{ASSETS:async()=>new Response('<html>SPA</html>',{headers:{'content-type':'text/html'}})}}));
});
afterAll(async()=>{await runtime?.dispose();});
it('returns a JSON 503 while the D1 schema is missing, without exposing SQL',async()=>{
 const response=await runtime.dispatchFetch('https://test/api/health');
 expect(response.status).toBe(503);expect(response.headers.get('content-type')).toContain('application/json');
 expect(await response.json()).toMatchObject({phase:1,d1Ready:false,build:'test-release'});
});
it('reports D1 50 and preserved active Supabase 42 separately after migration',async()=>{
 const db=await runtime.getD1Database('DB');
 const sql=readFileSync('migrations/d1/0001_baseline.sql','utf8');
 await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 const response=await runtime.dispatchFetch('https://test/api/health');
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({phase:1,d1Ready:true,competitionBackend:'supabase',capacities:{d1Class:50,activeClass:42,mate:4}});
 expect(response.headers.get('cache-control')).toBe('no-store');
});
it('keeps API errors out of SPA fallback and serves static routes',async()=>{
 for(const path of ['/api','/api/rooms','/api/unknown']){
  const response=await runtime.dispatchFetch('https://test'+path);
  expect(response.status).toBe(404);expect(response.headers.get('content-type')).toContain('application/json');
 }
 expect((await runtime.dispatchFetch('https://test/api/health',{method:'POST'})).status).toBe(405);
 expect(await(await runtime.dispatchFetch('https://test/')).text()).toBe('<html>SPA</html>');
});
