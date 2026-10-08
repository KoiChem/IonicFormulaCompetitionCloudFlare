import { expect, it } from 'vitest';
import { generateQuestionSet, validateGameSettings } from '../../../src/games/ionic-formula/server/question-generator';
import { DEFAULT_QUESTION_PROFILE } from '../../../src/games/ionic-formula/shared/question-profile';
import complexData from '../../../src/games/ionic-formula/data/complex-chemistry.json';
import { DEFAULT_SETTINGS, settingsSummary } from '../../../src/features/setup/CompetitionSettingsForm';
import type { IonicFormulaGameSettings } from '../../../src/games/ionic-formula/shared/types';

for (const mode of ['ion', 'compound'] as const) it(`uses all complex ${mode} items despite difficulty and OFF settings`, () => {
  const catalog = mode === 'ion' ? complexData.ions : complexData.compounds;
  const profile = structuredClone(DEFAULT_QUESTION_PROFILE);
  for (const item of catalog) (mode === 'ion' ? profile.ionDifficulties : profile.compoundDifficulties)[item.id] = 'off';
  const seen = new Set<string>();
  for (const difficulty of ['normal', 'hard'] as const) for (const questionCount of [5,10,15] as const) {
    const settings = { ...DEFAULT_SETTINGS, mode, difficulty, questionCount, complexEnabled: false, complexOnly: true } as IonicFormulaGameSettings;
    expect(validateGameSettings(settings, profile).availableCount).toBe(catalog.length);
    for (let seed = 1; seed <= 50; seed++) {
      let state = Math.imul(seed, 123456789);
      const questions = generateQuestionSet(settings, () => ((state = (Math.imul(state,1664525)+1013904223) >>> 0) / 2**32), profile);
      expect(questions).toHaveLength(questionCount);
      expect(new Set(questions.map(q => q.itemId)).size).toBe(questionCount);
      for (const question of questions) { expect(catalog.some(item => item.id === question.itemId)).toBe(true); seen.add(question.itemId); }
    }
  }
  expect([...seen].sort()).toEqual(catalog.map(item => item.id).sort());
});
it('labels complex-only settings without an ignored difficulty', () => {
  expect(settingsSummary({ ...DEFAULT_SETTINGS, complexOnly: true } as IonicFormulaGameSettings)).toContain('錯イオンのみ');
  expect(settingsSummary({ ...DEFAULT_SETTINGS, complexOnly: true } as IonicFormulaGameSettings)).not.toContain('やさしめ');
});
it('rejects malformed complex-only settings', () => {
  expect(() => validateGameSettings({ ...DEFAULT_SETTINGS, complexOnly: 'true' } as unknown as IonicFormulaGameSettings)).toThrow();
});
