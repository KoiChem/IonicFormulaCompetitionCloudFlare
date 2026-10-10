import {Results as CompetitionResults} from '../../src/features/results/Results';
import type {Snapshot} from './protocol';
export function Results({state}:{state:Snapshot}) {
  const result=state.results!;
  return <CompetitionResults data={{room:{id:state.room.code,kind:'class',endReason:state.room.endReason,createdAtMs:state.room.createdAtMs,expiresAtMs:state.room.expiresAtMs,settings:state.room.settings},own:result.own,ranking:result.ranking,
    questions:result.questions?.map(q=>({...q,fields:q.fields.map(f=>{
      const suffix=f.id==='formula'&&f.ionCharge?`${Math.abs(f.ionCharge)===1?'':Math.abs(f.ionCharge)}${f.ionCharge>0?'+':'-'}`:'';
      return {...f,correctFormulaCore:suffix&&f.correctAnswer.endsWith(suffix)?f.correctAnswer.slice(0,-suffix.length):null,correctFormulaCharge:f.ionCharge,lastAnswer:typeof f.lastAnswer==='string'?f.lastAnswer:null,lastAnswerEntry:typeof f.lastAnswer==='object'?f.lastAnswer:null,lastAnswerCorrect:f.state==='correct'?true:f.attempts?false:null,attemptCount:f.attempts};
    })})),aggregate:!result.own&&result.ranking?{averageCorrectCount:result.averageCorrectCount??0,perfectCount:result.ranking.filter(p=>p.correctCount===state.room.maxScore).length,completedCount:result.ranking.filter(p=>p.finishReason==='completed'||p.finishReason==='submitted').length}:undefined}}/>;
}
