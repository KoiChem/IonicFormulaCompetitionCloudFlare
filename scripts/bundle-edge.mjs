import { build } from 'esbuild';
import { readFileSync,writeFileSync } from 'node:fs';
const out='supabase/functions/competition/index.ts';
await build({entryPoints:['src/platform/edge-entry.ts'],outfile:out,bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['postgres'],minify:false});
writeFileSync(out,readFileSync(out,'utf8').replace('from "postgres"','from "npm:postgres@3.4.9"'));
