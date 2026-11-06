import { describe, expect, it } from "vitest";
import {
  usageActivitiesResponseSchema,
  usageCacheObservedResponseSchema,
  usageCallsResponseSchema,
  USAGE_RANGES,
  usageSummaryResponseSchema,
} from "../../../src/shared/dto/usage-analytics.ts";
import { activitiesResponse, cacheObservedResponse, callsResponse, summaryResponse } from "./engine.ts";
import { SCENARIOS, type ScenarioId } from "./scenarios.ts";
import type { FixtureScenario } from "./types.ts";

/** The preset ranges, in both display currencies, with the simulation on and off. */
const RANGES = USAGE_RANGES.filter((range) => range !== "custom");

function check(scenario: FixtureScenario): void {
  for (const range of RANGES) {
    for (const displayCurrency of ["CNY", "USD"] as const) {
      for (const simulate of [undefined, "1"] as const) {
        const summary = summaryResponse(scenario, { range, displayCurrency, ...(simulate === undefined ? {} : { simulate }) });
        expect(usageSummaryResponseSchema.safeParse(summary).success).toBe(true);
      }
    }
  }
  const activities = activitiesResponse(scenario, { range: "all", displayCurrency: "CNY", page: 1, pageSize: 50 });
  expect(usageActivitiesResponseSchema.safeParse(activities).success).toBe(true);
  for (const activity of activities.items) {
    const calls = callsResponse(scenario, { range: "all", displayCurrency: "CNY", group: activity.group });
    expect(usageCallsResponseSchema.safeParse(calls).success).toBe(true);
    expect(calls.items).toHaveLength(activity.requests);
  }
  expect(usageCacheObservedResponseSchema.safeParse(cacheObservedResponse(scenario)).success).toBe(true);
}

describe("usage fixtures", () => {
  for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
    it(`scenario ${id} produces responses that satisfy the contract`, () => {
      check(SCENARIOS[id]());
    });
  }

  it("keeps the summary, the chart and the records in agreement", () => {
    const scenario = SCENARIOS.main();
    const summary = summaryResponse(scenario, { range: "30d", displayCurrency: "CNY" });
    const activities = activitiesResponse(scenario, { range: "30d", displayCurrency: "CNY", page: 1, pageSize: 50 });
    expect(activities.items.reduce((total, item) => total + item.requests, 0)).toBe(summary.summary.requests);
    const requests = summary.series.find((block) => block.metric === "requests");
    expect(requests?.buckets.reduce((total, bucket) => total + Number(bucket.total), 0)).toBe(summary.summary.requests);
    expect(summary.models.reduce((total, model) => total + model.requests, 0)).toBe(summary.summary.requests);
  });

  it("groups several models and key versions into one activity, as a mixed task does", () => {
    const activities = activitiesResponse(SCENARIOS.main(), { range: "all", displayCurrency: "CNY", page: 1, pageSize: 50 });
    expect(activities.items.some((item) => item.models.length > 1)).toBe(true);
    expect(activities.items.some((item) => item.credentialVersions.length > 1)).toBe(true);
    expect(new Set(activities.items.map((item) => item.kind))).toEqual(new Set(["task", "chat", "test", "content_day", "deleted_day"]));
  });

  it("covers both currencies in the dual scenario and none in the empty one", () => {
    expect(summaryResponse(SCENARIOS.dual(), { range: "all", displayCurrency: "CNY" }).currencies.toSorted()).toEqual(["CNY", "USD"]);
    expect(summaryResponse(SCENARIOS.main(), { range: "all", displayCurrency: "CNY" }).currencies).toEqual(["CNY"]);
    const empty = summaryResponse(SCENARIOS.empty(), { range: "all", displayCurrency: "CNY" });
    expect(empty.summary.requests).toBe(0);
    expect(empty.range.from).toBeNull();
  });
});
