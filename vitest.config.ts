import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // PGlite (in-process PostgreSQL) boot is slow under coverage.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points are exercised by spawning them (server/cli tests).
      exclude: ['src/server.ts', 'src/jobs/cli.ts'],
      reporter: ['text', 'html', 'lcov'],
      // CI fails if coverage drops below these.
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
