import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Some suites scan/refine the ephemeris over date ranges (transits, search);
    // under parallel load these can exceed the 5s default. Give them headroom so
    // `pnpm -r test` is reliably green (they pass well under this in isolation).
    testTimeout: 30000,
  },
});
