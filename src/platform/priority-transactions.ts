import type {TransactionRunner} from './supabase-gateway';
/** Bound the critical pool's backlog; status snapshots jump waiting quotas. */
export function priorityTransactions(run:TransactionRunner,limit=256):TransactionRunner {
  const queue:Array<{priority:number;start:()=>Promise<void>}> = [];let active=false;let criticalStreak=0;
  const pump=()=>{
    if(active||!queue.length)return;active=true;
    // After eight status requests, let one old quota through to avoid starvation.
    const preferred=queue.findIndex(x=>x.priority===(criticalStreak>=8?1:0));
    const entry=queue.splice(preferred<0?0:preferred,1)[0];criticalStreak=entry.priority===0?criticalStreak+1:0;
    void entry.start().finally(()=>{active=false;pump();});
  };
  return (scope,work,metrics)=>new Promise((resolve,reject)=>{
    if(queue.length>=limit){reject(new Error('Critical request queue full'));return;}
    const queued=Date.now();
    queue.push({priority:scope.startsWith('snapshot:')||scope.startsWith('quota:critical:')?0:1,start:async()=>{
      if(metrics)metrics.poolWaitMs+=Date.now()-queued;
      try{resolve(await run(scope,work,metrics));}catch(error){reject(error);}
    }});pump();
  });
}
