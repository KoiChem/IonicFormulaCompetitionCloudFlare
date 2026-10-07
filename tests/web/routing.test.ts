import { describe, it, expect } from 'vitest';
import { appPath, parseRoute } from '../../src/web/routing';
describe('Pages routing', () => {
  it('keeps participant links under the repository base', () => {
    expect(appPath('/rooms/abc?role=teacher', '/IonicFormulaCompetition/')).toBe('/IonicFormulaCompetition/#/rooms/abc?role=teacher');
  });
  it('preserves join query on hash routes', () => {
    expect(parseRoute('#/join?code=ABC234')).toEqual({ path: '/join', search: '?code=ABC234' });
  });
  it('does not turn an external URL into an app route', () => {
    expect(() => appPath('//evil.example', '/IonicFormulaCompetition/')).toThrow();
  });
});
