import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Many tests open real SQLite databases, run the pinned ffmpeg or render whole pages, and the
 * full suite runs them in parallel workers: a test that takes 2 s alone can pass 5 s (vitest's
 * default) on a busy machine or CI runner and fail for no reason of its own. A hang still fails,
 * only later. Tests that need longer still set their own timeout.
 */
const LOADED_TEST_TIMEOUT_MS = 20_000;

export default defineConfig({
  test: {
    // One temporary root per run, removed afterwards (test/tools/temp-root.ts).
    globalSetup: ["test/tools/vitest-global-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
          exclude: ["node_modules/**", "test/guards/**", "test/e2e/**", "test/web/**"],
          environment: "node",
          testTimeout: LOADED_TEST_TIMEOUT_MS,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          include: ["test/web/**/*.test.ts", "test/web/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["test/fixtures/web/setup.ts"],
          testTimeout: LOADED_TEST_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: "guards",
          include: ["test/guards/**/*.test.ts"],
          exclude: ["node_modules/**", "test/guards/fixtures/**"],
          environment: "node",
          // Each guard parses the whole repository; it grows with the code, not with load.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
