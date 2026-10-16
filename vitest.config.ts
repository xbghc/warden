import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/server/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts', 'packages/web/src/lib/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // A developer's Git configuration must not hide missing fixture setup in CI.
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    testTimeout: 30000,
  },
});
