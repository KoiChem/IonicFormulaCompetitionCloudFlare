// Local-only browser fixture; this file is never a Worker entry point.
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const directory = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://localhost:8791', root = resolve(directory, 'dist');
const bundle = await build({entryPoints: [resolve(directory, 'worker/index.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers']});
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};
const runtime = new Miniflare(convertV4MiniflareOptions({name: 'lite-browser', host: '127.0.0.1', port: 8791, modules: true, compatibilityDate: '2026-10-07', script: bundle.outputFiles[0].text, unsafeInspectDurableObjects: true,
  durableObjects: {ROOMS: {className: 'LiteRoom', useSQLite: true}, TEACHERS: {className: 'LiteTeachers', useSQLite: true}},
  bindings: {RELEASE_SHA: 'browser-test', APP_ORIGIN: origin, MASTER_TEACHER_EMAIL: 'master@example.com', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret'},
  serviceBindings: {ASSETS: async request => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url).pathname));
    if (path !== root && !path.startsWith(root + '/')) return new Response('', {status: 404});
    try {return new Response(await readFile(path), {headers: {'content-type': types[extname(path)] ?? 'application/octet-stream'}});}
    catch {return path.includes('/assets/') ? new Response('', {status: 404}) : new Response(await readFile(resolve(root, 'index.html')), {headers: {'content-type': 'text/html'}});}
  }}
}));
await runtime.dispatchFetch(origin + '/api/auth/session');
const storage = await runtime.unsafeGetDurableObjectStorage('lite-browser', 'LiteTeachers', {name: 'teachers'});
const hash = value => createHash('sha256').update(value).digest('hex');
await storage.exec('INSERT INTO sessions VALUES(?,?,?,?)', hash('A'.repeat(43)), 'test-master', 'master@example.com', Date.now() + 28800000);
await storage.exec('INSERT INTO teachers VALUES(?)', 'teacher@example.com');
await storage.exec('INSERT INTO sessions VALUES(?,?,?,?)', hash('B'.repeat(43)), 'test-teacher', 'teacher@example.com', Date.now() + 28800000);
console.log('Lite browser fixture ready at ' + origin);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {await runtime.dispose(); process.exit(0);});
await new Promise(() => {});
