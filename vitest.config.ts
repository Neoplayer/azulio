import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine/server test suites moved to Rust (`cargo test` in
    // azul-server/). Only the web package remains on vitest.
    include: ['packages/web/src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    passWithNoTests: true,
  },
});
