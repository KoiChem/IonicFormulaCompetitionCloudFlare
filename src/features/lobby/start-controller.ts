export type StartDraft = {requestId:string;expectedRevision:number;requestedAtMs:number;protocolVersion:1|2;roomId:string;ownerKey:string;attempts?:number};
export type StartStatus = {requestId?:string;receipt:null|{preparationGeneration?:number};room:{state:string;revision:number;manifestId?:string|null;preparationGeneration?:number|null;preparationTimedOut?:boolean}};
export type StartView = {phase:'idle'|'submitting'|'checking'|'confirmed'|'rejected'|'unresolved';message:string};
type Failure = {status?:number;code?:string;message?:string;retryAfterMs?:number|null};
type Options = {storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;roomId:string;ownerKey:string;
 post(body:{requestId:string;expectedRevision:number}):Promise<unknown>;status(requestId:string):Promise<StartStatus>;refresh():Promise<unknown>;
 now():number;uuid():string;onChange(view:StartView):void;visible():boolean;online():boolean};
const terminalStates=['CANCELLED','EXPIRED'];
const startedStates=['PREPARING','COUNTDOWN','RUNNING','COLLECTING','FINISHED'];
export class StartController {
 readonly key:string;
 state:StartView={phase:'idle',message:''};
 pending:StartDraft|null=null;
 private completedRevision:number|null=null;private accepted=false;private generation=0;private timer:ReturnType<typeof setTimeout>|undefined;private checking=false;private disposed=false;
 private refreshTimer:ReturnType<typeof setTimeout>|undefined;private step=0;private firstSettledAt=Infinity;private rejection:Failure|null=null;
 constructor(private readonly options:Options){this.key=`ionic-formula-competition:start:${options.roomId}:${options.ownerKey}`;}
 private update(phase:StartView['phase'],message:string){if(this.disposed)return;this.state={phase,message};this.options.onChange(this.state);}
 private save(draft:StartDraft){this.options.storage.setItem(this.key,JSON.stringify(draft));this.pending=draft;}
 private complete(phase:'confirmed'|'rejected',message:string){if(this.timer)clearTimeout(this.timer);this.generation++;if(phase==='confirmed')this.completedRevision=this.pending?.expectedRevision??null;this.pending=null;
   try{this.options.storage.removeItem(this.key);}catch{/* The next resume will verify any retained draft before dispatch. */}
   this.update(phase,message);void this.refreshAfterCompletion();}
 private async refreshAfterCompletion(){try{await this.options.refresh();}catch{if(!this.disposed)this.refreshTimer=setTimeout(()=>void this.refreshAfterCompletion(),5000);}}
 async resume(){
  if(this.pending||this.disposed)return;
  try{const d=JSON.parse(this.options.storage.getItem(this.key)??'null');
   if(d&&d.roomId===this.options.roomId&&d.ownerKey===this.options.ownerKey&&typeof d.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(d.requestId)&&Number.isSafeInteger(d.expectedRevision)&&Number.isFinite(d.requestedAtMs)&&[1,2].includes(d.protocolVersion)){
    this.pending=d;this.firstSettledAt=this.options.now();this.update('checking','開始状況を確認しています…');await this.check();
   }
  }catch{this.update('rejected','保存した開始要求を確認できません。ページを再読み込みしてください。');}
 }
 async begin(expectedRevision:number,protocolVersion:1|2){
  if(this.disposed)return;
  if(this.pending){await this.check();return;}
  this.rejection=null;this.accepted=false;this.completedRevision=null;this.step=0;this.firstSettledAt=Infinity;
  try{this.save({requestId:this.options.uuid(),expectedRevision,requestedAtMs:this.options.now(),protocolVersion,roomId:this.options.roomId,ownerKey:this.options.ownerKey,attempts:0});}
  catch{this.update('rejected','開始要求をこの端末に保存できません。空き容量やブラウザー設定を確認してください。');return;}
  await this.send();
 }
 private async send(){
  const draft=this.pending;if(!draft||this.disposed)return;const generation=this.generation;
  try{this.save({...draft,attempts:(draft.attempts??0)+1});}catch{this.update('unresolved','開始要求を保存できません。開始状況を再確認してください。');return;}
  this.update('submitting','開始を要求しています…');
  try{await this.options.post({requestId:draft.requestId,expectedRevision:draft.expectedRevision});
   if(generation===this.generation&&!this.disposed){this.accepted=true;await this.check();}
  }catch(error){
   if(generation!==this.generation||this.disposed)return;
   const f=error as Failure;
   if(f.code==='request_id_reused'||[401,403,410].includes(f.status??0)){this.complete('rejected',f.message??'開始する権限を確認できません。');return;}
   if(f.status&&f.status<500&&![408,429].includes(f.status)&&f.code!=='database_conflict')this.rejection=f;
   this.firstSettledAt=this.options.now();await this.check();
  }
 }
 async check(){
  if(!this.pending){if(!this.disposed&&this.state.phase==='confirmed')await this.refreshAfterCompletion();return;}
  if(this.disposed||this.checking)return;
  if(this.timer)clearTimeout(this.timer);
  if(!this.options.online()){this.update('unresolved','通信が切れています。接続後に開始状況を確認します。');this.schedule(5000);return;}
  this.checking=true;const generation=this.generation;const draft=this.pending;
  this.update(this.options.now()-draft.requestedAtMs>=30000?'unresolved':'checking',this.options.now()-draft.requestedAtMs>=30000?'開始結果をまだ確認できません。参加者画面も確認し、開始状況を再確認してください。':'開始状況を確認しています…');
  let delay:number|undefined;
  try{
   const status=await this.options.status(draft.requestId);if(generation!==this.generation||this.disposed)return;
   if(terminalStates.includes(status.room.state)){this.complete('rejected','ルームは終了しています。');return;}
   if(startedStates.includes(status.room.state)){this.complete('confirmed',status.receipt?'問題の準備・開始を確認しました。':'別の操作で開始済みです。');return;}
   if((status.receipt||(this.accepted&&status.room.revision>draft.expectedRevision+1))&&status.room.state==='WAITING'){this.complete('rejected','前の開始は取り消されています。名簿と設定を確認して再度開始してください。');return;}
   if(this.rejection){this.complete('rejected',this.rejection.message??'名簿や設定が更新されました。確認して再度開始してください。');return;}
   if(!this.accepted&&status.room.state==='WAITING'&&(draft.attempts??1)<2&&this.options.now()-this.firstSettledAt>=2000){this.checking=false;await this.send();return;}
  }catch(error){if(generation!==this.generation||this.disposed)return;const f=error as Failure;
   if([401,403,410].includes(f.status??0)||['expired','not_found','request_id_reused'].includes(f.code??'')){this.complete('rejected',f.message??'開始状況を確認する権限がありません。');return;}
   delay=f.retryAfterMs??undefined;
  }finally{this.checking=false;}
  if(generation===this.generation&&this.pending)this.schedule(delay);
 }
 private schedule(minDelay=0){if(!this.pending||this.disposed)return;const base=this.options.visible()?[1000,2000,4000,5000][Math.min(this.step++,3)]:30000;
  this.timer=setTimeout(()=>void this.check(),Math.max(minDelay,Math.max(!this.options.visible()?30000:this.options.now()-this.pending.requestedAtMs>=30000?5000:0,Math.round(base*(.8+.4*Math.random())))));}
 observe(state:string,revision:number){if(this.state.phase==='confirmed'&&state==='WAITING'&&this.completedRevision!=null&&revision>this.completedRevision+1){this.completedRevision=null;this.update('rejected','前の開始は取り消されています。名簿と設定を確認して再度開始してください。');}if(this.pending&&(state!=='WAITING'||revision>this.pending.expectedRevision+1))void this.check();}
 dispose(){this.disposed=true;this.generation++;if(this.timer)clearTimeout(this.timer);if(this.refreshTimer)clearTimeout(this.refreshTimer);}
}
