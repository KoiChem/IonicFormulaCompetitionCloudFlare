import { expect, it } from 'vitest';
import { generateQuestionSet } from '../../../src/games/ionic-formula/server/question-generator';
import { DEFAULT_SETTINGS } from '../../../src/features/setup/CompetitionSettingsForm';
import compounds from '../../../src/games/ionic-formula/data/compounds.json';
import { DEFAULT_QUESTION_PROFILE, questionProfileCatalog } from '../../../src/games/ionic-formula/shared/question-profile';
const byId = new Map(compounds.map(item => [item.id, item]));
function seeded(seed: number) { let state = Math.imul(seed,123456789); return () => ((state = (Math.imul(state,1664525)+1013904223)>>>0)/2**32); }
it('spreads both ion types across hard ten-question compound competitions', () => {
  for (let seed=1;seed<=100;seed++) {
    const questions=generateQuestionSet({...DEFAULT_SETTINGS,mode:'compound',difficulty:'hard',complexEnabled:false},seeded(seed));
    for(const side of ['cation','anion'] as const) {
      const counts=new Map<string,number>();
      for(const q of questions){const id=byId.get(q.itemId)![side];counts.set(id,(counts.get(id)??0)+1);}
      expect(counts.size,`${side}/${seed}`).toBeGreaterThanOrEqual(7);
      expect(Math.max(...counts.values()),`${side}/${seed}`).toBeLessThanOrEqual(2);
    }
  }
});
it('still generates all questions when a teacher intentionally restricts the anion pool', () => {
 const profile=structuredClone(DEFAULT_QUESTION_PROFILE);
 for(const item of questionProfileCatalog().compounds)profile.compoundDifficulties[item.id]='off';
 for(const item of compounds.filter(item=>item.anion==='nitrate'))profile.compoundDifficulties[item.id]='both';
 const questions=generateQuestionSet({...DEFAULT_SETTINGS,mode:'compound',difficulty:'hard',questionCount:5},seeded(42),profile);
 expect(questions).toHaveLength(5);
 expect(new Set(questions.map(q=>q.itemId)).size).toBe(5);
 expect(questions.every(q=>byId.get(q.itemId)?.anion==='nitrate')).toBe(true);
});
