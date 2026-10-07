import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { PostgresDatabase } from '../../src/platform/postgres-database';
import { sharedTeacherStore } from '../../src/platform/shared-teacher-store';

let pg:PGlite;
const store=sharedTeacherStore(async<T>(_scope:string,run:(db:PostgresDatabase)=>Promise<T>)=>pg.transaction(tx=>run(new PostgresDatabase((q,v)=>tx.query(q,v)))),'master@example.com');
beforeAll(async()=>{
  pg=new PGlite();
  await pg.exec(`CREATE ROLE anon;CREATE ROLE authenticated;
    CREATE TABLE teacher_allowlist(id integer PRIMARY KEY,emails_json text NOT NULL DEFAULT '[]',revision integer NOT NULL DEFAULT 0,
      last_request_id text,last_body_hash text);
    CREATE TABLE app_auth_config(id integer PRIMARY KEY,master_email text NOT NULL);`);
  await pg.exec(readFileSync('supabase/migrations/202610040001_shared_teacher_authority.sql','utf8'));
  await pg.query(`INSERT INTO shared_teacher_callers(app_id,auth_url,publishable_key,secret_env_name,enabled)
    VALUES('alkane-puzzle-competition','https://remote.example','public-key','SHARED_TEACHER_ALKANE_HMAC_SECRET',true)`);
});
afterAll(async()=>pg.close());
it('reads only registered enabled callers and refuses a reused transport request ID',async()=>{
  expect(await store.lookupRegistry('unknown')).toBeNull();
  expect(await store.lookupRegistry('alkane-puzzle-competition')).toMatchObject({authUrl:'https://remote.example',publishableKey:'public-key'});
  expect(await store.claimRequest('alkane-puzzle-competition','request-0000000001',Date.now())).toBe(true);
  expect(await store.claimRequest('alkane-puzzle-competition','request-0000000001',Date.now())).toBe(false);
});
it('applies allowlist edits with revision CAS and an operation receipt',async()=>{
  expect(await store.mutateAllowlist({email:'teacher@example.com',enabled:true,expectedRevision:0,requestId:'operation-000000001',bodyHash:'hash-a'})).toBe(true);
  expect(await store.mutateAllowlist({email:'other@example.com',enabled:true,expectedRevision:0,requestId:'operation-000000002',bodyHash:'hash-b'})).toBe(false);
  expect(await store.readAllowlist()).toEqual({emails:['teacher@example.com'],revision:1,lastOperation:{requestId:'operation-000000001',bodyHash:'hash-a'}});
});
