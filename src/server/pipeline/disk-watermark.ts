import { appError } from "../domain/errors.ts";
import type { InstanceSettings } from "../domain/runtime-support.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { AppError } from "../../shared/errors.ts";
import { BYTES_PER_GB } from "../../shared/units.ts";

export type DiskUsageProbe = Pick<FileStore, "diskUsage">;
export type DiskUsage = Awaited<ReturnType<FileStore["diskUsage"]>>;

type FreeSpaceSettings = Pick<InstanceSettings, "lowWaterFreeGB" | "lowWaterFreeRatio">;

/**
 * The free space a volume must keep: the larger of the absolute floor `lowWaterFreeGB` and
 * `lowWaterFreeRatio` of the volume. A volume whose total size is unknown (0) only has the floor.
 * Rounded up to whole bytes: a ratio of an arbitrary volume size is fractional, and the value is
 * reported in DTOs and error details as an integer byte count.
 */
export function lowWaterBytes(usage: DiskUsage, settings: FreeSpaceSettings): number {
  return Math.ceil(Math.max(settings.lowWaterFreeGB * BYTES_PER_GB, usage.totalBytes * settings.lowWaterFreeRatio));
}

/**
 * The low-water mark of the volume holding the media cache. Only free space counts: the cache
 * has no size cap of its own and is never cleaned up automatically, so the only thing to protect
 * is the rest of the disk.
 */
export function cacheVolumeLow(usage: DiskUsage, settings: FreeSpaceSettings): boolean {
  return usage.freeBytes < lowWaterBytes(usage, settings);
}

/**
 * The low-water mark of the data directory: it exceeds `maxDataGB` (the cache directory is
 * measured separately and never counts here), or its volume is low on free space.
 */
export function belowWatermark(usage: DiskUsage, settings: Pick<InstanceSettings, "maxDataGB"> & FreeSpaceSettings): boolean {
  return usage.usedBytes > settings.maxDataGB * BYTES_PER_GB || cacheVolumeLow(usage, settings);
}

/** `disk_low` when new work must not start; running work is never interrupted by this check. */
export async function diskLowError(probe: DiskUsageProbe, settings: InstanceSettings): Promise<AppError | undefined> {
  return belowWatermark(await probe.diskUsage(), settings) ? appError("disk_low") : undefined;
}

/**
 * `disk_low` when the volume is below the low-water mark now, or would be once `plannedBytes`
 * more are written to it — the check a known-size output gets before it starts.
 */
export async function diskLowAfterWriting(probe: DiskUsageProbe, settings: InstanceSettings, plannedBytes: number): Promise<AppError | undefined> {
  const usage = await probe.diskUsage();
  return belowWatermark(usage, settings) || belowWatermark({ ...usage, freeBytes: usage.freeBytes - plannedBytes }, settings) ? appError("disk_low") : undefined;
}
