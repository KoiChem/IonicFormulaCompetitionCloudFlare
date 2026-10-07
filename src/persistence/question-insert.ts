import type {PersistenceDatabase} from './db';
import {toPublicQuestion} from '../games/ionic-formula/server/question-generator';
import type {InternalQuestion} from '../games/ionic-formula/shared/types';
/** Bound JSON keeps statement size and database round trips independent of question count. */
export function insertRoomQuestions(db:PersistenceDatabase,roomId:string,marker:string,questions:readonly InternalQuestion[]){
 const rows=questions.map(q=>({id:q.id,ordinal:q.ordinal,publicPayload:JSON.stringify(toPublicQuestion(q,{resolvedFieldIds:[]})),answer:JSON.stringify(q),fields:JSON.stringify(q.fields),maxScore:q.maxScore}));
 return db.prepare(`INSERT INTO room_questions(room_id,question_id,ordinal,public_payload_json,answer_snapshot_json,field_spec_json,max_score)
 SELECT r.id,json_extract(item.value,'$.id'),json_extract(item.value,'$.ordinal'),json_extract(item.value,'$.publicPayload'),
 json_extract(item.value,'$.answer'),json_extract(item.value,'$.fields'),json_extract(item.value,'$.maxScore')
 FROM rooms r CROSS JOIN json_each(?) AS item WHERE r.id=? AND r.last_command_id=?`).bind(JSON.stringify(rows),roomId,marker);
}
