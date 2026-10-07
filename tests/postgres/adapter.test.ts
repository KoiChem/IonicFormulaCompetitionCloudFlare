import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { PostgresDatabase, postgresQuery } from '../../src/platform/postgres-database';
let pg: PGlite;
beforeEach(async () => { pg = new PGlite(); });
afterEach(async () => { await pg.close(); });
describe('Postgres persistence compatibility', () => {
  it('normalizes postgres.js bigint join orders without changing text identifiers', async () => {
    const db = new PostgresDatabase(async () => ({ rows: [
      { joined_order: '1', nickname: '123', id: '456' },
      { joined_order: '2', nickname: '789', id: '012' },
    ] }));
    expect((await db.prepare('SELECT joined_order, nickname, id FROM participants').all()).results)
      .toEqual([{ joined_order: 1, nickname: '123', id: '456' }, { joined_order: 2, nickname: '789', id: '012' }]);
  });
  it('uses bound parameters without substituting quoted question marks', () => {
    expect(postgresQuery("SELECT '?' AS literal, ? AS value")).toBe("SELECT '?' AS literal, $1 AS value");
  });
  it('rolls back the complete batch when a later statement fails', async () => {
    await pg.exec('CREATE TABLE samples(id text PRIMARY KEY)');
    const db = new PostgresDatabase((query, values) => pg.query(query, values));
    await expect(pg.transaction(async tx => {
      const transactional = new PostgresDatabase((query, values) => tx.query(query, values));
      await transactional.batch([transactional.prepare('INSERT INTO samples VALUES (?)').bind('a'), transactional.prepare('INSERT INTO samples VALUES (?)').bind('a')]);
    })).rejects.toThrow();
    expect(await db.prepare('SELECT count(*)::int AS count FROM samples').first()).toEqual({ count: 0 });
  });
  it('handles SQLite JSON extraction and scalar bounds in real Postgres', async () => {
    const db = new PostgresDatabase((query, values) => pg.query(query, values));
    const row = await db.prepare("SELECT json_extract(?, '$.rank') AS rank, MAX(0, ?) AS bounded").bind('{"rank":2}', -10).first();
    expect(row).toEqual({ rank: 2, bounded: 0 });
  });
});

it('binds pre-encoded JSON as text before the JSON cast to avoid postgres.js double encoding', async () => {
 const query=postgresQuery("SELECT json_extract(value, '$.rank') AS rank FROM json_each(?)", ['[{"rank":2}]']);
 expect(query).toContain('jsonb_array_elements(($1)::text::jsonb)');
 const row=await pg.query(query,['[{"rank":2}]']);
 expect(Number((row.rows[0] as {rank:unknown}).rank)).toBe(2);
});
it('uses a lateral cross join for SQLite table-valued JSON array joins',async()=>{
 const query=postgresQuery("SELECT json_extract(field.value, '$.id') AS id FROM (SELECT '[{\"id\":\"formula\"}]' AS fields) q JOIN json_each(q.fields) AS field WHERE true");
 expect(query).toContain('CROSS JOIN LATERAL');expect((await pg.query(query)).rows).toEqual([{id:'formula'}]);
});
