import { describe, expect, it } from "vitest";
import { CollectionPreviewCache, type CollectionPreviewBinding } from "../../../src/server/application/collection-preview-cache.ts";
import { COLLECTION_PREVIEW_CACHE_MAX, COLLECTION_PREVIEW_PER_USER_MAX, COLLECTION_PREVIEW_TTL_MS } from "../../../src/shared/defaults.ts";

const T0 = 1_800_000_000_000;

function binding(ownerUserId: string, platformCollectionId = "1_2"): CollectionPreviewBinding {
  return { ownerUserId, platform: "bilibili", platformCollectionId, withLogin: false };
}

function cacheAt() {
  const clock = { now: T0 };
  let n = 0;
  const cache = new CollectionPreviewCache({ now: () => clock.now, newId: () => `preview-${++n}` });
  const store = (bound: CollectionPreviewBinding) => cache.store({ ...bound, title: "t", entries: [], truncated: false, resolved: new Map() }).id;
  return { cache, clock, store };
}

describe("CollectionPreviewCache", () => {
  it("serves a preview only to its own user, platform, collection and login state", () => {
    const { cache, store } = cacheAt();
    const id = store(binding("alice"));
    expect(cache.find(id, binding("alice"))?.id).toBe(id);
    expect(cache.find(id, binding("bob"))).toBeUndefined();
    expect(cache.find(id, binding("alice", "1_3"))).toBeUndefined();
    expect(cache.find(id, { ...binding("alice"), platform: "youtube" })).toBeUndefined();
    expect(cache.find(id, { ...binding("alice"), withLogin: true })).toBeUndefined();
    expect(cache.find("unknown", binding("alice"))).toBeUndefined();
  });

  it(`forgets a preview COLLECTION_PREVIEW_TTL_MS after storing it`, () => {
    const { cache, clock, store } = cacheAt();
    const id = store(binding("alice"));
    clock.now = T0 + COLLECTION_PREVIEW_TTL_MS - 1;
    expect(cache.find(id, binding("alice"))).toBeDefined();
    clock.now = T0 + COLLECTION_PREVIEW_TTL_MS;
    expect(cache.find(id, binding("alice"))).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("drops the user's oldest past COLLECTION_PREVIEW_PER_USER_MAX, leaving other users alone", () => {
    const { cache, store } = cacheAt();
    const bobs = store(binding("bob"));
    const alices = Array.from({ length: COLLECTION_PREVIEW_PER_USER_MAX + 1 }, () => store(binding("alice")));
    expect(cache.find(alices[0] as string, binding("alice"))).toBeUndefined();
    for (const id of alices.slice(1)) expect(cache.find(id, binding("alice"))).toBeDefined();
    expect(cache.find(bobs, binding("bob"))).toBeDefined();
    expect(cache.size).toBe(COLLECTION_PREVIEW_PER_USER_MAX + 1);
  });

  it("drops the oldest of anyone's past COLLECTION_PREVIEW_CACHE_MAX and never refuses a new preview", () => {
    const { cache, store } = cacheAt();
    const ids = Array.from({ length: COLLECTION_PREVIEW_CACHE_MAX + 2 }, (_, index) => {
      const user = `user-${index}`;
      return { id: store(binding(user)), user };
    });
    expect(cache.size).toBe(COLLECTION_PREVIEW_CACHE_MAX);
    expect(ids.slice(0, 2).map(({ id, user }) => cache.find(id, binding(user)))).toEqual([undefined, undefined]);
    expect(ids.slice(2).every(({ id, user }) => cache.find(id, binding(user)) !== undefined)).toBe(true);
  });

  it("issues ids no one can guess by default", () => {
    const cache = new CollectionPreviewCache();
    const ids = new Set(Array.from({ length: 8 }, (_, index) => cache.store({ ...binding(`u${index}`), title: "t", entries: [], truncated: false, resolved: new Map() }).id));
    expect(ids.size).toBe(8);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
