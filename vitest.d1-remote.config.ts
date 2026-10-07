import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/d1/commands.test.ts'],fileParallelism:false,testTimeout:180000,hookTimeout:120000}});
