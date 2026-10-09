import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000 },
});
