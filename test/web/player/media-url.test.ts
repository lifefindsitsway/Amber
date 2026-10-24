import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MediaAssetDto } from "../../../src/shared/dto/content.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import {
  allPlayableCaches,
  cacheHeight,
  localPlayable,
  mediaUrlOf,
  playableCache,
  playableCaches,
  playableVideoCaches,
  playbackAsset,
  usePlaybackMedia,
} from "../../../src/web/player/media-url.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

function asset(id: string, overrides: Partial<MediaAssetDto>): MediaAssetDto {
  return { id, kind: "external_local", mimeType: "video/mp4", sizeBytes: 1, availability: "available", retentionPolicy: "never_delete", createdAt: 1, ...overrides };
}

describe("mediaUrlOf", () => {
  it("serves uploads and caches over /api/media in server mode and never reads local paths there", async () => {
    const server = new ApiClient({ baseUrl: "" }, "server");
    const media = [asset("a1", { kind: "managed_upload", retentionPolicy: "keep" })];
    expect(await mediaUrlOf({ media }, server, false)).toBe("/api/media/a1");
    expect(await mediaUrlOf({ media: [asset("a2", { localPath: "/data/a.mp4" })] }, server, true)).toBeUndefined();
  });

  it("plays the local original or the platform cache through the asset protocol in the desktop client", async () => {
    const local = new ApiClient({ baseUrl: "http://127.0.0.1:1", token: "t" }, "local");
    const original = asset("a1", { localPath: "D:\\课程\\第一讲.mp4" });
    expect(await mediaUrlOf({ media: [original] }, local, true)).toBe(`asset://localhost/${encodeURIComponent("D:\\课程\\第一讲.mp4")}`);
    const cache = asset("c1", { kind: "platform_cache", retentionPolicy: "evictable", localPath: "/data/assets/c1.mp4" });
    expect(await mediaUrlOf({ media: [cache] }, local, true)).toBe(`asset://localhost/${encodeURIComponent("/data/assets/c1.mp4")}`);
    // Outside the client, missing files and assets without a path have no source.
    expect(await mediaUrlOf({ media: [original] }, local, false)).toBeUndefined();
    expect(await mediaUrlOf({ media: [asset("a3", { availability: "missing" })] }, local, true)).toBeUndefined();
    expect(localPlayable({ media: [asset("a4", {})] })).toBeUndefined();
  });

  it("knows when a platform video has a playable cache", () => {
    expect(playableCache({ media: [asset("c1", { kind: "platform_cache", localPath: "/c.mp4" })] })?.asset.id).toBe("c1");
    expect(playableCache({ media: [asset("c1", { kind: "platform_cache", availability: "evicted", localPath: "/c.mp4" })] })).toBeUndefined();
    expect(playableCache({ media: [asset("a1", { localPath: "/a.mp4" })] })).toBeUndefined();
  });

  it("prefers the video cache to the audio cache and flags an audio-only cache", () => {
    const video = asset("v1", { kind: "platform_cache", mimeType: "video/webm", retentionPolicy: "evictable", localPath: "D:\\media\\课程.webm" });
    const audio = asset("m1", { kind: "platform_cache", mimeType: "audio/mpeg", retentionPolicy: "evictable", localPath: "D:\\media\\课程.mp3" });
    // Order in the list does not matter: the video always wins.
    expect(playableCache({ media: [audio, video] })).toEqual({ asset: video, audioOnly: false });
    expect(playableCaches({ media: [audio, video] }).map((item) => item.id)).toEqual(["v1", "m1"]);
    expect(localPlayable({ media: [audio, video] })?.id).toBe("v1");
    expect(playableCache({ media: [audio] })).toEqual({ asset: audio, audioOnly: true });
    expect(localPlayable({ media: [audio] })?.id).toBe("m1");
    expect(playbackAsset({ media: [audio] }, "local", true)?.mimeType).toBe("audio/mpeg");
    expect(playbackAsset({ media: [audio] }, "local", false)).toBeUndefined();
  });

  it("keeps a local original ahead of any cache", () => {
    const audio = asset("m1", { kind: "platform_cache", mimeType: "audio/mpeg", retentionPolicy: "evictable", localPath: "/c.mp3" });
    const original = asset("a1", { localPath: "/a.mp4" });
    expect(localPlayable({ media: [audio, original] })?.id).toBe("a1");
  });

  it("orders the video caches by quality, unknown last and the newest first within one quality", () => {
    const video = (id: string, quality: string | undefined, createdAt: number) =>
      asset(id, { kind: "platform_cache", retentionPolicy: "evictable", localPath: `/m/${id}.mp4`, createdAt, ...(quality === undefined ? {} : { quality }) });
    const sd = video("sd", "720", 5);
    const hdOld = video("hd-old", "1080", 1);
    const hdNew = video("hd-new", "1080", 2);
    const unknown = video("unk", "", 9);
    const unrecorded = video("none", undefined, 8);
    const audio = asset("m1", { kind: "platform_cache", mimeType: "audio/mpeg", retentionPolicy: "evictable", localPath: "/m/a.mp3" });
    const media = [unknown, sd, audio, hdOld, unrecorded, hdNew, video("gone", "2160", 3)];
    media[6] = { ...(media[6] as MediaAssetDto), availability: "evicted" };
    expect(playableVideoCaches({ media }).map((item) => item.id)).toEqual(["hd-new", "hd-old", "sd", "unk", "none"]);
    expect(playableCaches({ media }).map((item) => item.id)).toEqual(["hd-new", "m1"]);
    expect(allPlayableCaches({ media }).map((item) => item.id)).toEqual(["hd-new", "hd-old", "sd", "unk", "none", "m1"]);
    expect(playableCache({ media })?.asset.id).toBe("hd-new");
    // A chosen cache plays while it exists; otherwise the best one does.
    expect(localPlayable({ media }, "sd")?.id).toBe("sd");
    expect(localPlayable({ media }, "gone")?.id).toBe("hd-new");
    expect(playbackAsset({ media }, "local", true, "unk")?.id).toBe("unk");
    expect([cacheHeight({ quality: "1080" }), cacheHeight({ quality: "" }), cacheHeight({}), cacheHeight({ quality: "abc" }), cacheHeight({ quality: "0" })]).toEqual([
      1080,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // A recorded height not yet checked against the file is no more than a guess until it is.
    expect([cacheHeight({ quality: "1080", qualityVerified: false }), cacheHeight({ quality: "1080", qualityVerified: true })]).toEqual([undefined, 1080]);
    const unverified = asset("guess", { kind: "platform_cache", retentionPolicy: "evictable", localPath: "/m/guess.mp4", quality: "2160", qualityVerified: false });
    expect(playableVideoCaches({ media: [...media, unverified] }).map((item) => item.id).at(-1)).toBe("guess");
  });

  it("serves an upload first and else the chosen or best video cache in server mode", () => {
    const upload = asset("up", { kind: "managed_upload", retentionPolicy: "keep" });
    const hd = asset("hd", { kind: "platform_cache", retentionPolicy: "evictable", quality: "1080" });
    const sd = asset("sd", { kind: "platform_cache", retentionPolicy: "evictable", quality: "720" });
    expect(playbackAsset({ media: [sd, hd, upload] }, "server", false)?.id).toBe("up");
    expect(playbackAsset({ media: [sd, hd] }, "server", false)?.id).toBe("hd");
    expect(playbackAsset({ media: [sd, hd] }, "server", false, "sd")?.id).toBe("sd");
  });
});

describe("usePlaybackMedia", () => {
  const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", token: "t" }, "local");
  function wrapper(props: { children: ReactNode }) {
    return createElement(ApiProvider, { client, queryClient: createQueryClient(), children: props.children });
  }
  const cacheOf = (id: string, quality: string) => asset(id, { kind: "platform_cache", retentionPolicy: "evictable", quality, localPath: `/m/${id}.mp4` });
  const urlOf = (id: string) => `asset://localhost/${encodeURIComponent(`/m/${id}.mp4`)}`;

  it("hands over the URL and the asset id together, and drops them at once for another Content", async () => {
    fakeShell.desktop = true;
    const first = { id: "c1", media: [cacheOf("sd", "720"), cacheOf("hd", "1080")] };
    const initialProps: { content: typeof first; assetId?: string } = { content: first };
    const { result, rerender } = renderHook((props: { content: typeof first; assetId?: string }) => usePlaybackMedia(props.content, props.assetId), {
      wrapper,
      initialProps,
    });
    expect(result.current).toEqual({ src: undefined, assetId: undefined, audioOnly: false });
    await waitFor(() => expect(result.current).toEqual({ src: urlOf("hd"), assetId: "hd", audioOnly: false }));

    // Until the new URL is known, the previous pair stays as it was.
    rerender({ content: first, assetId: "sd" });
    expect([result.current.src, result.current.assetId]).toEqual([urlOf("hd"), "hd"]);
    await waitFor(() => expect(result.current).toEqual({ src: urlOf("sd"), assetId: "sd", audioOnly: false }));

    rerender({ content: { id: "c2", media: [cacheOf("other", "480")] } });
    expect(result.current).toEqual({ src: undefined, assetId: undefined, audioOnly: false });
    await waitFor(() => expect(result.current.assetId).toBe("other"));
  });

  it("flags an audio-only cache and has no source without a playable file", async () => {
    fakeShell.desktop = true;
    const audio = asset("m1", { kind: "platform_cache", mimeType: "audio/mpeg", retentionPolicy: "evictable", localPath: "/m/a.mp3" });
    const { result, rerender } = renderHook((props: { media: MediaAssetDto[] }) => usePlaybackMedia({ id: "c1", media: props.media }), {
      wrapper,
      initialProps: { media: [audio] },
    });
    await waitFor(() => expect(result.current).toEqual({ src: `asset://localhost/${encodeURIComponent("/m/a.mp3")}`, assetId: "m1", audioOnly: true }));
    rerender({ media: [] });
    await waitFor(() => expect(result.current).toEqual({ src: undefined, assetId: undefined, audioOnly: false }));
  });
});
