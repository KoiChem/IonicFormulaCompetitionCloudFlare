import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
for (const file of readdirSync('drizzle').filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(`drizzle/${file}`, 'utf8'));
const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all();
let sql = `-- Generated from the final Sites schema, reviewed for PostgreSQL.\nCREATE FUNCTION public.json_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$ BEGIN PERFORM value::jsonb; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;\n`;
// PostgreSQL checks foreign keys immediately at CREATE TABLE. Add after all tables.
const foreignKeys = [];
for (const row of rows) {
  if (row.type !== 'table') continue;
  let ddl = row.sql.replaceAll('`', '"').replace(/\binteger\b/gi, 'bigint').replace(/json_type\(([^)]+)\)/g, 'jsonb_typeof(($1)::jsonb)');
  ddl = ddl.replace(/,?\s*FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s*[^\s(]+\s*\([^)]*\)(?:\s+ON (?:UPDATE|DELETE) (?:no action|cascade|restrict|set null|set default))*/gi, m => { foreignKeys.push(`ALTER TABLE "${row.name}" ADD ${m.trim().replace(/^,\s*/, '')};`); return ''; });
  sql += ddl + ';\n';
}
sql += foreignKeys.join('\n') + '\n';
for (const row of rows) if (row.type === 'index') sql += row.sql.replaceAll('`', '"') + ';\n';
for (const row of rows) if (row.type === 'table') sql += `ALTER TABLE public."${row.name}" ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON public."${row.name}" FROM PUBLIC;\n`;
// Initial settings must preserve the original mate availability defaults.
const source = readdirSync('drizzle').filter(x => x.endsWith('.sql')).sort().map(x => readFileSync(`drizzle/${x}`, 'utf8')).join('\n');
for (const insert of source.matchAll(/INSERT (?:OR IGNORE )?INTO [`"]?(site_settings|teacher_allowlist)[`"]?[^;]*;/gi)) sql += insert[0].replaceAll('`','"').replace('INSERT OR IGNORE','INSERT').replace(/;$/, ' ON CONFLICT DO NOTHING;')+'\n';
writeFileSync('supabase/migrations/202610010001_core.sql', sql);
db.close();
