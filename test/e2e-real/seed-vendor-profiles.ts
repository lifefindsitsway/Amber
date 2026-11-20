import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadVendorEnv,
  redact,
  RUN_OUTPUT_ROOT,
  runStamp,
  TEST_PROFILE_PREFIX,
  vendorDisplayName,
  type VendorConfig,
  type VendorPrefix,
} from "./vendor-env.ts";

/**
 * Creates one "[测试] <vendor>" LLM profile per vendor with a key in the env file on a running
 * server-mode instance, so "test connection" can be clicked in its UI, and removes exactly
 * those profiles afterwards:
 *
 *   node test/e2e-real/seed-vendor-profiles.ts seed
 *   node test/e2e-real/seed-vendor-profiles.ts cleanup <seeded.json>
 *
 * The keys go from the env file straight to the instance's API and are never printed. Login
 * comes from the environment only: `AMBER_SEED_USERNAME`, `AMBER_SEED_PASSWORD`,
 * `AMBER_SEED_BASE_URL` (default `http://127.0.0.1:4191`) and `AMBER_SEED_ORIGIN` (the
 * instance's public origin, which unsafe requests must name; default the base URL's origin).
 * Cleanup deletes only ids from the list whose current name still starts with the test
 * prefix; other profiles, default models and tasks are never touched.
 *
 * The password and the keys travel to the instance, so it must be reached over https or on
 * this machine's loopback interface; any other address is refused before anything is sent.
 */

export const DEFAULT_SEED_BASE_URL = "http://127.0.0.1:4191";

export interface SeedLogin {
  baseUrl: string;
  origin: string;
  username: string;
  password: string;
}

export interface SeededProfile {
  vendor: VendorPrefix;
  presetId: string;
  id: string;
  name: string;
}

export interface SeededList {
  server: string;
  createdAt: string;
  profiles: SeededProfile[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Throws unless the instance is reached over https or on loopback, so no key crosses a network in clear text. */
export function assertSafeSeedBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("AMBER_SEED_BASE_URL 不是合法地址");
  }
  const safe = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!safe) {
    throw new Error("AMBER_SEED_BASE_URL 只能是本机回环地址（127.0.0.1 / localhost / ::1）或 https 地址");
  }
}

/** Reads the login from the environment; nothing of it is written anywhere. */
export function seedLoginFromEnv(env: NodeJS.ProcessEnv = process.env): SeedLogin {
  const baseUrl = (env["AMBER_SEED_BASE_URL"] ?? "").trim() || DEFAULT_SEED_BASE_URL;
  const username = env["AMBER_SEED_USERNAME"] ?? "";
  const password = env["AMBER_SEED_PASSWORD"] ?? "";
  if (username === "" || password === "") {
    throw new Error("需要环境变量 AMBER_SEED_USERNAME 与 AMBER_SEED_PASSWORD");
  }
  assertSafeSeedBaseUrl(baseUrl);
  const origin = (env["AMBER_SEED_ORIGIN"] ?? "").trim() || new URL(baseUrl).origin;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), origin, username, password };
}

interface ApiResponse {
  status: number;
  body: unknown;
}

/** A logged-in server-mode session: the session cookie plus the headers unsafe requests need. */
class Session {
  private readonly login: SeedLogin;
  private cookie = "";

  constructor(login: SeedLogin) {
    assertSafeSeedBaseUrl(login.baseUrl);
    this.login = login;
  }

  async open(): Promise<void> {
    const response = await fetch(`${this.login.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: this.headers("POST"),
      body: JSON.stringify({ username: this.login.username, password: this.login.password }),
    });
    if (response.status !== 200) {
      throw new Error(`登录失败：HTTP ${response.status} ${errorCode(await readBody(response))}`);
    }
    this.cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .filter((pair) => pair.includes("="))
      .join("; ");
    if (this.cookie === "") {
      throw new Error("登录成功但没有返回会话 cookie");
    }
  }

  async close(): Promise<void> {
    if (this.cookie !== "") {
      await this.call("POST", "/api/auth/logout").catch(() => undefined);
      this.cookie = "";
    }
  }

  async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<ApiResponse> {
    const response = await fetch(`${this.login.baseUrl}${path}`, {
      method,
      headers: { ...this.headers(method), ...(this.cookie === "" ? {} : { cookie: this.cookie }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await readBody(response) };
  }

  private headers(method: string): Record<string, string> {
    if (method === "GET") {
      return { accept: "application/json" };
    }
    return { accept: "application/json", "content-type": "application/json", "x-amber-request": "1", origin: this.login.origin };
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorCode(body: unknown): string {
  const error = (body as { error?: { code?: unknown } } | undefined)?.error;
  return typeof error?.code === "string" ? error.code : "";
}

function field(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

export interface SeedOptions {
  login: SeedLogin;
  vendors: readonly VendorConfig[];
  /** Parent of the run directory; defaults to `.amber-dev/llm-vendors`. */
  outputRoot?: string;
  log: (line: string) => void;
  now?: () => Date;
}

/** Written whole to a temporary file, then renamed over the list, so a crash never leaves half a file. */
function writeListAtomically(file: string, list: SeededList, keys: readonly string[]): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, redact(`${JSON.stringify(list, null, 2)}\n`, keys));
  renameSync(temporary, file);
}

/**
 * Creates the test profiles and returns the list's path (undefined when nothing was created).
 * The list is rewritten after every profile created, so a run that stops halfway still lists
 * every profile it left behind with a key.
 */
export async function seedProfiles(options: SeedOptions): Promise<{ file?: string; profiles: SeededProfile[]; failed: VendorPrefix[] }> {
  const keys = options.vendors.map((vendor) => vendor.apiKey);
  const log = (line: string): void => options.log(redact(line, keys));
  const ready = options.vendors.filter((vendor) => vendor.status === "ready");
  for (const vendor of options.vendors.filter((item) => item.status === "skip")) {
    log(`SKIP ${vendorDisplayName(vendor.presetId)}：${vendor.reason ?? ""}`);
  }
  if (ready.length === 0) {
    log("没有填写了 Key 的厂商，未创建任何 Profile");
    return { profiles: [], failed: [] };
  }
  const session = new Session(options.login);
  await session.open();
  const profiles: SeededProfile[] = [];
  const failed: VendorPrefix[] = [];
  const at = (options.now ?? (() => new Date()))();
  const dir = join(options.outputRoot ?? RUN_OUTPUT_ROOT, runStamp(at));
  const file = join(dir, "seeded.json");
  const list: SeededList = { server: options.login.baseUrl, createdAt: at.toISOString(), profiles };
  try {
    for (const vendor of ready) {
      const name = `${TEST_PROFILE_PREFIX} ${vendorDisplayName(vendor.presetId)}`;
      const response = await session.call(
        "POST",
        "/api/providers",
        {
          name,
          protocol: vendor.protocol,
          baseURL: vendor.baseURL,
          presetId: vendor.presetId,
          models: [{ modelId: vendor.modelId, ...(vendor.contextWindowTokens === undefined ? {} : { contextWindowTokens: vendor.contextWindowTokens }) }],
          credential: { value: vendor.apiKey },
        },
        { "idempotency-key": randomUUID() },
      );
      const id = field(response.body, "id");
      if ((response.status === 200 || response.status === 201) && id !== undefined) {
        profiles.push({ vendor: vendor.vendor, presetId: vendor.presetId, id, name });
        if (profiles.length === 1) {
          mkdirSync(dir, { recursive: true });
          log(`清单：${file}`);
        }
        writeListAtomically(file, list, keys);
        log(`已创建 ${vendorDisplayName(vendor.presetId)}：${id}`);
      } else {
        failed.push(vendor.vendor);
        log(`创建失败 ${vendorDisplayName(vendor.presetId)}：HTTP ${response.status} ${errorCode(response.body)}`);
      }
    }
  } finally {
    await session.close();
  }
  return profiles.length === 0 ? { profiles, failed } : { file, profiles, failed };
}

export interface CleanupOptions {
  login: SeedLogin;
  file: string;
  log: (line: string) => void;
}

export interface CleanupResult {
  deleted: string[];
  /** Ids left alone, with why. */
  skipped: Array<{ id: string; reason: "missing" | "name_mismatch" }>;
  failed: Array<{ id: string; status: number; code: string }>;
}

/** Deletes the listed profiles whose current name still carries the test prefix; nothing else. */
export async function cleanupProfiles(options: CleanupOptions): Promise<CleanupResult> {
  const list = JSON.parse(readFileSync(options.file, "utf8")) as Partial<SeededList>;
  const listed = Array.isArray(list.profiles) ? list.profiles.filter((item) => typeof item?.id === "string" && item.id !== "") : [];
  const result: CleanupResult = { deleted: [], skipped: [], failed: [] };
  if (listed.length === 0) {
    options.log("清单为空，没有要删除的 Profile");
    return result;
  }
  const session = new Session(options.login);
  await session.open();
  try {
    const current = await session.call("GET", "/api/providers");
    if (current.status !== 200) {
      throw new Error(`读取 Profile 列表失败：HTTP ${current.status} ${errorCode(current.body)}`);
    }
    const items = ((current.body as { items?: unknown } | undefined)?.items ?? []) as Array<{ id?: unknown; name?: unknown }>;
    for (const entry of listed) {
      const found = items.find((item) => item.id === entry.id);
      if (found === undefined) {
        result.skipped.push({ id: entry.id, reason: "missing" });
        options.log(`跳过 ${entry.id}：已不存在`);
        continue;
      }
      if (typeof found.name !== "string" || !found.name.startsWith(TEST_PROFILE_PREFIX)) {
        result.skipped.push({ id: entry.id, reason: "name_mismatch" });
        options.log(`跳过 ${entry.id}：名称不以「${TEST_PROFILE_PREFIX}」开头，未删除`);
        continue;
      }
      const response = await session.call("DELETE", `/api/providers/${encodeURIComponent(entry.id)}`);
      if (response.status === 204 || response.status === 200) {
        result.deleted.push(entry.id);
        options.log(`已删除 ${entry.id}`);
      } else {
        const code = errorCode(response.body);
        result.failed.push({ id: entry.id, status: response.status, code });
        options.log(`删除失败 ${entry.id}：HTTP ${response.status} ${code}`);
      }
    }
  } finally {
    await session.close();
  }
  return result;
}

async function main(args: readonly string[]): Promise<void> {
  const [command, file] = args;
  const log = (line: string): void => console.log(line);
  if (command === "seed") {
    const result = await seedProfiles({ login: seedLoginFromEnv(), vendors: loadVendorEnv(), log });
    process.exitCode = result.failed.length === 0 ? 0 : 1;
    return;
  }
  if (command === "cleanup" && file !== undefined && file !== "") {
    const result = await cleanupProfiles({ login: seedLoginFromEnv(), file: resolve(file), log });
    process.exitCode = result.failed.length === 0 ? 0 : 1;
    return;
  }
  console.error("用法：node test/e2e-real/seed-vendor-profiles.ts seed | cleanup <seeded.json>");
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Messages built here never carry a key; the env loader redacts its own.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
