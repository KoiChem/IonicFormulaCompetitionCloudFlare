import {expect, it} from 'vitest';
import {fixture, settings} from './helpers';
import {hashParticipantToken} from '../../src/platform/participant-auth';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';

it('requires a verified teacher session before creating a class room', async () => {
  const f = await fixture(false);
  try {
    const response = await f.fetch('/api/rooms', {method: 'POST', headers: {origin: 'https://lite.test', 'content-type': 'application/json'}, body: JSON.stringify({settings})});
    expect(response.status).toBe(401);
  } finally { await f.runtime.dispose(); }
});

it('completes signed OAuth callbacks, authorizes the verified identity, and rejects token failures', async () => {
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  const jwk = {...await exportJWK(publicKey), kid: 'lite-google'};
  let encoded = '';
  const f = await fixture(false, async request => {
    const url = new URL(request.url);
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({keys: [jwk]});
    if (url.href === 'https://oauth2.googleapis.com/token' && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      if (body.get('client_id') !== 'test-client' || body.get('client_secret') !== 'test-secret' || body.get('redirect_uri') !== 'https://lite.test/api/auth/google/callback' || !body.get('code_verifier')) return new Response('', {status: 400});
      return Response.json({id_token: encoded});
    }
    throw new Error('unexpected OAuth destination');
  });
  try {
    const login = async (claims: Record<string,unknown> = {}) => {
      const start = await f.fetch('/api/auth/google/start');
      const url = new URL(start.headers.get('location')!);
      encoded = await new SignJWT({email: 'master@example.com', email_verified: true, nonce: url.searchParams.get('nonce'), ...claims}).setProtectedHeader({alg: 'RS256', kid: 'lite-google'}).setIssuer('https://accounts.google.com').setAudience('test-client').setSubject('google-master').setIssuedAt().setExpirationTime('1m').sign(privateKey);
      const path = `/api/auth/google/callback?code=private-code&state=${url.searchParams.get('state')}`;
      const headers = {cookie: start.headers.get('set-cookie')!.split(';')[0]};
      return {response: await f.fetch(path, {headers}), path, headers};
    };
    const success = await login();
    expect(success.response.headers.get('location')).toBe('https://lite.test/#/teacher');
    const sessionCookie = /__Host-ionic-lite-session=[A-Za-z0-9_-]+/.exec(success.response.headers.get('set-cookie')!)?.[0];
    expect(sessionCookie).toBeTruthy();
    const session = await (await f.fetch('/api/auth/session', {headers: {cookie: sessionCookie!}})).json() as any;
    expect(session).toMatchObject({identity: {id: 'google-master', email: 'master@example.com'}, isMaster: true});
    expect((await f.fetch('/api/rooms', {method: 'POST', headers: {origin: 'https://lite.test', cookie: sessionCookie!, 'x-competition-csrf': session.csrfToken}, body: JSON.stringify({settings})})).status).toBe(201);
    expect((await f.fetch(success.path, {headers: success.headers})).headers.get('location')).toContain('authError=google');
    expect((await login({email: 'unregistered@example.com'})).response.headers.get('location')).toContain('authError=forbidden');
    for (const claims of [{email_verified: false}, {nonce: 'wrong-nonce'}]) {
      const rejected = await login(claims);
      expect(rejected.response.headers.get('location')).toContain('authError=google');
      expect(rejected.response.headers.get('set-cookie')).not.toContain('__Host-ionic-lite-session=');
    }
    expect(JSON.stringify(await f.authStorage.exec('SELECT * FROM sessions'))).not.toContain(sessionCookie!.split('=')[1]);
  } finally { await f.runtime.dispose(); }
});

it('rejects CSRF, another origin, forged cookies, and expired sessions', async () => {
  const f = await fixture(false);
  try {
    const create = (headers: Record<string,string>) => f.fetch('/api/rooms', {method: 'POST', headers, body: JSON.stringify({settings})});
    expect((await create(f.teacherHeaders)).status).toBe(201);
    expect((await create({...f.teacherHeaders, 'x-competition-csrf': 'forged'})).status).toBe(403);
    expect((await create({...f.teacherHeaders, origin: 'https://other.test'})).status).toBe(403);
    expect((await create({...f.teacherHeaders, cookie: '__Host-ionic-lite-session=' + 'B'.repeat(43)})).status).toBe(401);
    await f.authStorage.exec('UPDATE sessions SET expires_at=?', Date.now() - 1);
    expect((await create(f.teacherHeaders)).status).toBe(401);
  } finally { await f.runtime.dispose(); }
});

it('lets only the master register teachers and revokes removed teacher sessions', async () => {
  const f = await fixture(false);
  try {
    const mutate = (method: string, email: string, headers = f.teacherHeaders) => f.fetch('/api/teacher/allowlist', {method, headers, body: JSON.stringify({email})});
    expect((await f.fetch('/api/teacher/allowlist')).status).toBe(401);
    const added = await mutate('POST', ' Teacher@Example.com ');
    expect(await added.json()).toEqual({emails: ['teacher@example.com'], masterEmail: 'master@example.com'});
    expect((await mutate('POST', 'master@example.com')).status).toBe(400);
    expect((await mutate('POST', 'invalid')).status).toBe(400);
    expect((await mutate('POST', 'another@example.com', {...f.teacherHeaders, 'x-competition-csrf': ''})).status).toBe(403);
    const secret = 'C'.repeat(43), teacherHeaders = {origin: 'https://lite.test', cookie: '__Host-ionic-lite-session=' + secret, 'x-competition-csrf': await hashParticipantToken(secret + ':csrf')};
    await f.authStorage.exec('INSERT INTO sessions VALUES(?,?,?,?)', await hashParticipantToken(secret), 'teacher-id', 'teacher@example.com', Date.now() + 3600000);
    expect((await f.fetch('/api/rooms', {method: 'POST', headers: teacherHeaders, body: JSON.stringify({settings})})).status).toBe(201);
    expect((await mutate('POST', 'other@example.com', teacherHeaders)).status).toBe(403);
    expect((await f.fetch('/api/teacher/allowlist', {headers: teacherHeaders})).status).toBe(403);
    expect((await mutate('DELETE', 'teacher@example.com')).status).toBe(200);
    expect((await f.fetch('/api/rooms', {method: 'POST', headers: teacherHeaders, body: JSON.stringify({settings})})).status).toBe(401);
    expect(await f.authStorage.exec('SELECT email FROM teachers')).toHaveLength(0);
    expect(await f.authStorage.exec('SELECT email FROM sessions WHERE email=?', 'teacher@example.com')).toHaveLength(0);
  } finally { await f.runtime.dispose(); }
});

it('rejects roster overflow without dropping existing teachers', async () => {
  const f = await fixture(false);
  try {
    for (let i = 0; i < 100; i++) await f.authStorage.exec('INSERT INTO teachers VALUES(?)', `teacher${i}@example.com`);
    const insert = (email: string) => f.fetch('/api/teacher/allowlist', {method: 'POST', headers: f.teacherHeaders, body: JSON.stringify({email})});
    expect((await insert('overflow@example.com')).status).toBe(409);
    expect((await insert('teacher0@example.com')).status).toBe(200);
    expect(await f.authStorage.exec('SELECT email FROM teachers')).toHaveLength(100);
  } finally { await f.runtime.dispose(); }
});

it('logout revokes the session and sends an HttpOnly cookie deletion', async () => {
  const f = await fixture(false);
  try {
    expect((await f.fetch('/api/auth/logout', {headers: f.teacherHeaders})).status).toBe(405);
    expect((await f.fetch('/api/auth/logout', {method: 'POST', headers: {...f.teacherHeaders, 'x-competition-csrf': ''}})).status).toBe(403);
    const response = await f.fetch('/api/auth/logout', {method: 'POST', headers: f.teacherHeaders});
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    const session = await f.fetch('/api/auth/session', {headers: f.teacherHeaders});
    expect(await session.json()).toMatchObject({identity: null});
  } finally { await f.runtime.dispose(); }
});

it('rejects mismatched, expired, cancelled, and replayed OAuth requests', async () => {
  const f = await fixture(false);
  try {
    const start = await f.fetch('/api/auth/google/start');
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    const browserCookie = start.headers.get('set-cookie')!.split(';')[0];
    const callback = (cookie: string, query = 'error=access_denied') => f.fetch(`/api/auth/google/callback?state=${state}&${query}`, {headers: {cookie}});
    expect((await callback('__Host-ionic-lite-oauth=' + 'B'.repeat(43))).headers.get('location')).toContain('authError=google');
    expect(await f.authStorage.exec('SELECT state_hash FROM oauth')).toHaveLength(1);
    expect((await callback(browserCookie)).headers.get('location')).toContain('authError=google');
    expect(await f.authStorage.exec('SELECT state_hash FROM oauth')).toHaveLength(0);
    expect((await callback(browserCookie, 'code=private-code')).headers.get('location')).toContain('authError=google');
    const stale = await f.fetch('/api/auth/google/start');
    await f.authStorage.exec('UPDATE oauth SET expires_at=?', Date.now() - 1);
    const staleState = new URL(stale.headers.get('location')!).searchParams.get('state');
    const expired = await f.fetch(`/api/auth/google/callback?state=${staleState}&code=private-code`, {headers: {cookie: stale.headers.get('set-cookie')!.split(';')[0]}});
    expect(expired.headers.get('location')).toContain('authError=google');
    expect(expired.headers.get('location')).not.toContain('private-code');
  } finally { await f.runtime.dispose(); }
});

it('cleans expired login records with an alarm while keeping teacher permissions', async () => {
  const f = await fixture(false);
  try {
    await f.authStorage.exec('INSERT INTO teachers VALUES(?)', 'teacher@example.com');
    await f.authStorage.exec('UPDATE sessions SET expires_at=?', Date.now() + 200);
    await f.fetch('/api/auth/google/start');
    await f.authStorage.exec('UPDATE oauth SET expires_at=?', Date.now() - 1);
    const until = Date.now() + 3000;
    while ((await f.authStorage.exec('SELECT token_hash FROM sessions')).length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    expect(await f.authStorage.exec('SELECT token_hash FROM sessions')).toHaveLength(0);
    expect(await f.authStorage.exec('SELECT state_hash FROM oauth')).toHaveLength(0);
    expect(await f.authStorage.exec('SELECT email FROM teachers')).toEqual([{email: 'teacher@example.com'}]);
  } finally { await f.runtime.dispose(); }
});

it('returns an anonymous session without leaking teacher addresses', async () => {
  const f = await fixture(false);
  try {
    const response = await f.fetch('/api/auth/session');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({identity: null, csrfToken: null});
  } finally { await f.runtime.dispose(); }
});

it('sends the standard S256 PKCE challenge and binds state to a browser cookie', async () => {
  const f = await fixture(false);
  try {
    const response = await f.fetch('/api/auth/google/start');
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    const [tx] = await f.authStorage.exec('SELECT verifier FROM oauth');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tx.verifier)));
    const expected = Buffer.from(digest).toString('base64url');
    expect(target.searchParams.get('code_challenge')).toBe(expected);
    expect(target.searchParams.get('scope')).toBe('openid email');
    expect(target.searchParams.get('redirect_uri')).toBe('https://lite.test/api/auth/google/callback');
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
  } finally { await f.runtime.dispose(); }
});
