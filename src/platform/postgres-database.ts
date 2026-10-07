import type { PersistenceDatabase, PreparedSql, SqlValue } from '../persistence/db';

type QueryResult = { rows: Record<string, unknown>[]; affectedRows?: number };
export type Query = (sql: string, values: SqlValue[]) => Promise<QueryResult>;

// The application only supplies static SQL. Values always remain bound parameters.
export function postgresQuery(input: string, values: readonly SqlValue[] = []): string {
  let sql = input.replaceAll('`', '"')
    .replace(/CAST\(unixepoch\('subsec'\) \* 1000 AS INTEGER\)/g, 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint')
    .replace(/CAST\(([^()]+) AS INTEGER\)/gi, 'CAST($1 AS bigint)')
    .replace(/json_object\(/g, 'json_build_object(')
    // Force text parameter OIDs: postgres.js otherwise JSON-encodes our JSON strings again.
    .replace(/(?<!CROSS )\bJOIN\s+json_each\(/g, 'CROSS JOIN LATERAL json_each(')
    .replace(/json_each\(([^()]+)\)/g, 'jsonb_array_elements(($1)::text::jsonb)')
    .replace(/json_extract\(([^,()]+),\s*'\$((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+)'\)/g, (_match, expression: string, path: string) => {
      const keys = Array.from(path.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g), m => m[1] ?? m[2]);
      const extract = `((${expression})::text::jsonb #>> '{${keys.join(',')}}')`;
      return ['correctCount', 'elapsedCs', 'rank', 'ordinal', 'maxScore', 'seq', 'elapsedMs', 'acceptedForScore'].includes(keys.at(-1)!) ? `${extract}::bigint` : extract;
    })
    .replace(/MAX\((expires_at_ms|0),/g, 'GREATEST($1,');
  const ignore = /\bINSERT OR IGNORE\b/i.test(sql);
  sql = sql.replace(/\bINSERT OR IGNORE\b/gi, 'INSERT');
  if (ignore) sql = sql.trim().replace(/;$/, '') + ' ON CONFLICT DO NOTHING';
  // SQLite allows numeric CASE conditions; Postgres requires boolean.
  sql = sql.replace(/CASE WHEN \? THEN/g, 'CASE WHEN ?::bigint <> 0 THEN');
  // JSON columns in the migrated schema intentionally retain their text contract.
  sql = sql.replace(/json_build_object\(([^]*?)\)(?=\s*,\s*(?:\?|CAST|r\.|revision|ended_at_ms))/g, 'json_build_object($1)::text');
  let quoted = false; let index = 0; let result = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (quoted && sql[i + 1] === "'") { result += "''"; i++; continue; }
      quoted = !quoted;
    }
    if (c === '?' && !quoted) {
      const numeric = typeof values[index] === 'number';
      result += `$${++index}${numeric ? '::bigint' : ''}`;
    } else result += c;
  }
  return result;
}

function normalize(row: Record<string, unknown>) {
  // postgres.js bigint parser and PGlite return strings for int8. Application
  // integer fields are all safe JS integers, validated at API boundaries.
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    typeof value === 'bigint' ? Number(value) : typeof value === 'string' && /^(?:-?\d+)$/.test(value)
      && /(?:_ms|_cs|count|revision|ordinal|generation|epoch|seq|rank|enabled|score|joined_order)$/.test(key) ? Number(value) : value]));
}

class PostgresStatement implements PreparedSql {
  constructor(private readonly execute: Query, readonly query: string, private readonly values: SqlValue[] = []) {}
  bind(...values: SqlValue[]) { return new PostgresStatement(this.execute, this.query, values); }
  async all<T>() { const result = await this.execute(postgresQuery(this.query, this.values), this.values); return { results: result.rows.map(normalize) as T[] }; }
  async first<T>() { return (await this.all<T>()).results[0] ?? null; }
  async run() { const result = await this.execute(postgresQuery(this.query, this.values), this.values); return { success: true, meta: { changes: result.affectedRows ?? result.rows.length } }; }
}

/** Must be created inside the enclosing request transaction. Batch does not
 * create nested transactions: every read and write shares the same snapshot. */
export class PostgresDatabase implements PersistenceDatabase {
  readonly transactional=true;
  // Preserved Supabase/native-command capacity until its separate migration.
  readonly classCompetitionCapacity=42;
  constructor(private readonly execute: Query) {}
  prepare(query: string) { return new PostgresStatement(this.execute, query); }
  async batch(statements: PreparedSql[]) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}
