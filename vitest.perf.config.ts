import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/perf/**/*.perf.ts'],
    environment: 'node',
    testTimeout: 120_000,
    pool: 'forks',
    // Vitest 4+: pool options live on the pool itself. The heap tests need `gc()`.
    execArgv: ['--expose-gc'],
  },
});
