import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {PostgresDatabase} from '../../src/platform/postgres-database';
import {readQuestionProfile,updateQuestionProfile} from '../../src/persistence/question-profiles';
let pg:PGlite;let db:PostgresDatabase;
beforeAll(async()=>{pg=new PGlite();await pg.exec(readFileSync('supabase/migrations/202610010001_core.sql','utf8'));await pg.exec('CREATE ROLE anon;CREATE ROLE authenticated');db=new PostgresDatabase((q,v)=>pg.query(q,v));});
afterAll(async()=>pg.close());
it('stores immutable revisions and idempotent receipt on PostgreSQL',async()=>{
 await pg.exec(readFileSync('supabase/migrations/202610020001_question_profiles.sql','utf8'));
 const initial=await readQuestionProfile(db);const profile=structuredClone(initial.profile);profile.rules.ion.normal.complexPercent=30;
 const input={teacherId:'master',requestId:'profile-test',bodyHash:'hash',expectedRevision:0,profile,nowMs:Date.now()};
 expect(await updateQuestionProfile(db,input)).toEqual({profile,revision:1});expect(await updateQuestionProfile(db,input)).toEqual({profile,revision:1});expect(await readQuestionProfile(db)).toEqual({profile,revision:1});
 expect((await pg.query("SELECT has_table_privilege('authenticated','question_profiles','SELECT') AS permitted")).rows[0]).toMatchObject({permitted:false});
 expect((await pg.query("SELECT relrowsecurity FROM pg_class WHERE relname='question_profiles'")).rows[0]).toMatchObject({relrowsecurity:true});
});
