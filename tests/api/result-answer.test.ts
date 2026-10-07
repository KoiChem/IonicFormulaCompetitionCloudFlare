import { describe, expect, it } from 'vitest';
import { decodeDisplayAnswer } from '../../src/platform/result-answer';

describe('stored result answer decoding', () => {
 it('keeps SQL NULL, JSON null, and a literal null answer distinct', () => {
  expect(decodeDisplayAnswer(null)).toEqual({lastAnswer:null,lastAnswerEntry:null});
  expect(decodeDisplayAnswer('  null  ')).toEqual({lastAnswer:null,lastAnswerEntry:null});
  expect(decodeDisplayAnswer('"null"')).toEqual({lastAnswer:'null',lastAnswerEntry:null});
 });
 it('accepts formula entries with or without a cursor', () => {
  expect(decodeDisplayAnswer('{"tokens":["N","a"],"charge":{"sign":"+","magnitude":1,"source":"typed"}}').lastAnswer).toBe('Na+');
  expect(decodeDisplayAnswer('{"tokens":["S","O","4"],"charge":{"sign":"-","magnitude":2,"source":"typed"}}').lastAnswer).toBe('SO42-');
 });
 it.each(['{', '42', 'false', '[]', '{}', '{"tokens":[42]}', '{"tokens":["Na"],"charge":{"sign":"?","magnitude":1}}', '{"tokens":["Na"],"charge":{"sign":"+","magnitude":0}}'])('marks invalid answer %s without throwing', raw => {
  expect(decodeDisplayAnswer(raw)).toMatchObject({lastAnswer:null,lastAnswerEntry:null,answerDisplayUnavailable:true});
 });
});
