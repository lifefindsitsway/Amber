import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlatCacheFileStore } from "../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { SplitMediaFiles } from "../../../src/server/pipeline/media-files.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

function setup() {
  const dataDir = tempDataDir("amber-media-files-");
  const data = new LocalFileStore(dataDir);
  const media = new SplitMediaFiles(data, (dir, options) => new FlatCacheFileStore(dir, options), join(dataDir, "media"));
  return { dataDir, data, media };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("SplitMediaFiles", () => {
  it("keeps platform_cache in the flat cache store under <data dir>/media by default", async () => {
    const { dataDir, data, media } = setup();
    expect(media.hasCustomRoot()).toBe(false);
    expect(media.cache.root()).toBeUndefined();
    expect(media.cache.directory()).toBe(join(dataDir, "media"));
    expect(media.storeFor("platform_cache")).toBe(media.cache);
    for (const kind of ["external_local", "managed_upload", "extracted_audio", "temporary"] as const) {
      expect(media.storeFor(kind)).toBe(data);
    }
    expect(await media.cache.isAvailable()).toBe(true);
    await media.cache.writeAtomic("media/第 1 讲.mp4", Buffer.from("x"));
    // One `media` level only: the logical ref's prefix is the directory itself.
    expect(existsSync(join(dataDir, "media", "第 1 讲.mp4"))).toBe(true);
    expect(existsSync(join(dataDir, "media", "media"))).toBe(false);
    expect(await media.cache.list("media")).toEqual(["media/第 1 讲.mp4"]);
  });

  it("moves the cache store to a custom media directory", async () => {
    const { dataDir, media } = setup();
    const root = join(tempDataDir("amber-cache-"), "media");
    mkdirSync(root);
    media.cache.setRoot(root);
    expect(media.hasCustomRoot()).toBe(true);
    expect(media.cache.root()).toBe(root);
    expect(media.cache.directory()).toBe(root);
    expect(media.cache.defaultDirectory()).toBe(join(dataDir, "media"));
    const stored = await media.cache.writeAtomic("media/a.mp3", Buffer.from("cache"));
    expect(existsSync(join(root, "a.mp3"))).toBe(true);
    expect(existsSync(join(dataDir, "media", "a.mp3"))).toBe(false);
    expect(await media.cache.digest("media/a.mp3")).toBe(stored.digest);
    expect(media.cache.pathOf("media/a.mp3")).toBe(join(root, "a.mp3"));
  });

  it("refuses to write into a missing custom directory instead of creating it, and reports it unavailable", async () => {
    const { media } = setup();
    const root = join(tempDataDir("amber-cache-"), "media");
    media.cache.setRoot(root);
    expect(media.cache.isAvailableSync()).toBe(true);
    expect(await media.cache.isAvailable()).toBe(false);
    expect(media.cache.isAvailableSync()).toBe(false);
    expect(await codeOf(media.cache.writeAtomic("media/a.mp4", Buffer.from("x")))).toBe("conflict.cache_unavailable");
    expect(existsSync(root)).toBe(false);
    expect(await media.cache.stat("media/a.mp4")).toBeNull();
    mkdirSync(root);
    expect(await media.cache.isAvailable()).toBe(true);
    await media.cache.writeAtomic("media/a.mp4", Buffer.from("x"));
    expect(existsSync(join(root, "a.mp4"))).toBe(true);
    media.cache.setRoot(undefined);
    expect(media.hasCustomRoot()).toBe(false);
    expect(await media.cache.stat("media/a.mp4")).toBeNull();
  });

  it("opens a download's scratch directory in the cache directory, empty, and removes .amber-tmp with the last one", async () => {
    const { dataDir, media } = setup();
    const scratchRoot = join(dataDir, "media", ".amber-tmp");
    mkdirSync(join(scratchRoot, "01A"), { recursive: true });
    writeFileSync(join(scratchRoot, "01A", "video.f30080.mp4"), "left by an earlier attempt");
    const first = await media.cache.openScratch("01A");
    expect(first.path).toBe(join(scratchRoot, "01A"));
    expect(readdirSync(first.path)).toEqual([]);
    const second = await media.cache.openScratch("01B");
    writeFileSync(join(second.path, "video.f30280.m4a"), "audio");
    await first.close();
    // Another download still uses .amber-tmp.
    expect(readdirSync(scratchRoot)).toEqual(["01B"]);
    await second.close();
    expect(existsSync(scratchRoot)).toBe(false);
    // Closing again, or after a sweep, is harmless.
    await second.close();
    // Scratch directories are not cache files.
    expect(await media.cache.list("media")).toEqual([]);
  });

  it("refuses scratch ids that could climb out of .amber-tmp, and an unmounted custom directory", async () => {
    const { media } = setup();
    await expect(media.cache.openScratch("../x")).rejects.toThrow(TypeError);
    await expect(media.cache.openScratch("")).rejects.toThrow(TypeError);
    const root = join(tempDataDir("amber-cache-"), "media");
    media.cache.setRoot(root);
    expect(await codeOf(media.cache.openScratch("01A"))).toBe("conflict.cache_unavailable");
    expect(existsSync(root)).toBe(false);
  });

  it("removes .amber-tmp and what interrupted downloads left in it, and counts the entries", async () => {
    const { dataDir, media } = setup();
    expect(await media.cache.removeScratch()).toBe(0);
    const scratchRoot = join(dataDir, "media", ".amber-tmp");
    mkdirSync(join(scratchRoot, "01A", "01RUN"), { recursive: true });
    writeFileSync(join(scratchRoot, "01A", "01RUN", "video.f30080.mp4"), "x");
    mkdirSync(join(scratchRoot, "01B"));
    await media.cache.writeAtomic("media/kept.mp4", Buffer.from("x"));
    expect(await media.cache.removeScratch()).toBe(2);
    expect(existsSync(scratchRoot)).toBe(false);
    expect(await media.cache.list("media")).toEqual(["media/kept.mp4"]);
  });

  it("never empties or removes a scratch directory holding a replacement record", async () => {
    const { dataDir, media } = setup();
    const scratchRoot = join(dataDir, "media", ".amber-tmp");
    mkdirSync(join(scratchRoot, "01HELD"), { recursive: true });
    writeFileSync(join(scratchRoot, "01HELD", "swap.json"), "{}");
    writeFileSync(join(scratchRoot, "01HELD", "displaced"), "the only copy");
    mkdirSync(join(scratchRoot, "01DEBRIS"));
    expect(await media.cache.swapScratchIds()).toEqual(["01HELD"]);
    expect(await codeOf(media.cache.openScratch("01HELD"))).toBe("conflict.cache_recovery_pending");
    await media.cache.removeScratchDir("01HELD");
    expect(await media.cache.removeScratch()).toBe(1);
    expect(readdirSync(scratchRoot)).toEqual(["01HELD"]);
    expect(readdirSync(join(scratchRoot, "01HELD")).sort()).toEqual(["displaced", "swap.json"]);
    await media.cache.removeScratchDir("01HELD", { force: true });
    expect(existsSync(scratchRoot)).toBe(false);
  });

  it("moves files in and out of the cache directory by renaming", async () => {
    const { dataDir, media } = setup();
    const scratch = await media.cache.openScratch("01MOVE");
    writeFileSync(join(scratch.path, "download.mp4"), "new");
    await media.cache.moveIn(join(scratch.path, "download.mp4"), "media/a [720P].mp4");
    expect(await media.cache.stat("media/a [720P].mp4")).toEqual({ sizeBytes: 3 });
    await media.cache.moveOut("media/a [720P].mp4", join(scratch.path, "displaced"));
    expect(await media.cache.stat("media/a [720P].mp4")).toBeNull();
    expect(readdirSync(join(dataDir, "media", ".amber-tmp", "01MOVE"))).toEqual(["displaced"]);
    await scratch.close();
  });
});
