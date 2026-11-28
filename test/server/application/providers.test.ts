import { afterEach, describe, expect, it } from "vitest";
import type { LlmProbeOutcome } from "../../../src/server/application/llm-gateway.ts";
import { ProviderService, type ModelProber } from "../../../src/server/application/providers.ts";

import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import type { ProviderProfile } from "../../../src/server/domain/provider-profile.ts";
import { amberError, isAmberError, type AmberError } from "../../../src/server/domain/errors.ts";
import { probeResultDtoSchema } from "../../../src/shared/dto/provider.ts";
import { FakeLlmProvider } from "../../fixtures/llm/fake-llm.ts";
import { BOB, createHarness, createTaskOfKind, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const KEY = "test-key-<placeholder-llm>";
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

type Verdict = "supported" | "unsupported" | "inconclusive";

/**
 * Scripted "test connection": takes its basis from the profile as it stands when called, like
 * the gateway, then runs `during` (an edit made while the upstream answers) and returns the
 * scripted verdicts or throws.
 */
class FakeProber implements ModelProber {
  calls: ModelRef[] = [];
  outcome: Error | { basic?: "connected" | "incomplete"; route?: "direct" | "proxy"; stream: Verdict; structuredOutput: Verdict; tools: Verdict } = {
    stream: "supported",
    structuredOutput: "unsupported",
    tools: "supported",
  };
  during: (() => void) | undefined;
  private readonly h: Harness;

  constructor(h: Harness) {
    this.h = h;
  }

  async probe(userId: string, modelRef: ModelRef): Promise<LlmProbeOutcome> {
    this.calls.push(modelRef);
    const basis = this.h.repository.withTransaction((scope) => {
      const profile = scope.providerProfiles.get(userId, modelRef.providerProfileId) as ProviderProfile;
      const ref = profile.credentialRef;
      return {
        protocol: profile.protocol,
        baseURL: profile.baseURL,
        credentialVersion: ref === undefined ? undefined : scope.secretEnvelopes.get(userId, ref)?.versionId,
        modelId: modelRef.modelId,
      };
    });
    this.during?.();
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    const outcome = this.outcome;
    const flags = ["stream", "structuredOutput", "tools"] as const;
    return {
      basic: { status: outcome.basic ?? "connected", latencyMs: 12, ...(outcome.route === undefined ? {} : { route: outcome.route }) },
      checks: flags.map((flag) => (outcome[flag] === "inconclusive" ? { flag, result: "inconclusive", reason: "truncated" } : { flag, result: outcome[flag] })),
      basis,
    };
  }
}

function setup(options: { newId?: () => string } = {}) {
  const h = createHarness();
  open.push(h);
  const prober = new FakeProber(h);
  let clock = 1_000;
  const changed: Array<[string, readonly string[] | undefined]> = [];
  const service = new ProviderService({
    repository: h.repository,
    secrets: h.secrets,
    prober,
    newId: options.newId ?? h.newId,
    now: () => (clock += 1),
    onChanged: (profileId, modelIds) => changed.push([profileId, modelIds]),
  });
  return { h, prober, service, changed };
}

const signal = new AbortController().signal;

function create(service: ProviderService) {
  return service.create(LOCAL, {
    name: "relay",
    protocol: "openai_compatible",
    baseURL: " https://llm.invalid/v1/ ",
    models: [
      { modelId: "model-a", contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
      { modelId: "model-b", contextWindowTokens: 64_000 },
    ],
  });
}

function code(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

async function asyncCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

describe("ProviderService", () => {
  it("creates profiles with all-unknown declared flags and the stated limits as a user override", () => {
    const { service } = setup();
    const created = create(service);
    expect(created).toMatchObject({ name: "relay", protocol: "openai_compatible", baseURL: "https://llm.invalid/v1", credentialStatus: "missing", hasCredential: false });
    expect(created.models.map((model) => model.modelId)).toEqual(["model-a", "model-b"]);
    const [a, b] = created.models;
    expect(a?.flags).toEqual({ declared: { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" } });
    expect(a?.limits).toEqual({ declared: {}, userOverride: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 } });
    expect(b?.limits.userOverride).toEqual({ contextWindowTokens: 64_000 });
    expect(a?.effective.limits).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 4_096 });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([created.id]);
    expect(service.list(BOB).items).toEqual([]);
  });

  it("rejects duplicate model ids and non-http base URLs", () => {
    const { service } = setup();
    const duplicate = () =>
      service.create(LOCAL, {
        name: "relay",
        protocol: "anthropic_messages",
        baseURL: "https://llm.invalid",
        models: [
          { modelId: "m", contextWindowTokens: 1 },
          { modelId: "m", contextWindowTokens: 2 },
        ],
      });
    expect(code(duplicate)).toBe("invalid_request");
    expect(code(() => service.create(LOCAL, { name: "x", protocol: "anthropic_messages", baseURL: "ftp://llm.invalid", models: [] }))).toBe("invalid_request");
    expect(code(() => service.create(LOCAL, { name: "x", protocol: "anthropic_messages", baseURL: "https://u:p@llm.invalid", models: [] }))).toBe("invalid_request");
  });

  it("stores the key as one Secret, replaces it in place and never returns it", () => {
    const { h, service } = setup();
    const created = create(service);
    const configured = service.putCredential(LOCAL, created.id, KEY);
    expect(configured).toMatchObject({ credentialStatus: "configured", hasCredential: true });
    const ref = h.repository.withTransaction((scope) => scope.providerProfiles.get(LOCAL.userId, created.id)?.credentialRef) as string;
    service.putCredential(LOCAL, created.id, `${KEY}-2`);
    expect(countRows(h.db, "secret")).toBe(1);
    expect(h.secrets.reveal(LOCAL.userId, ref)).toBe(`${KEY}-2`);
    expect(JSON.stringify([configured, service.list(LOCAL)])).not.toContain(KEY);
    expect(JSON.stringify(service.list(LOCAL))).not.toContain(ref);
    expect(code(() => service.putCredential(BOB, created.id, KEY))).toBe("not_found");
  });

  it("replaces the model list, keeping measured and overridden layers of kept models", async () => {
    const { service } = setup();
    const created = create(service);
    await service.probe(LOCAL, created.id, "model-a", signal);
    service.putOverride(LOCAL, created.id, "model-a", { flags: { vision: "supported" } });
    const updated = service.update(LOCAL, created.id, {
      name: "renamed",
      models: [
        { modelId: "model-c", contextWindowTokens: 8_000 },
        { modelId: "model-a", contextWindowTokens: 200_000 },
      ],
    });
    expect(updated).toMatchObject({ name: "renamed", baseURL: "https://llm.invalid/v1" });
    expect(updated.models.map((model) => model.modelId)).toEqual(["model-c", "model-a"]);
    const a = updated.models[1];
    expect(a?.flags.observed).toEqual({ stream: "supported", structuredOutput: "unsupported", tools: "supported" });
    expect(a?.flags.userOverride).toEqual({ vision: "supported" });
    // A restated limit replaces the stored one; an omitted one is kept.
    expect(a?.limits.userOverride).toEqual({ contextWindowTokens: 200_000, maxOutputTokens: 4_096 });
    expect(code(() => service.update(BOB, created.id, { name: "x" }))).toBe("not_found");
  });

  it("keeps a kept model's limits when they are omitted, replaces them when given and clears them with null", () => {
    const { service } = setup();
    const created = create(service);
    const limitsOf = (dto: { models: Array<{ modelId: string; limits: { userOverride?: unknown } }> }, modelId: string) =>
      dto.models.find((model) => model.modelId === modelId)?.limits.userOverride;
    // Renaming alone touches no window.
    const renamed = service.update(LOCAL, created.id, { name: "renamed" });
    expect(limitsOf(renamed, "model-a")).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 4_096 });
    const omitted = service.update(LOCAL, created.id, { models: [{ modelId: "model-a" }, { modelId: "model-b" }] });
    expect(limitsOf(omitted, "model-a")).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 4_096 });
    expect(limitsOf(omitted, "model-b")).toEqual({ contextWindowTokens: 64_000 });
    const replaced = service.update(LOCAL, created.id, { models: [{ modelId: "model-a", contextWindowTokens: 256_000 }, { modelId: "model-b", maxOutputTokens: 1_000 }] });
    expect(limitsOf(replaced, "model-a")).toEqual({ contextWindowTokens: 256_000, maxOutputTokens: 4_096 });
    expect(limitsOf(replaced, "model-b")).toEqual({ contextWindowTokens: 64_000, maxOutputTokens: 1_000 });
    const cleared = service.update(LOCAL, created.id, { models: [{ modelId: "model-a", maxOutputTokens: null }, { modelId: "model-b", contextWindowTokens: null, maxOutputTokens: null }] });
    expect(limitsOf(cleared, "model-a")).toEqual({ contextWindowTokens: 256_000 });
    expect(limitsOf(cleared, "model-b")).toBeUndefined();
    expect(cleared.models[1]?.effective.limits).toEqual({});
    // A new model takes what was stated, and a null equals nothing.
    const added = service.update(LOCAL, created.id, { models: [{ modelId: "model-a" }, { modelId: "model-n", contextWindowTokens: null }] });
    expect(added.models[1]?.limits).toEqual({ declared: {} });
  });

  it("reorders the user's profiles, listing each exactly once, and refuses anything else", () => {
    const { service } = setup();
    const first = create(service);
    const second = service.create(LOCAL, { name: "second", protocol: "openai_compatible", baseURL: "https://two.invalid", models: [{ modelId: "m", contextWindowTokens: 1_000 }] });
    expect(service.list(LOCAL).items.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(service.reorder(LOCAL, [second.id, first.id]).items.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(service.list(LOCAL).items.map((p) => p.id)).toEqual([second.id, first.id]);
    for (const ids of [[second.id], [second.id, first.id, first.id], [second.id, first.id, "elsewhere"]]) {
      expect(code(() => service.reorder(LOCAL, ids)), JSON.stringify(ids)).toBe("invalid_request");
    }
    // Another user names profiles that are not theirs.
    expect(code(() => service.reorder(BOB, [first.id, second.id]))).toBe("invalid_request");
    expect(service.list(LOCAL).items.map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("keeps every capability layer when the model list is only reordered", async () => {
    const { service } = setup();
    const created = create(service);
    await service.probe(LOCAL, created.id, "model-a", signal);
    service.putOverride(LOCAL, created.id, "model-a", { flags: { vision: "supported" } });
    const before = service.get(LOCAL, created.id).models;
    const reordered = service.update(LOCAL, created.id, {
      models: [...before].reverse().map((model) => ({
        modelId: model.modelId,
        contextWindowTokens: model.effective.limits.contextWindowTokens as number,
        ...(model.effective.limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.effective.limits.maxOutputTokens }),
      })),
    });
    expect(reordered.models.map((model) => model.modelId)).toEqual(["model-b", "model-a"]);
    expect(reordered.models.find((model) => model.modelId === "model-a")).toEqual(before.find((model) => model.modelId === "model-a"));
    expect(reordered.models.find((model) => model.modelId === "model-b")).toEqual(before.find((model) => model.modelId === "model-b"));
  });

  it("refuses to remove a model or delete a profile still used by an unfinished Task", () => {
    const { h, service } = setup();
    const created = create(service);
    const taskId = createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: created.id, modelId: "model-a" }, autoProofread: false });
    const keepOnlyB = () => service.update(LOCAL, created.id, { models: [{ modelId: "model-b", contextWindowTokens: 1 }] });
    expect(code(keepOnlyB)).toBe("conflict");
    // Removing the model nobody uses is fine.
    expect(code(() => service.update(LOCAL, created.id, { models: [{ modelId: "model-a", contextWindowTokens: 1 }] }))).toBeUndefined();
    expect(code(() => service.delete(LOCAL, created.id))).toBe("conflict");

    h.tasks.cancel(LOCAL, taskId);
    service.delete(LOCAL, created.id);
    expect(service.list(LOCAL).items).toEqual([]);
    expect(code(() => service.delete(LOCAL, created.id))).toBe("not_found");
  });

  it("counts a model frozen into a stage input as a reference", () => {
    const { h, service } = setup();
    const created = create(service);
    const taskId = createTaskOfKind(h, "process_content", { autoProofread: false });
    h.db.prepare("UPDATE stage_run SET input_json = ? WHERE task_id = ? AND stage = 'summary'").run(
      JSON.stringify({ modelRef: { providerProfileId: created.id, modelId: "model-b" } }),
      taskId,
    );
    expect(code(() => service.update(LOCAL, created.id, { models: [{ modelId: "model-a", contextWindowTokens: 1 }] }))).toBe("conflict");
    expect(code(() => service.delete(LOCAL, created.id))).toBe("conflict");
  });

  it("deletes the profile's Secret with it", () => {
    const { h, service } = setup();
    const created = create(service);
    service.putCredential(LOCAL, created.id, KEY);
    expect(code(() => service.delete(BOB, created.id))).toBe("not_found");
    service.delete(LOCAL, created.id);
    expect(countRows(h.db, "secret")).toBe(0);
  });

  it("writes probe results as observed flags only when the probe succeeds", async () => {
    const { prober, service } = setup();
    const created = create(service);
    prober.outcome = amberError("llm_failed", "refused", { code: "llm_failed.auth" });
    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-a", signal))).toBe("llm_failed.auth");
    expect(service.get(LOCAL, created.id).models[0]?.flags.observed).toBeUndefined();

    prober.outcome = { stream: "supported", structuredOutput: "unsupported", tools: "supported" };
    const result = await service.probe(LOCAL, created.id, "model-a", signal);
    expect(result.body).toEqual({
      modelId: "model-a",
      basic: { status: "connected", latencyMs: 12 },
      checks: [
        { flag: "stream", result: "supported" },
        { flag: "structuredOutput", result: "unsupported" },
        { flag: "tools", result: "supported" },
      ],
      observed: { stream: "supported", structuredOutput: "unsupported", tools: "supported" },
      observedAt: result.body.observedAt,
      route: "direct",
    });
    expect(probeResultDtoSchema.parse(result.body)).toEqual(result.body);
    const model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.observed).toEqual({ stream: "supported", structuredOutput: "unsupported", tools: "supported" });
    expect(model?.observedAt).toBe(result.body.observedAt);

    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-x", signal))).toBe("not_found");
    expect(await asyncCode(() => service.probe(BOB, created.id, "model-a", signal))).toBe("not_found");
    expect(prober.calls).toHaveLength(2);
  });

  it("tells which path the test request took, as the outbound response reported it", async () => {
    const { prober, service } = setup();
    const created = create(service);
    prober.outcome = { route: "proxy", stream: "supported", structuredOutput: "supported", tools: "supported" };
    expect((await service.probe(LOCAL, created.id, "model-a", signal)).body.route).toBe("proxy");
    prober.outcome = { route: "direct", stream: "supported", structuredOutput: "supported", tools: "supported" };
    expect((await service.probe(LOCAL, created.id, "model-a", signal)).body.route).toBe("direct");
  });

  it("clears the observed flag of an inconclusive check, so lower layers show through again", async () => {
    const { prober, service } = setup();
    const created = create(service);
    await service.probe(LOCAL, created.id, "model-a", signal);
    prober.outcome = { basic: "incomplete", stream: "supported", structuredOutput: "inconclusive", tools: "inconclusive" };
    const result = await service.probe(LOCAL, created.id, "model-a", signal);
    expect(result.body.basic.status).toBe("incomplete");
    expect(result.body.checks[1]).toEqual({ flag: "structuredOutput", result: "inconclusive", reason: "truncated" });
    expect(result.body.observed).toEqual({ stream: "supported" });
    const model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.observed).toEqual({ stream: "supported" });
    expect(model?.effective.flags).toMatchObject({ stream: "supported", structuredOutput: "unknown", tools: "unknown" });
    expect(model?.observedAt).toBe(result.body.observedAt);

    prober.outcome = { stream: "inconclusive", structuredOutput: "inconclusive", tools: "inconclusive" };
    const none = await service.probe(LOCAL, created.id, "model-a", signal);
    expect(none.body.observed).toEqual({});
    expect(service.get(LOCAL, created.id).models[0]?.flags).not.toHaveProperty("observed");
  });

  it("discards the results when the endpoint, the key or the model changed while testing", async () => {
    const { h, prober, service } = setup();
    const created = create(service);
    service.putCredential(LOCAL, created.id, KEY);
    const edits: Array<[string, () => void]> = [
      ["endpoint", () => void service.update(LOCAL, created.id, { baseURL: "https://moved.invalid/v1" })],
      ["key", () => void service.putCredential(LOCAL, created.id, `${KEY}-new`)],
      ["model", () => void service.update(LOCAL, created.id, { models: [{ modelId: "model-b" }] })],
    ];
    for (const [what, edit] of edits) {
      prober.during = edit;
      expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-a", signal, `probe-${what}`)), what).toBe("conflict.probe_config_changed");
      prober.during = undefined;
      expect(service.get(LOCAL, created.id).models.every((model) => model.flags.observed === undefined && model.observedAt === undefined), what).toBe(true);
    }
    // A discarded result is no answer to replay: the same key tests again.
    service.update(LOCAL, created.id, { models: [{ modelId: "model-a" }, { modelId: "model-b" }] });
    expect((await service.probe(LOCAL, created.id, "model-a", signal, "probe-endpoint")).replayed).toBe(false);
    expect(countRows(h.db, "idempotency_record")).toBe(1);

    // Re-entering the same key keeps its version: nothing changed that the results depend on.
    prober.during = () => void service.putCredential(LOCAL, created.id, `${KEY}-new`);
    expect((await service.probe(LOCAL, created.id, "model-b", signal)).body.observed).toEqual({ stream: "supported", structuredOutput: "unsupported", tools: "supported" });
  });

  it("replays a probe under the same Idempotency-Key without probing again", async () => {
    const { prober, service } = setup();
    const created = create(service);
    const first = await service.probe(LOCAL, created.id, "model-a", signal, "probe-key-1");
    const again = await service.probe(LOCAL, created.id, "model-a", signal, "probe-key-1");
    expect(again).toEqual({ ...first, replayed: true });
    expect(prober.calls).toHaveLength(1);
    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-b", signal, "probe-key-1"))).toBe("idempotency_conflict");
  });

  it("takes effective capabilities field by field: override > observed > declared", async () => {
    const { service } = setup();
    const created = create(service);
    expect(service.get(LOCAL, created.id).models[0]?.effective.flags.stream).toBe("unknown");
    await service.probe(LOCAL, created.id, "model-a", signal);
    let model = service.get(LOCAL, created.id).models[0];
    expect(model?.effective.flags).toMatchObject({ stream: "supported", structuredOutput: "unsupported", tools: "supported", vision: "unknown" });

    service.putOverride(LOCAL, created.id, "model-a", { flags: { structuredOutput: "supported", audioInput: "unsupported" }, limits: { maxOutputTokens: 1_000 } });
    model = service.get(LOCAL, created.id).models[0];
    expect(model?.effective.flags).toMatchObject({ stream: "supported", structuredOutput: "supported", tools: "supported", audioInput: "unsupported" });
    // Replacing only the flags layer leaves the limits override; null clears one field.
    expect(model?.limits.userOverride).toEqual({ maxOutputTokens: 1_000 });
    expect(model?.effective.limits).toEqual({ maxOutputTokens: 1_000 });

    service.putOverride(LOCAL, created.id, "model-a", { flags: { structuredOutput: null, audioInput: "unsupported" } });
    model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.userOverride).toEqual({ audioInput: "unsupported" });
    expect(model?.effective.flags.structuredOutput).toBe("unsupported");

    service.putOverride(LOCAL, created.id, "model-a", { flags: {}, limits: { maxOutputTokens: null } });
    model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.userOverride).toBeUndefined();
    expect(model?.limits.userOverride).toBeUndefined();
    expect(model?.effective.flags).toMatchObject({ structuredOutput: "unsupported", audioInput: "unknown" });

    expect(code(() => service.putOverride(LOCAL, created.id, "model-x", {}))).toBe("not_found");
    expect(code(() => service.putOverride(BOB, created.id, "model-a", {}))).toBe("not_found");
  });

  it("sets and clears a model's price, keeps it through model-list replacement and while the model is bound", () => {
    const { h, service } = setup();
    const created = create(service);
    const pricing = { currency: "CNY" as const, items: [{ unit: "input_tokens_per_million" as const, amount: "0.8" }, { unit: "output_tokens_per_million" as const, amount: "2.7" }], note: "free quota first" };
    const priced = service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing });
    expect(priced.models.find((model) => model.modelId === "model-a")?.pricing).toEqual(pricing);
    expect(priced.models.find((model) => model.modelId === "model-b")).not.toHaveProperty("pricing");
    // The price stays out of the capability layers.
    expect(priced.models.find((model) => model.modelId === "model-a")?.effective).toEqual(created.models.find((model) => model.modelId === "model-a")?.effective);
    const replaced = service.update(LOCAL, created.id, { models: [{ modelId: "model-b", contextWindowTokens: 1 }, { modelId: "model-a", contextWindowTokens: 2 }] });
    expect(replaced.models.find((model) => model.modelId === "model-a")?.pricing).toEqual(pricing);
    expect(service.list(LOCAL).items[0]?.models.find((model) => model.modelId === "model-a")?.pricing).toEqual(pricing);

    createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: created.id, modelId: "model-a" }, autoProofread: false });
    const perRequest = { currency: "USD" as const, items: [{ unit: "per_request" as const, amount: "0.01" }] };
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing: perRequest }).models.find((model) => model.modelId === "model-a")?.pricing).toEqual(perRequest);
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing: null }).models.find((model) => model.modelId === "model-a")).not.toHaveProperty("pricing");

    // Audio and image units belong to other sections.
    for (const unit of ["audio_per_second", "per_image"] as const) {
      expect(code(() => service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing: { currency: "CNY", items: [{ unit, amount: "1" }] } }))).toBe("invalid_request");
    }
    expect(code(() => service.setModelPricing(LOCAL, created.id, { modelId: "model-x", pricing: null }))).toBe("not_found");
    expect(code(() => service.setModelPricing(BOB, created.id, { modelId: "model-a", pricing: perRequest }))).toBe("not_found");
    expect(service.get(LOCAL, created.id).models.find((model) => model.modelId === "model-a")).not.toHaveProperty("pricing");
  });
});

describe("ProviderService create", () => {
  const request = { name: "Kimi", protocol: "openai_compatible" as const, baseURL: "https://api.moonshot.cn/v1", presetId: "kimi" as const, models: [{ modelId: "kimi-model" }] };
  const records = (h: Harness) => h.db.prepare("SELECT * FROM idempotency_record").all() as Array<Record<string, unknown>>;

  it("stores the profile and its key in one go, with the preset, and without limits when none were stated", () => {
    const { h, service } = setup();
    const created = service.create(LOCAL, { ...request, credential: { value: KEY } });
    expect(created).toMatchObject({ name: "Kimi", presetId: "kimi", credentialStatus: "configured", hasCredential: true });
    expect(created.models[0]?.limits).toEqual({ declared: {} });
    expect(countRows(h.db, "secret")).toBe(1);
    const ref = h.repository.withTransaction((scope) => scope.providerProfiles.get(LOCAL.userId, created.id)?.credentialRef) as string;
    expect(h.secrets.reveal(LOCAL.userId, ref)).toBe(KEY);
    expect(JSON.stringify(created)).not.toContain(KEY);
    expect(service.get(LOCAL, created.id).presetId).toBe("kimi");

    const keyless = service.create(LOCAL, { ...request, presetId: undefined as never, models: [{ modelId: "m", contextWindowTokens: null, maxOutputTokens: null }] });
    expect(keyless).toMatchObject({ credentialStatus: "missing", hasCredential: false });
    expect(keyless).not.toHaveProperty("presetId");
    expect(keyless.models[0]?.limits).toEqual({ declared: {} });
    expect(countRows(h.db, "secret")).toBe(1);
  });

  it("leaves no key behind when the profile cannot be written", () => {
    const { h, service } = setup({ newId: () => "same-id" });
    service.create(LOCAL, request);
    expect(code(() => service.create(LOCAL, { ...request, credential: { value: KEY } }))).toMatch(/UNIQUE constraint/);
    expect(countRows(h.db, "secret")).toBe(0);
    expect(countRows(h.db, "provider_profile")).toBe(1);
  });

  it("replays a create under the same Idempotency-Key without creating again, and keeps the key out of the record", () => {
    const { h, service } = setup();
    const first = service.create(LOCAL, { ...request, credential: { value: KEY } }, "create-1");
    const again = service.create(LOCAL, { ...request, credential: { value: KEY } }, "create-1");
    expect(again).toEqual(first);
    expect(countRows(h.db, "provider_profile")).toBe(1);
    expect(countRows(h.db, "secret")).toBe(1);
    expect(records(h)).toHaveLength(1);
    expect(JSON.stringify(records(h))).not.toContain(KEY);

    // The digest says only that a key came along, so another key value is the same request.
    const otherKey = service.create(LOCAL, { ...request, credential: { value: `${KEY}-other` } }, "create-1");
    expect(otherKey).toEqual(first);
    const ref = h.repository.withTransaction((scope) => scope.providerProfiles.get(LOCAL.userId, first.id)?.credentialRef) as string;
    expect(h.secrets.reveal(LOCAL.userId, ref)).toBe(KEY);
    expect(countRows(h.db, "secret")).toBe(1);

    // Leaving the key out, or changing any other field, is a different request.
    expect(code(() => service.create(LOCAL, request, "create-1"))).toBe("idempotency_conflict");
    expect(code(() => service.create(LOCAL, { ...request, name: "other", credential: { value: KEY } }, "create-1"))).toBe("idempotency_conflict");
    // Without a key every request creates.
    service.create(LOCAL, request);
    service.create(LOCAL, request);
    expect(countRows(h.db, "provider_profile")).toBe(3);
  });

  it("rolls back the idempotency record with a failed create", () => {
    const { h, service } = setup({ newId: () => "same-id" });
    service.create(LOCAL, request);
    expect(code(() => service.create(LOCAL, { ...request, credential: { value: KEY } }, "create-2"))).toMatch(/UNIQUE constraint/);
    expect(records(h)).toHaveLength(0);
  });
});

describe("ProviderService edits that invalidate measurements", () => {
  async function probed() {
    const context = setup();
    const created = create(context.service);
    context.service.putCredential(LOCAL, created.id, KEY);
    await context.service.probe(LOCAL, created.id, "model-a", signal);
    await context.service.probe(LOCAL, created.id, "model-b", signal);
    context.changed.length = 0;
    return { ...context, created };
  }
  const measured = (service: ProviderService, profileId: string) =>
    service.get(LOCAL, profileId).models.map((model) => [model.modelId, model.flags.observed !== undefined, model.observedAt !== undefined]);

  it("sets, keeps and clears the preset on update", () => {
    const { h, service } = setup();
    const created = create(service);
    expect(created).not.toHaveProperty("presetId");
    expect(service.update(LOCAL, created.id, { presetId: "deepseek" }).presetId).toBe("deepseek");
    expect(service.update(LOCAL, created.id, { name: "renamed" }).presetId).toBe("deepseek");
    expect(service.update(LOCAL, created.id, { presetId: "qwen" }).presetId).toBe("qwen");
    expect(service.update(LOCAL, created.id, { presetId: null })).not.toHaveProperty("presetId");
    // "Custom" is no preset: choosing it clears one, and it is never stored.
    service.update(LOCAL, created.id, { presetId: "kimi" });
    expect(service.update(LOCAL, created.id, { presetId: "custom" })).not.toHaveProperty("presetId");
    const custom = service.create(LOCAL, { name: "mine", protocol: "openai_compatible", baseURL: "https://relay.invalid/v1", presetId: "custom", models: [] });
    expect(custom).not.toHaveProperty("presetId");
    expect(service.get(LOCAL, custom.id)).not.toHaveProperty("presetId");
    expect(countRows(h.db, "provider_profile", "preset_id IS NOT NULL")).toBe(0);
  });

  it("refuses a new Base URL while unfinished Tasks use the profile, telling how many", async () => {
    const { h, service, created } = await probed();
    createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: created.id, modelId: "model-a" }, autoProofread: false });
    const second = createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: created.id, modelId: "model-b" }, autoProofread: false });
    let thrown: unknown;
    try {
      service.update(LOCAL, created.id, { baseURL: "https://moved.invalid/v1" });
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && (thrown as AmberError).appError).toMatchObject({ code: "conflict.profile_tasks_unfinished", details: { taskCount: 2 } });
    expect(service.get(LOCAL, created.id).baseURL).toBe("https://llm.invalid/v1");
    // The same address, written differently, is no change; renaming and the key are not locked.
    expect(code(() => service.update(LOCAL, created.id, { baseURL: "https://llm.invalid/v1/", name: "renamed" }))).toBeUndefined();
    expect(code(() => service.putCredential(LOCAL, created.id, `${KEY}-2`))).toBeUndefined();
    h.tasks.cancel(LOCAL, second);
    expect(code(() => service.update(LOCAL, created.id, { baseURL: "https://moved.invalid/v1" }))).toBe("conflict.profile_tasks_unfinished");
  });

  it("drops every model's measurements in the same transaction as a new Base URL", async () => {
    const { service, created, changed } = await probed();
    service.putOverride(LOCAL, created.id, "model-a", { flags: { vision: "supported" } });
    expect(measured(service, created.id)).toEqual([["model-a", true, true], ["model-b", true, true]]);
    const moved = service.update(LOCAL, created.id, { baseURL: "https://moved.invalid/v1" });
    expect(moved.baseURL).toBe("https://moved.invalid/v1");
    expect(measured(service, created.id)).toEqual([["model-a", false, false], ["model-b", false, false]]);
    expect(moved.models[0]?.flags.userOverride).toEqual({ vision: "supported" });
    expect(changed).toEqual([[created.id, undefined]]);
  });

  it("drops every model's measurements when a new key starts a new version, and keeps them when the same key is entered again", async () => {
    const { service, created } = await probed();
    service.putCredential(LOCAL, created.id, KEY);
    expect(measured(service, created.id)).toEqual([["model-a", true, true], ["model-b", true, true]]);
    service.putCredential(LOCAL, created.id, `${KEY}-rotated`);
    expect(measured(service, created.id)).toEqual([["model-a", false, false], ["model-b", false, false]]);
  });

  it("works through the real gateway: the basis it records matches, and a key changed mid-test is caught", async () => {
    const fake = new FakeLlmProvider();
    const h = createHarness({ llmProviders: [fake] });
    open.push(h);
    const service = new ProviderService({ repository: h.repository, secrets: h.secrets, prober: h.llm, newId: h.newId });
    const created = create(service);
    service.putCredential(LOCAL, created.id, KEY);
    const result = await service.probe(LOCAL, created.id, "model-a", signal);
    expect(result.body.checks.map((check) => check.result)).toEqual(["supported", "supported", "supported"]);
    expect(service.get(LOCAL, created.id).models[0]?.flags.observed).toEqual({ stream: "supported", structuredOutput: "supported", tools: "supported" });

    const probe = fake.probe.bind(fake);
    fake.probe = (profile, modelId) =>
      probe(profile, modelId).map((check) =>
        check.kind === "tools"
          ? {
              ...check,
              run: (options) => {
                service.putCredential(LOCAL, created.id, `${KEY}-rotated`);
                return check.run(options);
              },
            }
          : check,
      );
    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-b", signal))).toBe("conflict.probe_config_changed");
    expect(service.get(LOCAL, created.id).models.every((model) => model.flags.observed === undefined)).toBe(true);
  });
});
