import {build} from 'esbuild';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
export async function createWorkerFixture(entry='worker/index.ts',options:{bindings?:Record<string,string>;durableObjects?:Record<string,string>}={}){
 const bundle=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-07',script:bundle.outputFiles[0].text,
  d1Databases:{DB:'isolated-independent-test'},durableObjects:options.durableObjects,
  bindings:{RELEASE_SHA:'test-release',...options.bindings},serviceBindings:{ASSETS:async()=>new Response('<html>SPA</html>',{headers:{'content-type':'text/html'}})}}));
 const db=await runtime.getD1Database('DB');
 for(const file of readdirSync('migrations/d1').filter(x=>x.endsWith('.sql')).sort()){
  const sql=readFileSync('migrations/d1/'+file,'utf8');
  await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
 return {runtime,db,fetch:(path:string,init?:RequestInit)=>runtime.dispatchFetch('https://test'+path,init),close:()=>runtime.dispose()};
}
