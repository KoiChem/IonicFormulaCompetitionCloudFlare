import {createWorkerApi} from './api';
import type {IndependentEnv} from './env';
export {RoomCoordinator} from './room';
import { PUBLIC_CONFIG } from '../src/config/public';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default {
  async fetch(request: Request, env: IndependentEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      let d1Ready = false;
      try {
        const result = await env.DB.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('rooms', 'participants', 'v2_operations', 'v2_batch_receipts')").first<{ count: number }>();
        d1Ready = result?.count === 4;
      } catch { /* Health responses never expose database errors or SQL. */ }
      return json({ phase: 1, d1Ready, build: env.RELEASE_SHA,
        competitionBackend: 'supabase',
        capacities: { d1Class: PUBLIC_CONFIG.participantLimits.classCompetition, activeClass: 42, mate: PUBLIC_CONFIG.participantLimits.mateMatch },
      }, d1Ready ? 200 : 503);
    }
    if (path === '/api' || path.startsWith('/api/')) return createWorkerApi(env)(request);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<IndependentEnv>;
