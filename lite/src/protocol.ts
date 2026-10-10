import type { AnswerFieldId, FormulaEntry, IonicFormulaGameSettings, PublicQuestion, QuestionPrompt } from '../../src/games/ionic-formula/shared/types';
export type Credential = { code: string; role: 'teacher' | 'participant'; token: string; participantId?: string; nickname?: string; expiresAtMs: number; rememberUntilMs?: number; pending?:boolean };
export type Participant = { id: string; nickname: string; correctCount: number; questionIndex: number; joinedOrder: number; finished: boolean; finishedAtMs: number | null; elapsedCs: number; lastSeq: number; finishReason: string; finalSyncUnconfirmed?:boolean; answeredCount: number; advancedQuestionCount: number };
export type ReviewField = { id: AnswerFieldId; state: 'correct' | 'incorrect' | 'passed' | 'unanswered'; correctAnswer: string; ionCharge?: number; lastAnswer: string | FormulaEntry | null; attempts: number };
export type ReviewQuestion = { id: string; ordinal: number; prompt: QuestionPrompt; fields: ReviewField[] };
export type Ranking = Participant & {rank: number};
export type ResultsData = { own?: Ranking; ranking?: Pick<Ranking,"rank"|"nickname"|"correctCount"|"elapsedCs"|"finishReason"|"finalSyncUnconfirmed">[]; questions?: ReviewQuestion[]; averageCorrectCount?: number };
export type Snapshot = {
  serverNow: number;
  room: { code: string; state: 'WAITING' | 'COUNTDOWN' | 'RUNNING' | 'FINISHED' | 'CANCELLED' | 'COLLECTING'; settings: IonicFormulaGameSettings; maxScore: number; participantCount: number; startAtMs: number | null; deadlineAtMs: number | null; expiresAtMs: number; createdAtMs: number; cutoffAtMs: number | null; endReason: 'normal' | 'interrupted' };
  deferred?: {questions:PublicQuestion[];drafts:Record<string,string|FormulaEntry>};
  review?: {questions:PublicQuestion[];frontier:number;fields:Record<string,"correct"|"passed"|"passedRetry"|"retry">};
  own?: Participant; participants?: Participant[]; question?: PublicQuestion; results?: ResultsData;
};
export type Verdict = { correct: boolean; passed?: boolean; questionNumber?:number; fieldId: AnswerFieldId };
export type ServerMessage = { type: 'ack' | 'state' | 'progress' | 'error'; requestId?: string; state?: Snapshot; participant?: Participant; serverNow?: number; verdict?: Verdict; code?: string; message?: string };
export type ClientMessage = { type: 'hello' | 'sync' | 'start' | 'finish' | 'answer' | 'pass' | 'review' | 'submit' | 'draft' | 'nickname' | 'remove' | 'settings' | 'cancel'; requestId?: string; role?: string; token?: string; participantId?: string; nickname?: string; seq?: number; questionId?: string; fieldId?: AnswerFieldId; value?: string | FormulaEntry; settings?:IonicFormulaGameSettings; answers?:{questionId:string;fieldId:AnswerFieldId;value:string|FormulaEntry}[]; advancedQuestionCount?:number; capturedAtMs?:number; final?:boolean };
