/** The `server` e2e project's backend (playwright.config.ts) and the account it presets. */

/** `AMBER_E2E_SERVER_PORT` moves it, so separate checkouts can run their suites side by side. */
export const E2E_SERVER_PORT = Number(process.env["AMBER_E2E_SERVER_PORT"] ?? 4175);

/** Set by the Playwright config in the runner; workers inherit it. */
export const E2E_SERVER_DATA_DIR_ENV = "AMBER_E2E_SERVER_DATA_DIR";

/**
 * Placeholder credentials of a throwaway instance on a temporary data directory; the
 * preset forces a password change on first login.
 */
export const E2E_ADMIN = {
  username: "e2e-admin",
  initialPassword: "e2e-initial-placeholder",
  password: "e2e-changed-placeholder",
} as const;
