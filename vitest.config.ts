import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/server/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
