import { describe, expect, it } from 'vitest';
import { parseJoinQr, joinQrPath } from '../../src/features/setup/join-qr';
const origin = 'https://koichem.github.io';
const base = '/IonicFormulaCompetition/';
describe('QR participation targets', () => {
  it('reflects a normalized code from a current invitation', () => {
    expect(parseJoinQr(`${origin}${base}#/join/room-123?code=ab2345`, origin, base)).toEqual({ code: 'AB2345' });
    expect(parseJoinQr(' ab2345 ', origin, base)).toEqual({ code: 'AB2345' });
    expect(parseJoinQr(`${origin}${base}#/join?code=AB2345`, origin, base)).toEqual({ code: 'AB2345' });
  });
  it('keeps existing invitations usable', () => {
    expect(parseJoinQr(`${origin}${base}#/join/room-123`, origin, base)).toEqual({ roomId: 'room-123' });
  });
  it.each([
    'https://evil.example/IonicFormulaCompetition/#/join/room-123?code=AB2345',
    `${origin}/IonicFormula/#/join/room-123?code=AB2345`,
    `${origin}${base}#/teacher?code=AB2345`,
    `${origin}${base}#/join/room-123?code=invalid`,
    `${origin}${base}#/join/%2Fteacher?code=AB2345`,
    `${origin}${base}#/join/room-123?code=AB2345&code=CD2345`,
    'javascript:alert(1)', 'not a QR invitation',
  ])('rejects unrelated or malformed invitations: %s', value => {
    expect(parseJoinQr(value, origin, base)).toBeNull();
  });
  it('adds the code while preserving the direct nickname route', () => {
    expect(joinQrPath('room-123', 'ab2345', base)).toBe('/IonicFormulaCompetition/#/join/room-123?code=AB2345');
  });
});
