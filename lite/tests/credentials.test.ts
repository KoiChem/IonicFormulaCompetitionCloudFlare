import {afterEach,expect,test,vi} from 'vitest';
import {readCredential,saveCredential,recent} from '../src/credentials';
import type {Credential} from '../src/protocol';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
test('a student offline at start keeps their identity after the provisional waiting expiry',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
  const storage:Record<string,string>={};vi.stubGlobal('localStorage',Object.assign(storage,{getItem:(k:string)=>storage[k]??null,setItem:(k:string,v:string)=>{storage[k]=v;}}));
  const c:Credential={code:'ABC234',role:'participant',participantId:'original-id',token:'original-token',expiresAtMs:Date.now()+2*60*60*1000};
  saveCredential(c);vi.advanceTimersByTime(3*60*60*1000);
  expect(readCredential(c.code,c.role)).toMatchObject({participantId:'original-id',token:'original-token'});
  expect(recent()).toHaveLength(1);
  const restored=readCredential(c.code,c.role)!;restored.expiresAtMs=Date.now()+7*24*60*60*1000;saveCredential(restored);
  expect(restored.rememberUntilMs).toBe(c.rememberUntilMs);
  vi.advanceTimersByTime(8*24*60*60*1000);expect(readCredential(c.code,c.role)).toBeNull();expect(recent()).toEqual([]);
});
