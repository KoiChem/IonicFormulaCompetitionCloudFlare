import { LiteRoom, type LiteEnv, json } from './room';
import {LiteTeachers, teacherSession} from './auth';
export { LiteRoom, LiteTeachers };
export default {
  async fetch(request: Request, env: LiteEnv): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (url.pathname === '/api/health') response = json({ backend: 'lite', d1: false, maxParticipants: 50, release: env.RELEASE_SHA });
      else if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/teacher/allowlist') {
        response = await env.TEACHERS.get(env.TEACHERS.idFromName('teachers')).fetch(new Request(request, {redirect: 'manual'}));
      } else if (url.pathname === '/api/rooms' && request.method === 'POST') {
        if (request.headers.get('origin') !== url.origin) return json({error:'別のサイトからの操作は受け付けません'},403);
        const session = await teacherSession(request, env);
        if (!session.ready) return json({error:'教員認証の設定を準備中です'},503);
        if (!session.identity) return json({error:'教員ログインが必要です'},401);
        if (request.headers.get('x-competition-csrf') !== session.csrfToken) return json({error:'操作資格を再確認してください'},403);
        if (Number(request.headers.get('content-length')) > 16384) return json({error:'設定が大きすぎます'},413);
        const body = await request.text();
        if (body.length > 16384) return json({error:'設定が大きすぎます'},413);
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>alphabet[n&31]).join('');
        response = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(url.origin+'/create', {method:'POST',body,headers:{'x-room-code':code}}));
      } else {
        const match = /^\/api\/rooms\/([A-Z2-9]{6})\/(socket|info|state)$/.exec(url.pathname);
        if (match) {
          if (match[2]==='socket' && request.headers.get('origin') !== url.origin) return json({error:'別のサイトからの接続は受け付けません'},403);
          return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
        }
        response = url.pathname.startsWith('/api') ? json({error:'見つかりません'},404) : await env.ASSETS.fetch(request);
      }
    } catch { response = json({error:'処理できませんでした。再接続してください'},500); }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff'); headers.set('Referrer-Policy','no-referrer');
    headers.set('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
    headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${url.origin.replace(/^http/,'ws')}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    return new Response(response.body,{status:response.status,headers});
  }
};
