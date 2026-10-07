import ionsData from '../data/ions.json';
import compoundsData from '../data/compounds.json';
import complexData from '../data/complex-chemistry.json';
import { isComplexItem } from './complex-policy';
export type ItemDifficulty = 'normal' | 'hard' | 'both' | 'off';
export type Rule = { complexPercent: number; categoryWeights: Record<string, number> | null };
export type QuestionProfile = { version: 1; rules: { ion: { normal: Rule; hard: Rule }; compound: { normal: Rule; hard: Rule } }; ionDifficulties: Record<string, ItemDifficulty>; compoundDifficulties: Record<string, ItemDifficulty> };
export type CatalogItem = { id: string; formula: string; name: string; complex: boolean; category: string; defaultDifficulty: ItemDifficulty };
const ions = [...ionsData, ...complexData.supportIons, ...complexData.ions];
const ionMap = new Map(ions.map(i => [i.id,i]));
function defaultDifficulty(i: {enabled:boolean; difficulty?:string}):ItemDifficulty { return !i.enabled ? 'off' : i.difficulty === 'normal' || i.difficulty === 'hard' ? i.difficulty : 'both'; }
function gcd(a:number,b:number):number { return b ? gcd(b,a%b) : Math.abs(a); }
export function questionProfileCatalog(): {ions:CatalogItem[];compounds:CatalogItem[]} {
 return {
 ions:ions.filter(i=>!('ionQuestionEnabled' in i) || i.ionQuestionEnabled!==false).map(i=>({id:i.id,formula:`${i.formula}${Math.abs(i.charge)===1?'':Math.abs(i.charge)}${i.charge>0?'+':'-'}`,name:i.name,complex:isComplexItem(i,ionMap),category:i.requiresOxidationNumeral?'ionVariableOx':i.atomicity==='polyatomic'?'ionPolyatomic':'ionSimple',defaultDifficulty:defaultDifficulty(i)})),
 compounds:[...compoundsData,...complexData.compounds].map(i=>{const c=ionMap.get(i.cation)!;const a=ionMap.get(i.anion)!;return {id:i.id,formula:i.formula??'',name:i.name,complex:isComplexItem(i,ionMap),category:c.requiresOxidationNumeral||a.requiresOxidationNumeral?'variableOx':c.atomicity==='polyatomic'||a.atomicity==='polyatomic'?'polyatomic':Math.abs(a.charge)/gcd(c.charge,a.charge)===1&&c.charge/gcd(c.charge,a.charge)===1?'simple11':'simpleRatio',defaultDifficulty:defaultDifficulty(i)};})
 };
}
function freeze<T>(x:T):T { if(x&&typeof x==='object') {Object.values(x).forEach(freeze);Object.freeze(x);}return x; }
export const DEFAULT_QUESTION_PROFILE:QuestionProfile=freeze({version:1,rules:{ion:{normal:{complexPercent:10,categoryWeights:null},hard:{complexPercent:20,categoryWeights:null}},compound:{normal:{complexPercent:10,categoryWeights:null},hard:{complexPercent:20,categoryWeights:null}}},ionDifficulties:{},compoundDifficulties:{}});
function object(x:unknown):Record<string,unknown> {if(!x||typeof x!=='object'||Array.isArray(x))throw new TypeError('出題設定が不正です');return x as Record<string,unknown>;}
function keys(x:Record<string,unknown>,allowed:string[],required=allowed) {if(Object.keys(x).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(x,k)))throw new TypeError('出題設定の項目が不正です');}
export function validateQuestionProfileShape(raw:unknown):QuestionProfile {
 const p=object(raw);keys(p,['version','rules','ionDifficulties','compoundDifficulties']);if(p.version!==1)throw new TypeError('出題設定の版が不正です');const rules=object(p.rules);keys(rules,['ion','compound']);const catalog=questionProfileCatalog();
 for(const mode of ['ion','compound'] as const){const levels=object(rules[mode]);keys(levels,['normal','hard']);for(const level of ['normal','hard'] as const){const r=object(levels[level]);keys(r,['complexPercent','categoryWeights']);if(!Number.isInteger(r.complexPercent)||Number(r.complexPercent)<(level==='hard'?20:0)||Number(r.complexPercent)>100)throw new TypeError('錯イオンの割合が不正です');if(r.categoryWeights!==null){const w=object(r.categoryWeights);const categories=mode==='ion'?['ionSimple','ionPolyatomic','ionVariableOx']:['simple11','simpleRatio','polyatomic','variableOx'];keys(w,categories,[]);if(Object.values(w).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>10000)||Object.values(w).reduce<number>((s,v)=>s+Number(v),0)<=0)throw new TypeError('カテゴリの重みが不正です');}}
 const overrides=object(p[mode==='ion'?'ionDifficulties':'compoundDifficulties']);const ids=new Set((mode==='ion'?catalog.ions:catalog.compounds).map(i=>i.id));if(Object.entries(overrides).some(([id,v])=>!ids.has(id)||(typeof v!=='string'||!['normal','hard','both','off'].includes(v))))throw new TypeError('教材の難易度が不正です');}
 return structuredClone(p) as QuestionProfile;
}
