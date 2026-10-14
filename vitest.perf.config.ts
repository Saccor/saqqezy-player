import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/perf/**/*.perf.ts'],
    environment: 'node',
    testTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
});
