import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { randomBytes } from "node:crypto";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { AsrModelEntry, AsrProviderProfile, CapabilityFlags, ModelCapability, ProviderProfile } from "../../../../../src/server/domain/provider-profile.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("read-only profile repositories", () => {
  it("returns an owned provider profile with its models in position order, and nothing for another owner", () => {
    insertRow(db, "provider_profile", { id: "p", user_id: "alice", name: "relay", protocol: "openai_compatible", base_url: "https://llm.invalid/v1", created_at: T0 });
    const flags = { stream: "supported", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
    insertRow(db, "model_capability", { profile_id: "p", model_id: "b", position: 1, flags_declared_json: JSON.stringify(flags), limits_declared_json: "{}" });
    insertRow(db, "model_capability", {
      profile_id: "p", model_id: "a", position: 0, flags_declared_json: JSON.stringify(flags), flags_user_override_json: '{"tools":"supported"}',
      limits_declared_json: '{"contextWindowTokens":8000}', observed_at: 7,
    });
    const profile = repository.withTransaction((scope) => scope.providerProfiles.get("alice", "p"));
    expect(profile).toMatchObject({ id: "p", baseURL: "https://llm.invalid/v1", models: [{ modelId: "a", observedAt: 7 }, { modelId: "b" }] });
    expect(profile?.credentialRef).toBeUndefined();
    expect(profile?.models[0]?.flags.userOverride).toEqual({ tools: "supported" });
    expect(repository.withTransaction((scope) => scope.providerProfiles.get("bob", "p"))).toBeUndefined();
  });

  it("returns an owned ASR profile with its models in order, nothing for another owner, and lists the owner's profiles by position", () => {
    insertRow(db, "asr_provider_profile", { id: "b", user_id: "alice", name: "百炼", provider: "dashscope", models_json: '[{"modelId":"fun-asr"}]', created_at: T0 + 1, position: 1 });
    insertRow(db, "asr_provider_profile", { id: "a", user_id: "alice", name: "ElevenLabs", provider: "elevenlabs", models_json: '[{"modelId":"scribe_v2_medical"},{"modelId":"scribe_v3","family":"scribe","testedAt":5}]', created_at: T0 + 2, position: 0 });
    expect(repository.withTransaction((scope) => scope.asrProfiles.get("alice", "a"))).toEqual({
      id: "a", userId: "alice", name: "ElevenLabs", provider: "elevenlabs", models: [{ modelId: "scribe_v2_medical" }, { modelId: "scribe_v3", family: "scribe", testedAt: 5 }], createdAt: T0 + 2,
    });
    expect(repository.withTransaction((scope) => scope.asrProfiles.get("bob", "a"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.asrProfiles.list("alice")).map((profile) => profile.id)).toEqual(["a", "b"]);
    expect(repository.withTransaction((scope) => scope.asrProfiles.list("bob"))).toEqual([]);
  });
});

describe("ASR profile writes", () => {
  function secret(id: string, userId: string): void {
    insertRow(db, "secret", {
      id, user_id: userId, envelope_version: 1, kdf_salt: randomBytes(16), nonce: randomBytes(12), ciphertext: randomBytes(8), auth_tag: randomBytes(16), created_at: T0, updated_at: T0,
    });
  }
  const profile = (id: string, userId: string, extra: Partial<AsrProviderProfile> = {}): AsrProviderProfile => ({
    id, userId, name: id, provider: "elevenlabs", models: [{ modelId: "scribe_v2" }], createdAt: T0, ...extra,
  });

  it("keeps several profiles per user and rewrites one in place only for its owner", () => {
    secret("s-alice", "alice");
    repository.withTransaction((scope) => {
      scope.asrProfiles.insert(profile("a1", "alice"));
      scope.asrProfiles.insert(profile("a2", "alice", { provider: "dashscope", models: [{ modelId: "fun-asr" }, { modelId: "qwen-audio-3.1-asr-flash-filetrans" }], createdAt: T0 + 1 }));
    });
    const updated = profile("a1", "alice", { name: "renamed", models: [{ modelId: "scribe_v2_medical" }, { modelId: "scribe_v2" }], credentialRef: "s-alice", baseURL: "https://asr.invalid", providerConfig: { k: 1 } });
    expect(repository.withTransaction((scope) => scope.asrProfiles.update(updated))).toBe(true);
    expect(repository.withTransaction((scope) => scope.asrProfiles.get("alice", "a1"))).toEqual(updated);
    expect(repository.withTransaction((scope) => scope.asrProfiles.update(profile("a1", "bob")))).toBe(false);
    expect(repository.withTransaction((scope) => scope.asrProfiles.update(profile("missing", "alice")))).toBe(false);
    expect(countRows(db, "asr_provider_profile")).toBe(2);
  });

  it("round-trips model entries with family, price and test time, in the given order", () => {
    const models: AsrModelEntry[] = [
      { modelId: "scribe_v3", family: "scribe", pricing: { currency: "USD", items: [{ unit: "audio_per_hour", amount: "0.22" }], note: "billed per minute" }, testedAt: T0 + 3 },
      { modelId: "scribe_v2" },
      { modelId: "org/model:2", family: "scribe_v2", pricing: { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "0.8" }, { unit: "output_tokens_per_million", amount: "2.7" }] } },
    ];
    repository.withTransaction((scope) => scope.asrProfiles.insert(profile("a1", "alice", { models })));
    expect(repository.withTransaction((scope) => scope.asrProfiles.get("alice", "a1"))?.models).toEqual(models);
    const reordered = [models[2], models[0]] as AsrModelEntry[];
    repository.withTransaction((scope) => scope.asrProfiles.update(profile("a1", "alice", { models: reordered })));
    expect(repository.withTransaction((scope) => scope.asrProfiles.get("alice", "a1"))?.models).toEqual(reordered);
  });

  it("reads one ASR model's current price on its own, scoped to the owner", () => {
    const models: AsrModelEntry[] = [{ modelId: "plain" }, { modelId: "priced", pricing: { currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.00022" }] } }];
    repository.withTransaction((scope) => scope.asrProfiles.insert(profile("a1", "alice", { models })));
    const price = (owner: string, profileId: string, modelId: string) => repository.withTransaction((scope) => scope.asrProfiles.getModelPricing(owner, profileId, modelId));
    expect(price("alice", "a1", "priced")).toEqual(models[1]?.pricing);
    expect(price("alice", "a1", "plain")).toBeUndefined();
    expect(price("alice", "a1", "unknown")).toBeUndefined();
    expect(price("bob", "a1", "priced")).toBeUndefined();
  });

  it("refuses another user's secret as the credential", () => {
    secret("s-bob", "bob");
    expect(() => repository.withTransaction((scope) => scope.asrProfiles.insert(profile("a1", "alice", { credentialRef: "s-bob" })))).toThrow(/FOREIGN KEY/);
  });

  it("puts a new profile last and renumbers the owner's profiles in the given order", () => {
    repository.withTransaction((scope) => {
      scope.asrProfiles.insert(profile("a1", "alice"));
      scope.asrProfiles.insert(profile("a2", "alice", { createdAt: T0 - 5 }));
      scope.asrProfiles.insert(profile("b1", "bob"));
    });
    const ids = (owner: string) => repository.withTransaction((scope) => scope.asrProfiles.list(owner)).map((item) => item.id);
    expect(ids("alice")).toEqual(["a1", "a2"]);
    repository.withTransaction((scope) => scope.asrProfiles.reorder("alice", ["a2", "a1"]));
    expect(ids("alice")).toEqual(["a2", "a1"]);
    expect(() => repository.withTransaction((scope) => scope.asrProfiles.reorder("alice", ["b1"]))).toThrow();
    expect(ids("bob")).toEqual(["b1"]);
  });

  it("refuses an empty or malformed model list", () => {
    expect(() => repository.withTransaction((scope) => scope.asrProfiles.insert(profile("a1", "alice", { models: [] })))).toThrow(/CHECK/);
    expect(() => insertRow(db, "asr_provider_profile", { id: "x", user_id: "alice", name: "x", provider: "dashscope", models_json: '"fun-asr"', created_at: T0 })).toThrow(/CHECK/);
  });

  it("deletes only the owner's profile together with its secret", () => {
    secret("s-alice", "alice");
    secret("s-bob", "bob");
    repository.withTransaction((scope) => {
      scope.asrProfiles.insert(profile("a1", "alice", { credentialRef: "s-alice" }));
      scope.asrProfiles.insert(profile("b1", "bob", { credentialRef: "s-bob" }));
    });
    expect(repository.withTransaction((scope) => scope.asrProfiles.delete("bob", "a1"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.asrProfiles.delete("alice", "a1"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.asrProfiles.delete("alice", "a1"))).toBe(false);
    expect(countRows(db, "secret", "id = 's-alice'")).toBe(0);
    expect(countRows(db, "secret", "id = 's-bob'")).toBe(1);
    expect(repository.withTransaction((scope) => scope.asrProfiles.get("bob", "b1"))?.id).toBe("b1");
  });
});

describe("provider profile writes", () => {
  const unknownFlags: CapabilityFlags = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
  const model = (modelId: string, extra: Partial<ModelCapability> = {}): ModelCapability => ({
    modelId,
    flags: { declared: unknownFlags },
    limits: { declared: {}, userOverride: { contextWindowTokens: 128_000 } },
    ...extra,
  });
  const profile = (id: string, userId: string, extra: Partial<ProviderProfile> = {}): ProviderProfile => ({
    id, userId, name: id, protocol: "openai_compatible", baseURL: "https://llm.invalid/v1", models: [], createdAt: T0, ...extra,
  });
  const get = (owner: string, id: string) => repository.withTransaction((scope) => scope.providerProfiles.get(owner, id));
  function secret(id: string, userId: string): void {
    insertRow(db, "secret", {
      id, user_id: userId, envelope_version: 1, kdf_salt: randomBytes(16), nonce: randomBytes(12), ciphertext: randomBytes(8), auth_tag: randomBytes(16), created_at: T0, updated_at: T0,
    });
  }

  it("round-trips a profile with every capability layer and the given model order", () => {
    secret("s1", "alice");
    const full = model("zeta", {
      flags: { declared: unknownFlags, observed: { stream: "supported", tools: "unsupported" }, userOverride: { audioInput: "supported" } },
      limits: { declared: {}, observed: { maxOutputTokens: 4096 }, userOverride: { contextWindowTokens: 64_000, maxOutputTokens: 2048 } },
      observedAt: T0 + 5,
    });
    const written = profile("p1", "alice", { credentialRef: "s1", models: [full, model("alpha")] });
    repository.withTransaction((scope) => scope.providerProfiles.insert(written));
    expect(get("alice", "p1")).toEqual(written);
    expect(get("bob", "p1")).toBeUndefined();
  });

  it("round-trips a model's price outside its capability layers, and drops it with the model", () => {
    const priced = model("priced", { pricing: { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "0.00022" }, { unit: "per_request", amount: "1" }], note: "免费额度 100 万" } });
    repository.withTransaction((scope) => scope.providerProfiles.insert(profile("p1", "alice", { models: [model("plain"), priced] })));
    expect(get("alice", "p1")?.models).toEqual([model("plain"), priced]);
    expect(get("alice", "p1")?.models[0]).not.toHaveProperty("pricing");
    const repriced = { ...priced, pricing: { currency: "USD" as const, items: [{ unit: "output_tokens_per_million" as const, amount: "15" }] } };
    repository.withTransaction((scope) => scope.providerProfiles.update(profile("p1", "alice", { models: [repriced, model("plain")] })));
    expect(get("alice", "p1")?.models).toEqual([repriced, model("plain")]);
    repository.withTransaction((scope) => scope.providerProfiles.update(profile("p1", "alice", { models: [model("plain")] })));
    expect(get("alice", "p1")?.models).toEqual([model("plain")]);
    expect(() => insertRow(db, "model_capability", { profile_id: "p1", model_id: "bad", position: 5, flags_declared_json: "{}", limits_declared_json: "{}", pricing_json: "{oops" })).toThrow(/CHECK/);
  });

  it("reads one model's current price on its own, scoped to the owner, and nothing for unknown or unpriced models", () => {
    const priced = model("priced", { pricing: { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "0.8" }] } });
    repository.withTransaction((scope) => scope.providerProfiles.insert(profile("p1", "alice", { models: [model("plain"), priced] })));
    const price = (owner: string, profileId: string, modelId: string) => repository.withTransaction((scope) => scope.providerProfiles.getModelPricing(owner, profileId, modelId));
    expect(price("alice", "p1", "priced")).toEqual(priced.pricing);
    expect(price("alice", "p1", "plain")).toBeUndefined();
    expect(price("alice", "p1", "unknown")).toBeUndefined();
    expect(price("bob", "p1", "priced")).toBeUndefined();
    expect(price("alice", "nope", "priced")).toBeUndefined();
    // A later edit is what the next read sees.
    const repriced = { ...priced, pricing: { currency: "USD" as const, items: [{ unit: "output_tokens_per_million" as const, amount: "15" }] } };
    repository.withTransaction((scope) => scope.providerProfiles.update(profile("p1", "alice", { models: [repriced] })));
    expect(price("alice", "p1", "priced")).toEqual(repriced.pricing);
  });

  it("lists the owner's profiles in their order: each new one last, reordering renumbers them", () => {
    const ids = (owner: string) => repository.withTransaction((scope) => scope.providerProfiles.list(owner)).map((p) => p.id);
    repository.withTransaction((scope) => {
      scope.providerProfiles.insert(profile("late", "alice", { createdAt: T0 + 2 }));
      scope.providerProfiles.insert(profile("b", "alice", { createdAt: T0 + 1 }));
      scope.providerProfiles.insert(profile("bobs", "bob"));
      scope.providerProfiles.insert(profile("a", "alice", { createdAt: T0 + 1 }));
    });
    expect(ids("alice")).toEqual(["late", "b", "a"]);
    expect(ids("bob")).toEqual(["bobs"]);
    repository.withTransaction((scope) => scope.providerProfiles.reorder("alice", ["a", "late", "b"]));
    expect(ids("alice")).toEqual(["a", "late", "b"]);
    // Another owner's profile is not theirs to number; the transaction rolls back.
    expect(() => repository.withTransaction((scope) => scope.providerProfiles.reorder("alice", ["b", "bobs"]))).toThrow();
    expect(ids("alice")).toEqual(["a", "late", "b"]);
    expect(ids("bob")).toEqual(["bobs"]);
  });

  it("updates name, endpoint and credential and replaces the model list as given", () => {
    secret("s1", "alice");
    repository.withTransaction((scope) =>
      scope.providerProfiles.insert(profile("p1", "alice", { models: [model("a"), model("b"), model("c")] })),
    );
    const kept = model("c", { flags: { declared: unknownFlags, observed: { structuredOutput: "supported" } }, observedAt: T0 + 9 });
    const updated = profile("p1", "alice", { name: "renamed", baseURL: "https://other.invalid", credentialRef: "s1", models: [kept, model("new")] });
    repository.withTransaction((scope) => scope.providerProfiles.update(updated));
    expect(get("alice", "p1")).toEqual(updated);
    expect(countRows(db, "model_capability")).toBe(2);
    // The protocol is fixed at creation.
    repository.withTransaction((scope) => scope.providerProfiles.update({ ...updated, protocol: "anthropic_messages" }));
    expect(get("alice", "p1")?.protocol).toBe("openai_compatible");
  });

  it("treats another user's profile id like an unknown one on update and delete", () => {
    repository.withTransaction((scope) => scope.providerProfiles.insert(profile("p1", "alice", { models: [model("a")] })));
    const code = (work: () => unknown): string | undefined => {
      try {
        work();
      } catch (error) {
        return isAmberError(error) ? error.appError.code : String(error);
      }
      return undefined;
    };
    expect(code(() => repository.withTransaction((scope) => scope.providerProfiles.update(profile("p1", "bob", { name: "stolen" }))))).toBe("not_found");
    expect(code(() => repository.withTransaction((scope) => scope.providerProfiles.update(profile("missing", "alice"))))).toBe("not_found");
    expect(repository.withTransaction((scope) => scope.providerProfiles.delete("bob", "p1"))).toBe(false);
    expect(get("alice", "p1")).toMatchObject({ name: "p1", models: [{ modelId: "a" }] });
  });

  it("refuses another user's secret as the credential", () => {
    secret("s-bob", "bob");
    expect(() => repository.withTransaction((scope) => scope.providerProfiles.insert(profile("p1", "alice", { credentialRef: "s-bob" })))).toThrow(/FOREIGN KEY/);
  });

  it("deletes the profile with its models and secret only", () => {
    secret("s1", "alice");
    secret("s2", "alice");
    repository.withTransaction((scope) => {
      scope.providerProfiles.insert(profile("p1", "alice", { credentialRef: "s1", models: [model("a")] }));
      scope.providerProfiles.insert(profile("p2", "alice", { credentialRef: "s2", models: [model("b")] }));
    });
    expect(repository.withTransaction((scope) => scope.providerProfiles.delete("alice", "p1"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.providerProfiles.delete("alice", "p1"))).toBe(false);
    expect(countRows(db, "secret", "id = 's1'")).toBe(0);
    expect(countRows(db, "secret", "id = 's2'")).toBe(1);
    expect(countRows(db, "model_capability")).toBe(1);
  });
});
