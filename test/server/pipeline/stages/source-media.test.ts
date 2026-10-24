import { afterEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import { availableMediaSource, availableVideoSource, bestVideoCache, videoCachesBestFirst } from "../../../../src/server/pipeline/stages/source-media.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../../fixtures/pipeline/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const contentId = createLocalContent(h);
  const add = (fields: Partial<MediaAsset> & Pick<MediaAsset, "kind" | "mimeType" | "createdAt">): MediaAsset => {
    const id = h.newId();
    const asset: MediaAsset = {
      id,
      userId: LOCAL.userId,
      contentId,
      storageRef: `media/${id}`,
      sizeBytes: 1,
      availability: "available",
      retentionPolicy: fields.kind === "platform_cache" ? "evictable" : "keep",
      ...fields,
    };
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
    return asset;
  };
  const pick = (choose: typeof availableMediaSource) => h.repository.withTransaction((scope) => choose(scope, LOCAL.userId, contentId))?.id;
  const order = () => h.repository.withTransaction((scope) => videoCachesBestFirst(scope, LOCAL.userId, contentId)).map((asset) => asset.id);
  return { add, pick, order };
}

describe("availableVideoSource / availableMediaSource", () => {
  it("prefer the original, then the latest video cache; only audio work falls back to an audio cache", () => {
    const { add, pick } = setup();
    const audio = add({ kind: "platform_cache", mimeType: "audio/mpeg", createdAt: 3 });
    expect(pick(availableVideoSource)).toBeUndefined();
    expect(pick(availableMediaSource)).toBe(audio.id);

    add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 1 });
    const newerVideo = add({ kind: "platform_cache", mimeType: "video/webm", createdAt: 2 });
    add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 4, availability: "evicted" });
    expect(pick(availableVideoSource)).toBe(newerVideo.id);
    expect(pick(availableMediaSource)).toBe(newerVideo.id);

    const original = add({ kind: "managed_upload", mimeType: "video/mp4", createdAt: 0 });
    expect(pick(availableVideoSource)).toBe(original.id);
    expect(pick(availableMediaSource)).toBe(original.id);
  });
});

describe("bestVideoCache", () => {
  it("prefers the highest verified height, the newest among equals, and unverified or unknown quality last", () => {
    const { add, pick, order } = setup();
    const unverified = add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 9, quality: "2160" });
    const unknown = add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 8, quality: "", qualityVerified: true });
    const older720 = add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 1, quality: "720", qualityVerified: true });
    const newer720 = add({ kind: "platform_cache", mimeType: "video/webm", createdAt: 2, quality: "720", qualityVerified: true });
    expect(pick(bestVideoCache)).toBe(newer720.id);
    const best = add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 0, quality: "1080", qualityVerified: true });
    add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 3, quality: "1440", qualityVerified: true, availability: "evicted" });
    expect(pick(bestVideoCache)).toBe(best.id);
    expect(pick(availableVideoSource)).toBe(best.id);
    expect(order()).toEqual([best.id, newer720.id, older720.id, unverified.id, unknown.id]);
  });
});
