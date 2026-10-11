import {describe,it,expect} from 'vitest';
import {HostSoundGate} from '../src/host-sound-model';
describe('host countdown cues',()=>{
 it('ticks once per second, then distinguishes start and timeout',()=>{
  const g=new HostSoundGate();
  expect(g.observe(5000,20000,0,true)).toBe('tick');
  expect(g.observe(5000,20000,50,true)).toBe(null);
  expect(g.observe(5000,20000,4000,true)).toBe('tick');
  expect(g.observe(5000,20000,5000,true)).toBe('boundary');
  expect(g.observe(5000,20000,10000,true)).toBe('tick');
  expect(g.observe(5000,20000,19000,true)).toBe('tick');
  expect(g.observe(5000,20000,20000,true)).toBe('boundary');
  expect(g.observe(5000,20000,20001,true)).toBe(null);
 });
 it('does not replay hidden, muted or missed cues, or old boundaries after reload',()=>{
  const g=new HostSoundGate();
  expect(g.observe(5000,20000,4000,false)).toBe(null);
  expect(g.observe(5000,20000,4100,true)).toBe(null);
  expect(g.observe(5000,20000,8000,true)).toBe(null);
  expect(g.observe(5000,20000,18000,false)).toBe(null);
  expect(g.observe(5000,20000,18001,true)).toBe(null);
  expect(g.observe(5000,20000,22000,true)).toBe(null);
  expect(new HostSoundGate().observe(5000,20000,20500,true)).toBe(null);
 });
 it('never repeats a digit after a backwards clock correction',()=>{
  const g=new HostSoundGate();g.observe(5000,20000,10000,true);g.observe(5000,20000,11000,true);
  expect(g.observe(5000,20000,10000,true)).toBe(null);
 });
});
