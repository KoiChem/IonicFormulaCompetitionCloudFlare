import {build} from 'esbuild';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
export async function createWorkerFixture(entry='worker/index.ts',options:{bindings?:Record<string,string>;durableObjects?:Record<string,string>;port?:number;assetsDirectory?:string}={}){
 const bundle=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,host:'127.0.0.1',...(options.port?{port:options.port}:{}),compatibilityDate:'2026-10-07',script:bundle.outputFiles[0].text,
  d1Databases:{DB:'isolated-independent-test'},durableObjects:options.durableObjects,
  bindings:{RELEASE_SHA:'test-release',...options.bindings},serviceBindings:{ASSETS:async(request:Request)=>{if(!options.assetsDirectory)return new Response('<html>SPA</html>',{headers:{'content-type':'text/html'}});const root=resolve(options.assetsDirectory);let path=resolve(root,'.'+decodeURIComponent(new URL(request.url).pathname));if(!path.startsWith(root+sep))path=resolve(root,'index.html');let data:Buffer;try{data=readFileSync(path);}catch{path=resolve(root,'index.html');data=readFileSync(path);}return new Response(data,{headers:{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'} as Record<string,string>)[extname(path)]??'application/octet-stream'}});}}}));
 const db=await runtime.getD1Database('DB');
 for(const file of readdirSync('migrations/d1').filter(x=>x.endsWith('.sql')).sort()){
  const sql=readFileSync('migrations/d1/'+file,'utf8');
  await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
 return {runtime,db,fetch:(path:string,init?:RequestInit)=>runtime.dispatchFetch('https://test'+path,init),close:()=>runtime.dispose()};
}
