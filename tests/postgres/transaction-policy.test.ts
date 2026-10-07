import {it,expect} from 'vitest';
import {transactionIsolation} from '../../src/platform/postgres-runtime';
it('reads a fresh snapshot after room mutex acquisition while preserving creation isolation',()=>{
 expect(transactionIsolation('room:public-room')).toBe('read committed');
 expect(transactionIsolation('broadcast:public-room')).toBe('read committed');
 expect(transactionIsolation('creation:user-id')).toBe('serializable');
 expect(transactionIsolation('teacher-configuration')).toBe('serializable');
});
