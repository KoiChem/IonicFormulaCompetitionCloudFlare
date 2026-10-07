import { DEFAULT_QUESTION_PROFILE, validateQuestionProfileShape, type QuestionProfile } from '../games/ionic-formula/shared/question-profile';
import { PersistenceConflictError, changed, commandMarker, json, type PersistenceDatabase } from './db';

export type SavedQuestionProfile = { profile: QuestionProfile; revision: number };
export async function readQuestionProfile(database: PersistenceDatabase): Promise<SavedQuestionProfile> {
  const row = await database.prepare('SELECT profile_json, revision FROM question_profiles WHERE id = 1').first<{profile_json:string; revision:number}>();
  return row ? {profile:validateQuestionProfileShape(JSON.parse(row.profile_json)),revision:row.revision} : {profile:structuredClone(DEFAULT_QUESTION_PROFILE),revision:0};
}
export async function readRoomQuestionProfile(database: PersistenceDatabase, roomId:string): Promise<QuestionProfile|null> {
  const row=await database.prepare('SELECT profile_json FROM room_question_profiles WHERE room_id = ?').bind(roomId).first<{profile_json:string}>();
  return row ? validateQuestionProfileShape(JSON.parse(row.profile_json)) : null;
}
export async function updateQuestionProfile(database:PersistenceDatabase,input:{teacherId:string;requestId:string;bodyHash:string;expectedRevision:number;profile:QuestionProfile;nowMs:number}):Promise<SavedQuestionProfile> {
  const receipt=async()=>{const row=await database.prepare('SELECT body_hash, result_json FROM question_profile_receipts WHERE teacher_id = ? AND request_id = ?').bind(input.teacherId,input.requestId).first<{body_hash:string;result_json:string}>(); if(!row)return null;if(row.body_hash!==input.bodyHash)throw new PersistenceConflictError('request_id_reused','操作IDが別の変更に使われています');return JSON.parse(row.result_json) as SavedQuestionProfile;};
  const previous=await receipt();if(previous)return previous;
  const result={profile:input.profile,revision:input.expectedRevision+1};const marker=commandMarker(`question-profile:${input.teacherId}`,input.requestId);
  const statements=[
    database.prepare('INSERT INTO question_profiles (id, profile_json, revision, updated_at_ms) VALUES (1, ?, 0, 0) ON CONFLICT(id) DO NOTHING').bind(json(DEFAULT_QUESTION_PROFILE)),
    database.prepare(`UPDATE question_profiles SET profile_json = ?, revision = revision + 1, updated_at_ms = ?, last_command_id = ? WHERE id = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM question_profile_receipts WHERE teacher_id = ? AND request_id = ?)`).bind(json(input.profile),input.nowMs,marker,input.expectedRevision,input.teacherId,input.requestId),
    database.prepare(`INSERT INTO question_profile_receipts (teacher_id, request_id, body_hash, result_json) SELECT ?, ?, ?, ? FROM question_profiles WHERE id = 1 AND last_command_id = ?`).bind(input.teacherId,input.requestId,input.bodyHash,json(result),marker),
  ];
  try {const batch=await database.batch(statements);if(changed(batch[1]))return result;}catch(error){const committed=await receipt();if(committed)return committed;throw error;}
  const raced=await receipt();if(raced)return raced;throw new PersistenceConflictError('stale_question_profile','設定が更新されました。再読み込みしてください');
}
