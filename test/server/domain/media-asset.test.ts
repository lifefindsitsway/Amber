import { describe, expect, it } from "vitest";
import { defaultRetentionPolicy, needsQualityProbe, verifiedCacheHeight } from "../../../src/server/domain/media-asset.ts";
import { UPLOAD_RETENTION_DEFAULT } from "../../../src/shared/defaults.ts";

describe("defaultRetentionPolicy", () => {
  it("follows the five MediaAsset lifecycles", () => {
    expect(defaultRetentionPolicy("external_local", UPLOAD_RETENTION_DEFAULT)).toBe("never_delete");
    expect(defaultRetentionPolicy("managed_upload", UPLOAD_RETENTION_DEFAULT)).toBe(UPLOAD_RETENTION_DEFAULT);
    expect(defaultRetentionPolicy("platform_cache", UPLOAD_RETENTION_DEFAULT)).toBe("evictable");
    expect(defaultRetentionPolicy("extracted_audio", UPLOAD_RETENTION_DEFAULT)).toBe("ephemeral");
    expect(defaultRetentionPolicy("temporary", UPLOAD_RETENTION_DEFAULT)).toBe("ephemeral");
  });

  it("takes managed uploads from the effective instance setting and nothing else", () => {
    expect(defaultRetentionPolicy("managed_upload", "discard_after_audio")).toBe("discard_after_audio");
    expect(defaultRetentionPolicy("external_local", "discard_after_audio")).toBe("never_delete");
    expect(defaultRetentionPolicy("platform_cache", "discard_after_audio")).toBe("evictable");
  });
});

describe("verifiedCacheHeight / needsQualityProbe", () => {
  const video = { kind: "platform_cache" as const, mimeType: "video/mp4", availability: "available" as const };

  it("reads a verified quality as its tier, also an encoded height an earlier build recorded", () => {
    expect(verifiedCacheHeight({ ...video, quality: "720", qualityVerified: true })).toBe(720);
    expect(verifiedCacheHeight({ ...video, quality: "714", qualityVerified: true })).toBe(720);
    expect(verifiedCacheHeight({ ...video, quality: "1072", qualityVerified: true })).toBe(1080);
    expect(verifiedCacheHeight({ ...video, quality: "720" })).toBeUndefined();
    expect(verifiedCacheHeight({ ...video, quality: "", qualityVerified: true })).toBeUndefined();
    expect(verifiedCacheHeight({ ...video, mimeType: "audio/mpeg", quality: "720", qualityVerified: true })).toBeUndefined();
  });

  it("probes an available video cache never verified or recorded as a height that is not a tier", () => {
    expect(needsQualityProbe({ ...video, quality: "1080" })).toBe(true);
    expect(needsQualityProbe({ ...video, quality: "714", qualityVerified: true })).toBe(true);
    expect(needsQualityProbe({ ...video, quality: "720", qualityVerified: true })).toBe(false);
    expect(needsQualityProbe({ ...video, quality: "", qualityVerified: true })).toBe(false);
    expect(needsQualityProbe({ ...video, quality: "5000", qualityVerified: true })).toBe(false);
    expect(needsQualityProbe({ ...video, availability: "evicted", quality: "1080" })).toBe(false);
    expect(needsQualityProbe({ ...video, mimeType: "audio/mpeg" })).toBe(false);
  });
});
