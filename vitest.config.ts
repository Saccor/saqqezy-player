import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'tools/**/test/**/*.test.ts', 'services/**/test/**/*.test.ts', 'apps/tv/src/**/*.test.ts'],
    environment: 'node',
  },
});
