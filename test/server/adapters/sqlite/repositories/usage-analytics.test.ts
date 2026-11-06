import { describe, expect, it } from "vitest";
import { SqliteUsageAnalyticsRepository } from "../../../../../src/server/adapters/sqlite/repositories/usage-analytics.ts";
import {
  bucketGroupsSql,
  CACHE_OBSERVED_SQL,
  earliestSql,
} from "../../../../../src/server/adapters/sqlite/repositories/usage-analytics-sql.ts";
import { bucketStart } from "../../../../../src/server/application/usage-time.ts";
import { USAGE_COMPONENT, USAGE_FLAG, type UsageScope } from "../../../../../src/server/domain/usage-analytics.ts";
import { USAGE_GRANULARITIES } from "../../../../../src/shared/dto/usage-analytics.ts";
import { prng } from "../../../../fixtures/usage/reference.ts";
import {
  DAY,
  insertAsrProfile,
  insertAsrUsage,
  insertLlmProfile,
  insertLlmUsage,
  MONDAY,
  NOW,
  OTHER_OWNER,
  OWNER,
  usageDb,
} from "../../../../fixtures/usage/rows.ts";

function setup() {
  const { db } = usageDb();
  return { db, repository: new SqliteUsageAnalyticsRepository(db) };
}

const ALL: UsageScope = { owner: OWNER };

/** All groups of a scope; the calls of these tests fall in one month, so the bucket does not split them. */
function groupsOf(repository: SqliteUsageAnalyticsRepository, scope: UsageScope) {
  return repository.groupsByBucket(scope, "month");
}

describe("bucket boundaries", () => {
  it.each(USAGE_GRANULARITIES)("agree between SQL and the bucket list at %s granularity", (granularity) => {
    const { db, repository } = setup();
    const random = prng(7);
    // Edges of weeks, months and years in Beijing time, plus random moments.
    const edges = [
      MONDAY, MONDAY - 1, MONDAY + 7 * DAY - 1, MONDAY + 7 * DAY,
      Date.UTC(2026, 8, 30, 15, 59, 59, 999), Date.UTC(2026, 8, 30, 16),
      Date.UTC(2027, 11, 31, 15, 59, 59, 999), Date.UTC(2027, 11, 31, 16),
      Date.UTC(2028, 1, 29, 15, 59, 59), Date.UTC(2028, 1, 29, 16),
    ];
    const times = [...edges, ...Array.from({ length: 60 }, () => Date.UTC(2025, 0, 1) + Math.floor(random() * 3 * 365 * DAY))];
    times.forEach((sentAt, index) => insertLlmUsage(db, { id: `u${index}`, modelId: `m${index}`, sentAt, input: 1, output: 1 }));

    const rows = repository.groupsByBucket(ALL, granularity);
    expect(rows).toHaveLength(times.length);
    for (const row of rows) {
      const sentAt = times[Number(row.modelId.slice(1))] as number;
      expect(row.bucketStart, `${granularity} ${new Date(sentAt).toISOString()}`).toBe(bucketStart(granularity, sentAt));
    }
  });
});

describe("the time a call is attributed to", () => {
  it("is when it was sent, else when it was recorded", () => {
    const { db, repository } = setup();
    // Sent at 23:59:59 Beijing on Thursday but recorded after midnight, on Friday.
    const thursday = MONDAY + 3 * DAY;
    insertLlmUsage(db, { id: "late", modelId: "sent-thursday", sentAt: thursday + DAY - 1000, createdAt: thursday + DAY + 5000, input: 1, output: 1 });
    insertLlmUsage(db, { id: "old", modelId: "recorded-friday", sentAt: null, createdAt: thursday + DAY + 5000, input: 1, output: 1 });
    const byDay = new Map(repository.groupsByBucket(ALL, "day").map((row) => [row.modelId, row.bucketStart]));
    expect(byDay.get("sent-thursday")).toBe(thursday);
    expect(byDay.get("recorded-friday")).toBe(thursday + DAY);
  });

  it("bounds a range half-open on that time", () => {
    const { db, repository } = setup();
    for (const [id, sentAt] of [["a", 1000], ["b", 2000], ["c", 3000]] as const) {
      insertLlmUsage(db, { id, modelId: id, sentAt, createdAt: NOW, input: 1, output: 1 });
    }
    insertAsrUsage(db, { id: "d", modelId: "d", sentAt: null, createdAt: 2000 });
    const ids = (scope: UsageScope) => groupsOf(repository, scope).map((row) => row.modelId).sort();
    expect(ids({ owner: OWNER, from: 2000, to: 3000 })).toEqual(["b", "d"]);
    expect(ids({ owner: OWNER, from: 2001 })).toEqual(["c"]);
    expect(ids({ owner: OWNER, to: 2000 })).toEqual(["a"]);
  });
});

describe("filters", () => {
  function seed() {
    const { db, repository } = setup();
    // The same model id under two profiles and under both modalities.
    insertLlmUsage(db, { id: "l1", profileId: "p-1", modelId: "shared", sentAt: 1000, input: 1, output: 1, credentialVersion: "v1" });
    insertLlmUsage(db, { id: "l2", profileId: "p-2", modelId: "shared", sentAt: 1000, input: 1, output: 1, credentialVersion: "v2" });
    insertLlmUsage(db, { id: "l3", profileId: "p-1", modelId: "shared", sentAt: 1000, input: 1, output: 1, credentialVersion: null });
    insertAsrUsage(db, { id: "a1", profileId: "p-1", modelId: "shared", sentAt: 1000, credentialVersion: "v1" });
    insertAsrUsage(db, { id: "a2", profileId: null, modelId: "shared", sentAt: 1000 });
    insertLlmUsage(db, { id: "x1", userId: OTHER_OWNER, profileId: "p-1", modelId: "shared", sentAt: 1000, input: 1, output: 1 });
    return repository;
  }

  const requestsBy = (repository: SqliteUsageAnalyticsRepository, scope: UsageScope): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const row of groupsOf(repository, scope)) {
      const key = `${row.modality}:${row.profileId}:${row.modelId}`;
      counts[key] = (counts[key] ?? 0) + Number(row.requests);
    }
    return counts;
  };

  it("always belong to the owner", () => {
    expect(requestsBy(seed(), ALL)).toEqual({ "llm:p-1:shared": 2, "llm:p-2:shared": 1, "asr:p-1:shared": 1, "asr::shared": 1 });
    expect(requestsBy(seed(), { owner: OTHER_OWNER })).toEqual({ "llm:p-1:shared": 1 });
  });

  it("never merge a model id across profiles or modalities", () => {
    const repository = seed();
    expect(requestsBy(repository, { owner: OWNER, model: { modality: "llm", profileId: "p-1", modelId: "shared" } })).toEqual({ "llm:p-1:shared": 2 });
    expect(requestsBy(repository, { owner: OWNER, model: { modality: "llm", profileId: "p-2", modelId: "shared" } })).toEqual({ "llm:p-2:shared": 1 });
    expect(requestsBy(repository, { owner: OWNER, model: { modality: "asr", profileId: "p-1", modelId: "shared" } })).toEqual({ "asr:p-1:shared": 1 });
  });

  it("filter by modality and by profile, keeping an unrecorded ASR profile apart", () => {
    const repository = seed();
    expect(requestsBy(repository, { owner: OWNER, modality: "asr" })).toEqual({ "asr:p-1:shared": 1, "asr::shared": 1 });
    expect(requestsBy(repository, { owner: OWNER, profile: { modality: "asr", profileId: "" } })).toEqual({ "asr::shared": 1 });
    expect(requestsBy(repository, { owner: OWNER, profile: { modality: "llm", profileId: "p-1" } })).toEqual({ "llm:p-1:shared": 2 });
    expect(requestsBy(repository, { owner: OWNER, profile: { modality: "asr", profileId: "p-2" } })).toEqual({});
  });

  it("filter by credential version, with null for records made before versions were kept", () => {
    const repository = seed();
    expect(requestsBy(repository, { owner: OWNER, profile: { modality: "llm", profileId: "p-1" }, credentialVersion: "v1" })).toEqual({ "llm:p-1:shared": 1 });
    expect(requestsBy(repository, { owner: OWNER, profile: { modality: "llm", profileId: "p-1" }, credentialVersion: null })).toEqual({ "llm:p-1:shared": 1 });
    expect(requestsBy(repository, { owner: OWNER, profile: { modality: "asr", profileId: "" }, credentialVersion: null })).toEqual({ "asr::shared": 1 });
  });

  it("combine, and a contradiction matches nothing", () => {
    const repository = seed();
    expect(requestsBy(repository, { owner: OWNER, modality: "asr", model: { modality: "llm", profileId: "p-1", modelId: "shared" } })).toEqual({});
  });
});

describe("grouping of a call", () => {
  const snapshot = { currency: "CNY", items: [{ unit: "input_tokens_per_million", amount: "2" }] };

  it("sums quantities per group, with normal input and the default cache write derived per call", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "a", sentAt: 1, input: 1000, output: 100, cacheRead: 300, cacheWrite: 200, cacheWrite1h: 50, reasoning: 7, snapshot });
    insertLlmUsage(db, { id: "b", sentAt: 2, input: 900, output: 10, cacheRead: 300, cacheWrite: 30, cacheWrite1h: 20, snapshot });
    const [row, ...rest] = groupsOf(repository, ALL);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      requests: 2n,
      rawInput: 1900n,
      // 1000 - 300 - 200, and 900 - 300 - 30.
      input: 1070n,
      output: 110n,
      reasoning: 7n,
      cacheRead: 600n,
      // 200 - 50, and 30 - 20.
      cacheWrite: 160n,
      cacheWrite1h: 70n,
      lastAt: 2,
    });
    expect(row?.bitmap).toBe(USAGE_COMPONENT.input | USAGE_COMPONENT.cacheRead | USAGE_COMPONENT.cacheWrite | USAGE_COMPONENT.cacheWrite1h | USAGE_COMPONENT.output);
    expect(row?.flags).toBe(USAGE_FLAG.cacheReported);
  });

  it("never lets cache parts that exceed the input make the normal input negative", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "a", sentAt: 1, input: 100, output: 10, cacheRead: 300, cacheWrite: 20 });
    expect(groupsOf(repository, ALL)[0]).toMatchObject({ input: 0n, cacheRead: 300n, bitmap: USAGE_COMPONENT.cacheRead | USAGE_COMPONENT.cacheWrite | USAGE_COMPONENT.output });
  });

  it("splits groups by snapshot, which quantities are positive, which were reported and how they ended", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "base", sentAt: 1, input: 10, output: 5, snapshot });
    insertLlmUsage(db, { id: "same", sentAt: 1, input: 20, output: 6, snapshot });
    insertLlmUsage(db, { id: "no-output", sentAt: 1, input: 20, output: 0, snapshot });
    insertLlmUsage(db, { id: "other-price", sentAt: 1, input: 10, output: 5, snapshot: { ...snapshot, currency: "USD" } });
    insertLlmUsage(db, { id: "failed", sentAt: 1, input: 10, output: 5, snapshot, outcome: "failed" });
    insertLlmUsage(db, { id: "cache", sentAt: 1, input: 10, output: 5, snapshot, cacheRead: 0 });
    const groups = groupsOf(repository, ALL);
    // The first two share everything; each other call differs in one respect.
    expect(groups.map((group) => group.requests).sort()).toEqual([1n, 1n, 1n, 1n, 2n]);
    expect(groups.find((group) => group.requests === 2n)).toMatchObject({ rawInput: 30n, output: 11n });
  });

  it("flags usage that is absent and input that is missing", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "absent", sentAt: 1, input: null, output: null, outcome: "outcome_unknown" });
    insertLlmUsage(db, { id: "missing", sentAt: 1, input: 0, output: 12 });
    insertLlmUsage(db, { id: "empty", sentAt: 1, input: 0, output: 0 });
    const flags = Object.fromEntries(groupsOf(repository, ALL).map((row) => [row.result + row.flags, row.flags]));
    expect(flags).toEqual({ outcome_unknown1: USAGE_FLAG.usageAbsent, succeeded2: USAGE_FLAG.inputMissing, succeeded0: 0 });
  });

  it("derives a transcription's effective result, accepted state and reported quantities", () => {
    const { db, repository } = setup();
    insertAsrUsage(db, { id: "accepted", sentAt: 1, modelId: "m1", jobId: "j1", audioMs: 5000 });
    insertAsrUsage(db, { id: "done", sentAt: 1, modelId: "m2", jobId: "j2", jobOutcome: "cancelled", audioMs: 100, billedAudioMs: 90, billedInput: 3, billedOutput: 4 });
    insertAsrUsage(db, { id: "sync", sentAt: 1, modelId: "m3", outcome: "outcome_unknown", audioMs: 1 });
    const byModel = Object.fromEntries(groupsOf(repository, ALL).map((row) => [row.modelId, row]));
    expect(byModel["m1"]).toMatchObject({ result: "succeeded", flags: USAGE_FLAG.accepted, audioLocalMs: 5000n, audioBilledMs: 0n });
    expect(byModel["m2"]).toMatchObject({
      result: "cancelled",
      flags: USAGE_FLAG.billedTokens | USAGE_FLAG.billedAudio,
      audioLocalMs: 100n,
      audioBilledMs: 90n,
      rawInput: 3n,
      input: 3n,
      output: 4n,
      bitmap: USAGE_COMPONENT.input | USAGE_COMPONENT.output,
    });
    expect(byModel["m3"]).toMatchObject({ result: "outcome_unknown", flags: 0 });
  });

  it("splits groups by credential version and reports when the version took effect", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "a", sentAt: 1, input: 1, output: 1, credentialVersion: "v1", credentialSetAt: 10 });
    insertLlmUsage(db, { id: "b", sentAt: 1, input: 1, output: 1, credentialVersion: "v2", credentialSetAt: 20 });
    insertLlmUsage(db, { id: "c", sentAt: 1, input: 1, output: 1 });
    const byVersion = Object.fromEntries(groupsOf(repository, ALL).map((row) => [row.credentialVersion ?? "none", row.credentialSetAt]));
    expect(byVersion).toEqual({ v1: 10, v2: 20, none: null });
  });

  it("counts requests per model and credential version for the menus", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "a", sentAt: 1, input: 1, output: 1, credentialVersion: "v1", credentialSetAt: 10 });
    insertLlmUsage(db, { id: "b", sentAt: 2, input: 5, output: 1, credentialVersion: "v1", credentialSetAt: 10 });
    insertAsrUsage(db, { id: "c", sentAt: 3 });
    const rows = repository.identities(ALL).map((row) => `${row.modality}:${row.profileId}:${row.modelId}:${row.credentialVersion}:${row.credentialSetAt}:${row.requests}`);
    expect(rows.sort()).toEqual(["asr:ap-1:scribe_v2:null:null:1", "llm:p-1:model-a:v1:10:2"]);
  });

  it("recalls the name the newest call recorded, for the profiles asked about", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "old", sentAt: 1, profileId: "gone", profileName: "Old name", input: 1, output: 1 });
    insertLlmUsage(db, { id: "new", sentAt: 2, profileId: "gone", profileName: "New name", input: 1, output: 1 });
    insertLlmUsage(db, { id: "other", sentAt: 3, profileId: "other", profileName: "Other", input: 1, output: 1 });
    insertAsrUsage(db, { id: "a", sentAt: 1, profileId: "ap-gone", profileName: "Early scribe" });
    insertAsrUsage(db, { id: "b", sentAt: 2, profileId: "ap-gone", profileName: "Late scribe" });
    insertAsrUsage(db, { id: "c", sentAt: 3, profileId: null, profileName: null });
    insertLlmUsage(db, { id: "theirs", userId: OTHER_OWNER, sentAt: 9, profileId: "gone", profileName: "Not mine", input: 1, output: 1 });
    const asked = [
      { modality: "llm", profileId: "gone" },
      { modality: "asr", profileId: "ap-gone" },
      { modality: "asr", profileId: "" },
      { modality: "llm", profileId: "never-used" },
    ] as const;
    expect(repository.recordedProfileNames(OWNER, asked)).toEqual([
      { modality: "llm", profileId: "gone", name: "New name" },
      { modality: "asr", profileId: "ap-gone", name: "Late scribe" },
    ]);
  });
});

describe("integer sums", () => {
  it("stay exact beyond 2^53", () => {
    const { db, repository } = setup();
    const huge = 2n ** 53n + 1n;
    insertLlmUsage(db, { id: "a", sentAt: 1, input: huge, output: huge });
    insertLlmUsage(db, { id: "b", sentAt: 1, input: huge, output: 1 });
    const [row] = groupsOf(repository, ALL);
    expect(row?.rawInput).toBe(2n * huge);
    expect(row?.output).toBe(huge + 1n);
  });

  it("raise rather than wrap when a sum leaves 64 bits", () => {
    const { db, repository } = setup();
    const nearMax = 2n ** 62n;
    for (const id of ["a", "b", "c"]) {
      insertLlmUsage(db, { id, sentAt: 1, input: nearMax, output: 1 });
    }
    expect(() => groupsOf(repository, ALL)).toThrow(/overflow/i);
  });
});

describe("lookups", () => {
  it("find the earliest call matching the filters and ignore the time bounds", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "a", sentAt: 5000, modelId: "late", input: 1, output: 1 });
    insertAsrUsage(db, { id: "b", sentAt: 3000, modelId: "early" });
    insertAsrUsage(db, { id: "c", sentAt: null, createdAt: 4000, modelId: "early" });
    expect(repository.earliest(ALL)).toBe(3000);
    expect(repository.earliest({ owner: OWNER, modality: "llm", from: 9999 })).toBe(5000);
    expect(repository.earliest({ owner: OWNER, model: { modality: "asr", profileId: "ap-1", modelId: "early" } })).toBe(3000);
    expect(repository.earliest({ owner: OWNER, model: { modality: "asr", profileId: "ap-1", modelId: "missing" } })).toBeNull();
    expect(repository.earliest({ owner: OTHER_OWNER })).toBeNull();
  });

  it("list the distinct currencies the owner has ever priced in", () => {
    const { db, repository } = setup();
    const item = { unit: "per_request", amount: "1" };
    insertLlmUsage(db, { id: "a", sentAt: 1, snapshot: { currency: "USD", items: [item] } });
    insertLlmUsage(db, { id: "b", sentAt: 1, snapshot: { currency: "USD", items: [item] } });
    insertAsrUsage(db, { id: "c", sentAt: 1, snapshot: { currency: "CNY", items: [item] } });
    insertLlmUsage(db, { id: "d", userId: OTHER_OWNER, sentAt: 1, snapshot: { currency: "EUR", items: [item] } });
    insertLlmUsage(db, { id: "e", sentAt: 1 });
    expect(repository.currencies(OWNER).sort()).toEqual(["CNY", "USD"]);
  });

  it("report the profiles that exist and their current prices, the owner's only", () => {
    const { db, repository } = setup();
    const price = { currency: "CNY", items: [{ unit: "per_request", amount: "1" }] };
    insertLlmProfile(db, "p-1", { name: "Relay", models: [{ modelId: "priced", pricing: price }, { modelId: "free" }] });
    insertLlmProfile(db, "p-other", { userId: OTHER_OWNER, name: "Theirs", models: [{ modelId: "x", pricing: price }] });
    insertAsrProfile(db, "ap-1", { name: "Scribe", models: [{ modelId: "scribe_v2", pricing: price }, { modelId: "plain" }] });
    expect(repository.profileNames(OWNER).sort((a, b) => a.profileId.localeCompare(b.profileId))).toEqual([
      { modality: "asr", profileId: "ap-1", name: "Scribe" },
      { modality: "llm", profileId: "p-1", name: "Relay" },
    ]);
    const pricing = repository.currentPricing(OWNER).map((entry) => `${entry.modality}:${entry.profileId}:${entry.modelId}:${entry.pricingJson === null ? "-" : "priced"}`);
    expect(pricing.sort()).toEqual(["asr:ap-1:plain:-", "asr:ap-1:scribe_v2:priced", "llm:p-1:free:-", "llm:p-1:priced:priced"]);
  });

  it("list the models whose usage ever reported a cache read", () => {
    const { db, repository } = setup();
    insertLlmUsage(db, { id: "a", sentAt: 1, profileId: "p-1", modelId: "cached", input: 10, output: 1, cacheRead: 4 });
    insertLlmUsage(db, { id: "b", sentAt: 1, profileId: "p-1", modelId: "cached", input: 10, output: 1, cacheRead: 5 });
    insertLlmUsage(db, { id: "c", sentAt: 1, profileId: "p-1", modelId: "zero", input: 10, output: 1, cacheRead: 0 });
    insertLlmUsage(db, { id: "d", sentAt: 1, profileId: "p-1", modelId: "none", input: 10, output: 1 });
    insertLlmUsage(db, { id: "e", userId: OTHER_OWNER, sentAt: 1, profileId: "p-9", modelId: "theirs", input: 10, output: 1, cacheRead: 4 });
    expect(repository.cacheObserved(OWNER)).toEqual([{ profileId: "p-1", modelId: "cached" }]);
  });
});

describe("query plans", () => {
  function planOf(sql: string, params: Record<string, unknown>): string {
    const { db } = setup();
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  }

  const ranged: UsageScope = { owner: OWNER, from: NOW - 30 * DAY, to: NOW };

  it("scan a time range through the occurred-time index of each table", () => {
    for (const granularity of USAGE_GRANULARITIES) {
      const query = bucketGroupsSql(ranged, granularity);
      const plan = planOf(query.sql, query.params);
      expect(plan).toMatch(/SEARCH \w+ USING (COVERING )?INDEX token_usage_user_occurred/);
      expect(plan).toMatch(/SEARCH \w+ USING (COVERING )?INDEX asr_usage_user_occurred/);
    }
  });

  it("find the earliest call from the same indexes", () => {
    const query = earliestSql({ owner: OWNER });
    const plan = planOf(query.sql, query.params);
    expect(plan).toContain("token_usage_user_occurred");
    expect(plan).toContain("asr_usage_user_occurred");
  });

  it("read cache-observed models from the partial index", () => {
    expect(planOf(CACHE_OBSERVED_SQL, { owner: OWNER })).toContain("token_usage_cache_observed");
  });

  it("scan by model with a model filter and no time bounds", () => {
    const query = bucketGroupsSql({ owner: OWNER, model: { modality: "llm", profileId: "p-1", modelId: "m" } }, "month");
    expect(planOf(query.sql, query.params)).toMatch(/token_usage_model/);
  });
});
