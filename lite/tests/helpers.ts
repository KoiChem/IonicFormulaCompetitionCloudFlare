import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {hashParticipantToken} from '../../src/platform/participant-auth';

export const settings = { questionCount: 5, timeLimitMinutes: 3, mode: 'ion', difficulty: 'normal',
  ionAnswer: 'name', compoundPrompts: { formula: true, name: true }, compoundAnswer: 'formula' };
export async function fixture(authenticated = true, outbound?: (request: Request) => Promise<Response>) {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'lite-test', modules: true,
    compatibilityDate: '2026-10-07', script: bundle.outputFiles[0].text,
    unsafeInspectDurableObjects: true,
    durableObjects: { ROOMS: { className: 'LiteRoom', useSQLite: true }, TEACHERS: {className: 'LiteTeachers', useSQLite: true} },
    bindings: { RELEASE_SHA: 'test-lite', APP_ORIGIN: 'https://lite.test', MASTER_TEACHER_EMAIL: 'master@example.com', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' },
    serviceBindings: { ASSETS: async () => new Response('Lite') },
    ...(outbound ? {outboundService: outbound} : {}),
  }));
  await runtime.dispatchFetch('https://lite.test/api/auth/session');
  const authStorage = await runtime.unsafeGetDurableObjectStorage('lite-test', 'LiteTeachers', {name: 'teachers'});
  const secret = 'A'.repeat(43);
  await authStorage.exec('INSERT INTO sessions(token_hash,sub,email,expires_at) VALUES(?,?,?,?)', await hashParticipantToken(secret), 'master-id', 'master@example.com', Date.now() + 3600000);
  const teacherHeaders = {cookie: '__Host-ionic-lite-session=' + secret, 'x-competition-csrf': await hashParticipantToken(secret + ':csrf'), origin: 'https://lite.test'};
  const fetch = (path: string, init?: RequestInit) => {
    const headers = new Headers(authenticated && path === '/api/rooms' ? teacherHeaders : undefined);
    new Headers(init?.headers).forEach((value,key) => headers.set(key,value));
    return runtime.dispatchFetch('https://lite.test' + path, {redirect: 'manual', ...init,headers});
  };
  const create = async (value = settings) => {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { origin: 'https://lite.test', 'content-type': 'application/json' }, body: JSON.stringify({settings: value}) });
    return { response, data: await response.json() as any };
  };
  const storage = async (code: string) => {
    const actual = await runtime.unsafeGetDurableObjectStorage('lite-test', 'LiteRoom', {name: code});
    return {exec: async (...args: Parameters<typeof actual.exec>) => ({rows: await actual.exec(...args)})};
  };
  const connect = async (code: string) => {
    const response = await fetch(`/api/rooms/${code}/socket`, { headers: { upgrade: 'websocket', origin: 'https://lite.test' } });
    const socket = response.webSocket!;
    if (!socket) throw new Error(`Upgrade failed ${response.status}: ${await response.text()}`);
    socket.accept();
    const messages: any[] = [];
    socket.addEventListener('message', event => { if (event.data !== 'pong') messages.push(JSON.parse(String(event.data))); });
    let id = 0;
    const request = (message: any) => new Promise<any>((resolve, reject) => {
      const requestId = String(++id);
      const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('WS response timeout')); }, 5000);
      function receive(event: any) {
        if (event.data === 'pong') return;
        const data = JSON.parse(String(event.data));
        if (data.requestId !== requestId) return;
        clearTimeout(timeout); socket.removeEventListener('message', receive); resolve(data);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ ...message, requestId }));
    });
    return {socket, request, messages};
  };
  return { runtime, fetch, create, storage, connect, authStorage, teacherHeaders };
}
export const credentials = (nickname = '生徒') => ({type: 'hello', role: 'participant', participantId: crypto.randomUUID(), token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), nickname});
