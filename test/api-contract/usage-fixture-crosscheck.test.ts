import { describe, expect, it } from "vitest";
import { SqliteUsageAnalyticsRepository } from "../../src/server/adapters/sqlite/repositories/usage-analytics.ts";
import { UsageAnalyticsService } from "../../src/server/application/usage-analytics.ts";
import type { UsageSummaryQuery } from "../../src/shared/dto/usage-analytics.ts";
import { summaryResponse } from "../fixtures/usage/engine.ts";
import { insertCalls, type ReferenceCall } from "../fixtures/usage/reference.ts";
import { principalOf, usageDb, OWNER } from "../fixtures/usage/rows.ts";
import { SCENARIOS } from "../fixtures/usage/scenarios.ts";
import type { FixtureCall, FixturePrice, FixtureScenario } from "../fixtures/usage/types.ts";

/**
 * The fixtures the usage page is built and screenshotted against derive their responses with a
 * small engine of their own. This test loads the same calls into a real database and compares
 * that engine with the server's: where they differ, the server is right and the fixture engine
 * is wrong.
 */

type Snapshot = { currency: string; items: Array<{ unit: string; amount: string }> };

/** A frozen price in the wire shape of a price snapshot. */
function snapshotOf(price: FixturePrice | null): Snapshot | null {
  if (price === null) return null;
  const items: Snapshot["items"] = [];
  const add = (unit: string, amount: number | undefined): void => {
    if (amount !== undefined) items.push({ unit, amount: String(amount) });
  };
  add("input_tokens_per_million", price.inputPerMillion ?? price.billedInputPerMillion);
  add("output_tokens_per_million", price.outputPerMillion ?? price.billedOutputPerMillion);
  add("cached_input_tokens_per_million", price.cacheReadPerMillion);
  add("audio_per_second", price.audioPerSecond);
  add("per_request", price.perRequest);
  return { currency: price.currency, items };
}

function credentialOf(call: FixtureCall): { credentialVersion: string | null; credentialSetAt: number | null } {
  const version = call.model.profile.versions.find((item) => item.id === call.version);
  return { credentialVersion: call.version, credentialSetAt: version?.setAt ?? null };
}

/** One fixture call as the raw row the server stores. */
function rowOf(call: FixtureCall): ReferenceCall {
  const common = { id: call.id, userId: OWNER, sentAt: call.at, createdAt: call.at, snapshot: snapshotOf(call.price), ...credentialOf(call) };
  const profile = call.model.profile;
  if (profile.modality === "llm") {
    const usage = call.llm;
    return {
      modality: "llm",
      ...common,
      profileId: profile.id,
      profileName: profile.name ?? "",
      modelId: call.model.modelId,
      feature: call.feature,
      // An LLM call's own outcome; only transcription has a cancelled remote job.
      outcome: call.result,
      input: usage?.input ?? null,
      output: usage?.output ?? null,
      cacheRead: usage?.cacheRead ?? null,
      cacheWrite: usage?.cacheWrite ?? null,
      reasoning: usage?.reasoning ?? null,
    };
  }
  const outcome = call.result === "cancelled" ? "succeeded" : call.result;
  return {
    modality: "asr",
    ...common,
    profileId: profile.id,
    profileName: profile.name,
    modelId: call.model.modelId,
    feature: call.feature,
    outcome,
    jobOutcome: call.result === "cancelled" ? "cancelled" : null,
    audioMs: call.asr?.audioMs ?? 0,
    billedInput: call.asr?.billedInput ?? null,
    billedOutput: call.asr?.billedOutput ?? null,
    billedAudioMs: call.asr?.billedAudioMs ?? null,
  };
}

function serverFor(scenario: FixtureScenario): UsageAnalyticsService {
  const { db } = usageDb();
  insertCalls(db, scenario.calls.map(rowOf));
  return new UsageAnalyticsService({ repository: new SqliteUsageAnalyticsRepository(db), now: () => scenario.now });
}

const reasons = (response: ReturnType<typeof summaryResponse>) =>
  response.costDetail.unpriced.map((item) => ({ reason: item.reason, requests: item.requests })).sort((a, b) => a.reason.localeCompare(b.reason));

describe("the fixture engine against the server", () => {
  for (const id of ["main", "partial", "dual"] as const) {
    for (const range of ["all", "30d", "7d"] as const) {
      for (const displayCurrency of ["CNY", "USD"] as const) {
        it(`${id} · ${range} · ${displayCurrency}: summary, usage and unpriced reasons agree`, () => {
          const scenario = SCENARIOS[id]();
          const query: UsageSummaryQuery = { range, displayCurrency };
          const fixture = summaryResponse(scenario, query);
          const server = serverFor(scenario).summary(principalOf(OWNER), query);

          expect(server.summary.requests).toBe(fixture.summary.requests);
          expect(server.summary.results).toEqual(fixture.summary.results);
          expect(server.summary.usage).toEqual(fixture.summary.usage);
          expect(server.summary.cost).toEqual(fixture.summary.cost);
          expect(reasons(server)).toEqual(reasons(fixture));
          expect(server.currencies.toSorted()).toEqual(fixture.currencies.toSorted());
        });
      }
    }
  }
});
