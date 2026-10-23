import { configDefaults, defineConfig } from 'vitest/config';

const integrationFiles = [
  'test/**/*.test.ts',
  'packages/server/src/git-env.test.ts',
  'packages/server/src/worktrees.test.ts',
  'packages/server/src/shared-repository.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    // Each integration file already runs parallel Git reads. Serialize Windows files
    // so independent fixtures do not compete for process startup and disk access.
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/server/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts', 'packages/web/src/lib/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...integrationFiles],
          testTimeout: 5000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationFiles,
          testTimeout: 30000,
          // Real Git fixture setup can outlast Vitest's default 10-second hook budget.
          hookTimeout: 30000,
        },
      },
    ],
  },
});
