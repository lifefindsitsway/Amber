import { afterEach, describe, expect, it } from "vitest";
import { registerProviderRoutes } from "../../../../src/server/api/routes/providers.ts";
import { PolicyOutboundHttpClient } from "../../../../src/server/adapters/outbound-http/policy-client.ts";
import { ProviderService, type ModelProber } from "../../../../src/server/application/providers.ts";
import type { ProviderProfile } from "../../../../src/server/domain/provider-profile.ts";
import type { NetworkTargetCheck } from "../../../../src/server/ports/network-target-check.ts";
import { BOB_TOKEN, createHarness, createTaskOfKind, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

// A distinctive value so its plaintext can be searched for in responses and logs.
const KEY = "test-key-<placeholder-llm>";
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(targets?: NetworkTargetCheck) {
  const h = createHarness();
  open.push(h);
  const probes: string[] = [];
  const prober: ModelProber = {
    async probe(userId, modelRef) {
      probes.push(modelRef.modelId);
      const basis = h.repository.withTransaction((scope) => {
        const profile = scope.providerProfiles.get(userId, modelRef.providerProfileId) as ProviderProfile;
        const ref = profile.credentialRef;
        return { protocol: profile.protocol, baseURL: profile.baseURL, credentialVersion: ref === undefined ? undefined : scope.secretEnvelopes.get(userId, ref)?.versionId, modelId: modelRef.modelId };
      });
      return {
        basic: { status: "connected", latencyMs: 5 },
        checks: [
          { flag: "stream", result: "supported" },
          { flag: "structuredOutput", result: "supported" },
          { flag: "tools", result: "unsupported" },
        ],
        basis,
      };
    },
  };
  const providers = new ProviderService({ repository: h.repository, secrets: h.secrets, prober, newId: h.newId, ...(targets === undefined ? {} : { targets }) });
  const lines: string[] = [];
  const { app } = await h.app({ log: { write: (line) => void lines.push(line) }, extraRoutes: (instance) => registerProviderRoutes(instance, { providers }) });
  return { h, app, probes, lines };
}

const profileBody = {
  name: "relay",
  protocol: "anthropic_messages",
  baseURL: "https://llm.invalid/",
  models: [{ modelId: "vendor/model a", contextWindowTokens: 200_000 }],
};

describe("/api/providers", () => {
  it("refuses to store a baseURL the network policy forbids, on create and on update", async () => {
    // Host names resolve through a stub; nothing leaves the machine.
    const strict = new PolicyOutboundHttpClient({ mode: "strict", resolve: async (host) => [{ address: host === "intranet.test" ? "10.0.0.5" : "93.184.215.14", family: 4 }] });
    const { h, app } = await setup(strict);
    for (const [baseURL, code] of [
      ["http://169.254.169.254/v1", "network_blocked_by_policy.private_address"],
      ["http://[::1]:8080/v1", "network_blocked_by_policy.private_address"],
      ["https://intranet.test/v1", "network_blocked_by_policy.dns_rebinding"],
    ] as const) {
      const refused = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, baseURL } });
      expect(refused.statusCode, baseURL).toBe(422);
      expect(refused.json().error.code).toBe(code);
    }
    expect(h.db.prepare("SELECT count(*) AS n FROM provider_profile").get()).toEqual({ n: 0 });
    const created = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, baseURL: "https://relay.test/v1" } });
    expect(created.statusCode).toBe(201);
    const patched = await app.inject({ method: "PATCH", url: `/api/providers/${created.json().id}`, headers: auth, payload: { baseURL: "http://10.0.0.5/v1" } });
    expect(patched.json().error.code).toBe("network_blocked_by_policy.private_address");
    expect((h.db.prepare("SELECT base_url FROM provider_profile").get() as { base_url: string }).base_url).toBe("https://relay.test/v1");
  });

  it("creates, lists, configures and deletes a profile without ever returning the key", async () => {
    const { app, lines } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/providers", headers: auth })).json()).toEqual({ items: [] });
    const created = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: profileBody });
    expect(created.statusCode).toBe(201);
    const profile = created.json();
    expect(profile).toMatchObject({ name: "relay", baseURL: "https://llm.invalid", credentialStatus: "missing", hasCredential: false });
    expect(profile.models[0].limits.userOverride).toEqual({ contextWindowTokens: 200_000 });

    const credential = await app.inject({ method: "PUT", url: `/api/providers/${profile.id}/credential`, headers: auth, payload: { value: KEY } });
    expect(credential.statusCode).toBe(200);
    expect(credential.json()).toMatchObject({ credentialStatus: "configured", hasCredential: true });
    const listed = await app.inject({ method: "GET", url: "/api/providers", headers: auth });
    expect(listed.json().items).toHaveLength(1);
    for (const text of [credential.body, listed.body, ...lines]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("credentialRef");
    }
    expect((await app.inject({ method: "GET", url: "/api/providers", headers: bob })).json()).toEqual({ items: [] });
    expect((await app.inject({ method: "DELETE", url: `/api/providers/${profile.id}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/providers/${profile.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/providers/${profile.id}`, headers: auth })).statusCode).toBe(404);
  });

  it("validates bodies: limits are optional, unknown fields, unknown presets and bad URLs are refused", async () => {
    const { app } = await setup();
    const noWindow = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, models: [{ modelId: "m" }, { modelId: "n", contextWindowTokens: null }] } });
    expect(noWindow.statusCode).toBe(201);
    expect(noWindow.json().models.map((model: { limits: unknown }) => model.limits)).toEqual([{ declared: {} }, { declared: {} }]);
    const extra = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, apiKey: KEY } });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain(KEY);
    const extraInCredential = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, credential: { value: KEY, note: 1 } } });
    expect(extraInCredential.statusCode).toBe(400);
    expect(extraInCredential.body).not.toContain(KEY);
    const emptyKey = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, credential: { value: "" } } });
    expect(emptyKey.statusCode).toBe(400);
    const unknownPreset = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, presetId: "acme" } });
    expect(unknownPreset.statusCode).toBe(400);
    const ftp = await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, baseURL: "ftp://llm.invalid" } });
    expect(ftp.json().error.code).toBe("invalid_request");
    const badKey = await app.inject({ method: "PUT", url: "/api/providers/x/credential", headers: auth, payload: { value: KEY, extra: 1 } });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.body).not.toContain(KEY);
  });

  it("creates a profile with its preset and key at once, and replays a keyed create", async () => {
    const { h, app, lines } = await setup();
    const request = { method: "POST" as const, url: "/api/providers", headers: { ...auth, "idempotency-key": "create-1" }, payload: { ...profileBody, presetId: "anthropic", credential: { value: KEY } } };
    const created = await app.inject(request);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ presetId: "anthropic", credentialStatus: "configured", hasCredential: true });
    const again = await app.inject(request);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(created.json());
    expect(h.db.prepare("SELECT count(*) AS n FROM provider_profile").get()).toEqual({ n: 1 });
    expect(h.db.prepare("SELECT count(*) AS n FROM secret").get()).toEqual({ n: 1 });
    const conflicting = await app.inject({ ...request, payload: { ...request.payload, name: "other" } });
    expect(conflicting.statusCode).toBe(409);
    for (const text of [created.body, again.body, conflicting.body, JSON.stringify(h.db.prepare("SELECT * FROM idempotency_record").all()), ...lines]) {
      expect(text).not.toContain(KEY);
    }
    const cleared = await app.inject({ method: "PATCH", url: `/api/providers/${created.json().id}`, headers: auth, payload: { presetId: null } });
    expect(cleared.json()).not.toHaveProperty("presetId");
  });

  it("probes and overrides a model addressed by its encoded id, and replays a keyed probe", async () => {
    const { app, probes } = await setup();
    const profile = (await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: profileBody })).json();
    const probeRequest = { method: "POST" as const, url: `/api/providers/${profile.id}/probe`, headers: { ...auth, "idempotency-key": "probe-1" }, payload: { modelId: "vendor/model a" } };
    const probed = await app.inject(probeRequest);
    expect(probed.statusCode).toBe(200);
    expect(probed.json()).toMatchObject({
      modelId: "vendor/model a",
      basic: { status: "connected", latencyMs: 5 },
      checks: [
        { flag: "stream", result: "supported" },
        { flag: "structuredOutput", result: "supported" },
        { flag: "tools", result: "unsupported" },
      ],
      observed: { stream: "supported", structuredOutput: "supported", tools: "unsupported" },
    });
    expect((await app.inject(probeRequest)).json()).toEqual(probed.json());
    expect(probes).toEqual(["vendor/model a"]);
    const missing = await app.inject({ ...probeRequest, headers: auth, payload: { modelId: "other" } });
    expect(missing.statusCode).toBe(404);

    const url = `/api/providers/${profile.id}/models/${encodeURIComponent("vendor/model a")}/override`;
    const overridden = await app.inject({ method: "PUT", url, headers: auth, payload: { flags: { tools: "supported", stream: null } } });
    expect(overridden.statusCode).toBe(200);
    expect(overridden.json().models[0].effective.flags).toMatchObject({ stream: "supported", structuredOutput: "supported", tools: "supported" });
    expect((await app.inject({ method: "PUT", url, headers: auth, payload: { flags: { tools: "maybe" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url, headers: bob, payload: {} })).statusCode).toBe(404);
  });

  it("puts the profiles in the given order and refuses an incomplete one", async () => {
    const { app } = await setup();
    const one = (await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: profileBody })).json() as { id: string };
    const two = (await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: { ...profileBody, name: "two" } })).json() as { id: string };
    const put = (payload: unknown) => app.inject({ method: "PUT", url: "/api/providers/order", headers: auth, payload: payload as Record<string, unknown> });
    const ordered = await put({ profileIds: [two.id, one.id] });
    expect(ordered.statusCode).toBe(200);
    expect((ordered.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([two.id, one.id]);
    const listed = await app.inject({ method: "GET", url: "/api/providers", headers: auth });
    expect((listed.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([two.id, one.id]);
    for (const payload of [{ profileIds: [one.id] }, { profileIds: [] }, { profileIds: [one.id, two.id], extra: 1 }, {}]) {
      expect((await put(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("refuses with 409 to drop a model an unfinished Task uses", async () => {
    const { h, app } = await setup();
    const profile = (await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: profileBody })).json();
    createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: profile.id, modelId: "vendor/model a" }, autoProofread: false });
    const patch = await app.inject({ method: "PATCH", url: `/api/providers/${profile.id}`, headers: auth, payload: { models: [{ modelId: "m2", contextWindowTokens: 1 }] } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe("conflict");
    expect((await app.inject({ method: "DELETE", url: `/api/providers/${profile.id}`, headers: auth })).statusCode).toBe(409);
    const renamed = await app.inject({ method: "PATCH", url: `/api/providers/${profile.id}`, headers: auth, payload: { name: "renamed" } });
    expect(renamed.json().name).toBe("renamed");
    const moved = await app.inject({ method: "PATCH", url: `/api/providers/${profile.id}`, headers: auth, payload: { baseURL: "https://moved.invalid" } });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error).toMatchObject({ code: "conflict.profile_tasks_unfinished", details: { taskCount: 1 } });
  });

  it("prices a model addressed in the body, keeps the price through list edits and while bound, and isolates users", async () => {
    const { h, app } = await setup();
    const profile = (await app.inject({ method: "POST", url: "/api/providers", headers: auth, payload: profileBody })).json() as { id: string };
    const pricing = { currency: "USD", items: [{ unit: "input_tokens_per_million", amount: "3" }, { unit: "output_tokens_per_million", amount: "15" }, { unit: "cached_input_tokens_per_million", amount: "0.3" }] };
    const put = (payload: object, headers = auth) => app.inject({ method: "PUT", url: `/api/providers/${profile.id}/model-pricing`, headers, payload });
    const priced = await put({ modelId: "vendor/model a", pricing });
    expect(priced.statusCode).toBe(200);
    expect(priced.json().models[0].pricing).toEqual(pricing);
    createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: profile.id, modelId: "vendor/model a" }, autoProofread: false });
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/providers/${profile.id}`,
      headers: auth,
      payload: { models: [{ modelId: "m2", contextWindowTokens: 1 }, { modelId: "vendor/model a", contextWindowTokens: 2 }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().models.map((model: { pricing?: unknown }) => model.pricing)).toEqual([undefined, pricing]);
    expect((await put({ modelId: "vendor/model a", pricing: { currency: "CNY", items: [{ unit: "per_request", amount: "0.1" }] } })).statusCode).toBe(200);
    for (const wrong of [
      { modelId: "vendor/model a", pricing: { currency: "CNY", items: [{ unit: "audio_per_hour", amount: "1" }] } },
      { modelId: "vendor/model a", pricing: { currency: "CNY", items: [{ unit: "per_request", amount: ".5" }] } },
      { modelId: "vendor/model a" },
      { modelId: "", pricing: null },
    ]) {
      expect((await put(wrong)).statusCode, JSON.stringify(wrong)).toBe(400);
    }
    expect((await put({ modelId: "absent", pricing: null })).statusCode).toBe(404);
    expect((await put({ modelId: "vendor/model a", pricing: null }, bob)).statusCode).toBe(404);
    const listed = (await app.inject({ method: "GET", url: "/api/providers", headers: auth })).json() as { items: Array<{ models: Array<{ pricing?: unknown }> }> };
    expect(listed.items[0]?.models[1]?.pricing).toEqual({ currency: "CNY", items: [{ unit: "per_request", amount: "0.1" }] });
  });
});

