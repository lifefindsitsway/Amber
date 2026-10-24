import { describe, expect, it } from "vitest";
import { belowWatermark, cacheVolumeLow, diskLowAfterWriting, diskLowError, lowWaterBytes } from "../../../src/server/pipeline/disk-watermark.ts";

const GB = 1024 ** 3;
const settings = { maxDataGB: 30, lowWaterFreeGB: 10, lowWaterFreeRatio: 0.2 };

describe("disk low-water mark", () => {
  it("trips on data size, absolute free space or free ratio", () => {
    expect(belowWatermark({ usedBytes: 1 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB }, settings)).toBe(false);
    expect(belowWatermark({ usedBytes: 31 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB }, settings)).toBe(true);
    expect(belowWatermark({ usedBytes: 1 * GB, freeBytes: 9 * GB, totalBytes: 20 * GB }, settings)).toBe(true);
    expect(belowWatermark({ usedBytes: 1 * GB, freeBytes: 150 * GB, totalBytes: 1000 * GB }, settings)).toBe(true);
  });

  it("keeps the larger of the absolute floor and the volume ratio free", () => {
    expect(lowWaterBytes({ usedBytes: 0, freeBytes: 0, totalBytes: 20 * GB }, settings)).toBe(10 * GB);
    expect(lowWaterBytes({ usedBytes: 0, freeBytes: 0, totalBytes: 1000 * GB }, settings)).toBe(200 * GB);
    // A volume of unknown size has only the absolute floor; a zero ratio leaves only the floor too.
    expect(lowWaterBytes({ usedBytes: 0, freeBytes: 0, totalBytes: 0 }, settings)).toBe(10 * GB);
    expect(lowWaterBytes({ usedBytes: 0, freeBytes: 0, totalBytes: 1000 * GB }, { ...settings, lowWaterFreeRatio: 0 })).toBe(10 * GB);
  });

  it("rounds a fractional ratio of the volume up to whole bytes", () => {
    // 0.2 of a real volume size is rarely a whole number of bytes; DTOs carry it as an integer.
    const low = lowWaterBytes({ usedBytes: 0, freeBytes: 0, totalBytes: 1_099_511_627_779 }, settings);
    expect(Number.isInteger(low)).toBe(true);
    expect(low).toBe(219_902_325_556);
  });

  it("judges the cache volume by free space only, never by how much is stored", () => {
    // Far beyond the data directory cap, yet plenty of free space: the cache has no size cap.
    expect(cacheVolumeLow({ usedBytes: 500 * GB, freeBytes: 300 * GB, totalBytes: 1000 * GB }, settings)).toBe(false);
    expect(belowWatermark({ usedBytes: 500 * GB, freeBytes: 300 * GB, totalBytes: 1000 * GB }, settings)).toBe(true);
    expect(cacheVolumeLow({ usedBytes: 0, freeBytes: 9 * GB, totalBytes: 20 * GB }, settings)).toBe(true);
    expect(cacheVolumeLow({ usedBytes: 0, freeBytes: 150 * GB, totalBytes: 1000 * GB }, settings)).toBe(true);
    expect(cacheVolumeLow({ usedBytes: 0, freeBytes: 150 * GB, totalBytes: 1000 * GB }, { ...settings, lowWaterFreeRatio: 0 })).toBe(false);
    expect(cacheVolumeLow({ usedBytes: 0, freeBytes: 10 * GB, totalBytes: 1000 * GB }, { ...settings, lowWaterFreeRatio: 0 })).toBe(false);
    expect(cacheVolumeLow({ usedBytes: 0, freeBytes: 10 * GB - 1, totalBytes: 1000 * GB }, { ...settings, lowWaterFreeRatio: 0 })).toBe(true);
  });

  it("reports disk_low as a never-retried error", async () => {
    const probe = { diskUsage: async () => ({ usedBytes: 0, freeBytes: 0, totalBytes: 1 }) };
    const full = { ...settings, concurrencyPipeline: 1, uploadRetentionDefault: "keep" as const, updatedAt: 0 };
    expect(await diskLowError(probe, full)).toMatchObject({ class: "disk_low", retryDisposition: "never" });
  });

  it("counts a planned output against free space", async () => {
    const full = { ...settings, concurrencyPipeline: 1, uploadRetentionDefault: "keep" as const, updatedAt: 0 };
    const probe = { diskUsage: async () => ({ usedBytes: 1 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB }) };
    // 200 GB is the ratio mark of a 1000 GB volume: 300 GB may be written, a byte more may not.
    expect(await diskLowAfterWriting(probe, full, 300 * GB)).toBeUndefined();
    expect(await diskLowAfterWriting(probe, full, 300 * GB + 1)).toMatchObject({ class: "disk_low" });
  });
});
