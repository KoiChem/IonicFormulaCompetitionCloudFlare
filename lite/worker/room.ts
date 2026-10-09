import { DurableObject } from 'cloudflare:workers';
import { generateQuestionSet, validateGameSettings, toPublicQuestion } from '../../src/games/ionic-formula/server/question-generator';
import { evaluateField } from '../../src/games/ionic-formula/shared/answer-evaluator';
import { parseCompetitionSettings } from '../../src/config/public';
import type { InternalQuestion, IonicFormulaGameSettings, AnswerFieldId } from '../../src/games/ionic-formula/shared/types';
import type { ClientMessage, Snapshot, Participant, Ranking, ReviewQuestion, ServerMessage, Verdict } from '../src/protocol';

export type LiteEnv = {ROOMS: DurableObjectNamespace<LiteRoom>; ASSETS: Fetcher; RELEASE_SHA: string};
type Principal = { role: 'teacher' | 'participant'; id?: string };
type RoomRow = {code:string;state:string;host_hash:string;settings:string;questions:string;start_at:number|null;deadline_at:number|null;ended_at:number|null;expires_at:number;end_reason:'normal'|'interrupted'};
type PersonRow = {id:string;nickname:string;token_hash:string;joined_order:number;correct_count:number;question_index:number;finished_at:number|null;last_seq:number;last_verdict:string|null};
type AnswerRow = {participant_id:string;question_id:string;field_id:AnswerFieldId;state:'pending'|'correct'|'passed';value:string|null;attempts:number};
class RoomError extends Error { constructor(public code:string,message:string) { super(message); } }
export const json = (data:unknown,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store'}});
const tokenPattern = /^[a-f0-9]{64}$/;
async function hash(value:string) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');}
function token() {return Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');}

export class LiteRoom extends DurableObject<LiteEnv> {
  private sql: SqlStorage;
  constructor(ctx:DurableObjectState,env:LiteEnv) {
    super(ctx,env); this.sql=ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room (code TEXT PRIMARY KEY,state TEXT NOT NULL,host_hash TEXT NOT NULL,settings TEXT NOT NULL,questions TEXT NOT NULL,start_at INTEGER,deadline_at INTEGER,ended_at INTEGER,expires_at INTEGER NOT NULL,end_reason TEXT NOT NULL DEFAULT 'normal');
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY,nickname TEXT NOT NULL,token_hash TEXT NOT NULL,joined_order INTEGER NOT NULL,correct_count INTEGER NOT NULL DEFAULT 0,question_index INTEGER NOT NULL DEFAULT 0,finished_at INTEGER,last_seq INTEGER NOT NULL DEFAULT 0,last_verdict TEXT);
      CREATE TABLE IF NOT EXISTS answers (participant_id TEXT NOT NULL,question_id TEXT NOT NULL,field_id TEXT NOT NULL,state TEXT NOT NULL,value TEXT,attempts INTEGER NOT NULL,PRIMARY KEY(participant_id,question_id,field_id));`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  private room() {return this.sql.exec<RoomRow>('SELECT * FROM room LIMIT 1').toArray()[0];}
  private person(id:string) {return this.sql.exec<PersonRow>('SELECT * FROM participants WHERE id=?',id).toArray()[0];}
  private people() {return this.sql.exec<PersonRow>('SELECT * FROM participants ORDER BY joined_order').toArray();}
  private requireRoom() { const r=this.room(); if(!r) throw new RoomError('not_found','ルームが見つかりません'); if(Date.now()>=r.expires_at) throw new RoomError('expired','このルームの閲覧期限を過ぎています'); return r; }
  async fetch(request:Request):Promise<Response> {
    if (new URL(request.url).pathname==='/create' && request.method==='POST') {
      try {
        const raw=await request.json() as {settings?:IonicFormulaGameSettings};
        const settings={...raw.settings,...parseCompetitionSettings(raw.settings),gradingMode:'immediate'} as IonicFormulaGameSettings;
        if(raw.settings?.gradingMode && raw.settings.gradingMode!=='immediate') throw new TypeError('Liteは問題毎判定です');
        validateGameSettings(settings); const questions=generateQuestionSet(settings); const hostToken=token(); const hostHash=await hash(hostToken);
        const code=request.headers.get('x-room-code')!; const expiresAtMs=Date.now()+2*60*60*1000;
        this.ctx.storage.transactionSync(()=>{if(this.room())throw new RoomError('collision','参加コードが重なりました。もう一度作成してください');this.sql.exec('INSERT INTO room(code,state,host_hash,settings,questions,expires_at) VALUES(?,?,?,?,?,?)',code,'WAITING',hostHash,JSON.stringify(settings),JSON.stringify(questions),expiresAtMs);});
        await this.ctx.storage.setAlarm(expiresAtMs);
        return json({code,token:hostToken,expiresAtMs},201);
      } catch(error) {return json({error:error instanceof Error?error.message:'設定を確認してください'},error instanceof RoomError?409:400);}
    }
    const r=this.room();
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket接続が必要です'},426);
    if(this.ctx.getWebSockets().length>=104)return json({error:'接続が多すぎます。少し待って再接続してください'},429);
    const pair=new WebSocketPair(); const [client,server]=Object.values(pair); this.ctx.acceptWebSocket(server);
    server.serializeAttachment({pendingUntil:Date.now()+10000});
    if(r&&r.expires_at>Date.now())await this.schedule(r);
    else await this.ctx.storage.setAlarm(Date.now()+10000);
    return new Response(null,{status:101,webSocket:client});
  }
  private principal(ws:WebSocket):Principal|undefined {return (ws.deserializeAttachment() as {principal?:Principal})?.principal;}
  private send(ws:WebSocket,message:ServerMessage) {try{ws.send(JSON.stringify(message));}catch{/* reconnect gets persisted state */}}
  async webSocketMessage(ws:WebSocket,raw:string|ArrayBuffer):Promise<void> {
    let message:ClientMessage|undefined;
    try {
      if(typeof raw!=='string'||new TextEncoder().encode(raw).length>8192)throw new RoomError('invalid_message','送信内容が大きすぎます');
      message=JSON.parse(raw) as ClientMessage;
      if(!message||typeof message!=='object'||typeof message.requestId!=='string'||message.requestId.length>80)throw new RoomError('invalid_message','送信内容を確認してください');
      let principal=this.principal(ws); let joined=false;
      if(message.type==='hello') {
        if(principal)throw new RoomError('invalid_message','接続済みです');
        const attachment=ws.deserializeAttachment() as {pendingUntil?:number};
        if(!attachment?.pendingUntil||Date.now()>attachment.pendingUntil)throw new RoomError('unauthorized','もう一度接続してください');
        if(typeof message.token!=='string'||!tokenPattern.test(message.token))throw new RoomError('unauthorized','参加情報を確認してください');
        const tokenHash=await hash(message.token); const room=this.requireRoom();
        if(message.role==='teacher') {
          if(tokenHash!==room.host_hash)throw new RoomError('unauthorized','教員の参加情報を確認してください');
          principal={role:'teacher'};
        } else if(message.role==='participant') {
          const id=message.participantId;
          if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new RoomError('invalid_message','参加情報を確認してください');
          this.ctx.storage.transactionSync(()=>{
            const existing=this.person(id);
            if(existing) {if(existing.token_hash!==tokenHash)throw new RoomError('unauthorized','参加情報を確認してください');return;}
            if(room.state!=='WAITING')throw new RoomError('already_started','開始済みのコンペには新しく参加できません');
            const nickname=typeof message!.nickname==='string'?message!.nickname.trim():'';
            if(!nickname||nickname.length>30||/[\u0000-\u001f\u007f]/.test(nickname))throw new RoomError('invalid_nickname','ニックネームは1〜30文字で入力してください');
            const count=this.people().length; if(count>=50)throw new RoomError('room_full','参加上限の50人に達しています');
            this.sql.exec('INSERT INTO participants(id,nickname,token_hash,joined_order) VALUES(?,?,?,?)',id,nickname,tokenHash,count+1); joined=true;
          });
          principal={role:'participant',id};
        } else throw new RoomError('unauthorized','参加情報を確認してください');
        for(const previous of this.ctx.getWebSockets()) {const p=this.principal(previous);if(previous!==ws&&p?.role===principal.role&&p.id===principal.id)previous.close(4001,'別のタブで接続しました');}
        ws.serializeAttachment({principal});
      }
      if(!principal)throw new RoomError('unauthorized','参加情報を確認してください');
      const before=this.requireRoom();
      if(before.state==='RUNNING'&&Date.now()>=before.deadline_at!) {
        // Deadline completion must survive a subsequently rejected command.
        this.ctx.storage.transactionSync(()=>this.finish(before,'normal',before.deadline_at!));
        await this.schedule(this.requireRoom());this.broadcastState(ws);
      }
      let changed=false; let verdict:Verdict|undefined; let progress:Participant|undefined;
      this.ctx.storage.transactionSync(()=>{
        const room=this.requireRoom();
        if(message!.type==='start'||message!.type==='finish') {
          if(principal!.role!=='teacher')throw new RoomError('forbidden','教員だけが操作できます');
          if(message!.type==='start') {
            if(room.state==='WAITING') {
              if(!this.people().length)throw new RoomError('no_participants','生徒が参加してから開始してください');
              const start=Date.now()+5000,settings=JSON.parse(room.settings) as IonicFormulaGameSettings;
              this.sql.exec('UPDATE room SET state=?,start_at=?,deadline_at=?,expires_at=?','RUNNING',start,start+settings.timeLimitMinutes*60000,start+7*24*60*60*1000);changed=true;
            }
          } else if(room.state==='RUNNING') {this.finish(room,'interrupted',Math.max(room.start_at!,Math.min(Date.now(),room.deadline_at!)));changed=true;}
        } else if(message!.type==='answer'||message!.type==='pass') {
          if(principal!.role!=='participant')throw new RoomError('forbidden','生徒の回答だけを受け付けます');
          const person=this.person(principal!.id!)!;
          const seq=message!.seq;
          if(!Number.isSafeInteger(seq)||seq!<1)throw new RoomError('invalid_sequence','回答情報を確認してください');
          if(seq!<=person.last_seq) {if(seq===person.last_seq&&person.last_verdict)verdict=JSON.parse(person.last_verdict);return;}
          if(seq!==person.last_seq+1)throw new RoomError('invalid_sequence','再接続して回答状況を確認してください');
          if(room.state!=='RUNNING'||Date.now()<room.start_at!||person.finished_at!==null)throw new RoomError('not_running','現在は回答を受け付けていません');
          const questions=JSON.parse(room.questions) as InternalQuestion[],question=questions[person.question_index];
          if(message!.questionId!==question?.id)throw new RoomError('stale_question','問題が更新されました。現在の問題を確認してください');
          const field=question.fields.find(f=>f.id===message!.fieldId);
          if(!field)throw new RoomError('invalid_field','回答欄を確認してください');
          const old=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=? AND field_id=?',person.id,question.id,field.id).toArray()[0];
          if(old&&old.state!=='pending')throw new RoomError('resolved_field','この回答欄は確定済みです');
          const value=message!.value;
          if(message!.type==='answer') {
            if(typeof value==='string') {if(value.length>200)throw new RoomError('invalid_answer','回答は200文字以内で入力してください');}
            else if(!value||!Array.isArray(value.tokens)||value.tokens.length>100||value.tokens.some(t=>typeof t!=='string'||t.length>10))throw new RoomError('invalid_answer','回答内容を確認してください');
          }
          const correct=message!.type==='answer'&&evaluateField(question,field.id,value).correct;
          const state=message!.type==='pass'?'passed':correct?'correct':'pending';
          this.sql.exec('INSERT INTO answers(participant_id,question_id,field_id,state,value,attempts) VALUES(?,?,?,?,?,?) ON CONFLICT(participant_id,question_id,field_id) DO UPDATE SET state=excluded.state,value=excluded.value,attempts=excluded.attempts',person.id,question.id,field.id,state,message!.type==='pass'?(old?.value??null):JSON.stringify(value),message!.type==='pass'?(old?.attempts??0):(old?.attempts??0)+1);
          const resolved=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=?',person.id,question.id).toArray().filter(a=>a.state!=='pending').length;
          const nextIndex=person.question_index+(resolved===question.fields.length?1:0);
          verdict={correct,passed:message!.type==='pass',fieldId:field.id};
          this.sql.exec('UPDATE participants SET correct_count=correct_count+?,question_index=?,finished_at=?,last_seq=?,last_verdict=? WHERE id=?',correct?1:0,nextIndex,nextIndex>=questions.length?Date.now():null,seq!,JSON.stringify(verdict),person.id);
          progress=this.viewPerson(this.person(person.id)!,room);
          if(this.people().every(p=>p.finished_at!==null)){this.finish(room,'normal',Date.now());changed=true;}
        } else if(!['hello','sync'].includes(message!.type))throw new RoomError('invalid_message','この操作は受け付けていません');
      });
      const room=this.requireRoom();
      if(changed||message.type==='hello')await this.schedule(room);
      this.send(ws,{type:'ack',requestId:message.requestId,state:this.snapshot(principal),...(verdict?{verdict}:{})});
      if(changed||joined)this.broadcastState(ws);
      else if(progress)for(const host of this.ctx.getWebSockets())if(this.principal(host)?.role==='teacher')this.send(host,{type:'progress',participant:progress,serverNow:Date.now()});
    } catch(error) {
      const e=error instanceof RoomError?error:new RoomError('invalid_message','送信内容を確認してください');
      const p=this.principal(ws);let state:Snapshot|undefined;try{if(p)state=this.snapshot(p);}catch{}
      this.send(ws,{type:'error',requestId:message?.requestId,code:e.code,message:e.message,...(state?{state}:{})});
      if(['unauthorized','expired','not_found'].includes(e.code))ws.close(1008,e.message);
    }
  }
  private finish(room:RoomRow,reason:'normal'|'interrupted',endedAt:number) {if(room.state!=='FINISHED')this.sql.exec('UPDATE room SET state=?,ended_at=?,end_reason=?','FINISHED',endedAt,reason);}
  private viewPerson(p:PersonRow,room:RoomRow):Participant {
    const end=p.finished_at??room.ended_at??room.deadline_at??room.start_at??0;
    return {id:p.id,nickname:p.nickname,correctCount:p.correct_count,questionIndex:p.question_index,joinedOrder:p.joined_order,finished:p.finished_at!==null,finishedAtMs:p.finished_at,elapsedCs:Math.max(0,Math.round((end-(room.start_at??end))/10)),lastSeq:p.last_seq,answeredCount:p.correct_count,advancedQuestionCount:p.question_index};
  }
  private rankings(room:RoomRow):Ranking[] {
    const rows=this.people().map(p=>this.viewPerson(p,room)).sort((a,b)=>b.correctCount-a.correctCount||a.elapsedCs-b.elapsedCs||a.joinedOrder-b.joinedOrder);
    const ranked:Ranking[]=[];for(const [i,p]of rows.entries()){const prev=ranked[i-1];ranked.push({...p,rank:prev&&prev.correctCount===p.correctCount&&prev.elapsedCs===p.elapsedCs?prev.rank:i+1});}return ranked;
  }
  private review(room:RoomRow,id:string):ReviewQuestion[] {
    const answers=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=?',id).toArray();
    return (JSON.parse(room.questions) as InternalQuestion[]).map(q=>({id:q.id,ordinal:q.ordinal,prompt:q.prompt,fields:q.fields.map(f=>{const a=answers.find(a=>a.question_id===q.id&&a.field_id===f.id);const spec=q.answer.type==='both'?q.answer[f.id]:q.answer;return {id:f.id,state:a?.state==='pending'?'incorrect':a?.state??'unanswered',correctAnswer:spec.canonical,...(q.ionCharge!==undefined?{ionCharge:q.ionCharge}:{}),lastAnswer:a?.value?JSON.parse(a.value):null,attempts:a?.attempts??0};})}));
  }
  private snapshot(principal:Principal):Snapshot {
    const room=this.requireRoom();const settings=JSON.parse(room.settings) as IonicFormulaGameSettings,questions=JSON.parse(room.questions) as InternalQuestion[];
    const state:Snapshot={serverNow:Date.now(),room:{code:room.code,state:room.state==='RUNNING'&&Date.now()<room.start_at!?'COUNTDOWN':room.state as Snapshot['room']['state'],settings,maxScore:questions.reduce((n,q)=>n+q.maxScore,0),participantCount:this.people().length,startAtMs:room.start_at,deadlineAtMs:room.deadline_at,expiresAtMs:room.expires_at,endReason:room.end_reason}};
    if(principal.role==='teacher') {state.participants=this.people().map(p=>this.viewPerson(p,room));if(room.state==='FINISHED'){const ranking=this.rankings(room);state.results={ranking,averageCorrectCount:ranking.reduce((sum,p)=>sum+p.correctCount,0)/Math.max(1,ranking.length)};}}
    else {
      const person=this.person(principal.id!)!;state.own=this.viewPerson(person,room);
      if(room.state==='RUNNING'&&person.finished_at===null){const q=questions[person.question_index];const answers=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=?',person.id,q.id).toArray();state.question={...toPublicQuestion(q,{resolvedFieldIds:answers.filter(a=>a.state!=='pending').map(a=>a.field_id)}),progress:{resolvedFieldIds:answers.filter(a=>a.state!=='pending').map(a=>a.field_id),fieldStates:Object.fromEntries(answers.map(a=>[a.field_id,a.state]))}};}
      if(room.state==='FINISHED')state.results={own:this.rankings(room).find(p=>p.id===person.id),questions:this.review(room,person.id)};
    }
    return state;
  }
  private broadcastState(except?:WebSocket) {for(const ws of this.ctx.getWebSockets()){const p=this.principal(ws);if(p&&ws!==except)try{this.send(ws,{type:'state',state:this.snapshot(p)});}catch{ws.close(1008,'閲覧期限を過ぎています');}}}
  private async schedule(room:RoomRow) {
    const due=[room.expires_at];if(room.state==='RUNNING')due.push(room.deadline_at!);
    for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment() as {pendingUntil?:number};if(a?.pendingUntil&&a.pendingUntil>Date.now())due.push(a.pendingUntil);}
    await this.ctx.storage.setAlarm(Math.min(...due));
  }
  async alarm():Promise<void> {
    const room=this.room();
    if(!room||Date.now()>=room.expires_at){
      for(const ws of this.ctx.getWebSockets())ws.close(1008,'閲覧期限を過ぎています');
      this.ctx.storage.transactionSync(()=>this.sql.exec('DELETE FROM answers; DELETE FROM participants; DELETE FROM room;'));
      await this.ctx.storage.deleteAlarm();return;
    }
    for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment() as {pendingUntil?:number};if(a?.pendingUntil&&a.pendingUntil<=Date.now())ws.close(1008,'もう一度接続してください');}
    if(room.state==='RUNNING'&&Date.now()>=room.deadline_at!){this.ctx.storage.transactionSync(()=>this.finish(room,'normal',room.deadline_at!));this.broadcastState();}
    await this.schedule(this.room()!);
  }
  webSocketClose(ws:WebSocket,code:number) {try{ws.close(code===1005?1000:code);}catch{}}
  webSocketError(ws:WebSocket) {try{ws.close(1011,'再接続してください');}catch{}}
}
