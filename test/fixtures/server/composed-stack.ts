import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { compose, type Composition } from "../../../src/server/compose.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

/**
 * The real server-mode composition (`compose()`) on a temporary data directory, driven
 * through `app.inject` with the SPA's CSRF headers and real session cookies. Nothing is
 * listening unless a test asks; the scheduler starts only with `startBackground()`.
 */

export const STACK_ORIGIN = "https://amber.example";
export const ADMIN_USERNAME = "root-admin";
/** Placeholder passwords of a throwaway instance. */
const INITIAL_PASSWORD = "initial-placeholder-pw";
export const STACK_PASSWORD = "changed-placeholder-pw";
const SESSION_COOKIE = /^(__Host-amber-session=[^;]+)/u;

export interface StackRequest {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

export interface ComposedStack {
  composition: Composition;
  dataDir: string;
  /** A request as the SPA would send it, with the given `Cookie` value (or none). */
  send(request: StackRequest, cookie?: string): Promise<LightMyRequestResponse>;
  /** Logs in, completing a forced password change; returns the `Cookie` value. */
  login(username: string): Promise<string>;
  adminCookie: string;
  /** A user created by the administrator and logged in once; returns its id and cookie. */
  createUser(username: string): Promise<{ id: string; cookie: string }>;
  close(): Promise<void>;
}

function cookieOf(response: LightMyRequestResponse): string | undefined {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  for (const value of values) {
    const match = SESSION_COOKIE.exec(value);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export async function composeServerStack(): Promise<ComposedStack> {
  const dataDir = tempDataDir("amber-stack-");
  const webRoot = tempDataDir("amber-stack-web-");
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><div id=root></div>");
  const composition = await compose({
    mode: "server",
    dataDir,
    binDir: dataDir,
    logLevel: "error",
    logDestination: { write: () => undefined },
    env: {
      AMBER_ADMIN_USERNAME: ADMIN_USERNAME,
      AMBER_ADMIN_PASSWORD: INITIAL_PASSWORD,
      // The stack measures the real disk, unlike the harness's stub: thresholds no test host
      // can fall below keep `disk_low` from refusing new tasks on a small CI runner.
      AMBER_LOW_WATER_FREE_GB: "0.001",
      AMBER_LOW_WATER_FREE_RATIO: "0",
    },
    publicOrigin: STACK_ORIGIN,
    trustedProxyCidrs: [],
    webRoot,
  });
  const app = composition.app;

  const send: ComposedStack["send"] = (request, cookie) =>
    app.inject({
      method: request.method,
      url: request.url,
      headers: {
        "x-amber-request": "1",
        origin: STACK_ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
        ...(request.payload === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.payload === undefined ? {} : { payload: JSON.stringify(request.payload) }),
    });

  const login = async (username: string, password = STACK_PASSWORD, fallback = INITIAL_PASSWORD): Promise<string> => {
    let response = await send({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    let used = password;
    if (response.statusCode === 401) {
      response = await send({ method: "POST", url: "/api/auth/login", payload: { username, password: fallback } });
      used = fallback;
    }
    if (response.statusCode !== 200) {
      throw new Error(`login of ${username} failed: ${response.statusCode} ${response.body}`);
    }
    let cookie = cookieOf(response) ?? "";
    if ((response.json() as { mustChangePassword: boolean }).mustChangePassword) {
      const changed = await send({ method: "POST", url: "/api/auth/change-password", payload: { currentPassword: used, newPassword: STACK_PASSWORD } }, cookie);
      if (changed.statusCode !== 200) {
        throw new Error(`password change of ${username} failed: ${changed.statusCode} ${changed.body}`);
      }
      cookie = cookieOf(changed) ?? cookie;
    }
    return cookie;
  };

  const adminCookie = await login(ADMIN_USERNAME, INITIAL_PASSWORD);
  return {
    composition,
    dataDir,
    send,
    login: (username) => login(username),
    adminCookie,
    async createUser(username) {
      const created = await send({ method: "POST", url: "/api/admin/users", payload: { username, password: INITIAL_PASSWORD, role: "user" } }, adminCookie);
      if (created.statusCode !== 201) {
        throw new Error(`creating ${username} failed: ${created.statusCode} ${created.body}`);
      }
      const id = (created.json() as { id: string }).id;
      // A new account only has its initial password: trying the other first would spend
      // the login rate limit, which a stack with several users then runs into.
      return { id, cookie: await login(username, INITIAL_PASSWORD) };
    },
    close: () => composition.shutdown(),
  };
}
