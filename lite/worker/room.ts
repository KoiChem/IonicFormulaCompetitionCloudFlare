import initialProfile from '../src/initial-question-profile.json';
import {validateQuestionProfileShape} from '../../src/games/ionic-formula/shared/question-profile';
import { DurableObject } from 'cloudflare:workers';
import { generateQuestionSet, validateGameSettings, toPublicQuestion } from '../../src/games/ionic-formula/server/question-generator';
import { evaluateField } from '../../src/games/ionic-formula/shared/answer-evaluator';
import { topRankingRows } from '../../src/features/results/ranking-visibility';
import { parseCompetitionSettings } from '../../src/config/public';
import type { InternalQuestion, IonicFormulaGameSettings, AnswerFieldId } from '../../src/games/ionic-formula/shared/types';
import type { ClientMessage, Snapshot, Participant, Ranking, ReviewQuestion, ServerMessage, Verdict } from '../src/protocol';

export type LiteEnv = {ROOMS: DurableObjectNamespace<LiteRoom>; ASSETS: Fetcher; RELEASE_SHA: string};
type Principal = { role: 'teacher' | 'participant'; id?: string };
type RoomRow = {code:string;state:string;host_hash:string;settings:string;questions:string;start_at:number|null;deadline_at:number|null;ended_at:number|null;expires_at:number;end_reason:'normal'|'interrupted';created_at:number;profile:string|null};
type PersonRow = {id:string;nickname:string;token_hash:string;joined_order:number;correct_count:number;question_index:number;finished_at:number|null;last_seq:number;last_verdict:string|null;finish_reason:string|null;removed:number};
type AnswerRow = {participant_id:string;question_id:string;field_id:AnswerFieldId;state:'pending'|'correct'|'passed';value:string|null;attempts:number};
class RoomError extends Error { constructor(public code:string,message:string) { super(message); } }
export const json = (data:unknown,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store'}});
const tokenPattern = /^[a-f0-9]{64}$/;
async function hash(value:string) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');}
function settingsEmpty(value:string|null|undefined){if(!value)return false;const v=JSON.parse(value);return typeof v==='string'?!v.trim():!v.tokens.length&&!v.charge;}
function token() {return Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');}

export class LiteRoom extends DurableObject<LiteEnv> {
  private sql: SqlStorage;
  constructor(ctx:DurableObjectState,env:LiteEnv) {
    super(ctx,env); this.sql=ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room (code TEXT PRIMARY KEY,state TEXT NOT NULL,host_hash TEXT NOT NULL,settings TEXT NOT NULL,questions TEXT NOT NULL,start_at INTEGER,deadline_at INTEGER,ended_at INTEGER,expires_at INTEGER NOT NULL,end_reason TEXT NOT NULL DEFAULT 'normal');
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY,nickname TEXT NOT NULL,token_hash TEXT NOT NULL,joined_order INTEGER NOT NULL,correct_count INTEGER NOT NULL DEFAULT 0,question_index INTEGER NOT NULL DEFAULT 0,finished_at INTEGER,last_seq INTEGER NOT NULL DEFAULT 0,last_verdict TEXT);
      CREATE TABLE IF NOT EXISTS answers (participant_id TEXT NOT NULL,question_id TEXT NOT NULL,field_id TEXT NOT NULL,state TEXT NOT NULL,value TEXT,attempts INTEGER NOT NULL,PRIMARY KEY(participant_id,question_id,field_id));`);
    // Add only the columns needed by existing Lite rooms; no external data migration.
    for(const [table,name,definition] of [['room','created_at','INTEGER NOT NULL DEFAULT 0'],['room','profile','TEXT'],['participants','finish_reason','TEXT'],['participants','removed','INTEGER NOT NULL DEFAULT 0']]) {
      if(!this.sql.exec<{name:string}>(`PRAGMA table_info(${table})`).toArray().some(c=>c.name===name))this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  private room() {return this.sql.exec<RoomRow>('SELECT * FROM room LIMIT 1').toArray()[0];}
  private person(id:string) {return this.sql.exec<PersonRow>('SELECT * FROM participants WHERE id=?',id).toArray()[0];}
  private people() {return this.sql.exec<PersonRow>('SELECT * FROM participants WHERE removed=0 ORDER BY joined_order').toArray();}
  private requireRoom() { const r=this.room(); if(!r) throw new RoomError('not_found','ルームが見つかりません'); if(Date.now()>=r.expires_at) throw new RoomError('expired','このルームの閲覧期限を過ぎています'); return r; }
  async fetch(request:Request):Promise<Response> {
    if (new URL(request.url).pathname==='/create' && request.method==='POST') {
      try {
        const raw=await request.json() as {settings?:IonicFormulaGameSettings;profile?:unknown};
        const settings={...raw.settings,...parseCompetitionSettings(raw.settings),gradingMode:raw.settings?.gradingMode??'immediate'} as IonicFormulaGameSettings;
        const profile=validateQuestionProfileShape(raw.profile??initialProfile);
        validateGameSettings(settings,profile); const questions=generateQuestionSet(settings,Math.random,profile); const hostToken=token(); const hostHash=await hash(hostToken);
        const code=request.headers.get('x-room-code')!; const expiresAtMs=Date.now()+2*60*60*1000;
        this.ctx.storage.transactionSync(()=>{if(this.room())throw new RoomError('collision','参加コードが重なりました。もう一度作成してください');this.sql.exec('INSERT INTO room(code,state,host_hash,settings,questions,expires_at,created_at,profile) VALUES(?,?,?,?,?,?,?,?)',code,'WAITING',hostHash,JSON.stringify(settings),JSON.stringify(questions),expiresAtMs,Date.now(),JSON.stringify(profile));});
        await this.ctx.storage.setAlarm(expiresAtMs);
        return json({code,token:hostToken,expiresAtMs},201);
      } catch(error) {return json({error:error instanceof Error?error.message:'設定を確認してください'},error instanceof RoomError?409:400);}
    }
    if(new URL(request.url).pathname.endsWith('/info')) {
      try {const r=this.requireRoom();return json({room:{state:r.state,settings:JSON.parse(r.settings),createdAtMs:r.created_at,expiresAtMs:r.expires_at},participantCount:this.people().length,capacity:50});}
      catch(e){return json({error:e instanceof Error?e.message:'ルームが見つかりません'},e instanceof RoomError&&e.code==='expired'?410:404);}
    }
    if(new URL(request.url).pathname.endsWith('/state')) {
      try {const room=this.requireRoom();const digest=await hash(request.headers.get('authorization')?.replace(/^Bearer /,'')??'');const id=request.headers.get('x-participant-id');const principal:Principal=id?{role:'participant',id}:{role:'teacher'};
        if(id?this.person(id)?.token_hash!==digest:room.host_hash!==digest)throw new RoomError('unauthorized','参加資格を確認できません');return json(this.snapshot(principal));
      }catch(e){return json({error:e instanceof Error?e.message:'結果を取得できません'},e instanceof RoomError&&['expired','not_found'].includes(e.code)?410:403);}
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
            if(existing) {if(existing.removed)throw new RoomError('participant_removed','ホストがロビーからあなたのエントリーを削除しました');if(existing.token_hash!==tokenHash)throw new RoomError('unauthorized','参加情報を確認してください');return;}
            if(room.state!=='WAITING')throw new RoomError('already_started','開始済みのコンペには新しく参加できません');
            const nickname=typeof message!.nickname==='string'?message!.nickname.trim():'';
            this.validateNickname(nickname);
            if(this.people().some(p=>this.nicknameKey(p.nickname)===this.nicknameKey(nickname)))throw new RoomError('conflict','同じ名前の参加者がいます。別の名前を入力してください');
            const count=this.people().length; if(count>=50)throw new RoomError('room_full','参加上限の50人に達しています');
            this.sql.exec('INSERT INTO participants(id,nickname,token_hash,joined_order) VALUES(?,?,?,?)',id,nickname,tokenHash,Number(this.sql.exec<{n:number}>('SELECT COALESCE(MAX(joined_order),0)+1 AS n FROM participants').toArray()[0].n)); joined=true;
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
      const current=this.requireRoom();if(current.state==='COLLECTING'&&Date.now()>=current.ended_at!+3000){this.ctx.storage.transactionSync(()=>this.finish(current,current.end_reason,current.ended_at!));await this.schedule(this.requireRoom());this.broadcastState(ws);}
      let changed=false; let verdict:Verdict|undefined; let progress:Participant|undefined;
      this.ctx.storage.transactionSync(()=>{
        const room=this.requireRoom();
        if(['nickname','remove','settings','cancel'].includes(message!.type)) {
          if(room.state!=='WAITING')throw new RoomError('not_waiting','開始したため設定を変更できません');
          if(message!.type==='nickname') {
            if(principal!.role!=='participant')throw new RoomError('forbidden','生徒の名前だけを変更できます');
            const nickname=message!.nickname?.trim()??'';this.validateNickname(nickname);
            if(this.people().some(p=>p.id!==principal!.id&&this.nicknameKey(p.nickname)===this.nicknameKey(nickname)))throw new RoomError('conflict','同じ名前の参加者がいます。別の名前を入力してください');
            this.sql.exec('UPDATE participants SET nickname=? WHERE id=?',nickname,principal!.id!);
          } else {
            if(principal!.role!=='teacher')throw new RoomError('forbidden','教員だけが操作できます');
            if(message!.type==='remove') {
              const person=this.person(message!.participantId??'');if(!person||person.removed)throw new RoomError('not_found','参加者が見つかりません');
              this.sql.exec('UPDATE participants SET removed=1 WHERE id=?',person.id);
            } else if(message!.type==='cancel')this.sql.exec('UPDATE room SET state=?','CANCELLED');
            else {const settings={...message!.settings,...parseCompetitionSettings(message!.settings),gradingMode:message!.settings?.gradingMode??'immediate'} as IonicFormulaGameSettings;const profile=validateQuestionProfileShape(room.profile?JSON.parse(room.profile):initialProfile);validateGameSettings(settings,profile);this.sql.exec('UPDATE room SET settings=?,questions=?',JSON.stringify(settings),JSON.stringify(generateQuestionSet(settings,Math.random,profile)));}
          }
          changed=true;
        } else if(message!.type==='start'||message!.type==='finish') {
          if(principal!.role!=='teacher')throw new RoomError('forbidden','教員だけが操作できます');
          if(message!.type==='start') {
            if(room.state==='WAITING') {
              if(!this.people().length)throw new RoomError('no_participants','生徒が参加してから開始してください');
              const start=Date.now()+5000,settings=JSON.parse(room.settings) as IonicFormulaGameSettings;
              this.sql.exec('UPDATE room SET state=?,start_at=?,deadline_at=?,expires_at=?','RUNNING',start,start+settings.timeLimitMinutes*60000,start+7*24*60*60*1000);changed=true;
            }
          } else if(room.state==='RUNNING') {this.finish(room,'interrupted',Math.max(room.start_at!,Math.min(Date.now(),room.deadline_at!)));changed=true;}
        } else if(message!.type==='answer'||message!.type==='pass'||message!.type==='submit'||message!.type==='draft') {
          if(principal!.role!=='participant')throw new RoomError('forbidden','生徒の回答だけを受け付けます');
          const person=this.person(principal!.id!)!;
          if(person.removed)throw new RoomError('participant_removed','ホストがロビーからあなたのエントリーを削除しました');
          const seq=message!.seq;
          if(!Number.isSafeInteger(seq)||seq!<1)throw new RoomError('invalid_sequence','回答情報を確認してください');
          if(seq!<=person.last_seq) {if(seq===person.last_seq&&person.last_verdict)verdict=JSON.parse(person.last_verdict);return;}
          if(seq!==person.last_seq+1)throw new RoomError('invalid_sequence','再接続して回答状況を確認してください');
          if(!['RUNNING','COLLECTING'].includes(room.state)||Date.now()<room.start_at!||person.finished_at!==null)throw new RoomError('not_running','現在は回答を受け付けていません');
          const questions=JSON.parse(room.questions) as InternalQuestion[];
          const settings=JSON.parse(room.settings) as IonicFormulaGameSettings;
          if(message!.type==='draft') {
            if(settings.gradingMode!=='deferred')throw new RoomError('invalid_message','この判定方式では解答記録を保存できません');
            if(room.state==='COLLECTING'&&(!Number.isFinite(message!.capturedAtMs)||message!.capturedAtMs!>room.ended_at!))throw new RoomError('not_running','締切後の解答は変更できません');
            if(!Array.isArray(message!.answers)||message!.answers.length>30)throw new RoomError('invalid_answer','解答内容を確認してください');
            for(const entry of message!.answers) {const q=questions.find(q=>q.id===entry.questionId);if(!q||!q.fields.some(f=>f.id===entry.fieldId))throw new RoomError('invalid_field','回答欄を確認してください');this.validateValue(entry.value);
              this.sql.exec('INSERT INTO answers(participant_id,question_id,field_id,state,value,attempts) VALUES(?,?,?,?,?,?) ON CONFLICT(participant_id,question_id,field_id) DO UPDATE SET value=excluded.value',person.id,q.id,entry.fieldId,'pending',JSON.stringify(entry.value),0);
            }
            const advanced=message!.advancedQuestionCount??person.question_index;if(!Number.isInteger(advanced)||advanced<0||advanced>questions.length)throw new RoomError('invalid_question','問題を確認してください');
            this.sql.exec('UPDATE participants SET question_index=MAX(question_index,?),last_seq=?,last_verdict=NULL WHERE id=?',advanced,seq!,person.id);progress=this.viewPerson(this.person(person.id)!,room);return;
          }
          if(message!.type==='submit') {
            if(settings.gradingMode==='deferred')this.gradeDeferred(room,person.id);
            const collecting=room.state==='COLLECTING';if(collecting&&!message!.final&&(!Number.isFinite(message!.capturedAtMs)||message!.capturedAtMs!>room.ended_at!))throw new RoomError('not_running','記録を確認しています');
            this.sql.exec('UPDATE participants SET finished_at=?,finish_reason=?,last_seq=?,last_verdict=NULL WHERE id=?',collecting?message!.final?room.ended_at!:Math.max(room.start_at!,message!.capturedAtMs!):Date.now(),collecting&&message!.final?room.end_reason==='interrupted'?'interrupted':'timeout':'submitted',seq!,person.id);
            progress=this.viewPerson(this.person(person.id)!,room);
            if(this.people().every(p=>p.finished_at!==null)){this.finish(room,room.state==='COLLECTING'?room.end_reason:'normal',room.state==='COLLECTING'?room.ended_at!:Date.now());changed=true;}
            return;
          }
          if(settings.gradingMode==='deferred')throw new RoomError('invalid_message','まとめて判定では提出後に採点します');
          const question=questions.find(q=>q.id===message!.questionId);
          if(!question||question.ordinal>person.question_index)throw new RoomError('stale_question','問題が更新されました。現在の問題を確認してください');
          const field=question.fields.find(f=>f.id===message!.fieldId);
          if(!field)throw new RoomError('invalid_field','回答欄を確認してください');
          const old=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=? AND field_id=?',person.id,question.id,field.id).toArray()[0];
          if(question.ordinal<person.question_index&&(!old||old.state==='correct'))throw new RoomError('stale_question','この問題は確定済みです');
          if(old?.state==='correct')throw new RoomError('resolved_field','この回答欄は確定済みです');
          const value=message!.value;
          if(message!.type==='answer')this.validateValue(value);
          const correct=message!.type==='answer'&&evaluateField(question,field.id,value).correct;
          const state=message!.type==='pass'?'passed':correct?'correct':'pending';
          this.sql.exec('INSERT INTO answers(participant_id,question_id,field_id,state,value,attempts) VALUES(?,?,?,?,?,?) ON CONFLICT(participant_id,question_id,field_id) DO UPDATE SET state=excluded.state,value=excluded.value,attempts=excluded.attempts',person.id,question.id,field.id,state,message!.type==='pass'?(old?.value??null):JSON.stringify(value),message!.type==='pass'?(old?.attempts??0):(old?.attempts??0)+1);
          const resolved=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=?',person.id,question.id).toArray().filter(a=>a.state!=='pending').length;
          const nextIndex=person.question_index+(question.ordinal===person.question_index&&resolved===question.fields.length?1:0);
          const maxScore=questions.reduce((n,q)=>n+q.maxScore,0);
          verdict={correct,passed:message!.type==='pass',questionNumber:question.ordinal+1,fieldId:field.id};
          this.sql.exec('UPDATE participants SET correct_count=correct_count+?,question_index=?,finished_at=?,finish_reason=?,last_seq=?,last_verdict=? WHERE id=?',correct?1:0,nextIndex,person.correct_count+(correct?1:0)===maxScore?Date.now():null,person.correct_count+(correct?1:0)===maxScore?'completed':null,seq!,JSON.stringify(verdict),person.id);
          progress=this.viewPerson(this.person(person.id)!,room);
          if(this.people().every(p=>p.finished_at!==null)){this.finish(room,'normal',Date.now());changed=true;}
        } else if(!['hello','sync','review'].includes(message!.type))throw new RoomError('invalid_message','この操作は受け付けていません');
      });
      const room=this.requireRoom();
      if(changed||message.type==='hello')await this.schedule(room);
      this.send(ws,{type:'ack',requestId:message.requestId,state:this.snapshot(principal,message.type==='review'),...(verdict?{verdict}:{})});
      if(changed||joined)this.broadcastState(ws);
      else if(progress)for(const host of this.ctx.getWebSockets())if(this.principal(host)?.role==='teacher')this.send(host,{type:'progress',participant:progress,serverNow:Date.now()});
    } catch(error) {
      const e=error instanceof RoomError?error:new RoomError('invalid_message','送信内容を確認してください');
      const p=this.principal(ws);let state:Snapshot|undefined;try{if(p)state=this.snapshot(p);}catch{}
      this.send(ws,{type:'error',requestId:message?.requestId,code:e.code,message:e.message,...(state?{state}:{})});
      if(['unauthorized','expired','not_found'].includes(e.code))ws.close(1008,e.message);
    }
  }
  private nicknameKey(value:string){return value.normalize('NFKC').toLocaleLowerCase('ja-JP');}
  private validateNickname(value:string){if(!value||Array.from(value).length>16||/[\u0000-\u001f\u007f-\u009f]/.test(value))throw new RoomError('invalid_nickname','ニックネームは1〜16文字で入力してください');}
  private validateValue(value:unknown) {
    if(typeof value==='string'){if(value.length>200)throw new RoomError('invalid_answer','回答は200文字以内で入力してください');return;}
    const v=value as {tokens?:unknown[];charge?:{magnitude?:number;sign?:string}|null}|null;
    if(!v||!Array.isArray(v.tokens)||v.tokens.length>100||v.tokens.some(t=>typeof t!=='string'||t.length>10)||v.charge&&(!Number.isInteger(v.charge.magnitude)||v.charge.magnitude!<1||v.charge.magnitude!>9||!['+','-'].includes(v.charge.sign!)))throw new RoomError('invalid_answer','回答内容を確認してください');
  }
  private gradeDeferred(room:RoomRow,id:string) {
    const qs=JSON.parse(room.questions) as InternalQuestion[];let score=0;
    for(const q of qs)for(const field of q.fields){const a=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=? AND field_id=?',id,q.id,field.id).toArray()[0];if(!a?.value)continue;const value=JSON.parse(a.value);const empty=typeof value==='string'?!value.trim():!value.tokens.length&&!value.charge;if(empty)continue;const correct=evaluateField(q,field.id,value).correct;score+=Number(correct);this.sql.exec('UPDATE answers SET state=?,attempts=1 WHERE participant_id=? AND question_id=? AND field_id=?',correct?'correct':'pending',id,q.id,field.id);}
    this.sql.exec('UPDATE participants SET correct_count=? WHERE id=?',score,id);
  }
  private finish(room:RoomRow,reason:'normal'|'interrupted',endedAt:number) {
    if(room.state==='FINISHED')return;
    if((JSON.parse(room.settings) as IonicFormulaGameSettings).gradingMode==='deferred'&&room.state==='RUNNING'&&this.people().some(p=>p.finished_at===null)&&Date.now()<endedAt+3000){this.sql.exec('UPDATE room SET state=?,ended_at=?,end_reason=?','COLLECTING',endedAt,reason);return;}
    if((JSON.parse(room.settings) as IonicFormulaGameSettings).gradingMode==='deferred')for(const p of this.people())if(p.finished_at===null)this.gradeDeferred(room,p.id);
    this.sql.exec('UPDATE room SET state=?,ended_at=?,end_reason=?','FINISHED',endedAt,reason);
  }
  private viewPerson(p:PersonRow,room:RoomRow):Participant {
    const end=p.finished_at??room.ended_at??room.deadline_at??room.start_at??0;
    return {id:p.id,nickname:p.nickname,correctCount:p.correct_count,questionIndex:p.question_index,joinedOrder:p.joined_order,finished:p.finished_at!==null,finishedAtMs:p.finished_at,elapsedCs:Math.max(0,Math.round((end-(room.start_at??end))/10)),lastSeq:p.last_seq,finalSyncUnconfirmed:room.state==='FINISHED'&&(JSON.parse(room.settings) as IonicFormulaGameSettings).gradingMode==='deferred'&&p.finished_at===null,finishReason:p.finish_reason??(p.finished_at!==null?'completed':room.end_reason==='interrupted'?'interrupted':'timeout'),answeredCount:(JSON.parse(room.settings) as IonicFormulaGameSettings).gradingMode==='deferred'?this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=?',p.id).toArray().filter(a=>{if(!a.value)return false;const v=JSON.parse(a.value);return typeof v==='string'?!!v.trim():!!v.tokens.length||!!v.charge;}).length:p.correct_count,advancedQuestionCount:p.question_index};
  }
  private rankings(room:RoomRow):Ranking[] {
    const rows=this.people().map(p=>this.viewPerson(p,room)).sort((a,b)=>b.correctCount-a.correctCount||a.elapsedCs-b.elapsedCs||a.joinedOrder-b.joinedOrder);
    const ranked:Ranking[]=[];for(const [i,p]of rows.entries()){const prev=ranked[i-1];ranked.push({...p,rank:prev&&prev.correctCount===p.correctCount&&prev.elapsedCs===p.elapsedCs?prev.rank:i+1});}return ranked;
  }
  private review(room:RoomRow,id:string):ReviewQuestion[] {
    const answers=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=?',id).toArray();
    return (JSON.parse(room.questions) as InternalQuestion[]).map(q=>({id:q.id,ordinal:q.ordinal,prompt:q.prompt,fields:q.fields.map(f=>{const a=answers.find(a=>a.question_id===q.id&&a.field_id===f.id);const spec=q.answer.type==='both'?q.answer[f.id]:q.answer;return {id:f.id,state:!a?.value&&a?.state!=='passed'||settingsEmpty(a?.value)?'unanswered':a?.state==='pending'?'incorrect':a?.state??'unanswered',correctAnswer:spec.canonical,...(q.ionCharge!==undefined?{ionCharge:q.ionCharge}:{}),lastAnswer:a?.value?JSON.parse(a.value):null,attempts:a?.attempts??0};})}));
  }
  private snapshot(principal:Principal,includeReview=false):Snapshot {
    const room=this.requireRoom();const settings=JSON.parse(room.settings) as IonicFormulaGameSettings,questions=JSON.parse(room.questions) as InternalQuestion[];
    const state:Snapshot={serverNow:Date.now(),room:{code:room.code,state:room.state==='RUNNING'&&Date.now()<room.start_at!?'COUNTDOWN':room.state as Snapshot['room']['state'],settings,maxScore:questions.reduce((n,q)=>n+q.maxScore,0),participantCount:this.people().length,startAtMs:room.start_at,deadlineAtMs:room.deadline_at,expiresAtMs:room.expires_at,cutoffAtMs:room.ended_at,createdAtMs:room.created_at||room.expires_at-2*60*60*1000,endReason:room.end_reason}};
    if(principal.role==='teacher') {state.participants=this.people().map(p=>this.viewPerson(p,room));if(room.state==='FINISHED'){const ranking=this.rankings(room);state.results={ranking,averageCorrectCount:ranking.reduce((sum,p)=>sum+p.correctCount,0)/Math.max(1,ranking.length)};}}
    else {
      const person=this.person(principal.id!)!;if(person.removed)throw new RoomError('participant_removed','ホストがロビーからあなたのエントリーを削除しました');state.own=this.viewPerson(person,room);
      if(settings.gradingMode==='deferred'&&['RUNNING','COLLECTING'].includes(room.state)&&person.finished_at===null)state.deferred={questions:questions.map(q=>toPublicQuestion(q,{resolvedFieldIds:[]})),drafts:Object.fromEntries(this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=?',person.id).toArray().filter(a=>a.value).map(a=>[`${a.question_id}:${a.field_id}`,JSON.parse(a.value!)]))};
      if(includeReview&&room.state==='RUNNING') {
        const answers=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=?',person.id).toArray();
        state.review={questions:questions.map(q=>toPublicQuestion(q,{resolvedFieldIds:answers.filter(a=>a.question_id===q.id&&a.state!=='pending').map(a=>a.field_id)})),frontier:person.question_index,fields:Object.fromEntries(answers.map(a=>[`${a.question_id}:${a.field_id}`,a.state==='pending'?(questions.find(q=>q.id===a.question_id)!.ordinal<person.question_index?'passedRetry':'retry'):a.state]))};
      }
      if(room.state==='RUNNING'&&person.finished_at===null&&person.question_index<questions.length){const q=questions[person.question_index];const answers=this.sql.exec<AnswerRow>('SELECT * FROM answers WHERE participant_id=? AND question_id=?',person.id,q.id).toArray();state.question={...toPublicQuestion(q,{resolvedFieldIds:answers.filter(a=>a.state!=='pending').map(a=>a.field_id)}),progress:{resolvedFieldIds:answers.filter(a=>a.state!=='pending').map(a=>a.field_id),fieldStates:Object.fromEntries(answers.map(a=>[a.field_id,a.state]))}};}
      if(room.state==='FINISHED')state.results={ranking:topRankingRows(this.rankings(room),3).map(({rank,nickname,correctCount,elapsedCs,finishReason,finalSyncUnconfirmed})=>({rank,nickname,correctCount,elapsedCs,finishReason,finalSyncUnconfirmed})),own:this.rankings(room).find(p=>p.id===person.id),questions:this.review(room,person.id)};
    }
    return state;
  }
  private broadcastState(except?:WebSocket) {for(const ws of this.ctx.getWebSockets()){const p=this.principal(ws);if(p&&ws!==except)try{this.send(ws,{type:'state',state:this.snapshot(p)});}catch(error){const e=error as RoomError;this.send(ws,{type:'error',code:e.code,message:e.message});ws.close(1008,e.message);}}}
  private async schedule(room:RoomRow) {
    const due=[room.expires_at];if(room.state==='RUNNING')due.push(room.deadline_at!);if(room.state==='COLLECTING')due.push(room.ended_at!+3000);
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
    const current=this.room()!;if(current.state==='COLLECTING'&&Date.now()>=current.ended_at!+3000){this.ctx.storage.transactionSync(()=>this.finish(current,current.end_reason,current.ended_at!));this.broadcastState();}
    await this.schedule(this.room()!);
  }
  webSocketClose(ws:WebSocket,code:number) {try{ws.close(code===1005?1000:code);}catch{}}
  webSocketError(ws:WebSocket) {try{ws.close(1011,'再接続してください');}catch{}}
}
