import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Network/env isolation for every e2e file (never an external database): see test/support/isolate-e2e-env.ts
    setupFiles: ['./test/support/isolate-e2e-env.ts'],
    // Each file boots its own PGlite (WASM Postgres + every migration): too many at once starves the event loop and
    // makes timing-sensitive tests (business-limits' concurrency cases) flaky, so cap the parallelism.
    maxWorkers: 4,
  },
});
