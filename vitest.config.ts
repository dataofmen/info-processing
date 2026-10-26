import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/snapshot-env.ts'],
    include: ['tests/**/*.snap.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
