import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      TURMINDER_LOG_LEVEL: process.env.TURMINDER_LOG_LEVEL ?? 'silent',
      TURMINDER_LOG_JSON: '1',
      // No test should depend on whether this checkout bundles an OAuth
      // client; the tests that care set or clear this themselves.
      TURMINDER_IGNORE_BUNDLED_GOOGLE_CLIENT: '1',
    },
  },
});
