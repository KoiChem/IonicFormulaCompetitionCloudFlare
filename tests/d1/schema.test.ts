import { afterAll, beforeAll, expect, it } from 'vitest';
import { SqliteD1, classRoomInput, joinInput } from '../persistence/helpers';
import { createRoom } from '../../src/persistence/rooms';
import { joinRoom } from '../../src/persistence/participants';
import { createD1TestDatabase } from './helpers';

let test: Awaited<ReturnType<typeof createD1TestDatabase>>;
beforeAll(async () => { test = await createD1TestDatabase(); });
afterAll(async () => { await test?.close(); });

it('preserves every legacy SQLite table, column and index in native D1', async () => {
  const legacy = new SqliteD1();
  try {
    const actual = (await test.binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results.map(row => row.name);
    const expected = legacy.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    expect(actual).toEqual(expected);
    for (const table of expected) {
      const columns = (await test.binding.prepare(`PRAGMA table_info('${table}')`).all()).results;
      expect(columns.map(({ name, type, notnull, pk, dflt_value }) => ({ name, type, notnull, pk, dflt_value })))
        .toEqual(legacy.sqlite.prepare(`PRAGMA table_info('${table}')`).all().map(({ name, type, notnull, pk, dflt_value }) => ({ name, type, notnull, pk, dflt_value })));
    }
    const indexes = (await test.binding.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()).results.map(row => row.name);
    expect(indexes).toEqual(legacy.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(row => row.name));
  } finally { legacy.close(); }
});

it('rolls back a failed command batch and enforces participant uniqueness', async () => {
  const nowMs = Date.now();
  await createRoom(test.db, classRoomInput({ nowMs, expiresAtMs: nowMs + 86400000 }));
  await joinRoom(test.db, joinInput(0, { nowMs }));
  await expect(test.binding.batch([
    test.binding.prepare("UPDATE rooms SET revision=999 WHERE id='room-1'"),
    test.binding.prepare("INSERT INTO participants SELECT * FROM participants WHERE id='p-0'"),
  ])).rejects.toThrow();
  expect(await test.binding.prepare("SELECT revision FROM rooms WHERE id='room-1'").first('revision')).toBe(1);
  expect((await test.binding.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await test.binding.prepare("DELETE FROM rooms WHERE id='room-1'").run();
  expect(await test.binding.prepare('SELECT COUNT(*) AS n FROM participants').first('n')).toBe(0);
  expect(await test.binding.prepare('SELECT COUNT(*) AS n FROM command_receipts').first('n')).toBe(0);
});
