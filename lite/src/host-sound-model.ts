export class HostSoundGate {
  private identity='';
  private seen=new Set<string>();
  private previous:number|null=null;
  observe(start:number,deadline:number,now:number,audible:boolean):'tick'|'boundary'|null {
    const identity=`${start}:${deadline}`;
    if(identity!==this.identity){this.identity=identity;this.seen.clear();this.previous=null;}
    const previous=this.previous;this.previous=now;
    let key:string|null=null,kind:'tick'|'boundary'='tick';
    const startSecond=Math.ceil((start-now)/1000),endSecond=Math.ceil((deadline-now)/1000);
    if(startSecond>=1&&startSecond<=5)key=`start:${startSecond}`;
    else if(now>=start&&endSecond>=1&&endSecond<=10)key=`end:${endSecond}`;
    for(const [label,time] of [['start',start],['end',deadline]] as const){
      if(previous!==null&&previous<time&&now>=time&&now-time<1000&&now-previous<=1500){key=`${label}:0`;kind='boundary';}
    }
    if(!key||this.seen.has(key))return null;
    this.seen.add(key);return audible?kind:null;
  }
}
