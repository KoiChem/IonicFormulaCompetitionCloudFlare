import {it,expect} from 'vitest';
import {transactionPoolerUrl} from '../../src/platform/database-url';
it('reuses encoded server credentials on the verified transaction pooler',()=>{
 const result=new URL(transactionPoolerUrl('postgresql://postgres:a%40b%3Ac@db.example.supabase.co:5432/postgres?sslmode=require','example','aws-0-ap-northeast-2.pooler.supabase.com'));
 expect(result.hostname).toBe('aws-0-ap-northeast-2.pooler.supabase.com');
 expect(result.port).toBe('6543');expect(result.username).toBe('postgres.example');
 expect(result.password).toBe('a%40b%3Ac');expect(result.pathname).toBe('/postgres');
 expect(result.searchParams.get('sslmode')).toBe('require');
});
it('rejects mismatched built-in credentials rather than forwarding them',()=>{
 expect(()=>transactionPoolerUrl('postgresql://postgres:example@db.other.supabase.co/postgres','example','pooler.supabase.com')).toThrow('Unexpected built-in database topology');
});
