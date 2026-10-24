import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { CacheHoldRegistry } from "../../../src/server/pipeline/cache-holds.ts";
import { CachePathLocks } from "../../../src/server/pipeline/cache-path-locks.ts";
import {
  describeHold,
  publishCache,
  readSwapRecord,
  recoverSwap,
  resolveHold,
  SWAP_RECORD_FILE,
  writeSwapRecord,
  type SwapRecord,
} from "../../../src/server/pipeline/cache-swap.ts";
import { LOCAL } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

const OLD = Buffer.from("the old cache file");
const NEW = Buffer.from("the new cache file, longer");
const OTHER = Buffer.from("something the user put here");
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const TARGET = "media/课 [720P].mp4";
const NEW_ID = "01NEWASSET0000000000000000";

/**
 * A replacement interrupted at some step: the old row (and maybe the new one) in the
 * database, `swap.json` in the scratch directory, and whichever files the step left.
 */
async function interrupted(options: {
  target?: Buffer;
  displacedCopy?: Buffer;
  download?: Buffer;
  recordDisplaced?: boolean;
  /** The new row exists: `true` as the commit left it, `"evicted"` when a later replacement or removal took it. */
  registered?: boolean | "evicted";
}) {
  const stack = createMediaStack();
  open.push(stack);
  const holds = new CacheHoldRegistry();
  const deps = { repository: stack.h.repository, cache: stack.stores.cache, locks: new CachePathLocks(), holds };
  const contentId = stack.h.newId();
  stack.h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id: contentId,
      userId: LOCAL.userId,
      source: { kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk", platformContentId: "abcdefghijk" },
      title: "课",
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const row = (id: string, bytes: Buffer, availability: MediaAsset["availability"]): MediaAsset => ({
    id,
    userId: LOCAL.userId,
    contentId,
    kind: "platform_cache",
    storageRef: TARGET,
    mimeType: "video/mp4",
    sizeBytes: bytes.length,
    quality: "720",
    qualityVerified: true,
    fingerprint: digest(bytes),
    availability,
    retentionPolicy: "evictable",
    createdAt: 1,
  });
  const registered = options.registered ?? false;
  const oldRow = row("01OLDASSET0000000000000000", OLD, registered === false ? "available" : "evicted");
  stack.h.repository.withTransaction((scope) => {
    scope.mediaAssets.insert(oldRow);
    if (registered !== false) {
      scope.mediaAssets.insert(row(NEW_ID, NEW, registered === true ? "available" : "evicted"));
    }
  });
  const dir = stack.stores.cache.scratchPath(NEW_ID);
  await mkdir(dir, { recursive: true });
  const record: SwapRecord = {
    v: 1,
    targetRef: TARGET,
    newAssetId: NEW_ID,
    newSizeBytes: NEW.length,
    newDigest: digest(NEW),
    ...(options.recordDisplaced === false ? {} : { displaced: { assetId: oldRow.id, sizeBytes: OLD.length, digest: digest(OLD) } }),
  };
  await writeSwapRecord(dir, record);
  if (options.target !== undefined) {
    await writeFile(stack.stores.cache.pathOf(TARGET), options.target);
  }
  if (options.displacedCopy !== undefined) {
    await writeFile(join(dir, "displaced"), options.displacedCopy);
  }
  if (options.download !== undefined) {
    await writeFile(join(dir, "download.mp4"), options.download);
  }
  const targetBytes = () => (existsSync(stack.stores.cache.pathOf(TARGET)) ? readFileSync(stack.stores.cache.pathOf(TARGET)) : undefined);
  const availability = (id: string) => stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, id))?.availability;
  return { stack, deps, holds, dir, oldRow, contentId, row, targetBytes, availability };
}

describe("recoverSwap", () => {
  it("finishes a committed replacement: the new row is registered and the new file is at the target", async () => {
    const { deps, dir, targetBytes } = await interrupted({ registered: true, target: NEW, displacedCopy: OLD });
    expect(await recoverSwap(deps, NEW_ID)).toBe("committed");
    expect(existsSync(dir)).toBe(false);
    expect(targetBytes()).toEqual(NEW);
  });

  it("puts the old file back after a crash between the move and the registration", async () => {
    const { deps, dir, targetBytes, availability, oldRow } = await interrupted({ target: NEW, displacedCopy: OLD });
    expect(await recoverSwap(deps, NEW_ID)).toBe("rolled_back");
    expect(targetBytes()).toEqual(OLD);
    expect(availability(oldRow.id)).toBe("available");
    expect(existsSync(dir)).toBe(false);
  });

  it("removes an unregistered new file when nothing was displaced", async () => {
    const { deps, targetBytes } = await interrupted({ target: NEW, recordDisplaced: false });
    expect(await recoverSwap(deps, NEW_ID)).toBe("rolled_back");
    expect(targetBytes()).toBeUndefined();
  });

  it("moves the displaced copy back after a crash between the two moves", async () => {
    const { deps, targetBytes } = await interrupted({ displacedCopy: OLD, download: NEW });
    expect(await recoverSwap(deps, NEW_ID)).toBe("rolled_back");
    expect(targetBytes()).toEqual(OLD);
  });

  it("discards a record written before anything moved", async () => {
    const withOld = await interrupted({ target: OLD, download: NEW });
    expect(await recoverSwap(withOld.deps, NEW_ID)).toBe("rolled_back");
    expect(withOld.targetBytes()).toEqual(OLD);
    expect(existsSync(withOld.dir)).toBe(false);

    const empty = await interrupted({ recordDisplaced: false, download: NEW });
    expect(await recoverSwap(empty.deps, NEW_ID)).toBe("discarded");
    expect(existsSync(empty.dir)).toBe(false);
  });

  it.each([
    { name: "the new file is missing", setup: { registered: true, displacedCopy: OLD } },
    { name: "the target is another file", setup: { registered: true, target: OTHER, displacedCopy: OLD } },
    { name: "the new row was evicted since", setup: { registered: "evicted", target: NEW, displacedCopy: OLD } },
  ] as const)("treats a replacement whose new row exists as committed and never touches the target when $name", async ({ setup }) => {
    const { deps, dir, holds, targetBytes } = await interrupted(setup);
    const target = targetBytes();
    expect(await recoverSwap(deps, NEW_ID)).toBe("committed");
    expect(targetBytes()).toEqual(target);
    expect(existsSync(dir)).toBe(false);
    expect(holds.list()).toEqual([]);
  });

  it("keeps a newer cache with the same bytes after a committed replacement's record outlived its scratch removal", async () => {
    // Committed, then the cache was removed (its row evicted) and the same video cached
    // again to the same name; the first replacement's record was left behind. A restart
    // must not read that record against the newer file.
    const { stack, deps, dir, holds, row, targetBytes, availability } = await interrupted({ registered: "evicted", target: NEW, displacedCopy: OLD });
    const newer = row("01NEWERASSET00000000000000", NEW, "available");
    stack.h.repository.withTransaction((scope) => scope.mediaAssets.insert(newer));
    expect(await recoverSwap(deps, NEW_ID)).toBe("committed");
    expect(targetBytes()).toEqual(NEW);
    expect(availability(newer.id)).toBe("available");
    expect(availability(NEW_ID)).toBe("evicted");
    expect(existsSync(dir)).toBe(false);
    expect(holds.list()).toEqual([]);
  });

  it("holds the new file when another available row describes it although the new row is gone", async () => {
    const { stack, deps, dir, holds, row, targetBytes } = await interrupted({ target: NEW, displacedCopy: OLD });
    stack.h.repository.withTransaction((scope) => scope.mediaAssets.insert(row("01NEWERASSET00000000000000", NEW, "available")));
    expect(await recoverSwap(deps, NEW_ID)).toBe("held");
    expect(targetBytes()).toEqual(NEW);
    expect(existsSync(join(dir, "displaced"))).toBe(true);
    expect(holds.isHeld(TARGET)).toBe(true);
  });

  it("holds the path when settling it throws, leaving the files as the failure found them", async () => {
    const { deps, dir, holds, targetBytes } = await interrupted({ target: NEW, displacedCopy: OLD });
    const cache = deps.cache;
    const failing = Object.assign(Object.create(cache) as typeof cache, {
      remove: async () => {
        throw Object.assign(new Error("in use"), { code: "EBUSY" });
      },
    });
    expect(await recoverSwap({ ...deps, cache: failing }, NEW_ID)).toBe("held");
    expect(targetBytes()).toEqual(NEW);
    expect(readdirSync(dir).sort()).toEqual(["displaced", SWAP_RECORD_FILE]);
    expect(holds.get(NEW_ID)?.currentSizeBytes).toBe(NEW.length);
  });

  it("settles under the target path's lock", async () => {
    const { deps, targetBytes } = await interrupted({ target: NEW, displacedCopy: OLD });
    let release!: () => void;
    const busy = deps.locks.withLock("media/课 [720P].MP4", () => new Promise<void>((resolve) => (release = resolve)));
    let settled = false;
    const recovery = recoverSwap(deps, NEW_ID).then((outcome) => {
      settled = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(targetBytes()).toEqual(NEW);
    release();
    await busy;
    expect(await recovery).toBe("rolled_back");
    expect(targetBytes()).toEqual(OLD);
  });

  it.each([
    { name: "the target is neither file", setup: { target: OTHER, displacedCopy: OLD } },
    { name: "the displaced copy changed", setup: { target: NEW, displacedCopy: OTHER } },
    { name: "the displaced copy is gone while the target is new", setup: { target: NEW } },
  ])("holds every file when $name", async ({ setup }) => {
    const { deps, dir, holds, targetBytes } = await interrupted(setup);
    const before = readdirSync(dir).sort();
    const target = targetBytes();
    expect(await recoverSwap(deps, NEW_ID)).toBe("held");
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(targetBytes()).toEqual(target);
    expect(holds.isHeld("media/课 [720P].MP4")).toBe(true);
    expect(holds.get(NEW_ID)?.record.targetRef).toBe(TARGET);
  });

  it("reads a record another tool wrote in the documented shape, and leaves a corrupt one alone", async () => {
    const { deps, dir } = await interrupted({ registered: true, target: NEW });
    expect(await readSwapRecord(dir)).toMatchObject({ v: 1, targetRef: TARGET, newAssetId: NEW_ID });
    await writeFile(join(dir, SWAP_RECORD_FILE), "{ not json");
    expect(await recoverSwap(deps, NEW_ID)).toBe("unreadable");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("resolveHold", () => {
  async function held(setup: Parameters<typeof interrupted>[0]) {
    const context = await interrupted(setup);
    expect(await recoverSwap(context.deps, NEW_ID)).toBe("held");
    return context;
  }

  /** A hold taken as a failed rollback takes one: whatever the database says about the new row. */
  async function heldAsFound(setup: Parameters<typeof interrupted>[0]) {
    const context = await interrupted(setup);
    const record = await readSwapRecord(context.dir);
    if (record === undefined || record === "corrupt") throw new Error("no record");
    context.holds.add(await describeHold(context.deps.cache, NEW_ID, record));
    return context;
  }

  it("never restores over a file that is not the new one; keeping it evicts the registered new row", async () => {
    const { deps, oldRow, targetBytes, availability } = await heldAsFound({ registered: true, target: OTHER, displacedCopy: OLD });
    await expect(resolveHold(deps, NEW_ID, "restore")).rejects.toSatisfy((error) => isAmberError(error) && error.appError.code === "conflict.cache_file_foreign");
    expect(targetBytes()).toEqual(OTHER);
    await resolveHold(deps, NEW_ID, "keep");
    expect(targetBytes()).toEqual(OTHER);
    expect(availability(NEW_ID)).toBe("evicted");
    expect(availability(oldRow.id)).toBe("evicted");
  });

  it("restores the displaced copy when the target is the new file", async () => {
    const { deps, dir, holds, oldRow, targetBytes, availability } = await held({ target: NEW, displacedCopy: OTHER });
    // The copy does not match its record: nothing to restore.
    await expect(resolveHold(deps, NEW_ID, "restore")).rejects.toSatisfy((error) => isAmberError(error) && error.appError.code === "conflict.cache_file_foreign");
    await writeFile(join(dir, "displaced"), OLD);
    await resolveHold(deps, NEW_ID, "restore");
    expect(targetBytes()).toEqual(OLD);
    expect(availability(oldRow.id)).toBe("available");
    expect(existsSync(dir)).toBe(false);
    expect(holds.list()).toEqual([]);
  });

  it("refuses to keep a missing file, which would only delete the displaced copy; restoring it still works", async () => {
    const { deps, dir, holds, oldRow, targetBytes, availability } = await heldAsFound({ registered: true, displacedCopy: OLD });
    expect(holds.get(NEW_ID)?.currentSizeBytes).toBeUndefined();
    await expect(resolveHold(deps, NEW_ID, "keep")).rejects.toSatisfy((error) => isAmberError(error) && error.appError.code === "conflict.cache_file_foreign");
    expect(readFileSync(join(dir, "displaced"))).toEqual(OLD);
    expect(holds.get(NEW_ID)).toBeDefined();
    await resolveHold(deps, NEW_ID, "restore");
    expect(targetBytes()).toEqual(OLD);
    expect(availability(NEW_ID)).toBe("evicted");
    expect(availability(oldRow.id)).toBe("available");
    expect(existsSync(dir)).toBe(false);
    expect(holds.list()).toEqual([]);
  });

  it("refuses to keep when the file disappeared after the hold was taken", async () => {
    const { deps, dir, stack } = await held({ target: OTHER, displacedCopy: OLD });
    await rm(stack.stores.cache.pathOf(TARGET));
    await expect(resolveHold(deps, NEW_ID, "keep")).rejects.toSatisfy((error) => isAmberError(error) && error.appError.code === "conflict.cache_file_foreign");
    expect(existsSync(join(dir, "displaced"))).toBe(true);
  });

  it("refuses to keep a file that changed since the hold was taken", async () => {
    const { deps, stack } = await held({ target: OTHER, displacedCopy: OLD });
    await writeFile(stack.stores.cache.pathOf(TARGET), Buffer.concat([OTHER, Buffer.from("!")]));
    await expect(resolveHold(deps, NEW_ID, "keep")).rejects.toSatisfy((error) => isAmberError(error) && error.appError.code === "conflict.cache_file_foreign");
    await expect(resolveHold(deps, "01UNKNOWN", "keep")).rejects.toSatisfy((error) => isAmberError(error) && error.appError.class === "not_found");
  });
});

describe("publishCache", () => {
  it("displaces a holder registered under a differently cased spelling from its own path", async () => {
    const { stack, deps, contentId, row, oldRow, availability } = await interrupted({ recordDisplaced: false });
    // Start from a clean scratch directory: this test publishes for real.
    await rm(stack.stores.cache.scratchPath(NEW_ID), { recursive: true, force: true });
    stack.h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...oldRow, availability: "evicted" }));
    const cased = "media/课 [720p].mp4";
    const holder = { ...row("01CASEDHOLDER0000000000000", OLD, "available"), storageRef: cased };
    stack.h.repository.withTransaction((scope) => scope.mediaAssets.insert(holder));
    await writeFile(stack.stores.cache.pathOf(cased), OLD);
    const scratch = await stack.stores.cache.openScratch(NEW_ID);
    const downloadPath = join(scratch.path, "download.mp4");
    await writeFile(downloadPath, NEW);
    const published = await publishCache(deps, {
      owner: LOCAL.userId,
      contentId,
      assetId: NEW_ID,
      downloadPath,
      targetRef: TARGET,
      type: "video",
      height: 720,
      mimeType: "video/mp4",
      identity: { sizeBytes: NEW.length, digest: digest(NEW) },
      createdAt: 2,
    });
    expect(published.replaced).toEqual([holder.id]);
    expect(availability(holder.id)).toBe("evicted");
    // On a case-insensitive file system both names are one file; on any other, the holder's
    // file was moved away rather than left beside the new one.
    expect(readFileSync(stack.stores.cache.pathOf(TARGET))).toEqual(NEW);
    if (process.platform !== "win32" && process.platform !== "darwin") {
      expect(existsSync(stack.stores.cache.pathOf(cased))).toBe(false);
    }
    expect(existsSync(stack.stores.cache.scratchPath(NEW_ID))).toBe(false);
  });
});
