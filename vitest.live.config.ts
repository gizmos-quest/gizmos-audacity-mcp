import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/live*.test.ts', 'test/live/**/*.test.ts'],
    // This config is the explicit opt-in: the suite drives a real Audacity.
    env: { AUDACITY_LIVE: '1' },
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
