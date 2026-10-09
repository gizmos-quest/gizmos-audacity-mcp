import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live*.test.ts', 'test/live/**', 'test/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 90 },
    },
  },
});
