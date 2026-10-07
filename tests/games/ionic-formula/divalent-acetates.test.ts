import {expect,it} from 'vitest';
import {DEFAULT_QUESTION_PROFILE,questionProfileCatalog} from '../../../src/games/ionic-formula/shared/question-profile';
import {generateQuestionSet} from '../../../src/games/ionic-formula/server/question-generator';
import {evaluateField} from '../../../src/games/ionic-formula/server/answer-evaluator';
import type {IonicFormulaGameSettings} from '../../../src/games/ionic-formula/shared/types';

const acetates=[
 {id:'lead2_acetate',name:'酢酸鉛(II)',formula:'(CH3COO)2Pb',alternative:'Pb(CH3COO)2',invalid:'CH3COOPb'},
 {id:'calcium_acetate',name:'酢酸カルシウム',formula:'(CH3COO)2Ca',alternative:'Ca(CH3COO)2',invalid:'CH3COOCa'},
];
const settings:IonicFormulaGameSettings={mode:'compound',difficulty:'hard',questionCount:5,timeLimitMinutes:3,complexEnabled:false,compoundPrompts:{formula:true,name:true},compoundAnswer:'formula',ionAnswer:'formula'};

it('includes both divalent acetates only in the default hard curriculum, with correct formula and name grading',()=>{
 const catalog=questionProfileCatalog().compounds;
 for(const item of acetates)expect(catalog.find(x=>x.id===item.id)?.defaultDifficulty).toBe('hard');
 const selected=new Set([...acetates.map(x=>x.id),...catalog.filter(x=>!x.complex&&!acetates.some(a=>a.id===x.id)).slice(0,3).map(x=>x.id)]);
 const profile=structuredClone(DEFAULT_QUESTION_PROFILE);
 for(const item of catalog)if(!acetates.some(a=>a.id===item.id))profile.compoundDifficulties[item.id]=selected.has(item.id)?'hard':'off';
 for(const answer of ['formula','name'] as const){
  const questions=generateQuestionSet({...settings,compoundAnswer:answer},()=>0.5,profile);
  for(const item of acetates){
   const question=questions.find(x=>x.itemId===item.id);expect(question).toBeDefined();
   if(answer==='formula'){
    expect(evaluateField(question!,'formula',item.formula)).toMatchObject({correct:true,matchedAnswerKind:'canonical'});
    expect(evaluateField(question!,'formula',item.alternative)).toMatchObject({correct:true,matchedAnswerKind:'acceptedAlternative'});
    expect(evaluateField(question!,'formula',item.invalid).correct).toBe(false);
   }else expect(evaluateField(question!,'name',item.name).correct).toBe(true);
  }
 }
 for(const profile of [DEFAULT_QUESTION_PROFILE,null]){
  const easy=generateQuestionSet({...settings,difficulty:'normal',questionCount:15},()=>0.5,profile);
  expect(easy.some(q=>acetates.some(x=>q.itemId===x.id))).toBe(false);
 }
});
