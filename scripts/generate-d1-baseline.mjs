import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Offline generation only. Never executed inside a Worker or against remote data.
const db = new DatabaseSync(':memory:');
const history = new URL('../drizzle/', import.meta.url);
for (const name of readdirSync(history).filter(name => name.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(name, history), 'utf8'));
}
const objects = db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL
  AND type IN ('table','index') AND name NOT LIKE 'sqlite_%'
  ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all();
const sql = '-- Empty-database D1 baseline generated from the preserved SQLite history.\n'
  + '-- Apply through Wrangler migrations; never apply drizzle history to this database.\n'
  + objects.map(({ sql }) => `${sql};`).join('\n--> statement-breakpoint\n') + '\n';
writeFileSync(new URL('../migrations/d1/0001_baseline.sql', import.meta.url), sql);
db.close();
