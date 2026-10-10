import type {Credential,Snapshot,Verdict,ClientMessage,ServerMessage} from './protocol';
type Callbacks={onError?(code:string,message:string):void;onState(state:Snapshot):void;onStatus(status:string):void;onVerdict(verdict:Verdict):void};
export class RoomConnection {
  private ws?:WebSocket;
  private stopped=false;
  private ready=false;
  private reconnect?:ReturnType<typeof setTimeout>;
  private timeout?:ReturnType<typeof setTimeout>;
  private heartbeat?:ReturnType<typeof setInterval>;
  private pongTimeout?:ReturnType<typeof setTimeout>;
  private helloId='';
  private state?:Snapshot;
  private operation?:ClientMessage;
  private inFlight?:{id:string;resolve(message:ServerMessage):void;reject(error:Error):void};
  private key:string;
  get pending(){return !!this.operation;}
  constructor(private credential:Credential,private callbacks:Callbacks){
    this.key=`ionic-lite:pending:${credential.code}:${credential.participantId??'teacher'}`;
    try{const value=JSON.parse(localStorage.getItem(this.key)??'null');if(value&&['answer','pass','submit','draft'].includes(value.type)&&Number.isSafeInteger(value.seq))this.operation=value;}catch{}
    window.addEventListener('online',this.wake);window.addEventListener('offline',this.offline);document.addEventListener('visibilitychange',this.wake);
    this.connect();
  }
  private wake=()=>{if(!this.stopped&&!document.hidden&&!this.ws){if(this.reconnect)clearTimeout(this.reconnect);this.connect();}};
  private offline=()=>{
    if(this.stopped)return;
    const ws=this.ws;this.ws=undefined;this.ready=false;this.clearTimers();if(this.reconnect)clearTimeout(this.reconnect);
    const waiter=this.inFlight;this.inFlight=undefined;waiter?.reject(new Error('接続が切れました。再接続して回答の受付状況を確認します'));
    this.callbacks.onStatus('切断中・再接続しています');ws?.close();
  };
  private clearTimers(){if(this.timeout)clearTimeout(this.timeout);if(this.heartbeat)clearInterval(this.heartbeat);if(this.pongTimeout)clearTimeout(this.pongTimeout);this.timeout=undefined;this.heartbeat=undefined;this.pongTimeout=undefined;}
  private clearOperation(){this.operation=undefined;try{localStorage.removeItem(this.key);}catch{}}
  private connect(){
    if(this.stopped||navigator.onLine===false||document.hidden)return;
    this.callbacks.onStatus('接続中');
    const ws=new WebSocket(`${location.origin.replace(/^http/,'ws')}/api/rooms/${this.credential.code}/socket`);this.ws=ws;
    this.timeout=setTimeout(()=>ws.close(),10000);
    ws.onopen=()=>{this.helloId=crypto.randomUUID();ws.send(JSON.stringify({type:'hello',requestId:this.helloId,role:this.credential.role,token:this.credential.token,participantId:this.credential.participantId,nickname:this.credential.nickname}));};
    ws.onmessage=event=>{
      if(this.ws!==ws||this.stopped)return;
      if(event.data==='pong'){if(this.pongTimeout)clearTimeout(this.pongTimeout);this.pongTimeout=undefined;return;}
      let message:ServerMessage;try{message=JSON.parse(event.data);}catch{return;}
      const hello=message.requestId===this.helloId;
      if(hello&&message.type==='ack'){this.ready=true;if(this.timeout)clearTimeout(this.timeout);this.timeout=undefined;this.heartbeat=setInterval(()=>{if(ws.readyState===1){ws.send('ping');this.pongTimeout=setTimeout(()=>ws.close(),10000);}},25000);}
      if(message.state){
        this.state=message.state;
        if(this.operation&&(message.state.own?.lastSeq??0)>=this.operation.seq!)this.clearOperation();
        this.callbacks.onState(message.state);
      } else if(message.type==='progress'&&message.participant&&this.state?.participants){
        this.state={...this.state,serverNow:message.serverNow??this.state.serverNow,participants:this.state.participants.map(p=>p.id===message.participant!.id?message.participant!:p)};
        this.callbacks.onState(this.state);
      }
      if(message.verdict)this.callbacks.onVerdict(message.verdict);
      if(message.type==='error')this.callbacks.onError?.(message.code??'error',message.message??'参加情報を確認してください');
      if(this.inFlight&&this.inFlight.id===message.requestId){
        const waiter=this.inFlight;this.inFlight=undefined;if(this.timeout)clearTimeout(this.timeout);this.timeout=undefined;
        if(message.type==='error'){this.clearOperation();waiter.reject(Object.assign(new Error(message.message),{code:message.code}));}else waiter.resolve(message);
        this.callbacks.onStatus('接続済み');
      }
      if(hello){
        if(message.type==='error'){this.stopped=true;this.callbacks.onStatus(message.message??'参加情報を確認してください');ws.close(1000);return;}
        if(this.operation){
          if(['RUNNING','COLLECTING'].includes(message.state?.room.state??'')&&!message.state?.own?.finished)void this.send(this.operation).catch(()=>{});
          else this.clearOperation();
        }
        this.callbacks.onStatus(this.pending?'送信中':'接続済み');
      }
    };
    ws.onerror=()=>ws.close();
    ws.onclose=event=>{
      if(this.ws!==ws)return;this.ws=undefined;this.ready=false;this.clearTimers();
      const waiter=this.inFlight;this.inFlight=undefined;waiter?.reject(new Error('接続が切れました。再接続して回答の受付状況を確認します'));
      if(event.code===4001){this.stopped=true;this.callbacks.onStatus('別のタブで接続しました。このタブを閉じてください');}
      else if(event.code===1008){this.stopped=true;this.callbacks.onStatus(event.reason||'参加情報を確認してください');}
      else if(!this.stopped){this.callbacks.onStatus('切断中・再接続しています');this.reconnect=setTimeout(()=>this.connect(),1000);}
    };
  }
  send(message:ClientMessage):Promise<ServerMessage>{
    if(!this.ready||this.ws?.readyState!==1)return Promise.reject(new Error('接続を確認してから操作してください'));
    if(this.inFlight)return Promise.reject(new Error('送信中です'));
    if(['answer','pass','submit','draft'].includes(message.type)){
      if(this.operation&&this.operation.seq!==message.seq)return Promise.reject(new Error('前の回答を確認中です'));
      try{localStorage.setItem(this.key,JSON.stringify(message));}catch{return Promise.reject(new Error('回答の受付状況を保存できません。ブラウザの保存設定を確認してください'));}
      this.operation=message;
    }
    const id=crypto.randomUUID();this.callbacks.onStatus('送信中');
    return new Promise((resolve,reject)=>{
      this.inFlight={id,resolve,reject};this.timeout=setTimeout(()=>this.ws?.close(),10000);
      this.ws!.send(JSON.stringify({...message,requestId:id}));
    });
  }
  dispose(){this.stopped=true;if(this.reconnect)clearTimeout(this.reconnect);this.clearTimers();window.removeEventListener('online',this.wake);window.removeEventListener('offline',this.offline);document.removeEventListener('visibilitychange',this.wake);this.inFlight?.reject(new Error('画面を閉じました'));this.inFlight=undefined;const ws=this.ws;this.ws=undefined;ws?.close(1000);}
}
