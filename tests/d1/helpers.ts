import { readFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import { getPlatformProxy } from 'wrangler';
let remotePlatform: ReturnType<typeof getPlatformProxy> | undefined;
afterAll(async () => { if (remotePlatform) await (await remotePlatform).dispose(); });
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fromD1, type PersistenceDatabase } from '../../src/persistence/db';

export async function createD1TestDatabase() {
  if (process.env.REMOTE_D1 === '1') {
    const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const target = config.env?.test?.d1_databases?.[0];
    if (target?.database_id !== '908e08e6-0b70-454b-a97d-0528fde1706e' || target.remote !== true) {
      throw new Error('Remote tests require the dedicated Phase 1 test D1; no candidate fallback');
    }
    remotePlatform ??= getPlatformProxy({configPath:'wrangler.jsonc',environment:'test',remoteBindings:true,persist:false,envFiles:[]});
    const binding = (await remotePlatform).env.DB as any;
    if (Number(await binding.prepare('SELECT COUNT(*) n FROM rooms').first('n')) !== 0) {
      throw new Error('Dedicated test DB contains rooms; inspect before cleanup');
    }
    return { runtime: null, binding, db: fromD1(binding), close: async () => {
      const ids = ['room-1', ...Array.from({length:59}, (_,i)=>`expired-${i}`)];
      await binding.prepare('DELETE FROM rooms WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).run();
    }};
  }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-07',
    script: 'export default { fetch() { return new Response("D1 test"); } };',
    d1Databases: { DB: 'phase1-test' },
  }));
  const binding = await runtime.getD1Database('DB');
  const sql = readFileSync(new URL('../../migrations/d1/0001_baseline.sql', import.meta.url), 'utf8');
  const statements = sql.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean);
  // Same statements as the Wrangler migration, applied only to isolated test storage.
  await binding.batch(statements.map(statement => binding.prepare(statement)));
  return { runtime, binding, db: fromD1(binding as unknown as PersistenceDatabase), close: () => runtime.dispose() };
}
