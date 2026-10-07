import postgres from 'postgres';
import { PostgresDatabase, type Query } from './postgres-database';
import type { TransactionRunner, TransactionMetrics } from './supabase-gateway';
export function transactionIsolation(scope:string){
  if(scope.startsWith('snapshot:'))return 'repeatable read read only';
  return scope.startsWith('room:')||scope.startsWith('broadcast:')?'read committed':'serializable';
}
export function postgresTransactions(connectionString:string,options:{ssl?:'require'|false;queryDelayMs?:number;idleTimeoutSeconds?:number;controlDelayMs?:number}={}):TransactionRunner {
  // Transaction-mode Supavisor does not support prepared statements.
  const sql=postgres(connectionString,{prepare:false,max:1,ssl:options.ssl??'require',idle_timeout:options.idleTimeoutSeconds??1,connect_timeout:10});
  return async<T>(scope:string,run:(db:PostgresDatabase)=>Promise<T>,metrics?:TransactionMetrics):Promise<T>=>{
    for(let attempt=0;;attempt++){
      // SERIALIZABLE snapshots taken by the lock SELECT would predate waiting.
      // Room commands instead read fresh statements after their shared mutex.
      const queuedAt=Date.now();let began=false;
      const control=()=>{if(metrics)metrics.controlQueryCount=(metrics.controlQueryCount??0)+1;};
      const controlDelay=async()=>{if(options.controlDelayMs)await new Promise(resolve=>setTimeout(resolve,options.controlDelayMs));};
      try{const value=await sql.begin(`isolation level ${transactionIsolation(scope)}`,async tx=>{
        began=true;control();await controlDelay(); // BEGIN confirmed before entering the callback.
        if(metrics)metrics.poolWaitMs+=Date.now()-queuedAt;
        control();await controlDelay();await tx.unsafe('SET LOCAL statement_timeout = 9000');
        control();await controlDelay();await tx.unsafe('SET LOCAL lock_timeout = 7000');
        const lockStarted=Date.now();
        if(!scope.startsWith('snapshot:')&&!scope.startsWith('quota:')){control();await controlDelay();await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope]);}
        if(metrics)metrics.roomLockWaitMs+=Date.now()-lockStarted;
        const workStarted=Date.now();
        const execute:Query=async(query,values)=>{
          try {
            if(metrics)metrics.queryCount++;
            if(options.queryDelayMs)await new Promise(resolve=>setTimeout(resolve,options.queryDelayMs));
            const rows=await tx.unsafe(query,values as any[]);
            return {rows:Array.from(rows) as Record<string,unknown>[],affectedRows:rows.count};
          } catch(error) {
            // Static SQL and SQLSTATE only; bound answers and credentials are never logged.
            console.error(JSON.stringify({event:'database_query_failed',code:(error as {code?:string}).code,operation:query.trim().split(/\s/)[0]}));
            throw error;
          }
        };
        let result:T;
        try{result=await run(new PostgresDatabase(execute));}finally{if(metrics)metrics.dbWorkMs+=Date.now()-workStarted;}
        if(result instanceof Response&&result.status>=500)throw result;
        await controlDelay();return result;
      }) as T;control();return value;}catch(error){
        if(began)control(); // sql.begin completed its ROLLBACK before rejecting.
        if(error instanceof Response)return error as T;
        if(attempt<4&&['40001','40P01'].includes((error as {code?:string}).code??'')){
          if(metrics)metrics.retryCount=(metrics.retryCount??0)+1;
          await new Promise(resolve=>setTimeout(resolve,25*2**attempt+Math.floor(Math.random()*50)));
          continue;
        }
        throw error;
      }
    }
  };
}
