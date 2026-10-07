import { expect, it } from 'vitest';
import { DEFAULT_QUESTION_PROFILE, questionProfileCatalog, validateQuestionProfileShape } from '../../../src/games/ionic-formula/shared/question-profile';
import { generateQuestionSet, validateQuestionProfile } from '../../../src/games/ionic-formula/server/question-generator';
import type { IonicFormulaGameSettings } from '../../../src/games/ionic-formula/shared/types';
it('validates the default profile across all supported settings', () => { expect(() => validateQuestionProfile(DEFAULT_QUESTION_PROFILE)).not.toThrow(); });
it('fixes complex quotas without duplicate items for every mode and difficulty', () => {
 const catalog=questionProfileCatalog();
 for (const mode of ['ion','compound'] as const) for (const difficulty of ['normal','hard'] as const) for (const questionCount of [5,10,15] as const) for (const complexEnabled of [true,false]) {
 const settings:IonicFormulaGameSettings={mode,difficulty,questionCount,complexEnabled,timeLimitMinutes:5,ionAnswer:'random',compoundAnswer:'random',compoundPrompts:{formula:true,name:true}};
 const q=generateQuestionSet(settings); const ids=new Set((mode==='ion'?catalog.ions:catalog.compounds).filter(x=>x.complex).map(x=>x.id));
 expect(q.filter(x=>ids.has(x.itemId))).toHaveLength(complexEnabled?Math.ceil(questionCount*(difficulty==='normal'?10:20)/100):0);
 expect(new Set(q.map(x=>x.itemId)).size).toBe(questionCount);
 }
});
it('rejects unknown IDs and insufficient quota capacities',()=>{
 const p=structuredClone(DEFAULT_QUESTION_PROFILE); p.ionDifficulties.unknown='both'; expect(()=>validateQuestionProfileShape(p)).toThrow();
 const empty=structuredClone(DEFAULT_QUESTION_PROFILE); for(const x of questionProfileCatalog().ions.filter(x=>x.complex)) empty.ionDifficulties[x.id]='off'; expect(()=>validateQuestionProfile(empty)).toThrow();
});
it.each([['normal','やさしめ'],['hard','ややむず']] as const)('names %s shortage contexts with the room difficulty label',(level,label)=>{
 const p=structuredClone(DEFAULT_QUESTION_PROFILE);
 for(const item of questionProfileCatalog().ions)p.ionDifficulties[item.id]=level==='normal'?'hard':'normal';
 expect(()=>validateQuestionProfile(p)).toThrow(`イオン・${label}・5問・錯イオンなし`);
});
it('rejects extra keys and below minimum hard percentage',()=>{expect(()=>validateQuestionProfileShape({...DEFAULT_QUESTION_PROFILE,extra:true})).toThrow();const p=structuredClone(DEFAULT_QUESTION_PROFILE);p.rules.ion.hard.complexPercent=19;expect(()=>validateQuestionProfileShape(p)).toThrow();});
it('applies ordinary category quotas after reserving the complex quota',()=>{
 const p=structuredClone(DEFAULT_QUESTION_PROFILE);p.rules.ion.normal.categoryWeights={ionSimple:1,ionPolyatomic:1,ionVariableOx:0};
 const settings:IonicFormulaGameSettings={mode:'ion',difficulty:'normal',questionCount:10,complexEnabled:true,timeLimitMinutes:5,ionAnswer:'formula',compoundAnswer:'formula',compoundPrompts:{formula:true,name:false}};
 const complexIds=new Set(questionProfileCatalog().ions.filter(x=>x.complex).map(x=>x.id));
 const q=generateQuestionSet(settings,Math.random,p);const ordinary=q.filter(x=>!complexIds.has(x.itemId));
 expect(ordinary).toHaveLength(9);expect(ordinary.filter(x=>x.category==='ionSimple')).toHaveLength(4);expect(ordinary.filter(x=>x.category==='ionPolyatomic')).toHaveLength(5);
});
it('membership overrides activate disabled items and suppress default members',()=>{
 const p=structuredClone(DEFAULT_QUESTION_PROFILE);const catalog=questionProfileCatalog();const available=catalog.ions.filter(x=>!x.complex);
 for(const x of catalog.ions)p.ionDifficulties[x.id]='off';for(const x of available.slice(0,5))p.ionDifficulties[x.id]='normal';
 const settings:IonicFormulaGameSettings={mode:'ion',difficulty:'normal',questionCount:5,complexEnabled:false,timeLimitMinutes:5,ionAnswer:'formula',compoundAnswer:'formula',compoundPrompts:{formula:true,name:false}};
 expect(new Set(generateQuestionSet(settings,Math.random,p).map(x=>x.itemId))).toEqual(new Set(available.slice(0,5).map(x=>x.id)));
 expect(()=>validateQuestionProfileShape({...p,ionDifficulties:{hydrogen:'both'}})).toThrow();
});
it('rejects category shortages rather than silently reallocating questions',()=>{
 const p=structuredClone(DEFAULT_QUESTION_PROFILE);p.rules.ion.normal.categoryWeights={ionVariableOx:1};
 for(const x of questionProfileCatalog().ions.filter(x=>x.category==='ionVariableOx'&&!x.complex))p.ionDifficulties[x.id]='off';
 expect(()=>validateQuestionProfile(p)).toThrow();
});
it('explicit null preserves legacy selection and does not enforce profile quotas',()=>{
 const settings:IonicFormulaGameSettings={mode:'ion',difficulty:'normal',questionCount:15,complexEnabled:true,timeLimitMinutes:5,ionAnswer:'formula',compoundAnswer:'formula',compoundPrompts:{formula:true,name:false}};
 const q=generateQuestionSet(settings,()=>0.999,null);
 const complexIds=new Set(questionProfileCatalog().ions.filter(x=>x.complex).map(x=>x.id));
 expect(q.filter(x=>complexIds.has(x.itemId))).toHaveLength(0);
 expect(generateQuestionSet(settings,()=>0.999).filter(x=>complexIds.has(x.itemId))).toHaveLength(2);
});
it('exposes detached catalogs and rejects invalid weights',()=>{
 const catalog=questionProfileCatalog();catalog.ions[0].name='changed';expect(questionProfileCatalog().ions[0].name).not.toBe('changed');
 for(const weights of [{bad:1},{ionSimple:0},{ionSimple:-1},{ionSimple:Infinity}] as Record<string,number>[]){const p=structuredClone(DEFAULT_QUESTION_PROFILE);p.rules.ion.normal.categoryWeights=weights;expect(()=>validateQuestionProfileShape(p)).toThrow();}
});
it('ordinary category zero never excludes complex quota members',()=>{
 const p=structuredClone(DEFAULT_QUESTION_PROFILE);p.rules.ion.normal.categoryWeights={ionSimple:1,ionPolyatomic:0,ionVariableOx:0};
 const settings:IonicFormulaGameSettings={mode:'ion',difficulty:'normal',questionCount:10,complexEnabled:true,timeLimitMinutes:5,ionAnswer:'formula',compoundAnswer:'formula',compoundPrompts:{formula:true,name:false}};
 expect(()=>generateQuestionSet(settings,Math.random,p)).not.toThrow();
});
it('rejects nonstring membership values including arrays and objects',()=>{
 const id=questionProfileCatalog().ions[0].id;
 for(const value of [['normal'],{value:'normal'},null,1,true]){
  const p=structuredClone(DEFAULT_QUESTION_PROFILE) as unknown as {ionDifficulties:Record<string,unknown>};p.ionDifficulties[id]=value;
  expect(()=>validateQuestionProfileShape(p)).toThrow();
 }
});
