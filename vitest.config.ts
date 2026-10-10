import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live*.test.ts', 'test/live/**', 'test/e2e/**'],
    // Coverage and slower hosted runners stretch process-spawning tests; a hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'json'],
      // Floors sit just below the measured totals (Windows and Linux); raise them as tests grow.
      thresholds: { statements: 96, branches: 92, functions: 96, lines: 97 },
    },
  },
});
