import {DurableObject} from 'cloudflare:workers';
import {verifyGoogleIdToken} from '../../worker/auth/google';
import {readBoundedJson} from '../../worker/auth/response';
import {cookie, hash, readCookie, token} from '../../worker/auth/store';
import type {TeacherSession} from '../src/teacher-auth';

export type LiteTeacherEnv = {
  TEACHERS: DurableObjectNamespace<LiteTeachers>;
  APP_ORIGIN: string;
  MASTER_TEACHER_EMAIL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};
const SESSION = '__Host-ionic-lite-session', OAUTH = '__Host-ionic-lite-oauth';
const SESSION_MS = 8 * 60 * 60 * 1000, OAUTH_MS = 10 * 60 * 1000;
const validToken = /^[A-Za-z0-9_-]{43}$/;
const normalize = (email: string) => email.trim().toLowerCase();
const validEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, {status, headers: {'cache-control': 'no-store', ...headers}});
type SessionRow = {sub: string; email: string; expires_at: number};
type OAuthRow = {nonce_hash: string; verifier: string};

// One small, separate object holds teacher permissions and short-lived login
// records. Student answers never access this object.
export class LiteTeachers extends DurableObject<LiteTeacherEnv> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: LiteTeacherEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS teachers (email TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  }
  private master() { return normalize(this.env.MASTER_TEACHER_EMAIL ?? ''); }
  private ready() {
    try {
      const origin = new URL(this.env.APP_ORIGIN);
      return validEmail(this.master()) && !!this.env.GOOGLE_CLIENT_ID && !!this.env.GOOGLE_CLIENT_SECRET
        && origin.origin === this.env.APP_ORIGIN && (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)));
    } catch { return false; }
  }
  private allowed(email: string) {
    return email === this.master() || this.sql.exec('SELECT email FROM teachers WHERE email=?', email).toArray().length > 0;
  }
  private async session(request: Request): Promise<TeacherSession> {
    const empty: TeacherSession = {ready: this.ready(), identity: null, isMaster: false, csrfToken: null, expiresAtMs: null};
    const secret = readCookie(request, SESSION);
    if (!empty.ready || !secret || !validToken.test(secret)) return empty;
    const row = this.sql.exec<SessionRow>('SELECT sub,email,expires_at FROM sessions WHERE token_hash=? AND expires_at>?', await hash(secret), Date.now()).toArray()[0];
    if (!row || !this.allowed(row.email)) return empty;
    return {...empty, identity: {id: row.sub, email: row.email}, isMaster: row.email === this.master(), csrfToken: await hash(secret + ':csrf'), expiresAtMs: row.expires_at};
  }
  private clean() {
    this.sql.exec('DELETE FROM oauth WHERE expires_at<=?', Date.now());
    this.sql.exec('DELETE FROM sessions WHERE expires_at<=?', Date.now());
  }
  private async schedule() {
    const next = this.sql.exec<{due: number | null}>('SELECT MIN(expires_at) AS due FROM (SELECT expires_at FROM oauth UNION ALL SELECT expires_at FROM sessions)').toArray()[0]?.due;
    if (next != null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() { this.clean(); await this.schedule(); }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (url.origin !== this.env.APP_ORIGIN) return json({error: '許可されたアプリから操作してください'}, 403);
    if (path === '/api/auth/session') return request.method === 'GET' ? json(await this.session(request)) : json({error: '操作方法を確認してください'}, 405);
    if (!this.ready()) return json({error: '教員認証の設定を準備中です'}, 503);
    if (path === '/api/auth/google/start' || path === '/api/auth/google/callback') {
      if (request.method !== 'GET') return json({error: '操作方法を確認してください'}, 405);
      return path.endsWith('/start') ? this.start() : this.callback(request);
    }
    const session = await this.session(request);
    if (!session.identity) return json({error: '教員ログインが必要です'}, 401);
    if (request.method !== 'GET' && (request.headers.get('origin') !== this.env.APP_ORIGIN || request.headers.get('x-competition-csrf') !== session.csrfToken)) return json({error: '操作資格を再確認してください'}, 403);
    if (path === '/api/auth/logout') {
      if (request.method !== 'POST') return json({error: '操作方法を確認してください'}, 405);
      this.sql.exec('DELETE FROM sessions WHERE token_hash=?', await hash(readCookie(request, SESSION)!));
      await this.schedule();
      return json({ok: true}, 200, {'set-cookie': cookie(SESSION, '', 0)});
    }
    if (path === '/api/teacher/allowlist') {
      if (!session.isMaster) return json({error: 'マスター教員だけが許可教員を管理できます'}, 403);
      if (request.method !== 'GET') {
        if (!['POST', 'DELETE'].includes(request.method)) return json({error: '操作方法を確認してください'}, 405);
        const text = await request.text();
        if (text.length > 1024) return json({error: 'メールアドレスを確認してください'}, 400);
        let email: string;
        try { const body = JSON.parse(text); email = typeof body.email === 'string' ? normalize(body.email) : ''; }
        catch { return json({error: 'メールアドレスを確認してください'}, 400); }
        if (!validEmail(email) || email === this.master()) return json({error: 'マスター教員以外のメールアドレスを入力してください'}, 400);
        if (request.method === 'POST') {
          if (!this.allowed(email) && this.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM teachers').toArray()[0].count >= 100) return json({error: '登録できる教員は100人までです'}, 409);
          this.sql.exec('INSERT OR IGNORE INTO teachers(email) VALUES(?)', email);
        } else {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM teachers WHERE email=?', email);
            this.sql.exec('DELETE FROM sessions WHERE email=?', email);
          });
          await this.schedule();
        }
      }
      return json({emails: this.sql.exec<{email: string}>('SELECT email FROM teachers ORDER BY email').toArray().map(row => row.email), masterEmail: this.master()});
    }
    return json({error: '見つかりません'}, 404);
  }
  private async start() {
    this.clean();
    if (this.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM oauth').toArray()[0].count >= 256) return json({error: 'しばらく待ってからログインしてください'}, 503);
    const state = token(), browser = token(), nonce = token(), verifier = token();
    this.sql.exec('INSERT INTO oauth(state_hash,browser_hash,nonce_hash,verifier,expires_at) VALUES(?,?,?,?,?)', await hash(state), await hash(browser), await hash(nonce), verifier, Date.now() + OAUTH_MS);
    await this.schedule();
    const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    target.search = new URLSearchParams({client_id: this.env.GOOGLE_CLIENT_ID!, redirect_uri: this.env.APP_ORIGIN + '/api/auth/google/callback', response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'}).toString();
    return new Response(null, {status: 302, headers: {location: target.href, 'cache-control': 'no-store', 'set-cookie': cookie(OAUTH, browser, OAUTH_MS / 1000)}});
  }
  private async callback(request: Request) {
    const url = new URL(request.url), headers = new Headers({'cache-control': 'no-store', 'set-cookie': cookie(OAUTH, '', 0)});
    let error = 'google';
    try {
      const state = url.searchParams.get('state') ?? '', browser = readCookie(request, OAUTH) ?? '';
      if (!validToken.test(state) || !validToken.test(browser)) throw new Error('invalid transaction');
      const tx = this.sql.exec<OAuthRow>('DELETE FROM oauth WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING nonce_hash,verifier', await hash(state), await hash(browser), Date.now()).toArray()[0];
      const code = url.searchParams.get('code');
      if (!tx || url.searchParams.has('error') || !code || code.length > 2048) throw new Error('invalid transaction');
      const response = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({code, client_id: this.env.GOOGLE_CLIENT_ID!, client_secret: this.env.GOOGLE_CLIENT_SECRET!, redirect_uri: this.env.APP_ORIGIN + '/api/auth/google/callback', grant_type: 'authorization_code', code_verifier: tx.verifier}), signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('token exchange failed');
      const body = await readBoundedJson(response);
      if (typeof body.id_token !== 'string' || body.id_token.length > 12000) throw new Error('invalid token');
      const identity = await verifyGoogleIdToken(body.id_token, this.env.GOOGLE_CLIENT_ID!, tx.nonce_hash);
      if (!this.allowed(identity.email)) { error = 'forbidden'; throw new Error('teacher forbidden'); }
      const secret = token();
      this.clean();
      this.sql.exec('INSERT INTO sessions(token_hash,sub,email,expires_at) VALUES(?,?,?,?)', await hash(secret), identity.id, identity.email, Date.now() + SESSION_MS);
      headers.append('set-cookie', cookie(SESSION, secret, SESSION_MS / 1000));
      headers.set('location', this.env.APP_ORIGIN + '/#/teacher');
    } catch { headers.set('location', this.env.APP_ORIGIN + '/#/teacher?authError=' + error); }
    await this.schedule();
    return new Response(null, {status: 302, headers});
  }
}

export async function teacherSession(request: Request, env: LiteTeacherEnv): Promise<TeacherSession> {
  const response = await env.TEACHERS.get(env.TEACHERS.idFromName('teachers')).fetch(new Request(env.APP_ORIGIN + '/api/auth/session', {headers: {cookie: request.headers.get('cookie') ?? ''}}));
  if (!response.ok) throw new Error('teacher auth unavailable');
  return response.json();
}
