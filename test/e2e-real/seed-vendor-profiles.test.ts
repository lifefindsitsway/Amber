import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeSeedBaseUrl, cleanupProfiles, DEFAULT_SEED_BASE_URL, seedLoginFromEnv, seedProfiles, type SeedLogin, type SeededList } from "./seed-vendor-profiles.ts";
import { parseVendorEnv } from "./vendor-env.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/vendor-env/partial.env", import.meta.url));
const PASSWORD = "xxxx-seed-password-0042";
const ORIGIN = "http://localhost:4191";
const COOKIE = "__Host-amber-session=fake-session-id";

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

interface FakeProfile {
  id: string;
  name: string;
}

/** A stand-in for a server-mode instance: login, CSRF headers, session cookie and the provider routes. */
class FakeInstance {
  readonly seen: Seen[] = [];
  profiles: FakeProfile[] = [{ id: "keep-1", name: "我的 OpenAI" }];
  /** Preset ids whose create answers 400. */
  rejectPresets = new Set<string>();
  /** Preset ids whose create drops the connection, so the client throws. */
  dropPresets = new Set<string>();
  private server: Server | undefined;
  private next = 1;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text === "" ? undefined : (JSON.parse(text) as unknown);
    const method = request.method ?? "";
    const path = request.url ?? "";
    this.seen.push({ method, path, headers: request.headers, body });
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (method !== "GET" && (request.headers["x-amber-request"] !== "1" || request.headers["origin"] !== ORIGIN)) {
      send(401, { error: { code: "unauthenticated.csrf" } });
      return;
    }
    if (method === "POST" && path === "/api/auth/login") {
      const { username, password } = body as { username: string; password: string };
      if (username === "tester" && password === PASSWORD) {
        send(200, { userId: "u1" }, { "set-cookie": `${COOKIE}; Path=/; HttpOnly; Secure; SameSite=Lax` });
      } else {
        send(401, { error: { code: "unauthenticated.bad_credentials" } });
      }
      return;
    }
    if (request.headers["cookie"] !== COOKIE) {
      send(401, { error: { code: "unauthenticated" } });
      return;
    }
    if (method === "POST" && path === "/api/auth/logout") {
      send(204);
      return;
    }
    if (method === "POST" && path === "/api/providers") {
      const create = body as { name: string; presetId: string };
      if (this.dropPresets.has(create.presetId)) {
        request.socket.destroy();
        return;
      }
      if (this.rejectPresets.has(create.presetId)) {
        send(400, { error: { code: "invalid_request" } });
        return;
      }
      const profile = { id: `p-${this.next++}`, name: create.name };
      this.profiles.push(profile);
      send(201, { ...profile, credentialStatus: "configured", hasCredential: true });
      return;
    }
    if (method === "GET" && path === "/api/providers") {
      send(200, { items: this.profiles });
      return;
    }
    const remove = /^\/api\/providers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && remove !== null) {
      const id = decodeURIComponent(remove[1] ?? "");
      this.profiles = this.profiles.filter((profile) => profile.id !== id);
      send(204);
      return;
    }
    send(404, { error: { code: "not_found" } });
  }
}

const vendors = parseVendorEnv(readFileSync(FIXTURE, "utf8"));
const keys = vendors.map((vendor) => vendor.apiKey).filter((key) => key !== "");

let instance: FakeInstance | undefined;
afterEach(async () => {
  await instance?.stop();
  instance = undefined;
});

async function started(): Promise<{ fake: FakeInstance; login: SeedLogin; out: string }> {
  const fake = new FakeInstance();
  await fake.start();
  instance = fake;
  return { fake, login: { baseUrl: fake.baseUrl, origin: ORIGIN, username: "tester", password: PASSWORD }, out: mkdtempSync(join(tmpdir(), "amber-seed-")) };
}

/** A one-entry list, written for tests that must never get as far as reading it. */
function unreadList(dir: string): string {
  const file = join(dir, "list.json");
  writeFileSync(file, JSON.stringify({ server: "x", createdAt: "x", profiles: [{ vendor: "GLM", presetId: "glm", id: "p-9", name: "[测试] GLM" }] }));
  return file;
}

function assertNoSecret(text: string): void {
  for (const secret of [...keys, PASSWORD]) {
    expect(text).not.toContain(secret);
  }
}

describe("seed-vendor-profiles", () => {
  it("logs in, creates one test profile per vendor with a key, logs out and lists what it made", async () => {
    const { fake, login, out } = await started();
    const lines: string[] = [];
    const result = await seedProfiles({ login, vendors, outputRoot: out, log: (line) => lines.push(line), now: () => new Date(Date.UTC(2026, 10, 20, 2, 0, 0)) });

    expect(fake.seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/auth/login",
      "POST /api/providers",
      "POST /api/providers",
      "POST /api/providers",
      "POST /api/providers",
      "POST /api/providers",
      "POST /api/auth/logout",
    ]);
    const creates = fake.seen.filter((request) => request.path === "/api/providers");
    expect(creates.map((request) => request.body)).toEqual([
      {
        name: "[测试] Anthropic",
        protocol: "anthropic_messages",
        baseURL: "https://api.anthropic.com",
        presetId: "anthropic",
        models: [{ modelId: "fake-anthropic-model", contextWindowTokens: 200000 }],
        credential: { value: "xxxx-fake-anthropic-key-0001" },
      },
      {
        name: "[测试] DeepSeek",
        protocol: "anthropic_messages",
        baseURL: "https://api.deepseek.com/anthropic",
        presetId: "deepseek",
        models: [{ modelId: "fake-deepseek-model" }],
        credential: { value: "xxxx-fake-deepseek-key-0002" },
      },
      {
        name: "[测试] Qwen（通义千问）",
        protocol: "openai_compatible",
        baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        presetId: "qwen",
        models: [{ modelId: "fake-qwen-model" }],
        credential: { value: "xxxx-fake-qwen-key-0003" },
      },
      {
        name: "[测试] GLM（智谱）",
        protocol: "openai_compatible",
        baseURL: "https://api.z.ai/api/paas/v4",
        presetId: "glm",
        models: [{ modelId: "fake-glm-model" }],
        credential: { value: "xxxx-fake-glm-key-0004" },
      },
      {
        name: "[测试] Grok（xAI）",
        protocol: "openai_responses",
        baseURL: "https://relay.example.com/v1",
        presetId: "grok",
        models: [{ modelId: "fake-grok-model", contextWindowTokens: 131072 }],
        credential: { value: "xxxx-fake-grok-key-0005" },
      },
    ]);
    // Every create carries its own Idempotency-Key and the session.
    const idempotencyKeys = creates.map((request) => request.headers["idempotency-key"]);
    expect(new Set(idempotencyKeys).size).toBe(5);
    expect(creates.every((request) => request.headers["cookie"] === COOKIE)).toBe(true);

    expect(result.failed).toEqual([]);
    expect(result.file).toBe(join(out, "20261120-100000", "seeded.json"));
    const list = JSON.parse(readFileSync(result.file ?? "", "utf8")) as SeededList;
    expect(list.server).toBe(fake.baseUrl);
    expect(list.profiles.map(({ vendor, id }) => [vendor, id])).toEqual([
      ["ANTHROPIC", "p-1"],
      ["DEEPSEEK", "p-2"],
      ["QWEN", "p-3"],
      ["GLM", "p-4"],
      ["GROK", "p-5"],
    ]);
    assertNoSecret(readFileSync(result.file ?? "", "utf8"));
    assertNoSecret(lines.join("\n"));
    expect(lines).toContain("已创建 Anthropic：p-1");
    expect(lines.filter((line) => line.startsWith("SKIP"))).toHaveLength(3);
  });

  it("goes on after one vendor is refused and reports it without the key", async () => {
    const { fake, login, out } = await started();
    fake.rejectPresets.add("qwen");
    const lines: string[] = [];
    const result = await seedProfiles({ login, vendors, outputRoot: out, log: (line) => lines.push(line) });
    expect(result.failed).toEqual(["QWEN"]);
    expect(result.profiles.map((profile) => profile.vendor)).toEqual(["ANTHROPIC", "DEEPSEEK", "GLM", "GROK"]);
    expect(lines).toContain("创建失败 Qwen（通义千问）：HTTP 400 invalid_request");
    assertNoSecret(lines.join("\n"));
  });

  it("keeps the list of profiles already created when a later create throws", async () => {
    const { fake, login, out } = await started();
    fake.dropPresets.add("deepseek");
    await expect(seedProfiles({ login, vendors, outputRoot: out, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 20, 2, 0, 0)) })).rejects.toThrow();
    const dir = join(out, "20261120-100000");
    const list = JSON.parse(readFileSync(join(dir, "seeded.json"), "utf8")) as SeededList;
    expect(list.profiles.map(({ vendor, id }) => [vendor, id])).toEqual([["ANTHROPIC", "p-1"]]);
    expect(readdirSync(dir)).toEqual(["seeded.json"]);
    assertNoSecret(readFileSync(join(dir, "seeded.json"), "utf8"));
  });

  it("refuses an instance address that is neither loopback nor https, before sending anything", async () => {
    const { fake, login, out } = await started();
    for (const allowed of ["http://127.0.0.1:4191", "http://localhost:4191", "http://[::1]:4191", "https://amber.example.com"]) {
      expect(() => assertSafeSeedBaseUrl(allowed)).not.toThrow();
    }
    for (const refused of ["http://192.168.1.5:4191", "http://amber.example.com", "ftp://127.0.0.1", "not a url"]) {
      expect(() => assertSafeSeedBaseUrl(refused)).toThrow(/AMBER_SEED_BASE_URL/);
    }
    expect(() => seedLoginFromEnv({ AMBER_SEED_USERNAME: "tester", AMBER_SEED_PASSWORD: PASSWORD, AMBER_SEED_BASE_URL: "http://10.0.0.2:4191" })).toThrow(/AMBER_SEED_BASE_URL/);
    await expect(seedProfiles({ login: { ...login, baseUrl: "http://10.0.0.2:4191" }, vendors, outputRoot: out, log: () => undefined })).rejects.toThrow(/AMBER_SEED_BASE_URL/);
    await expect(cleanupProfiles({ login: { ...login, baseUrl: "http://10.0.0.2:4191" }, file: unreadList(out), log: () => undefined })).rejects.toThrow(/AMBER_SEED_BASE_URL/);
    expect(fake.seen).toEqual([]);
    expect(existsSync(join(out, "seeded.json"))).toBe(false);
  });

  it("sends nothing and writes no list when no vendor has a key", async () => {
    const { fake, login, out } = await started();
    const lines: string[] = [];
    const result = await seedProfiles({ login, vendors: parseVendorEnv("OPENAI_MODEL_ID=m\n"), outputRoot: out, log: (line) => lines.push(line) });
    expect(result).toEqual({ profiles: [], failed: [] });
    expect(fake.seen).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
  });

  it("fails a bad login without repeating the password", async () => {
    const { login, out } = await started();
    await expect(seedProfiles({ login: { ...login, password: "xxxx-wrong-password" }, vendors, outputRoot: out, log: () => undefined })).rejects.toThrow(
      /登录失败：HTTP 401 unauthenticated\.bad_credentials/,
    );
    try {
      await seedProfiles({ login: { ...login, password: "xxxx-wrong-password" }, vendors, outputRoot: out, log: () => undefined });
    } catch (error) {
      expect((error as Error).message).not.toContain("xxxx-wrong-password");
    }
  });

  it("deletes only listed ids whose name still carries the test prefix", async () => {
    const { fake, login, out } = await started();
    const seeded = await seedProfiles({ login, vendors, outputRoot: out, log: () => undefined });
    // Someone renamed one test profile meanwhile; another list entry points at a real profile, one is gone.
    fake.profiles = fake.profiles.map((profile) => (profile.id === "p-2" ? { ...profile, name: "改过名的 DeepSeek" } : profile));
    fake.profiles.push({ id: "keep-2", name: "[测试] 不在清单里" });
    const list = JSON.parse(readFileSync(seeded.file ?? "", "utf8")) as SeededList;
    list.profiles.push({ vendor: "OPENAI", presetId: "openai", id: "keep-1", name: "[测试] OpenAI" }, { vendor: "KIMI", presetId: "kimi", id: "gone-1", name: "[测试] Kimi" });
    const file = join(out, "edited-seeded.json");
    writeFileSync(file, JSON.stringify(list));
    fake.seen.length = 0;

    const lines: string[] = [];
    const result = await cleanupProfiles({ login, file, log: (line) => lines.push(line) });

    expect(fake.seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/auth/login",
      "GET /api/providers",
      "DELETE /api/providers/p-1",
      "DELETE /api/providers/p-3",
      "DELETE /api/providers/p-4",
      "DELETE /api/providers/p-5",
      "POST /api/auth/logout",
    ]);
    expect(result).toEqual({
      deleted: ["p-1", "p-3", "p-4", "p-5"],
      skipped: [
        { id: "p-2", reason: "name_mismatch" },
        { id: "keep-1", reason: "name_mismatch" },
        { id: "gone-1", reason: "missing" },
      ],
      failed: [],
    });
    expect(fake.profiles.map((profile) => profile.id).sort()).toEqual(["keep-1", "keep-2", "p-2"]);
    assertNoSecret(lines.join("\n"));
  });

  it("reads the login from the environment only and defaults the address and origin", () => {
    expect(() => seedLoginFromEnv({ AMBER_SEED_PASSWORD: PASSWORD })).toThrow(/AMBER_SEED_USERNAME/);
    expect(() => seedLoginFromEnv({ AMBER_SEED_USERNAME: "tester" })).toThrow(/AMBER_SEED_PASSWORD/);
    expect(seedLoginFromEnv({ AMBER_SEED_USERNAME: "tester", AMBER_SEED_PASSWORD: PASSWORD })).toEqual({
      baseUrl: DEFAULT_SEED_BASE_URL,
      origin: new URL(DEFAULT_SEED_BASE_URL).origin,
      username: "tester",
      password: PASSWORD,
    });
    expect(
      seedLoginFromEnv({ AMBER_SEED_USERNAME: "tester", AMBER_SEED_PASSWORD: PASSWORD, AMBER_SEED_BASE_URL: "http://127.0.0.1:4191/", AMBER_SEED_ORIGIN: ORIGIN }),
    ).toMatchObject({ baseUrl: "http://127.0.0.1:4191", origin: ORIGIN });
  });
});
