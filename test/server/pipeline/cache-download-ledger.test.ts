import { describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { CacheDownloadLedger, readCacheVolumes } from "../../../src/server/pipeline/cache-download-ledger.ts";
import { BYTES_PER_GB } from "../../../src/shared/units.ts";

const GB = BYTES_PER_GB;
const settings = { maxDataGB: 30, lowWaterFreeGB: 10, lowWaterFreeRatio: 0 };
const volume = (freeGB: number, usedGB = 0) => ({ usedBytes: usedGB * GB, freeBytes: freeGB * GB, totalBytes: 1000 * GB });

describe("CacheDownloadLedger", () => {
  it("admits what each volume holds above its low-water mark after the other downloads' reservations", () => {
    const ledger = new CacheDownloadLedger();
    const usage = { data: volume(100), cache: volume(20), sameVolume: false };
    const first = ledger.admit("a", usage, settings, { cache: 6 * GB });
    expect(first.cache).toMatchObject({ freeBytes: 20 * GB, lowWaterBytes: 10 * GB, reservedBytes: 0, availableBytes: 10 * GB });
    const second = ledger.admit("b", usage, settings, { cache: 4 * GB });
    expect(second.cache.availableBytes).toBe(4 * GB);
    expect(() => ledger.admit("c", usage, settings, { cache: 1 })).toThrow();
    // The data volume is apart.
    expect(ledger.space(usage, settings, { data: 20 * GB }).shortfall).toBeUndefined();
    ledger.release("a");
    expect(ledger.space(usage, settings, { cache: 6 * GB }).shortfall).toBeUndefined();
    expect(ledger.ids()).toEqual(["b"]);
  });

  it("draws both reservations on one volume when the directories share it, and refuses with disk_low", () => {
    const ledger = new CacheDownloadLedger();
    const usage = { data: volume(20), cache: volume(20), sameVolume: true };
    ledger.admit("track", usage, settings, { data: 6 * GB, cache: 2 * GB });
    expect(ledger.reservedExcept(undefined, "cache", true)).toBe(8 * GB);
    expect(ledger.reservedExcept(undefined, "cache", false)).toBe(2 * GB);
    expect(ledger.space(usage, settings, { cache: 2 * GB }).shortfall).toBeUndefined();
    const short = ledger.space(usage, settings, { data: 1 * GB, cache: 2 * GB });
    expect(short.shortfall).toBe("cache");
    try {
      ledger.admit("more", usage, settings, { data: 1 * GB, cache: 2 * GB });
      expect.unreachable();
    } catch (error) {
      expect(isAmberError(error) && error.appError.class).toBe("disk_low");
    }
  });

  it("refuses with disk_low.cache_volume naming the short volume, the bytes asked for, its free space and its low-water mark", () => {
    const refusalOf = (ledger: CacheDownloadLedger, usage: Parameters<CacheDownloadLedger["admit"]>[1], need: Parameters<CacheDownloadLedger["admit"]>[3], budget = settings) => {
      try {
        ledger.admit("refused", usage, budget, need);
      } catch (error) {
        if (isAmberError(error)) return error.appError;
        throw error;
      }
      throw new Error("expected a refusal");
    };
    // Apart: the cache volume answers for the cache side alone.
    const apart = refusalOf(new CacheDownloadLedger(), { data: volume(100), cache: volume(15), sameVolume: false }, { data: GB, cache: 6 * GB });
    expect(apart).toMatchObject({
      class: "disk_low",
      code: "disk_low.cache_volume",
      details: { volume: "cache", needBytes: 6 * GB, freeBytes: 15 * GB, lowWaterBytes: 10 * GB },
    });
    // The data volume short of room for the track.
    const dataShort = refusalOf(new CacheDownloadLedger(), { data: volume(12), cache: volume(100), sameVolume: false }, { data: 3 * GB, cache: GB });
    expect(dataShort).toMatchObject({ code: "disk_low.cache_volume", details: { volume: "data", needBytes: 3 * GB, freeBytes: 12 * GB, lowWaterBytes: 10 * GB } });
    // Shared: both sides draw on one volume, so the need is their sum.
    const shared = refusalOf(new CacheDownloadLedger(), { data: volume(14), cache: volume(14), sameVolume: true }, { data: 3 * GB, cache: 2 * GB });
    expect(shared).toMatchObject({ code: "disk_low.cache_volume", details: { volume: "cache", needBytes: 5 * GB, freeBytes: 14 * GB, lowWaterBytes: 10 * GB } });
    // A ratio of the volume above the absolute floor is the mark reported.
    const ledger = new CacheDownloadLedger();
    const byRatio = refusalOf(ledger, { data: volume(500), cache: volume(255), sameVolume: false }, { cache: 6 * GB }, { ...settings, lowWaterFreeRatio: 0.25 });
    expect(byRatio.details).toEqual({ volume: "cache", needBytes: 6 * GB, freeBytes: 255 * GB, lowWaterBytes: 250 * GB });
    // A refusal reserves nothing.
    expect(ledger.ids()).toEqual([]);
  });

  it("leaves room on a shared volume for the download's own cache side when it tells the data side its budget", () => {
    const ledger = new CacheDownloadLedger();
    const usage = { data: volume(20), cache: volume(20), sameVolume: true };
    // 10 GB above the low-water mark: the audio track may take what the MP3 does not need.
    const space = ledger.admit("audio", usage, settings, { data: 3 * GB, cache: 2 * GB });
    expect(space.data.availableBytes).toBe(8 * GB);
    expect(space.cache.availableBytes).toBe(10 * GB);
    // Apart, each volume answers for itself.
    expect(new CacheDownloadLedger().space({ ...usage, sameVolume: false }, settings, { data: 3 * GB, cache: 2 * GB }).data.availableBytes).toBe(10 * GB);
  });

  it("holds what lands in the data directory to maxDataGB, never a cache download", () => {
    const ledger = new CacheDownloadLedger();
    const usage = { data: volume(500, 29), cache: volume(500), sameVolume: false };
    expect(ledger.space(usage, settings, { data: 2 * GB }).shortfall).toBe("data");
    expect(ledger.space(usage, settings, { data: GB }).data.availableBytes).toBe(GB);
    // Over the cap, a video download onto the cache volume still goes.
    expect(ledger.space({ ...usage, data: volume(500, 31) }, settings, { cache: GB }).shortfall).toBeUndefined();
  });

  it("reads both volumes and whether they are one", async () => {
    expect(await readCacheVolumes({ data: { diskUsage: async () => volume(1) }, cache: { diskUsage: async () => volume(2) }, sameVolume: async () => true })).toEqual({
      data: volume(1),
      cache: volume(2),
      sameVolume: true,
    });
  });
});
