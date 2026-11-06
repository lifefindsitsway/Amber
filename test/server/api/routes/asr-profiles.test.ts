import { afterEach, describe, expect, it } from "vitest";
import { ASR_PRESETS } from "../../../../src/shared/asr-presets.ts";
import type { AsrProviderId } from "../../../../src/shared/enums.ts";
import { registerAsrProfileRoutes } from "../../../../src/server/api/routes/asr-profiles.ts";
import { PolicyOutboundHttpClient } from "../../../../src/server/adapters/outbound-http/policy-client.ts";
import { AsrProfileService } from "../../../../src/server/application/asr-profile.ts";
import type { AsrProviderFactory } from "../../../../src/server/ports/asr-provider.ts";
import type { NetworkTargetCheck } from "../../../../src/server/ports/network-target-check.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import { FakeAsrFactory } from "../../../fixtures/asr/fake-asr.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { countRows, tempDataDir } from "../../../tools/sqlite.ts";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";

// A distinctive value so its plaintext can be searched for in responses and logs.
const KEY = "test-key-<placeholder-asr>";
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(targets?: NetworkTargetCheck) {
  const h = createHarness();
  open.push(h);
  const fake = new FakeAsrFactory();
  const presetOnly: AsrProviderFactory = {
    descriptor: ASR_PRESETS.dashscope,
    create: () => {
      throw new Error("not used");
    },
    probe: async () => ({}),
  };
  const asrProfiles = new AsrProfileService({
    repository: h.repository,
    secrets: h.secrets,
    factories: new Map<AsrProviderId, AsrProviderFactory>([
      ["elevenlabs", fake],
      ["dashscope", presetOnly],
    ]),
    newId: h.newId,
    files: new LocalFileStore(tempDataDir("amber-asr-route-")),
    ...(targets === undefined ? {} : { targets }),
  });
  const lines: string[] = [];
  const { app } = await h.app({ log: { write: (line) => void lines.push(line) }, extraRoutes: (instance) => registerAsrProfileRoutes(instance, { asrProfiles }) });
  return { h, app, fake, lines };
}

describe("/api/asr-profiles", () => {
  it("refuses to store a baseURL the network policy forbids", async () => {
    const { h, app } = await setup(new PolicyOutboundHttpClient({ mode: "strict", resolve: async () => [{ address: "93.184.215.14", family: 4 }] }));
    const refused = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs", baseURL: "http://192.168.1.10/v1" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("network_blocked_by_policy.private_address");
    expect(countRows(h.db, "asr_provider_profile")).toBe(0);
    const saved = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs", baseURL: "https://asr.test/v1" } });
    expect(saved.statusCode).toBe(201);
    const patched = await app.inject({ method: "PATCH", url: `/api/asr-profiles/${saved.json().id}`, headers: auth, payload: { baseURL: "http://10.0.0.2" } });
    expect(patched.statusCode).toBe(422);
  });

  it("creates, lists, renames and deletes profiles; stores the key only as a Secret and never returns it", async () => {
    const { h, app, lines } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/asr-profiles", headers: auth })).json()).toEqual({ items: [] });

    const created = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "百炼", provider: "dashscope", models: [{ modelId: "fun-asr" }] } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    expect(created.json()).toMatchObject({ name: "百炼", provider: "dashscope", models: [{ modelId: "fun-asr", available: true }], baseURL: "https://dashscope.aliyuncs.com", hasCredential: false, inUse: false });

    const put = await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/credential`, headers: auth, payload: { value: KEY } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ credentialStatus: "configured", hasCredential: true });
    expect(countRows(h.db, "secret")).toBe(1);

    const renamed = await app.inject({ method: "PATCH", url: `/api/asr-profiles/${id}`, headers: auth, payload: { name: "百炼 fun-asr", models: [{ modelId: "qwen-audio-3.1-asr-flash-filetrans" }, { modelId: "fun-asr" }] } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "百炼 fun-asr", models: [{ modelId: "qwen-audio-3.1-asr-flash-filetrans" }, { modelId: "fun-asr" }] });

    const listed = await app.inject({ method: "GET", url: "/api/asr-profiles", headers: auth });
    expect(listed.json().items).toHaveLength(1);
    for (const text of [put.body, renamed.body, listed.body, ...lines]) {
      expect(text).not.toContain(KEY);
    }

    // Another user sees, changes and deletes nothing of it.
    expect((await app.inject({ method: "GET", url: "/api/asr-profiles", headers: bob })).json()).toEqual({ items: [] });
    expect((await app.inject({ method: "PATCH", url: `/api/asr-profiles/${id}`, headers: bob, payload: { name: "mine" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/credential`, headers: bob, payload: { value: KEY } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/probe`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/test`, headers: bob, payload: { modelId: "fun-asr" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/model-pricing`, headers: bob, payload: { modelId: "fun-asr", pricing: null } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/asr-profiles/${id}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/asr-profiles/order", headers: bob, payload: { profileIds: [id] } })).statusCode).toBe(400);

    const deleted = await app.inject({ method: "DELETE", url: `/api/asr-profiles/${id}`, headers: auth });
    expect(deleted.statusCode).toBe(204);
    expect(countRows(h.db, "asr_provider_profile")).toBe(0);
    expect(countRows(h.db, "secret")).toBe(0);
    expect((await app.inject({ method: "DELETE", url: `/api/asr-profiles/${id}`, headers: auth })).statusCode).toBe(404);
  });

  it("orders the caller's profiles with every one exactly once", async () => {
    const { app } = await setup();
    const create = async (name: string) =>
      ((await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name, provider: "dashscope" } })).json() as { id: string }).id;
    const a = await create("a");
    const b = await create("b");
    const ordered = await app.inject({ method: "PUT", url: "/api/asr-profiles/order", headers: auth, payload: { profileIds: [b, a] } });
    expect(ordered.statusCode).toBe(200);
    expect((ordered.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([b, a]);
    expect(((await app.inject({ method: "GET", url: "/api/asr-profiles", headers: auth })).json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([b, a]);
    expect((await app.inject({ method: "PUT", url: "/api/asr-profiles/order", headers: auth, payload: { profileIds: [a] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/asr-profiles/order", headers: auth, payload: { profileIds: [] } })).statusCode).toBe(400);
  });

  it("rejects unknown fields, unknown providers and non-http base URLs without echoing the key", async () => {
    const { app } = await setup();
    const unknown = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "other" } });
    expect(unknown.statusCode).toBe(400);
    const extra = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs", value: KEY } });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain(KEY);
    const ftp = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs", baseURL: "ftp://asr.invalid" } });
    expect(ftp.statusCode).toBe(400);
    expect(ftp.json().error.code).toBe("invalid_request");
    const created = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs" } });
    const credential = await app.inject({ method: "PUT", url: `/api/asr-profiles/${created.json().id}/credential`, headers: auth, payload: { value: KEY, extra: 1 } });
    expect(credential.statusCode).toBe(400);
    expect(credential.body).not.toContain(KEY);
  });

  it("probes the stored key: account summary on success, asr_failed.auth when refused, asr_unconfigured without a key", async () => {
    const { app, fake } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs" } })).json() as { id: string };
    const unconfigured = await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/probe`, headers: auth });
    expect(unconfigured.statusCode).toBe(422);
    expect(unconfigured.json().error.code).toBe("asr_unconfigured");

    await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/credential`, headers: auth, payload: { value: KEY } });
    const ok = await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/probe`, headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ subscriptionStatus: "active", usedUnits: 10, limitUnits: 100 });
    expect(fake.probes).toHaveLength(1);

    fake.probeOutcome = amberError("asr_failed", "key refused", { code: "asr_failed.auth" });
    const refused = await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/probe`, headers: auth });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: "asr_failed.auth", retryDisposition: "never", action: "configure_asr" });
  });

  it("adds a custom model with a family and refuses malformed ids or a missing family", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/asr-profiles",
      headers: auth,
      payload: { name: "x", provider: "elevenlabs", models: [{ modelId: "vendor/stt-2:beta", family: "fake_basic" }, { modelId: "scribe_v2" }] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().models).toEqual([
      { modelId: "vendor/stt-2:beta", family: "fake_basic", available: true },
      { modelId: "scribe_v2", family: "fake", available: true },
    ]);
    for (const models of [[{ modelId: "-starts-badly", family: "fake_basic" }], [{ modelId: "has space", family: "fake_basic" }], [{ modelId: "x".repeat(129), family: "fake_basic" }], ["scribe_v2"]]) {
      const refused = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs", models } });
      expect(refused.statusCode, JSON.stringify(models)).toBe(400);
    }
    const noFamily = await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs", models: [{ modelId: "custom" }] } });
    expect(noFamily.statusCode).toBe(400);
    expect(noFamily.json().error.code).toBe("invalid_request");
  });

  it("sets a model's price within the schema bounds and the transcription units", async () => {
    const { app } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "dashscope" } })).json() as { id: string };
    const pricing = { currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.00022" }], note: "非语音不计费" };
    const priced = await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/model-pricing`, headers: auth, payload: { modelId: "fun-asr", pricing } });
    expect(priced.statusCode).toBe(200);
    expect(priced.json().models[1]).toEqual({ modelId: "fun-asr", family: "fun_asr", available: true, pricing });
    const bad = (pricing: unknown) => app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/model-pricing`, headers: auth, payload: { modelId: "fun-asr", pricing } });
    for (const wrong of [
      { currency: "EUR", items: [{ unit: "audio_per_second", amount: "1" }] },
      { currency: "CNY", items: [] },
      { currency: "CNY", items: [{ unit: "audio_per_second", amount: "1e-4" }] },
      { currency: "CNY", items: [{ unit: "audio_per_second", amount: "-1" }] },
      { currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.12345678901" }] },
      { currency: "CNY", items: [{ unit: "audio_per_second", amount: "1" }, { unit: "audio_per_second", amount: "2" }] },
      { currency: "CNY", items: [{ unit: "audio_per_second", amount: "1" }], note: "x".repeat(201) },
      { currency: "CNY", items: ["audio_per_second", "audio_per_minute", "audio_per_hour", "per_request", "input_tokens_per_million", "output_tokens_per_million", "cached_input_tokens_per_million"].map((unit) => ({ unit, amount: "1" })) },
      { currency: "CNY", items: [{ unit: "cached_input_tokens_per_million", amount: "1" }] },
      { currency: "CNY", items: [{ unit: "cache_write_tokens_per_million", amount: "1" }] },
      { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "1" }, { unit: "audio_per_second", amount: "1" }] },
      { currency: "CNY", items: [{ unit: "audio_per_second", amount: "1" }, { unit: "audio_per_minute", amount: "1" }] },
      // A unit of another section.
      { currency: "CNY", items: [{ unit: "per_image", amount: "1" }] },
    ]) {
      const refused = await bad(wrong);
      expect(refused.statusCode, JSON.stringify(wrong)).toBe(400);
      expect(refused.json().error.code).toBe("invalid_request");
    }
    expect((await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/model-pricing`, headers: auth, payload: { modelId: "absent", pricing: null } })).statusCode).toBe(404);
    const cleared = await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/model-pricing`, headers: auth, payload: { modelId: "fun-asr", pricing: null } });
    expect(cleared.json().models[1]).not.toHaveProperty("pricing");
  });

  it("tests one model and answers with the outcome or the upstream error; a key is needed", async () => {
    const { h, app, fake } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/asr-profiles", headers: auth, payload: { name: "x", provider: "elevenlabs" } })).json() as { id: string };
    const unconfigured = await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/test`, headers: auth, payload: { modelId: "scribe_v2" } });
    expect(unconfigured.statusCode).toBe(422);
    expect(unconfigured.json().error.code).toBe("asr_unconfigured");
    await app.inject({ method: "PUT", url: `/api/asr-profiles/${id}/credential`, headers: auth, payload: { value: KEY } });
    const tested = await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/test`, headers: auth, payload: { modelId: "scribe_v2" } });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ modelId: "scribe_v2", result: "transcribed", textPreview: "欢迎来到生成式软件工程。今天讲提示词。" });
    expect(typeof tested.json().testedAt).toBe("number");
    expect(fake.calls).toHaveLength(1);
    expect(countRows(h.db, "asr_usage", "feature = 'test_connection'")).toBe(1);
    expect((await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/test`, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/test`, headers: auth, payload: { modelId: "fake-model" } })).statusCode).toBe(404);
    fake.outcomes = [amberError("asr_failed", "no such model", { code: "asr_failed.model_unavailable" })];
    const refused = await app.inject({ method: "POST", url: `/api/asr-profiles/${id}/test`, headers: auth, payload: { modelId: "scribe_v2" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("asr_failed.model_unavailable");
    expect(tested.body).not.toContain(KEY);
  });
});

