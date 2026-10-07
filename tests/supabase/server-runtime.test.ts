import {it,expect,vi,afterEach} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('allows a server runtime that exposes window but has no browser document',async()=>{
 vi.stubGlobal('window',{});vi.resetModules();await expect(import('../../src/platform/server-only')).resolves.toBeDefined();
});
it('refuses a browser document',async()=>{
 vi.stubGlobal('window',{});vi.stubGlobal('document',{});vi.resetModules();await expect(import('../../src/platform/server-only')).rejects.toThrow('server-only');
});
