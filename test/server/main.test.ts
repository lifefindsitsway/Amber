import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signFileGrant } from "../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { CONCURRENCY_PIPELINE_MAX, FILE_GRANT_TTL_MS } from "../../src/shared/defaults.ts";
import { mediaFixtures } from "../fixtures/media/index.ts";
import { toolsBinDir } from "../fixtures/tools.ts";

const MAIN = join(import.meta.dirname, "../../src/server/main.ts");
const TOKEN = "t".repeat(64);
const GRANT_KEY = randomBytes(32);
const BASE_ENV = { AMBER_MODE: "local", AMBER_SIDECAR_TOKEN: TOKEN, AMBER_FILE_GRANT_KEY: GRANT_KEY.toString("base64url") };
let child: ChildProcessWithoutNullStreams | undefined;
let stderr = "";

function start(env: Record<string, string>): ChildProcessWithoutNullStreams {
  child = spawn(process.execPath, [MAIN], { env: { ...env }, stdio: "pipe" });
  stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return child;
}

function readyPort(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /^READY (\{.*\})\n/.exec(out);
      if (match?.[1] !== undefined) {
        resolve((JSON.parse(match[1]) as { port: number }).port);
      }
    });
    proc.once("exit", (code) => reject(new Error(`exited ${code} before READY`)));
  });
}

const exitCode = (proc: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolve) => proc.once("exit", (code) => resolve(code)));

// Response bodies are asserted structurally; Node's `fetch` types them as unknown.
const json = (response: Response): Promise<any> => response.json() as Promise<any>;

afterEach(() => {
  child?.kill();
  child = undefined;
});

describe("sidecar entry point", () => {
  it("prints READY, requires the token and exits cleanly when stdin closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const proc = start({ ...BASE_ENV, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir });
    const port = await readyPort(proc);
    const url = `http://127.0.0.1:${port}/api/health`;

    const denied = await fetch(url);
    expect(denied.status).toBe(401);
    expect((await json(denied)).error).toMatchObject({ class: "unauthenticated", code: "unauthenticated" });
    const ok = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ok" });

    const exited = exitCode(proc);
    proc.stdin.end();
    expect(await exited).toBe(0);
    // Request logs go to stderr as JSON lines, with the token redacted.
    expect(stderr).toContain('"url":"/api/health"');
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).not.toContain(BASE_ENV.AMBER_FILE_GRANT_KEY);
  });

  it("serves the task API base with environment-fixed instance settings and the link import route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    // The watermark reads the real volume; a nearly full CI disk must not answer the import with disk_low.
    const proc = start({
      ...BASE_ENV,
      AMBER_DATA_DIR: dir,
      AMBER_BIN_DIR: dir,
      AMBER_CONCURRENCY_PIPELINE: "4",
      AMBER_LOW_WATER_FREE_GB: "0.001",
      AMBER_LOW_WATER_FREE_RATIO: "0",
    });
    const port = await readyPort(proc);
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

    expect(await json(await api("/api/version"))).toMatchObject({ mode: "local" });
    expect(await json(await api("/api/auth/me"))).toEqual({ userId: "local", role: "admin", mode: "local", mustChangePassword: false });
    expect(await json(await api("/api/settings"))).toMatchObject({ theme: "light", language: "zh-CN", shortcuts: {} });
    // The start-up self-check route is gone with its page.
    expect((await api("/api/spike/m0")).status).toBe(404);

    const tasks = await api("/api/tasks");
    expect(tasks.status).toBe(200);
    expect(await tasks.json()).toEqual({ items: [], eventSeq: 0 });

    const settings = await json(await api("/api/instance-settings"));
    expect(settings).toMatchObject({ concurrencyPipeline: 4 });
    expect(settings.envOverridden).toContain("concurrencyPipeline");

    // A link no platform accepts is refused before anything goes online.
    const imported = await api("/api/contents/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ url: "https://example.com/watch?v=1" }] }),
    });
    expect(imported.status).toBe(422);
    expect((await json(imported)).error.class).toBe("source_unsupported_url");
    expect((await json(await api("/api/platform-accounts"))).accounts.map((account: { platform: string }) => account.platform)).toEqual(["bilibili", "youtube", "xiaohongshu"]);

    const exited = exitCode(proc);
    proc.stdin.end();
    expect(await exited).toBe(0);
  });

  it("refuses to start with an invalid instance-setting override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const proc = start({ ...BASE_ENV, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir, AMBER_CONCURRENCY_PIPELINE: "zero" });
    expect(await exitCode(proc)).toBe(1);
  });

  it.each(["AMBER_CONCURRENCY_HEAVY", "AMBER_CONCURRENCY_LLM"])("refuses to start while the removed %s is set, naming it", async (name) => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const proc = start({ ...BASE_ENV, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir, [name]: "2" });
    expect(await exitCode(proc)).toBe(1);
    expect(stderr).toContain(`${name} is no longer supported and must be removed`);
  });

  it("refuses to start with a concurrency override above its limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const proc = start({ ...BASE_ENV, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir, AMBER_CONCURRENCY_PIPELINE: String(CONCURRENCY_PIPELINE_MAX + 1) });
    expect(await exitCode(proc)).toBe(1);
  });

  it("refuses to start without a valid file grant key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const { AMBER_FILE_GRANT_KEY: _omitted, ...withoutKey } = BASE_ENV;
    expect(await exitCode(start({ ...withoutKey, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir }))).toBe(1);
    expect(stderr).toContain("AMBER_FILE_GRANT_KEY");
    expect(await exitCode(start({ ...BASE_ENV, AMBER_FILE_GRANT_KEY: "short", AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir }))).toBe(1);
  });

  it("imports a granted local file, probes it in the media stage and keeps server-only routes unregistered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    // The watermark reads the real volume; a nearly full CI disk must not turn this into a disk_low test.
    const proc = start({ ...BASE_ENV, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: toolsBinDir(), AMBER_LOW_WATER_FREE_GB: "0.001", AMBER_LOW_WATER_FREE_RATIO: "0" });
    const port = await readyPort(proc);
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    const { withAudio } = mediaFixtures();
    const grant = signFileGrant(GRANT_KEY, { path: withAudio.path, purpose: "local_file", expiresAt: Date.now() + FILE_GRANT_TTL_MS });

    const forged = await api("/api/contents/local-file", {
      method: "POST", body: JSON.stringify({ path: "/etc/hostname", grant: { ...grant, path: "/etc/hostname" } }),
    });
    expect(forged.status).toBe(401);
    expect((await json(forged)).error.code).toBe("unauthenticated.file_grant");

    const created = await api("/api/contents/local-file", { method: "POST", body: JSON.stringify({ path: withAudio.path, grant }) });
    expect(created.status).toBe(202);
    const { taskIds } = (await created.json()) as { taskIds: string[] };
    let stages: Array<{ stage: string; status: string }> = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      stages = ((await (await api(`/api/tasks/${taskIds[0]}`)).json()) as { stageRuns: Array<{ stage: string; status: string }> }).stageRuns;
      if (stages.find((run) => run.stage === "asr")?.status === "waiting_configuration") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stages.find((run) => run.stage === "media")?.status).toBe("succeeded");
    expect(stages.find((run) => run.stage === "asr")?.status).toBe("waiting_configuration");

    for (const path of ["/api/contents/upload", "/api/media/anything"]) {
      const response = await api(path, { method: path.endsWith("upload") ? "POST" : "GET", body: path.endsWith("upload") ? "{}" : null });
      expect(response.status, path).toBe(404);
    }

    const exited = exitCode(proc);
    proc.stdin.end();
    expect(await exited).toBe(0);
  });

  it("refuses to start without an explicit local mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const { AMBER_MODE: _omitted, ...withoutMode } = BASE_ENV;
    const proc = start({ ...withoutMode, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir });
    expect(await exitCode(proc)).toBe(1);
  });
});

describe("server entry point", () => {
  const SERVER_ENV = { AMBER_MODE: "server", AMBER_HOST: "127.0.0.1" };

  async function freePort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
      });
    });
  }

  async function waitForHealth(port: number, proc: ChildProcessWithoutNullStreams): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (proc.exitCode !== null) throw new Error(`exited ${proc.exitCode}: ${stderr}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("server did not become healthy");
  }

  it("prints the setup token once outside the structured log, accepts it once and stops on SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const proc = start({ ...SERVER_ENV, AMBER_PORT: String(port), AMBER_PUBLIC_ORIGIN: origin, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir });
    await waitForHealth(port, proc);
    const line = stderr.split("\n").find((text) => text.includes("setup token"));
    const token = /: ([A-Za-z0-9_-]{43})$/.exec(line ?? "")?.[1];
    expect(token).toBeDefined();
    expect(stderr.split(token as string)).toHaveLength(2);
    expect(line?.startsWith("{")).toBe(false);

    const status = await fetch(`${origin}/api/setup`, { headers: { "x-amber-setup-token": token as string } });
    expect(await json(status)).toEqual({ initialized: false });
    const password = "<server-entry-password>";
    const headers = { "content-type": "application/json", "x-amber-request": "1", origin, "x-amber-setup-token": token as string };
    const created = await fetch(`${origin}/api/setup`, { method: "POST", headers, body: JSON.stringify({ username: "Admin", password }) });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ role: "admin", mode: "server", mustChangePassword: false });
    expect(created.headers.get("set-cookie")).toMatch(/^__Host-amber-session=[^;]+;.*HttpOnly/u);
    const again = await fetch(`${origin}/api/setup`, { method: "POST", headers, body: JSON.stringify({ username: "other", password }) });
    expect(again.status).toBe(409);
    expect(await json(await fetch(`${origin}/api/setup`))).toEqual({ initialized: true });
    // The SPA is served with the security headers even where no build exists yet.
    const version = await fetch(`${origin}/api/version`);
    expect(version.headers.get("content-security-policy")).toContain("default-src 'self'");

    const exited = exitCode(proc);
    proc.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(stderr).not.toContain(password);
  });

  it("consumes a preset administrator once and refuses a short preset password without echoing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const short = "short-pw";
    const refused = start({
      ...SERVER_ENV, AMBER_PORT: String(port), AMBER_PUBLIC_ORIGIN: origin, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir,
      AMBER_ADMIN_USERNAME: "boss", AMBER_ADMIN_PASSWORD: short,
    });
    expect(await exitCode(refused)).toBe(1);
    expect(stderr).toContain("AMBER_ADMIN_PASSWORD");
    expect(stderr).not.toContain(short);

    const password = "<preset-admin-password>";
    const proc = start({
      ...SERVER_ENV, AMBER_PORT: String(port), AMBER_PUBLIC_ORIGIN: origin, AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir,
      AMBER_ADMIN_USERNAME: "boss", AMBER_ADMIN_PASSWORD: password,
    });
    await waitForHealth(port, proc);
    expect(stderr).not.toContain("setup token");
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", "x-amber-request": "1", origin }, body: JSON.stringify({ username: "boss", password }),
    });
    expect(await json(login)).toMatchObject({ role: "admin", mustChangePassword: true });
    expect((await fetch(`${origin}/api/setup`, { method: "POST", headers: { "content-type": "application/json", "x-amber-request": "1", origin }, body: "{}" })).status).toBe(409);
    const exited = exitCode(proc);
    proc.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(stderr).not.toContain(password);
  });

  it("refuses a public origin that is plain http on a non-loopback host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-main-"));
    const proc = start({ ...SERVER_ENV, AMBER_PUBLIC_ORIGIN: "http://amber.example.com", AMBER_DATA_DIR: dir, AMBER_BIN_DIR: dir });
    expect(await exitCode(proc)).toBe(1);
    expect(stderr).toContain("AMBER_PUBLIC_ORIGIN");
  });
});
