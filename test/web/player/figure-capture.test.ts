import { describe, expect, it } from "vitest";
import type { MediaAssetDto } from "../../../src/shared/dto/content.ts";
import { capturableAssetIds, captureTimeMs, frameSources } from "../../../src/web/player/figure-capture.ts";

describe("captureTimeMs", () => {
  it("takes the playback position in whole milliseconds when the frame on screen is unknown", () => {
    expect(captureTimeMs({ currentMs: 25_432.7, durationMs: 130_000, frameMs: undefined })).toBe(25_432);
    expect(captureTimeMs({ currentMs: 0, durationMs: undefined, frameMs: undefined })).toBe(0);
  });

  it("keeps a guessed time a frame before the end: stopped at the end there is no frame at or after it", () => {
    expect(captureTimeMs({ currentMs: 130_000, durationMs: 130_000, frameMs: undefined })).toBe(129_900);
    expect(captureTimeMs({ currentMs: 129_950, durationMs: 130_000, frameMs: undefined })).toBe(129_900);
    expect(captureTimeMs({ currentMs: 129_899, durationMs: 130_000, frameMs: undefined })).toBe(129_899);
  });

  it("takes the start of the frame on screen when the browser reports it, which is also before the end", () => {
    // Paused mid-frame: the frame shown started at 25.4 s, the position is a little later.
    expect(captureTimeMs({ currentMs: 25_460, durationMs: 130_000, frameMs: 25_400 })).toBe(25_400);
    // Stopped at the end: the last frame (10 fps) is what is on screen.
    expect(captureTimeMs({ currentMs: 130_000, durationMs: 130_000, frameMs: 129_900 })).toBe(129_900);
    // A frame time a hair past the position (rounding during playback) is still that frame.
    expect(captureTimeMs({ currentMs: 10_000, durationMs: 130_000, frameMs: 10_020.4 })).toBe(10_020);
  });

  it("ignores a frame time left over from before a seek", () => {
    expect(captureTimeMs({ currentMs: 60_000, durationMs: 130_000, frameMs: 25_400 })).toBe(60_000);
    expect(captureTimeMs({ currentMs: 20_000, durationMs: 130_000, frameMs: 25_400 })).toBe(20_000);
  });

  it("never goes below zero or follows a broken position or length", () => {
    expect(captureTimeMs({ currentMs: Number.NaN, durationMs: 130_000, frameMs: undefined })).toBe(0);
    expect(captureTimeMs({ currentMs: 50, durationMs: 60, frameMs: undefined })).toBe(0);
    expect(captureTimeMs({ currentMs: 5_000, durationMs: Number.POSITIVE_INFINITY, frameMs: undefined })).toBe(5_000);
  });
});

const asset = (overrides: Partial<MediaAssetDto>): MediaAssetDto => ({
  id: "a",
  kind: "managed_upload",
  mimeType: "video/mp4",
  sizeBytes: 1,
  availability: "available",
  retentionPolicy: "keep",
  createdAt: 1,
  ...overrides,
});

describe("capturableAssetIds", () => {
  it("offers originals and caches that are videos available now, nothing else", () => {
    expect(
      capturableAssetIds([
        asset({ id: "upload" }),
        asset({ id: "local", kind: "external_local", retentionPolicy: "never_delete" }),
        asset({ id: "cache", kind: "platform_cache", mimeType: "video/mp4", retentionPolicy: "evictable" }),
        asset({ id: "audio-cache", kind: "platform_cache", mimeType: "audio/mp4", retentionPolicy: "evictable" }),
        asset({ id: "audio", mimeType: "audio/mpeg" }),
        asset({ id: "extracted", kind: "extracted_audio", mimeType: "video/webm", retentionPolicy: "ephemeral" }),
        asset({ id: "missing", kind: "external_local", availability: "missing", retentionPolicy: "never_delete" }),
      ]),
    ).toEqual(["upload", "local", "cache"]);
  });
});

describe("frameSources", () => {
  it("clears only the source it set", () => {
    const first = frameSources.set({ kind: "audio", contentId: "c1" });
    const second = frameSources.set({ kind: "audio", contentId: "c2" });
    first();
    expect(frameSources.snapshot()?.contentId).toBe("c2");
    second();
    expect(frameSources.snapshot()).toBeUndefined();
  });
});
