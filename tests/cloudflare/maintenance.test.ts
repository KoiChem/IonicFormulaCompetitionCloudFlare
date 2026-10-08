import {expect,it} from 'vitest';
import {createWorkerFixture} from './helpers';
import {cleanupIndependentStorage} from '../../worker/maintenance';
import {fromD1} from '../../src/persistence/db';
it('cleans expired OAuth transactions in bounded batches and safely repeats',async()=>{
 const f=await createWorkerFixture();try{for(let n=0;n<105;n++)await f.db.prepare('INSERT INTO cf_oauth_transactions VALUES(?,?,?,?,?,?)').bind('state'+n,'browser','nonce','verifier',0,1).run();const env={DB:fromD1(f.db as any)};expect((await cleanupIndependentStorage(env as any,2)).deletedOAuth).toBe(100);expect((await cleanupIndependentStorage(env as any,2)).deletedOAuth).toBe(5);expect((await cleanupIndependentStorage(env as any,2)).deletedOAuth).toBe(0);}finally{await f.close();}
});
