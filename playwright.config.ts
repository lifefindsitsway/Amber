import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_ADMIN, E2E_SERVER_DATA_DIR_ENV, E2E_SERVER_PORT } from "./test/e2e/server/constants.ts";
import { enterRunRoot } from "./test/tools/temp-root.ts";

// Deterministic browser smoke: no external iframes, Tauri or real AI. The
// SPA is built once by `pnpm test:e2e` before Playwright starts. The `mock` project runs it
// under `vite preview` and answers `/api` with `page.route`; the `server` project talks to
// a real server-mode backend on a temporary data directory that also serves the build.
// `AMBER_E2E_PREVIEW_PORT` moves the preview, so separate checkouts can run side by side.
const PREVIEW_PORT = Number(process.env["AMBER_E2E_PREVIEW_PORT"] ?? 4173);
const ci = process.env["CI"] !== undefined;
// Workers inherit the runner's environment, so every process agrees on one run root and
// one data directory; the global setup's teardown removes the root.
process.env[E2E_SERVER_DATA_DIR_ENV] ??= mkdtempSync(join(enterRunRoot(), "amber-e2e-server-"));
const serverOrigin = `http://127.0.0.1:${E2E_SERVER_PORT}`;

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/fixtures/e2e/global-setup.ts",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mock",
      testIgnore: "server/**",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
    },
    {
      name: "server",
      testMatch: "server/**/*.spec.ts",
      // One backend shared by every test; its state (sessions, passwords) is sequential.
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], baseURL: serverOrigin },
    },
  ],
  // Plain node with `exec`, not `pnpm exec`: Playwright stops a server by signalling its
  // process group, and a package-manager wrapper in between keeps the server alive.
  webServer: [
    {
      command: `exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    {
      command: "exec node src/server/main.ts",
      url: `${serverOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AMBER_MODE: "server",
        AMBER_DATA_DIR: process.env[E2E_SERVER_DATA_DIR_ENV],
        AMBER_BIN_DIR: join(import.meta.dirname, ".amber-tools", "bin"),
        AMBER_HOST: "127.0.0.1",
        AMBER_PORT: String(E2E_SERVER_PORT),
        AMBER_PUBLIC_ORIGIN: serverOrigin,
        AMBER_ADMIN_USERNAME: E2E_ADMIN.username,
        AMBER_ADMIN_PASSWORD: E2E_ADMIN.initialPassword,
        AMBER_LOG_LEVEL: "warn",
        // The watermark reads the real volume; a nearly full CI disk must not refuse work.
        AMBER_LOW_WATER_FREE_GB: "0.001",
        AMBER_LOW_WATER_FREE_RATIO: "0",
      },
    },
  ],
});
