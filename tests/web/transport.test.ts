import { it, expect } from 'vitest';
import { apiHeaders } from '../../src/web/api';
it('preserves participant proof separately from verified Auth JWT', () => {
  const result = apiHeaders('auth-jwt',{authorization:'Bearer participant-token','x-competition-csrf':'1'});
  expect(result.get('authorization')).toBe('Bearer auth-jwt');
  expect(result.get('x-participant-authorization')).toBe('Bearer participant-token');
  expect(result.get('x-competition-csrf')).toBe('1');
});
