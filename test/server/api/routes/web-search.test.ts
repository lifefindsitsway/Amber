import { afterEach, describe, expect, it } from "vitest";
import { registerWebSearchRoutes } from "../../../../src/server/api/routes/web-search.ts";
import { WebSearchService } from "../../../../src/server/application/web-search.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "../../../../src/server/ports/web-search.ts";
import { webSearchProfileDtoSchema } from "../../../../src/shared/dto/web-search.ts";
import { BOB, BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const KEY = "tvly-test-route-key";
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

class FakeProvider implements WebSearchProvider {
  readonly service = "tavily";
  readonly keys: string[] = [];
  failWith: Error | undefined;
  async search(_query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    this.keys.push(options.apiKey);
    if (this.failWith !== undefined) throw this.failWith;
    return [{ url: "https://a.example.com/", title: "A", content: "a", score: 1 }];
  }
}

async function setup() {
  const h = createHarness();
  open.push(h);
  const provider = new FakeProvider();
  const webSearch = new WebSearchService({
    repository: h.repository,
    secrets: h.secrets,
    providers: [provider],
    llm: { complete: async () => ({ invocationId: "i", text: "{}", stopReason: "stop" }) },
  });
  const { app } = await h.app({ extraRoutes: (instance) => registerWebSearchRoutes(instance, { webSearch }) });
  return { h, app, provider };
}

const secretCount = (h: Harness): number => (h.db.prepare("SELECT count(*) AS n FROM secret").get() as { n: number }).n;

describe("/api/web-search", () => {
  it("chooses the service, stores the key without ever echoing it, and keeps users apart", async () => {
    const { h, app } = await setup();
    const empty = await app.inject({ method: "GET", url: "/api/web-search", headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ credentialStatus: "missing" });

    const chosen = await app.inject({ method: "PUT", url: "/api/web-search", headers: auth, payload: { service: "tavily" } });
    expect(chosen.statusCode).toBe(200);
    expect(webSearchProfileDtoSchema.parse(chosen.json())).toEqual({ service: "tavily", credentialStatus: "missing" });

    const before = secretCount(h);
    const keyed = await app.inject({ method: "PUT", url: "/api/web-search/credential", headers: auth, payload: { value: KEY } });
    expect(keyed.statusCode).toBe(200);
    expect(keyed.json()).toEqual({ service: "tavily", credentialStatus: "configured" });
    expect(keyed.body).not.toContain(KEY);
    expect(secretCount(h)).toBe(before + 1);
    const read = await app.inject({ method: "GET", url: "/api/web-search", headers: auth });
    expect(read.json()).toEqual({ service: "tavily", credentialStatus: "configured" });
    expect(read.body).not.toContain(KEY);

    expect((await app.inject({ method: "GET", url: "/api/web-search", headers: bob })).json()).toEqual({ credentialStatus: "missing" });
    // Bob's delete touches only his own (absent) profile.
    expect((await app.inject({ method: "DELETE", url: "/api/web-search", headers: bob })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/web-search", headers: auth })).json()).toEqual({ service: "tavily", credentialStatus: "configured" });
    expect(h.repository.withTransaction((scope) => scope.webSearchProfiles.get(BOB.userId))).toBeUndefined();
  });

  it("deletes the profile with its Secret", async () => {
    const { h, app } = await setup();
    await app.inject({ method: "PUT", url: "/api/web-search/credential", headers: auth, payload: { value: KEY } });
    const before = secretCount(h);
    const deleted = await app.inject({ method: "DELETE", url: "/api/web-search", headers: auth });
    expect(deleted.statusCode).toBe(204);
    expect(secretCount(h)).toBe(before - 1);
    expect(h.repository.withTransaction((scope) => scope.webSearchProfiles.get(LOCAL.userId))).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/web-search", headers: auth })).json()).toEqual({ credentialStatus: "missing" });
  });

  it("tests with the caller's own key and reports a failure as its AppError", async () => {
    const { app, provider } = await setup();
    const unconfigured = await app.inject({ method: "POST", url: "/api/web-search/test", headers: auth });
    expect(unconfigured.statusCode).toBe(422);
    expect(unconfigured.json().error).toMatchObject({ code: "web_search_failed.unconfigured", action: "configure_web_search" });

    await app.inject({ method: "PUT", url: "/api/web-search/credential", headers: auth, payload: { value: KEY } });
    const ok = await app.inject({ method: "POST", url: "/api/web-search/test", headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, resultCount: 1 });
    expect(provider.keys).toEqual([KEY]);

    provider.failWith = amberError("web_search_failed", "401", { code: "web_search_failed.auth" });
    const failed = await app.inject({ method: "POST", url: "/api/web-search/test", headers: auth });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error).toMatchObject({ code: "web_search_failed.auth", action: "configure_web_search" });
    expect(failed.body).not.toContain(KEY);

    expect((await app.inject({ method: "POST", url: "/api/web-search/test", headers: bob })).json().error.code).toBe("web_search_failed.unconfigured");
    expect(provider.keys).toEqual([KEY, KEY]);
  });

  it("validates bodies and requires authentication", async () => {
    const { app } = await setup();
    for (const [url, payload] of [
      ["/api/web-search", { service: "brave" }],
      ["/api/web-search", { service: "tavily", extra: 1 }],
      ["/api/web-search/credential", { value: "" }],
      ["/api/web-search/credential", { value: KEY, service: "tavily" }],
    ] as const) {
      const response = await app.inject({ method: "PUT", url, headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.body).not.toContain(KEY);
    }
    expect((await app.inject({ method: "GET", url: "/api/web-search" })).statusCode).toBe(401);
  });
});
