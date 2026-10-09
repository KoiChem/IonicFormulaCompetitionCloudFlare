import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const settings = { questionCount: 5, timeLimitMinutes: 3, mode: 'ion', difficulty: 'normal',
  ionAnswer: 'name', compoundPrompts: { formula: true, name: true }, compoundAnswer: 'formula' };
export async function fixture() {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'lite-test', modules: true,
    compatibilityDate: '2026-10-07', script: bundle.outputFiles[0].text,
    unsafeInspectDurableObjects: true,
    durableObjects: { ROOMS: { className: 'LiteRoom', useSQLite: true } },
    bindings: { RELEASE_SHA: 'test-lite' },
    serviceBindings: { ASSETS: async () => new Response('Lite') },
  }));
  const fetch = (path: string, init?: RequestInit) => runtime.dispatchFetch('https://lite.test' + path, init);
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
  return { runtime, fetch, create, storage, connect };
}
export const credentials = (nickname = '生徒') => ({type: 'hello', role: 'participant', participantId: crypto.randomUUID(), token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), nickname});
