import type { InstanceSettings } from "../domain/runtime-support.ts";
import { amberError } from "../domain/errors.ts";
import { BYTES_PER_GB } from "../../shared/units.ts";
import { lowWaterBytes, type DiskUsage, type DiskUsageProbe } from "./disk-watermark.ts";

/** The two volumes a cache download writes to: the data directory's and the cache directory's. */
export type CacheVolume = "data" | "cache";

/** Bytes one download may still write per volume. */
export interface CacheReservation {
  data: number;
  cache: number;
}

/** Free space of both volumes at one moment, and whether they are one volume. */
export interface CacheVolumeUsage {
  data: DiskUsage;
  cache: DiskUsage;
  sameVolume: boolean;
}

/** Where a volume stands for one download. */
export interface VolumeSpace {
  freeBytes: number;
  lowWaterBytes: number;
  /** What other downloads in flight reserved on this volume (both volumes' when they are one). */
  reservedBytes: number;
  /** What this download may still write before the volume reaches its low-water mark; never negative. */
  availableBytes: number;
}

export interface CacheSpace {
  data: VolumeSpace;
  cache: VolumeSpace;
  sameVolume: boolean;
  /** The first volume without room for the reservation asked about, if any. */
  shortfall?: CacheVolume;
}

type BudgetSettings = Pick<InstanceSettings, "maxDataGB" | "lowWaterFreeGB" | "lowWaterFreeRatio">;

/** The probes a budget reads: both volumes, and whether they are one. */
export interface CacheVolumes {
  data: DiskUsageProbe;
  cache: DiskUsageProbe;
  sameVolume: () => boolean | Promise<boolean>;
}

export async function readCacheVolumes(volumes: CacheVolumes): Promise<CacheVolumeUsage> {
  const [data, cache, sameVolume] = await Promise.all([volumes.data.diskUsage(), volumes.cache.diskUsage(), volumes.sameVolume()]);
  return { data, cache, sameVolume };
}

/**
 * The in-process ledger of the space cache downloads in flight may still need, per
 * volume. A download is admitted only when every volume it writes to keeps its low-water
 * mark after its own reservation and everyone else's; when the data and cache directories
 * share a volume, the two reservations draw on the same free space. Admission reads the
 * volumes first and then checks and records the reservation synchronously, so two
 * downloads starting together cannot both count the same free bytes.
 */
export class CacheDownloadLedger {
  private readonly reservations = new Map<string, CacheReservation>();

  /** What everyone but `exceptId` reserved on `volume`. */
  reservedExcept(exceptId: string | undefined, volume: CacheVolume, sameVolume: boolean): number {
    let total = 0;
    for (const [id, reservation] of this.reservations) {
      if (id !== exceptId) {
        total += sameVolume ? reservation.data + reservation.cache : reservation[volume];
      }
    }
    return total;
  }

  /**
   * The room both volumes have for `need`, without reserving it. The data volume also
   * answers to `maxDataGB`: what lands in the data directory counts against it, the cache
   * directory never does.
   */
  space(usage: CacheVolumeUsage, settings: BudgetSettings, need: Partial<CacheReservation>, exceptId?: string): CacheSpace {
    const wanted = { data: need.data ?? 0, cache: need.cache ?? 0 };
    const cacheLow = lowWaterBytes(usage.cache, settings);
    const dataLow = lowWaterBytes(usage.data, settings);
    const dataReserved = this.reservedExcept(exceptId, "data", usage.sameVolume);
    const cacheReserved = this.reservedExcept(exceptId, "cache", usage.sameVolume);
    // Room under the data directory's own cap, whatever the volume has.
    const dataCapRoom = settings.maxDataGB * BYTES_PER_GB - usage.data.usedBytes - this.reservedExcept(exceptId, "data", false);
    const cacheRoom = usage.cache.freeBytes - cacheLow - cacheReserved;
    // On one volume the data side of this download must leave room for its own cache side
    // (an audio track must not take the space its MP3 is transcoded into).
    const dataVolumeRoom = usage.sameVolume ? cacheRoom - wanted.cache : usage.data.freeBytes - dataLow - dataReserved;
    const data: VolumeSpace = {
      freeBytes: usage.data.freeBytes,
      lowWaterBytes: dataLow,
      reservedBytes: dataReserved,
      availableBytes: Math.max(0, Math.min(dataVolumeRoom, dataCapRoom)),
    };
    const cache: VolumeSpace = { freeBytes: usage.cache.freeBytes, lowWaterBytes: cacheLow, reservedBytes: cacheReserved, availableBytes: Math.max(0, cacheRoom) };
    let shortfall: CacheVolume | undefined;
    if (wanted.data > 0 && wanted.data > Math.min(dataCapRoom, usage.sameVolume ? Number.POSITIVE_INFINITY : dataVolumeRoom)) {
      shortfall = "data";
    } else if (usage.sameVolume ? wanted.data + wanted.cache > cacheRoom : wanted.cache > cacheRoom) {
      shortfall = wanted.cache > 0 ? "cache" : "data";
    }
    return { data, cache, sameVolume: usage.sameVolume, ...(shortfall === undefined ? {} : { shortfall }) };
  }

  /**
   * Checks `need` against the volumes and records it under `id` in one synchronous step;
   * `disk_low` when a volume lacks room. Returns the room as it was before the reservation.
   * A second admission under the same id replaces the first.
   */
  admit(id: string, usage: CacheVolumeUsage, settings: BudgetSettings, need: Partial<CacheReservation>): CacheSpace {
    const space = this.space(usage, settings, need, id);
    if (space.shortfall !== undefined) {
      const volume = space[space.shortfall];
      const needBytes = space.sameVolume ? (need.data ?? 0) + (need.cache ?? 0) : (need[space.shortfall] ?? 0);
      throw amberError("disk_low", `the ${space.shortfall} volume has no room for this cache download`, {
        code: "disk_low.cache_volume",
        details: { volume: space.shortfall, needBytes, freeBytes: volume.freeBytes, lowWaterBytes: volume.lowWaterBytes },
      });
    }
    this.reservations.set(id, { data: need.data ?? 0, cache: need.cache ?? 0 });
    return space;
  }

  release(id: string): void {
    this.reservations.delete(id);
  }

  /** Ids with a reservation; for tests and diagnostics. */
  ids(): string[] {
    return [...this.reservations.keys()];
  }
}
