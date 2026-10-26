import { afterEach, describe, expect, it } from "vitest";
import type { WebSearchProfile } from "../../../../../src/server/domain/web-search.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  open.push(h);
  const get = (owner: string) => h.repository.withTransaction((scope) => scope.webSearchProfiles.get(owner));
  const put = (profile: WebSearchProfile) => h.repository.withTransaction((scope) => scope.webSearchProfiles.put(profile));
  const secrets = (): number => (h.db.prepare("SELECT count(*) AS n FROM secret").get() as { n: number }).n;
  return { h, get, put, secrets };
}

describe("web search profile repository", () => {
  it("keeps one profile per owner and round-trips it", () => {
    const { h, get, put } = setup();
    const credentialRef = h.secrets.store(LOCAL.userId, "tvly-placeholder");
    put({ userId: LOCAL.userId, service: "tavily", createdAt: 1, updatedAt: 1 });
    put({ userId: LOCAL.userId, service: "tavily", credentialRef, createdAt: 1, updatedAt: 2 });
    expect(get(LOCAL.userId)).toEqual({ userId: LOCAL.userId, service: "tavily", credentialRef, createdAt: 1, updatedAt: 2 });
    expect(get(BOB.userId)).toBeUndefined();
    expect(h.db.prepare("SELECT count(*) AS n FROM web_search_profile").get()).toEqual({ n: 1 });
  });

  it("refuses another owner's Secret as its reference", () => {
    const { h, put } = setup();
    const bobsRef = h.secrets.store(BOB.userId, "tvly-placeholder");
    expect(() => put({ userId: LOCAL.userId, service: "tavily", credentialRef: bobsRef, createdAt: 1, updatedAt: 1 })).toThrow();
  });

  it("deletes the Secret with the profile, and a credential reset drops only the references", () => {
    const { h, get, put, secrets } = setup();
    const before = secrets();
    put({ userId: LOCAL.userId, service: "tavily", credentialRef: h.secrets.store(LOCAL.userId, "tvly-a"), createdAt: 1, updatedAt: 1 });
    put({ userId: BOB.userId, service: "tavily", credentialRef: h.secrets.store(BOB.userId, "tvly-b"), createdAt: 1, updatedAt: 1 });
    expect(secrets()).toBe(before + 2);
    expect(h.repository.withTransaction((scope) => scope.webSearchProfiles.delete(LOCAL.userId))).toBe(true);
    expect(h.repository.withTransaction((scope) => scope.webSearchProfiles.delete(LOCAL.userId))).toBe(false);
    expect(secrets()).toBe(before + 1);
    h.repository.withTransaction((scope) => scope.webSearchProfiles.clearCredentials());
    expect(get(BOB.userId)).toEqual({ userId: BOB.userId, service: "tavily", createdAt: 1, updatedAt: 1 });
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("goes with its owner, Secret included", () => {
    const { h, put, secrets } = setup();
    const before = secrets();
    put({ userId: BOB.userId, service: "tavily", credentialRef: h.secrets.store(BOB.userId, "tvly-b"), createdAt: 1, updatedAt: 1 });
    h.db.prepare("DELETE FROM user WHERE id = ?").run(BOB.userId);
    expect(h.db.prepare("SELECT count(*) AS n FROM web_search_profile").get()).toEqual({ n: 0 });
    expect(secrets()).toBe(before);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });
});
