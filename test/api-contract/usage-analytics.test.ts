import { afterEach, describe, expect, it } from "vitest";
import { SqliteUsageAnalyticsRepository } from "../../src/server/adapters/sqlite/repositories/usage-analytics.ts";
import { registerUsageRoutes } from "../../src/server/api/routes/usage.ts";
import { UsageAnalyticsService } from "../../src/server/application/usage-analytics.ts";
import { UsageService } from "../../src/server/application/usage.ts";
import {
  encodeModelKey,
  usageActivitiesResponseSchema,
  usageCacheObservedResponseSchema,
  usageCallsResponseSchema,
  usageSummaryResponseSchema,
} from "../../src/shared/dto/usage-analytics.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, type Harness } from "../fixtures/pipeline/harness.ts";
import { HOUR, insertAsrUsage, insertContent, insertLlmUsage, insertTask } from "../fixtures/usage/rows.ts";

/**
 * The four analysis routes under `/api/usage/`, with the harness's local owner and a second user.
 * The service runs on the real clock here, so rows are placed relative to the current time.
 */

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const PRICE = {
  currency: "CNY",
  items: [
    { unit: "input_tokens_per_million", amount: "2" },
    { unit: "output_tokens_per_million", amount: "8" },
    { unit: "cached_input_tokens_per_million", amount: "1" },
  ],
};
const BASE = "range=30d&displayCurrency=CNY";

async function setup() {
  const h = createHarness();
  open.push(h);
  const usage = new UsageService({ repository: h.repository });
  const analytics = new UsageAnalyticsService({ repository: new SqliteUsageAnalyticsRepository(h.db) });
  const sentAt = Date.now() - HOUR;
  insertContent(h.db, "c-1", { userId: LOCAL.userId });
  insertTask(h.db, "t-1", "c-1", LOCAL.userId);
  insertLlmUsage(h.db, {
    id: "l-1", userId: LOCAL.userId, taskId: "t-1", contentId: "c-1", sentAt, input: 1_000_000, output: 250_000, cacheRead: 100, snapshot: PRICE, credentialVersion: "v1",
  });
  insertAsrUsage(h.db, { id: "a-1", userId: LOCAL.userId, taskId: "t-1", contentId: "c-1", sentAt: sentAt + 1000, audioMs: 61_000 });
  const { app } = await h.app({ extraRoutes: (instance) => registerUsageRoutes(instance, { usage, analytics }) });
  return { app, h };
}

describe("GET /api/usage/summary", () => {
  it("answers the owner's usage in the contract's shape and nothing of anyone else's", async () => {
    const { app, h } = await setup();
    insertLlmUsage(h.db, { id: "b-1", userId: "bob", sentAt: Date.now() - HOUR, input: 9, output: 9 });
    const mine = await app.inject({ method: "GET", url: `/api/usage/summary?${BASE}&simulate=1`, headers: auth });
    expect(mine.statusCode).toBe(200);
    const body = usageSummaryResponseSchema.parse(mine.json());
    expect(body.summary.requests).toBe(2);
    expect(body.summary.cost.amount).toEqual({ currency: "CNY", amount: "3.9999" });
    expect(body.costDetail.simulated).toMatchObject({ requests: 0, unavailable: 1 });
    expect(body.models).toHaveLength(2);
    const theirs = await app.inject({ method: "GET", url: `/api/usage/summary?${BASE}`, headers: bob });
    expect(usageSummaryResponseSchema.parse(theirs.json()).summary.requests).toBe(1);
  });

  it("refuses a bad query with 400 and a too-fine granularity with the suggestion", async () => {
    const { app } = await setup();
    for (const query of [
      "displayCurrency=CNY",
      "range=30d",
      "range=yesterday&displayCurrency=CNY",
      "range=30d&displayCurrency=EUR",
      "range=custom&displayCurrency=CNY&from=1",
      "range=30d&displayCurrency=CNY&from=1&to=2",
      "range=30d&displayCurrency=CNY&credentialVersion=v1",
      "range=30d&displayCurrency=CNY&profileKey=nope",
      "range=30d&displayCurrency=CNY&other=1",
    ]) {
      const response = await app.inject({ method: "GET", url: `/api/usage/summary?${query}`, headers: auth });
      expect([query, response.statusCode]).toEqual([query, 400]);
    }
    const tooFine = await app.inject({ method: "GET", url: `/api/usage/summary?${BASE}&granularity=hour`, headers: auth });
    expect(tooFine.statusCode).toBe(400);
    expect(tooFine.json().error).toMatchObject({ class: "invalid_request", details: { suggestedGranularity: "day" } });
  });
});

describe("GET /api/usage/activities and /api/usage/calls", () => {
  it("lists the grouped activities, pages them, and opens a group into its calls", async () => {
    const { app } = await setup();
    const listed = await app.inject({ method: "GET", url: `/api/usage/activities?${BASE}&page=1&pageSize=10`, headers: auth });
    expect(listed.statusCode).toBe(200);
    const page = usageActivitiesResponseSchema.parse(listed.json());
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 10, items: [{ kind: "task", requests: 2, taskId: "t-1", contentId: "c-1" }] });

    const calls = await app.inject({ method: "GET", url: `/api/usage/calls?${BASE}&group=${page.items[0]?.group as string}`, headers: auth });
    expect(calls.statusCode).toBe(200);
    expect(usageCallsResponseSchema.parse(calls.json()).items.map((item) => item.id)).toEqual(["l-1", "a-1"]);
  });

  it("refuses a page size outside the allowed set and a group that is not this owner's", async () => {
    const { app } = await setup();
    const listed = await app.inject({ method: "GET", url: `/api/usage/activities?${BASE}`, headers: auth });
    const group = usageActivitiesResponseSchema.parse(listed.json()).items[0]?.group as string;
    expect((await app.inject({ method: "GET", url: `/api/usage/activities?${BASE}&pageSize=7`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/usage/activities?${BASE}&page=0`, headers: auth })).statusCode).toBe(400);
    for (const url of [`/api/usage/calls?${BASE}`, `/api/usage/calls?${BASE}&group=%21%21`, `/api/usage/calls?${BASE}&group=${group}A`]) {
      expect([url, (await app.inject({ method: "GET", url, headers: auth })).statusCode]).toEqual([url, 400]);
    }
    const foreign = await app.inject({ method: "GET", url: `/api/usage/calls?${BASE}&group=${group}`, headers: bob });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.class).toBe("invalid_request");
    expect(foreign.body).not.toContain("l-1");
  });
});

describe("GET /api/usage/cache-observed", () => {
  it("lists the owner's models with a cache read and takes no query", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/usage/cache-observed", headers: auth });
    expect(usageCacheObservedResponseSchema.parse(response.json())).toEqual({ models: [{ modelKey: encodeModelKey(["llm", "p-1", "model-a"]) }] });
    expect((await app.inject({ method: "GET", url: "/api/usage/cache-observed", headers: bob })).json()).toEqual({ models: [] });
    expect((await app.inject({ method: "GET", url: "/api/usage/cache-observed?x=1", headers: auth })).statusCode).toBe(400);
  });

  it("is not shadowed by the older listing", async () => {
    const { app } = await setup();
    const listing = await app.inject({ method: "GET", url: "/api/usage", headers: auth });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toHaveProperty("totals");
  });
});
