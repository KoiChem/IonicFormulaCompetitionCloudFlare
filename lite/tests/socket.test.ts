import {afterEach,expect,test,vi} from 'vitest';
import {RoomConnection} from '../src/socket';
import type {Credential,Snapshot} from '../src/protocol';
class FakeSocket {
  static instances:FakeSocket[]=[];
  readyState=0;sent:any[]=[];onopen?:()=>void;onmessage?:(event:any)=>void;onclose?:(event:any)=>void;onerror?:()=>void;
  constructor(public url:string){FakeSocket.instances.push(this);}
  send(value:string){this.sent.push(JSON.parse(value));}
  open(){this.readyState=1;this.onopen?.();}
  receive(message:any){this.onmessage?.({data:JSON.stringify(message)});}
  close(code=1006){this.readyState=3;this.onclose?.({code});}
}
const c:Credential={code:'ABC234',role:'participant',token:'a'.repeat(64),participantId:'11111111-1111-4111-8111-111111111111',nickname:'生徒',expiresAtMs:Date.now()+3600000};
const state=(seq:number)=>({serverNow:Date.now(),room:{code:c.code,state:'RUNNING',expiresAtMs:c.expiresAtMs},own:{lastSeq:seq,finished:false}} as Snapshot);
function setup(){
  vi.useFakeTimers();vi.stubGlobal('WebSocket',FakeSocket);vi.stubGlobal('location',{origin:'https://lite.test'});
  const events:Record<string,()=>void>={};
  vi.stubGlobal('window',{addEventListener:(name:string,fn:()=>void)=>{events[name]=fn;},removeEventListener:vi.fn()});vi.stubGlobal('document',{hidden:false,addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('navigator',{onLine:true});
  const saved=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>saved.set(k,v),removeItem:(k:string)=>saved.delete(k)});
  FakeSocket.instances=[];const snapshots:Snapshot[]=[];const statuses:string[]=[];
  const connection=new RoomConnection(c,{onState:s=>snapshots.push(s),onStatus:s=>statuses.push(s),onVerdict:()=>{}});
  const first=FakeSocket.instances[0];first.open();first.receive({type:'ack',requestId:first.sent[0].requestId,state:state(0)});
  return {connection,first,snapshots,statuses,events};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
test('pushed state is accepted even when no command is waiting for an acknowledgment',()=>{
  const {connection,first,snapshots}=setup();
  expect(()=>first.receive({type:'state',state:state(0)})).not.toThrow();
  expect(snapshots).toHaveLength(2);connection.dispose();
});
test('one acknowledged answer clears the pending operation without making an HTTP request',async()=>{
  const {connection,first}=setup();const reply=connection.send({type:'answer',seq:1,questionId:'q1',fieldId:'name',value:'ナトリウムイオン'});
  expect(first.sent).toHaveLength(2);first.receive({type:'ack',requestId:first.sent[1].requestId,state:state(1)});
  await reply;expect(connection.pending).toBe(false);connection.dispose();
});
test('lost acknowledgment is reconciled on reconnect before another question can be sent',async()=>{
  const {connection,first}=setup();const reply=connection.send({type:'answer',seq:1,questionId:'q1',fieldId:'name',value:'ナトリウムイオン'}).catch(()=>null);
  first.close();await reply;await vi.advanceTimersByTimeAsync(1100);
  const second=FakeSocket.instances[1];second.open();second.receive({type:'ack',requestId:second.sent[0].requestId,state:state(1)});
  expect(second.sent).toHaveLength(1);expect(connection.pending).toBe(false);connection.dispose();
});
test('an unreceived answer is resent unchanged once after the reconnect snapshot',async()=>{
  const {connection,first}=setup();const reply=connection.send({type:'pass',seq:1,questionId:'q1',fieldId:'name'}).catch(()=>null);
  first.close();await reply;await vi.advanceTimersByTimeAsync(1100);
  const second=FakeSocket.instances[1];second.open();second.receive({type:'ack',requestId:second.sent[0].requestId,state:state(0)});
  expect(second.sent[1]).toMatchObject({type:'pass',seq:1,questionId:'q1'});
  second.receive({type:'ack',requestId:second.sent[1].requestId,state:state(1)});
  expect(connection.pending).toBe(false);connection.dispose();
});
test('tab takeover stops reconnection instead of fighting the new tab',async()=>{
  const {connection,first}=setup();first.close(4001);await vi.advanceTimersByTimeAsync(10000);
  expect(FakeSocket.instances).toHaveLength(1);connection.dispose();
});
test('browser offline notification immediately disables the live connection',()=>{
  const {connection,first,events,statuses}=setup();
  events.offline?.();
  expect(first.readyState).toBe(3);expect(statuses.at(-1)).toBe('切断中・再接続しています');connection.dispose();
});
