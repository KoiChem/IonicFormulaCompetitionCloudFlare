import {postgresTransactions} from '../../src/platform/postgres-runtime';
import type {TransactionMetrics} from '../../src/platform/supabase-gateway';
import {writeFileSync} from 'node:fs';
const connection=process.env.TEST_DATABASE_URL;
if(!connection||new URL(connection).hostname!=='127.0.0.1'||new URL(connection).pathname!=='/ionic_timeout_validation_control')throw new Error('Requires local control validation DB');
const runner=postgresTransactions(connection,{ssl:false});const results=[];
for(const scope of ['room:metric-validation','snapshot:metric-validation','quota:metric-validation']){
 const metrics:TransactionMetrics={poolWaitMs:0,roomLockWaitMs:0,dbWorkMs:0,queryCount:0};
 await runner(scope,db=>db.prepare('SELECT 1 AS value').first(),metrics);
 const expected=scope.startsWith('room:')?5:4;
 if(metrics.queryCount!==1||(metrics as any).controlQueryCount!==expected)throw new Error(JSON.stringify({scope,metrics,expected}));results.push({scope,metrics});
}
const failure:TransactionMetrics={poolWaitMs:0,roomLockWaitMs:0,dbWorkMs:0,queryCount:0};
try{await runner('room:metric-rollback',db=>db.prepare('SELECT 1/0 AS value').first(),failure);throw new Error('Expected SQL failure');}catch(e){if((e as any).code!=='22012')throw e;}
if((failure as any).controlQueryCount!==5)throw new Error('Rollback control count missing');results.push({scope:'rollback',metrics:failure});
writeFileSync('/private/tmp/ionic-native-control-metrics.json',JSON.stringify(results,null,2));console.log(results);process.exit(0);
