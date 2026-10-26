import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostRace } from '../../src/features/lobby/HostRace';
const participant = { id: 'a', nickname: 'テスト', status: 'PLAYING', currentOrdinal: 0, correctCount: 0, answeredCount: 0, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null };
function render(mode: 'immediate' | 'deferred', active: boolean, waiting = false, submitted = false) {
  return renderToStaticMarkup(createElement(HostRace, { roomId: 'test', participants: [{ ...participant, submitted }], mode, maxScore: 10, active, waiting, pace: 0, remainingText: '01:00', interruptButton: null }));
}
describe('countdown runner', () => {
  for (const mode of ['immediate', 'deferred'] as const) {
    it(`${mode}: rests before start and runs at start`, () => {
      const before = render(mode, false, true);
      expect(before).toContain('is-resting');
      expect(before).toContain('runner-rest-sleep');
      expect(before).not.toContain('is-stopped');
      expect(before).not.toContain('提出済み');
      const running = render(mode, true);
      expect(running).not.toContain('is-resting');
      expect(running).not.toContain('is-stopped');
      expect(running).toContain('runner-sweat');
    });
    it(`${mode}: does not sleep merely because time expired`, () => {
      const ended = render(mode, false);
      expect(ended).not.toContain('is-resting');
      expect(ended).toContain('is-stopped');
    });
  }
  it('keeps deferred submitted runners asleep', () => {
    expect(render('deferred', true, false, true)).toContain('is-resting');
    expect(render('deferred', false, false, true)).toContain('is-resting');
  });
});
