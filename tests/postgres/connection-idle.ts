import {postgresTransactions} from '../../src/platform/postgres-runtime';
import {writeFileSync} from 'node:fs';
const connection=process.env.TEST_DATABASE_URL;
if(!connection||new URL(connection).hostname!=='127.0.0.1'||new URL(connection).pathname!=='/ionic_timeout_validation')throw new Error('Disposable local database only');
const results=[];
for(const idleTimeoutSeconds of [1,10,20]){
 const run=postgresTransactions(connection,{ssl:false,idleTimeoutSeconds});const samples=[];
 for(let i=0;i<3;i++){
  const metrics={poolWaitMs:0,roomLockWaitMs:0,dbWorkMs:0,queryCount:0};const began=Date.now();
  const row=await run('snapshot:idle',db=>db.prepare('SELECT pg_backend_pid() AS pid').first<{pid:number}>(),metrics);
  samples.push({pid:row!.pid,elapsedMs:Date.now()-began,...metrics});if(i<2)await new Promise(r=>setTimeout(r,1600));
 }
 results.push({idleTimeoutSeconds,samples,connections:new Set(samples.map(s=>s.pid)).size});
}
writeFileSync('/private/tmp/ionic-phase2-idle-result.json',JSON.stringify(results,null,2));console.log(results);process.exit(0);
