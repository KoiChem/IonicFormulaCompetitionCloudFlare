import ionsData from "../data/ions.json";
import compoundsData from "../data/compounds.json";
import difficultyData from "../data/difficulty.json";
import complexData from "../data/complex-chemistry.json";
import { CHEMISTRY_CONTENT_VERSION, complexItemAllowed, isComplexItem } from "../shared/complex-policy";
import { DEFAULT_QUESTION_PROFILE, validateQuestionProfileShape, type QuestionProfile } from "../shared/question-profile";
import type {
  AnswerSpecification,
  InternalQuestion,
  IonicFormulaGameSettings,
  PublicQuestion,
  QuestionAnswer,
  QuestionProgress,
  QuestionPrompt,
} from "../shared/types";

type Ion = {
  id: string; formula: string; charge: number; name: string; atomicity: string;
  requiresOxidationNumeral: boolean; enabled: boolean; ionQuestionEnabled?: boolean; difficulty?: string;
  compoundPromptDisplay?: string;
  chemistryClass?: string;
};
type AcceptedFormula = string | { formula: string; note?: string };
type Compound = {
  id: string; cation: string; anion: string; formula: string | null; name: string; enabled: boolean;
  difficulty?: string; acceptedFormulaVariants?: AcceptedFormula[];
  questionModes?: Record<string, boolean>;
  chemistryClass?: string;
};

const ions = [...ionsData, ...complexData.supportIons, ...complexData.ions] as Ion[];
const compounds = [...compoundsData, ...complexData.compounds] as unknown as Compound[];
const difficulty = difficultyData as {
  categoryWeights: Record<"ion" | "compound", Record<"normal" | "hard", Record<string, number>>>;
};
const ionById = new Map(ions.map((ion) => [ion.id, ion]));

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function ionCategory(ion: Ion) {
  if (ion.requiresOxidationNumeral) return "ionVariableOx";
  return ion.atomicity === "polyatomic" ? "ionPolyatomic" : "ionSimple";
}

function compoundCategory(compound: Compound) {
  const cation = ionById.get(compound.cation);
  const anion = ionById.get(compound.anion);
  if (!cation || !anion) return null;
  if (cation.requiresOxidationNumeral || anion.requiresOxidationNumeral) return "variableOx";
  if (cation.atomicity === "polyatomic" || anion.atomicity === "polyatomic") return "polyatomic";
  const divisor = gcd(cation.charge, anion.charge);
  return Math.abs(anion.charge) / divisor === 1 && cation.charge / divisor === 1 ? "simple11" : "simpleRatio";
}

function gcd(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left;
}

function availableAtDifficulty(item: { difficulty?: string }, level: string) {
  return !item.difficulty || item.difficulty === level;
}

function ionVariants(settings: IonicFormulaGameSettings) {
  if (settings.ionAnswer === "formula") return ["ionNameToFormula"];
  if (settings.ionAnswer === "name") return ["ionFormulaToName"];
  return ["ionNameToFormula", "ionFormulaToName"];
}

function compoundVariants(settings: IonicFormulaGameSettings) {
  const answers = settings.compoundAnswer === "random"
    ? ["Formula", "Name"]
    : settings.compoundAnswer === "both" ? ["Both"] : [settings.compoundAnswer === "formula" ? "Formula" : "Name"];
  const prefixes: string[] = [];
  if (settings.compoundPrompts.formula) prefixes.push("ions");
  if (settings.compoundPrompts.name) prefixes.push("ionNames");
  if (settings.compoundPrompts.formula && settings.compoundPrompts.name) prefixes.push("mixedIons");
  return prefixes.flatMap((prefix) => answers.map((answer) => `${prefix}To${answer}`));
}

function compoundSupports(compound: Compound, variant: string) {
  const modes = compound.questionModes ?? {};
  const formulaPrompt = variant.startsWith("ions") || variant.startsWith("mixedIons");
  const namePrompt = variant.startsWith("ionNames") || variant.startsWith("mixedIons");
  const formulaAnswer = variant.endsWith("ToFormula") || variant.endsWith("ToBoth");
  const nameAnswer = variant.endsWith("ToName") || variant.endsWith("ToBoth");
  if (formulaAnswer && !compound.formula) return false;
  const formulaMode = Boolean(modes.ionsToFormula);
  const nameMode = Boolean(modes.ionsToName);
  const namedFormulaMode = Boolean(modes.ionNamesToFormula ?? modes.ionsToFormula);
  const namedNameMode = Boolean(modes.ionNamesToName ?? modes.ionsToName);
  return (!formulaPrompt || ((!formulaAnswer || formulaMode) && (!nameAnswer || nameMode)))
    && (!namePrompt || ((!formulaAnswer || namedFormulaMode) && (!nameAnswer || namedNameMode)));
}

function legacyCandidates(settings: IonicFormulaGameSettings) {
  const weights = difficulty.categoryWeights[settings.mode][settings.difficulty];
  if (settings.mode === "ion") {
    return ions.filter((ion) => ion.enabled && ion.ionQuestionEnabled !== false && availableAtDifficulty(ion, settings.difficulty) && complexItemAllowed(ion, settings.complexEnabled, ionById))
      .map((item) => ({ item, category: ionCategory(item), variants: ionVariants(settings) }))
      .filter((candidate) => weights[candidate.category] > 0);
  }
  const variants = compoundVariants(settings);
  return compounds.filter((compound) => compound.enabled && availableAtDifficulty(compound, settings.difficulty) && complexItemAllowed(compound, settings.complexEnabled, ionById))
    .map((item) => ({ item, category: compoundCategory(item), variants: variants.filter((variant) => compoundSupports(item, variant)) }))
    .filter((candidate) => candidate.category && weights[candidate.category] > 0 && candidate.variants.length);
}

type Candidate = { item: Ion | Compound; category: string | null; variants: string[] };
function candidates(settings: IonicFormulaGameSettings, profile: QuestionProfile | null): Candidate[] {
  if (settings.complexOnly === true) {
    const source = settings.mode === "ion" ? ions.filter(i => i.ionQuestionEnabled !== false) : compounds;
    return source.filter(item => isComplexItem(item, ionById))
      .map(item => ({ item, category: "charge" in item ? ionCategory(item) : compoundCategory(item),
        variants: "charge" in item ? ionVariants(settings) : compoundVariants(settings).filter(v => compoundSupports(item, v)) }))
      .filter(candidate => candidate.category && candidate.variants.length);
  }
  if (profile === null) return legacyCandidates(settings);
  const rule = profile.rules[settings.mode][settings.difficulty];
  const overrides = settings.mode === "ion" ? profile.ionDifficulties : profile.compoundDifficulties;
  const source = settings.mode === "ion" ? ions.filter(i => i.ionQuestionEnabled !== false) : compounds;
  return source.filter(item => {
    const membership = overrides[item.id] ?? (!item.enabled ? "off" : item.difficulty ?? "both");
    return (membership === "both" || membership === settings.difficulty) && complexItemAllowed(item, settings.complexEnabled, ionById);
  }).map(item => ({item,category:"charge" in item ? ionCategory(item) : compoundCategory(item),variants:"charge" in item ? ionVariants(settings) : compoundVariants(settings).filter(v=>compoundSupports(item,v))}))
    .filter(c => c.category && c.variants.length && (isComplexItem(c.item,ionById) || (rule.categoryWeights !== null ? (rule.categoryWeights[c.category] ?? 0)>0 : Object.hasOwn(overrides,c.item.id) || difficulty.categoryWeights[settings.mode][settings.difficulty][c.category]>0)));
}
function allocations(pool: Candidate[], count: number, weights: Record<string,number> | null): Map<string,number> | null {
  if(pool.length<count) throw new RangeError("出題設定の教材数が不足しています");
  if(weights===null) return null;
  const categories=Object.keys(weights).filter(k=>weights[k]>0);
  const total=categories.reduce((sum,k)=>sum+weights[k],0);
  const parts=categories.map(category=>({category,exact:count*weights[category]/total,count:Math.floor(count*weights[category]/total)}));
  let remaining=count-parts.reduce((sum,p)=>sum+p.count,0);
  for(const p of [...parts].sort((a,b)=>(b.exact-b.count)-(a.exact-a.count)||a.category.localeCompare(b.category))){if(remaining-->0)p.count++;}
  for(const p of parts)if(pool.filter(c=>c.category===p.category).length<p.count)throw new RangeError(`カテゴリ「${({ionSimple:"単原子イオン",ionPolyatomic:"多原子イオン",ionVariableOx:"価数が変わるイオン",simple11:"1対1の化合物",simpleRatio:"組成比がある化合物",polyatomic:"多原子イオンを含む化合物",variableOx:"価数が変わる化合物"} as Record<string,string>)[p.category]}」の教材数が不足しています`);
  return new Map(parts.map(p=>[p.category,p.count]));
}
function selectCandidates(settings:IonicFormulaGameSettings, profile:QuestionProfile|null, random:()=>number):Candidate[] {
 const eligible=candidates(settings,profile);
 if(settings.complexOnly === true || profile===null)return shuffled(eligible,random).slice(0,settings.questionCount);
 const quota=settings.complexEnabled ? Math.ceil(settings.questionCount*profile.rules[settings.mode][settings.difficulty].complexPercent/100) : 0;
 const complex=eligible.filter(c=>isComplexItem(c.item,ionById));
 const ordinary=eligible.filter(c=>!isComplexItem(c.item,ionById));
 if(complex.length<quota)throw new RangeError("錯イオンの指定割合を満たす教材数が不足しています");
 const count=settings.questionCount-quota;
 const quotas=allocations(ordinary,count,profile.rules[settings.mode][settings.difficulty].categoryWeights);
 const selected=quotas ? [...quotas].flatMap(([category,n])=>shuffled(ordinary.filter(c=>c.category===category),random).slice(0,n)) : shuffled(ordinary,random).slice(0,count);
 return shuffled([...shuffled(complex,random).slice(0,quota),...selected],random);
}
export function validateQuestionProfile(profile:QuestionProfile):void {
 const valid=validateQuestionProfileShape(profile);
 for(const questionCount of [5,10,15] as const)for(const level of ["normal","hard"] as const)for(const complexEnabled of [false,true]){
  const base:IonicFormulaGameSettings={questionCount,timeLimitMinutes:5,mode:"ion",difficulty:level,complexEnabled,ionAnswer:"random",compoundAnswer:"random",compoundPrompts:{formula:true,name:true}};
  const check = (settings:IonicFormulaGameSettings) => { try { validateGameSettings(settings,valid); } catch(error) { throw new RangeError(`${settings.mode === "ion" ? "イオン" : "化合物"}・${level === "normal" ? "やさしめ" : "ややむず"}・${questionCount}問・錯イオン${complexEnabled ? "あり" : "なし"}：${error instanceof Error ? error.message : String(error)}`); } };
  for(const ionAnswer of ["formula","name","random"] as const)check({...base,ionAnswer});
  for(const compoundAnswer of ["formula","name","random","both"] as const)for(const compoundPrompts of [{formula:true,name:false},{formula:false,name:true},{formula:true,name:true}])check({...base,mode:"compound",compoundAnswer,compoundPrompts});
 }
}
export function validateGameSettings(settings: IonicFormulaGameSettings, profile: QuestionProfile | null = DEFAULT_QUESTION_PROFILE) {
  if (settings.complexOnly !== undefined && typeof settings.complexOnly !== "boolean") throw new TypeError("錯イオンのみ設定が不正です");
  if (settings.complexEnabled !== undefined && typeof settings.complexEnabled !== "boolean") throw new TypeError("錯イオン設定が不正です");
  if (settings.chemistryContentVersion !== undefined && settings.chemistryContentVersion !== CHEMISTRY_CONTENT_VERSION) throw new TypeError("教材の版が不正です");
  if (settings.gradingMode !== undefined && settings.gradingMode !== "immediate" && settings.gradingMode !== "deferred") throw new TypeError("判定方式が不正です");
  if (![5, 10, 15].includes(settings.questionCount)) throw new TypeError("問題数は5問、10問、15問から選んでください");
  if (![3, 4, 5, 6, 7, 8, 9, 10].includes(settings.timeLimitMinutes)) throw new TypeError("制限時間は3分から10分です");
  if (!(["ion", "compound"] as const).includes(settings.mode)) throw new TypeError("モードが不正です");
  if (!(["normal", "hard"] as const).includes(settings.difficulty)) throw new TypeError("難易度が不正です");
  if (settings.mode === "ion" && !(["formula", "name", "random"] as const).includes(settings.ionAnswer)) throw new TypeError("イオンの解答形式が不正です");
  if (settings.mode === "compound" && !settings.compoundPrompts.formula && !settings.compoundPrompts.name) throw new TypeError("化合物の出題形式を1つ以上選んでください");
  if (settings.mode === "compound" && !(["formula", "name", "random", "both"] as const).includes(settings.compoundAnswer)) throw new TypeError("化合物の解答形式が不正です");
  const availableCount = candidates(settings, profile).length;
  selectCandidates(settings, profile, () => 0.5);
  if (availableCount < settings.questionCount) throw new RangeError(`この設定では${settings.questionCount}問を用意できません`);
  return { availableCount, maxScore: settings.questionCount * (settings.mode === "compound" && settings.compoundAnswer === "both" ? 2 : 1) };
}

function ionAnswer(ion: Ion) {
  const magnitude = Math.abs(ion.charge);
  return `${ion.formula}${magnitude === 1 ? "" : magnitude}${ion.charge > 0 ? "+" : "-"}`;
}

function answerFor(item: Ion | Compound, variant: string): QuestionAnswer {
  if ("charge" in item) {
    return variant === "ionNameToFormula"
      ? { type: "formula", canonical: ionAnswer(item), accepted: [] }
      : { type: "name", canonical: item.name, accepted: [] };
  }
  const formula: AnswerSpecification = {
    type: "formula",
    canonical: item.formula!,
    accepted: (item.acceptedFormulaVariants ?? []).map((entry) => typeof entry === "string" ? entry : { ...entry }),
  };
  const name: AnswerSpecification = { type: "name", canonical: item.name, accepted: [] };
  if (variant.endsWith("ToBoth")) return { type: "both", formula, name };
  return variant.endsWith("ToFormula") ? formula : name;
}

function promptFor(item: Ion | Compound, variant: string, order: "cationFirst" | "anionFirst"): QuestionPrompt {
  if ("charge" in item) {
    return variant === "ionNameToFormula"
      ? { kind: "ionName", values: [{ type: "name", value: item.name }] }
      : { kind: "ionFormula", values: [{ type: "formula", value: item.formula, charge: item.charge }] };
  }
  const cation = ionById.get(item.cation)!;
  const anion = ionById.get(item.anion)!;
  const promptType = variant.startsWith("ionNames") ? ["name", "name"]
    : variant.startsWith("ions") ? ["formula", "formula"]
      : ["formula", "name"];
  const displayed = [cation, anion].map((ion, index) => {
    const type = promptType[index] as "formula" | "name";
    return { type, value: type === "formula" ? ion.formula : ion.name, ...(type === "formula" ? { charge: ion.charge } : {}) };
  });
  return { kind: "compoundIons", values: order === "cationFirst" ? displayed : displayed.reverse(), order };
}

function idFromRandom(random: () => number) {
  return Array.from({ length: 4 }, () => Math.floor(random() * 0x1_0000).toString(16).padStart(4, "0")).join("");
}

export function generateQuestionSet(settings: IonicFormulaGameSettings, random: () => number = Math.random, profile: QuestionProfile | null = DEFAULT_QUESTION_PROFILE): readonly InternalQuestion[] {
  validateGameSettings(settings, profile);
  const selected = selectCandidates(settings, profile, random);
  const variantCounts = new Map<string, number>();
  const assignedVariants = new Map<number, string>();
  // Scarce variants are placed first; this never changes the already selected item IDs.
  const assignmentOrder = shuffled(selected.map((_, index) => index), random)
    .sort((left, right) => selected[left].variants.length - selected[right].variants.length);
  for (const index of assignmentOrder) {
    const available = selected[index].variants;
    const fewest = Math.min(...available.map((variant) => variantCounts.get(variant) ?? 0));
    const choices = available.filter((variant) => (variantCounts.get(variant) ?? 0) === fewest);
    const variant = choices[Math.floor(random() * choices.length)];
    assignedVariants.set(index, variant);
    variantCounts.set(variant, fewest + 1);
  }
  const cationCount = Math.floor(settings.questionCount / 2) + (settings.questionCount % 2 && random() < 0.5 ? 1 : 0);
  const orderSlots = shuffled([
    ...Array(cationCount).fill("cationFirst" as const),
    ...Array(settings.questionCount - cationCount).fill("anionFirst" as const),
  ], random);
  const result: InternalQuestion[] = [];

  for (let ordinal = 0; ordinal < settings.questionCount; ordinal += 1) {
    const candidate = selected[ordinal];
    const variant = assignedVariants.get(ordinal)!;
    const answer = answerFor(candidate.item, variant);
    const fields = answer.type === "both"
      ? [{ id: "formula" as const, type: "formula" as const }, { id: "name" as const, type: "name" as const }]
      : [{ id: answer.type, type: answer.type }];
    result.push({
      id: idFromRandom(random), ordinal, itemId: candidate.item.id, category: candidate.category!, variant,
      prompt: promptFor(candidate.item, variant, orderSlots[ordinal]), fields, maxScore: fields.length, answer,
      ...("charge" in candidate.item && answer.type === "formula"
        ? { ionCharge: candidate.item.charge, ionFormula: candidate.item.formula }
        : {}),
    });
  }
  return deepFreeze(result);
}

export function toPublicQuestion(question: InternalQuestion, progress: QuestionProgress): PublicQuestion {
  return deepFreeze({
    id: question.id,
    ordinal: question.ordinal,
    prompt: {
      kind: question.prompt.kind,
      values: question.prompt.values.map((value) => ({ ...value })),
      ...(question.prompt.order === undefined ? {} : { order: question.prompt.order }),
    },
    fields: question.fields.map((field) => ({ ...field })),
    progress: { resolvedFieldIds: [...progress.resolvedFieldIds] },
  });
}
