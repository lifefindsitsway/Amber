import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirDiskUsage } from "../../../../src/server/adapters/file-store/disk-usage.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

describe("dataDirDiskUsage", () => {
  it("sums every regular file under the data directory without following symlinks", async () => {
    const root = tempDataDir("amber-disk-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "one.bin"), Buffer.alloc(1000));
    writeFileSync(join(root, "a", "b", "two.bin"), Buffer.alloc(24));
    const outside = tempDataDir("amber-disk-outside-");
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(50_000));
    symlinkSync(join(outside, "big.bin"), join(root, "link.bin"));

    const usage = await dataDirDiskUsage(root).diskUsage();
    expect(usage.usedBytes).toBe(1024);
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeLessThanOrEqual(usage.totalBytes);
  });

  it("leaves excluded subtrees out, reading a moving exclusion on every measurement", async () => {
    const root = tempDataDir("amber-disk-");
    mkdirSync(join(root, "media", ".amber-tmp", "x"), { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "kept.bin"), Buffer.alloc(100));
    writeFileSync(join(root, "media", "cached.mp4"), Buffer.alloc(5000));
    writeFileSync(join(root, "media", ".amber-tmp", "x", "part.mp4.partial"), Buffer.alloc(700));

    expect((await dataDirDiskUsage(root, { exclude: [join(root, "media")] }).diskUsage()).usedBytes).toBe(100);
    // A path that is not normalised still names the same directory.
    expect((await dataDirDiskUsage(root, { exclude: [join(root, "assets", "..", "media")] }).diskUsage()).usedBytes).toBe(100);

    let excluded = [join(root, "media")];
    const usage = dataDirDiskUsage(root, { exclude: () => excluded });
    expect((await usage.diskUsage()).usedBytes).toBe(100);
    // The cache moved to another volume: what stays under the data directory counts again.
    excluded = [join(tempDataDir("amber-disk-elsewhere-"), "media")];
    expect((await usage.diskUsage()).usedBytes).toBe(5800);
  });
});
