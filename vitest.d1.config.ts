import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', include: ['tests/d1/**/*.test.ts'],
  fileParallelism: false, testTimeout: 120000, hookTimeout: 120000,
}});
