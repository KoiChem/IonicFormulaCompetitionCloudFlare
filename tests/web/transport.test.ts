import { it, expect } from 'vitest';
import { apiHeaders } from '../../src/web/api';
it('preserves participant proof in independent transport', () => {
  const result = apiHeaders('auth-jwt',{authorization:'Bearer participant-token','x-competition-csrf':'1'});
  expect(result.get('authorization')).toBe('Bearer participant-token');
  expect(result.has('x-participant-authorization')).toBe(false);
  expect(result.get('x-competition-csrf')).toBe('1');
});
