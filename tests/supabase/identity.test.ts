import { it, expect } from 'vitest';
import { googleIdentity } from '../../src/platform/supabase-identity';
const user = { id: 'uid', email: 'TEACHER@example.com', email_confirmed_at: '2026-10-01', is_anonymous: false, identities: [{ provider: 'google' }] };
it('rejects anonymous and unverified accounts even if they claim a teacher email', () => {
  expect(googleIdentity({...user,is_anonymous:true})).toBeNull();
  expect(googleIdentity({...user,email_confirmed_at:undefined})).toBeNull();
  expect(googleIdentity({...user,identities:[{provider:'email'}]})).toBeNull();
});
it('uses only a server verified Google identity', () => {
  expect(googleIdentity(user)).toEqual({id:'uid',email:'teacher@example.com'});
});

it('keeps Auth service failures distinct from invalid credentials', async () => {
  const {verifySupabaseUser}=await import('../../src/platform/supabase-identity');
  const request=new Request('https://api.test',{headers:{authorization:'Bearer jwt'}});
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response('{}',{status:503});
    await expect(verifySupabaseUser(request,'https://auth.test','public')).rejects.toThrow('Authentication service unavailable');
    globalThis.fetch=async()=>new Response('{}',{status:429});
    await expect(verifySupabaseUser(request,'https://auth.test','public')).rejects.toThrow('Authentication service unavailable');
    globalThis.fetch=async()=>new Response('{}',{status:401});
    expect(await verifySupabaseUser(request,'https://auth.test','public')).toBeNull();
    globalThis.fetch=async()=>new Response('invalid',{status:200});
    await expect(verifySupabaseUser(request,'https://auth.test','public')).rejects.toThrow('Authentication service unavailable');
  } finally { globalThis.fetch=original; }
});
