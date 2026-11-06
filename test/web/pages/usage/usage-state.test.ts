import { describe, expect, it } from "vitest";
import { encodeModelKey, encodeProfileKey } from "../../../../src/shared/dto/usage-analytics.ts";
import {
  activitiesQueryOf,
  defaultUsageCurrency,
  hasUsageFilter,
  parseUsageState,
  patchUsageSearch,
  summaryQueryOf,
  usageStateToSearch,
  type UsageState,
} from "../../../../src/web/pages/usage/usage-state.ts";

const PROFILE = encodeProfileKey(["llm", "relay"]);
const MODEL = encodeModelKey(["llm", "relay", "gpt-5.6-sol"]);

const FULL: UsageState = {
  range: "custom",
  from: 1_793_000_000_000,
  to: 1_793_086_400_000,
  currency: "USD",
  profileKey: PROFILE,
  credentialVersion: "relay-v2",
  modelKey: MODEL,
  granularity: "hour",
  view: "models",
  metric: "llm_tokens",
  simulate: true,
};

describe("usage page state in the address", () => {
  it("round-trips every piece of state", () => {
    const search = usageStateToSearch(FULL);
    expect(Object.fromEntries(search)).toEqual({
      range: "custom",
      from: "1793000000000",
      to: "1793086400000",
      currency: "USD",
      profile: PROFILE,
      credential: "relay-v2",
      model: MODEL,
      granularity: "hour",
      view: "models",
      metric: "llm_tokens",
      simulate: "1",
    });
    expect(parseUsageState(search)).toEqual(FULL);
  });

  it("round-trips the page and page size the pager keeps beside it", () => {
    const base = new URLSearchParams("page=3&pageSize=20");
    const next = usageStateToSearch({ ...FULL, range: "30d" }, base);
    expect(next.get("page")).toBe("3");
    expect(next.get("pageSize")).toBe("20");
    expect(parseUsageState(next).range).toBe("30d");
  });

  it("leaves defaults out of the address and fills them in on reading", () => {
    expect(usageStateToSearch({ range: "7d", view: "trend", metric: "cost", simulate: false }).toString()).toBe("");
    expect(parseUsageState(new URLSearchParams(""))).toEqual({ range: "7d", view: "trend", metric: "cost", simulate: false });
  });

  it("falls back for anything malformed instead of failing", () => {
    const state = parseUsageState(new URLSearchParams("range=custom&from=5&to=2&currency=EUR&view=sideways&metric=x&granularity=year&credential=orphan"));
    expect(state).toEqual({ range: "7d", view: "trend", metric: "cost", simulate: false });
  });

  it("a credential version only counts with its profile", () => {
    expect(parseUsageState(new URLSearchParams("credential=v1")).credentialVersion).toBeUndefined();
    expect(parseUsageState(new URLSearchParams(`profile=${PROFILE}&credential=v1`)).credentialVersion).toBe("v1");
  });
});

describe("changing the state", () => {
  it("a preset range drops a drill-down's bounds and bucket size, and the page returns to the first", () => {
    const next = patchUsageSearch(new URLSearchParams(`range=custom&from=1&to=2&granularity=hour&page=4&pageSize=20`), { range: "30d" });
    expect(Object.fromEntries(next)).toEqual({ range: "30d", pageSize: "20" });
  });

  it("choosing another profile keeps no credential of the old one; clearing the profile clears its version", () => {
    const withVersion = new URLSearchParams(`profile=${PROFILE}&credential=v1`);
    expect(patchUsageSearch(withVersion, { profileKey: null }).has("credential")).toBe(false);
    expect(patchUsageSearch(withVersion, { credentialVersion: null }).get("profile")).toBe(PROFILE);
  });

  it("a view or metric change keeps the page", () => {
    const next = patchUsageSearch(new URLSearchParams("page=2&pageSize=10"), { view: "models", metric: "requests" });
    expect(next.get("page")).toBe("2");
    expect(next.get("view")).toBe("models");
    expect(next.get("metric")).toBe("requests");
  });

  it("the currency is written to the address like any other state", () => {
    expect(patchUsageSearch(new URLSearchParams(), { currency: "USD" }).get("currency")).toBe("USD");
  });
});

describe("queries built from the state", () => {
  it("send the filter and the display currency, and never the view or the metric", () => {
    expect(summaryQueryOf(FULL, "USD")).toEqual({
      range: "custom",
      from: FULL.from,
      to: FULL.to,
      profileKey: PROFILE,
      credentialVersion: "relay-v2",
      modelKey: MODEL,
      displayCurrency: "USD",
      granularity: "hour",
      simulate: "1",
    });
    expect(activitiesQueryOf(FULL, "USD", { page: 2, pageSize: 20 })).not.toHaveProperty("granularity");
    expect(summaryQueryOf({ range: "7d", view: "trend", metric: "cost", simulate: false }, "CNY")).toEqual({ range: "7d", displayCurrency: "CNY" });
  });

  it("know when a menu filter is set; the range and the currency are not filters", () => {
    expect(hasUsageFilter({ range: "30d", currency: "USD", view: "trend", metric: "cost", simulate: false })).toBe(false);
    expect(hasUsageFilter({ range: "7d", modelKey: MODEL, view: "trend", metric: "cost", simulate: false })).toBe(true);
  });
});

describe("the default display currency", () => {
  it("is the only currency of the history, else yuan", () => {
    expect(defaultUsageCurrency(["USD"])).toBe("USD");
    expect(defaultUsageCurrency(["CNY"])).toBe("CNY");
    expect(defaultUsageCurrency(["CNY", "USD"])).toBe("CNY");
    expect(defaultUsageCurrency([])).toBe("CNY");
  });
});
