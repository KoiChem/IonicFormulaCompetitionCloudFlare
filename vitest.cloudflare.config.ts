import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/cloudflare/**/*.test.ts'],fileParallelism:false,testTimeout:120000,hookTimeout:120000}});
