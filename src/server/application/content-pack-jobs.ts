import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ContentPackHeader } from "../domain/content-pack/document.ts";
import { amberError, type AmberError } from "../domain/errors.ts";
import { BYTES_PER_GB, formatBytes } from "../../shared/units.ts";
import type { ContentPackSource } from "../ports/content-pack.ts";
import { syncDirectory } from "../pipeline/cache-swap.ts";

/**
 * What the content pack export and import jobs share: the per-user job slot, the shapes of
 * the archive reader and writer the composition hands them, and the layout of their
 * working directory `<data dir>/tmp/content-packs/`:
 *
 *   exports/<jobId>/   a server-mode pack waiting for its download
 *   exports/<jobId>.json   the record of a local-mode export writing `<target>.partial`
 *   imports/<jobId>/   a server-mode upload being previewed and imported
 *   journal/<jobId>.json   the journal of an import placing files (survives a crash)
 *   imports/<jobId>/images/   the images of an import waiting for their Content's commit
 *   scratch/<jobId>/   short-lived image files of an export
 *
 * Everything but the journals is removed at start-up; the journals are settled first.
 */

/** The working directory of the content pack jobs, relative to the data directory. */
export const CONTENT_PACK_WORK_DIR = join("tmp", "content-packs");

export const packWorkPaths = (workDir: string) => ({
  exports: join(workDir, "exports"),
  imports: join(workDir, "imports"),
  journal: join(workDir, "journal"),
  scratch: join(workDir, "scratch"),
});

/**
 * One content pack job per user at a time, export or import alike: a second one answers
 * `conflict.pack_job_active`. An import holds its slot from the upload or file pick until it
 * finishes, fails, is cancelled or its preview expires; an export while it runs.
 */
export class PackJobSlots {
  private readonly held = new Map<string, string>();

  /** Takes the user's slot for `jobId`, or throws `conflict.pack_job_active`. */
  claim(userId: string, jobId: string): void {
    const holder = this.held.get(userId);
    if (holder !== undefined && holder !== jobId) {
      throw amberError("conflict", "a content pack job is already running", { code: "conflict.pack_job_active" });
    }
    this.held.set(userId, jobId);
  }

  /** Gives the slot back if `jobId` holds it; harmless otherwise. */
  release(userId: string, jobId: string): void {
    if (this.held.get(userId) === jobId) {
      this.held.delete(userId);
    }
  }

  holder(userId: string): string | undefined {
    return this.held.get(userId);
  }
}

export type OpenPackFile = (path: string) => ContentPackSource;

/** Hex SHA-256 of a file, streamed. */
export async function sha256OfFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Writes a small JSON record atomically and durably: a temporary file, synced, renamed, the directory synced. */
export async function writeRecord(dir: string, name: string, value: unknown): Promise<void> {
  const temp = join(dir, `${name}.tmp`);
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, name));
  await syncDirectory(dir);
}

/** `yyyyMMdd-HHmmss` in local time, as the shell names the originals directory. */
export function localStamp(ms: number): string {
  const date = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * `storage_quota_exceeded` when `addBytes` more would take the user past their limit;
 * `undefined` when they have none or it fits.
 */
export function quotaShortfall(usage: { usedBytes: number; storageLimitGB?: number }, addBytes: number): AmberError | undefined {
  const limitGB = usage.storageLimitGB;
  if (limitGB === undefined || usage.usedBytes + addBytes <= limitGB * BYTES_PER_GB) {
    return undefined;
  }
  return amberError("storage_quota_exceeded", "the content pack exceeds the user's storage limit", {
    params: {
      remaining: formatBytes(Math.max(0, limitGB * BYTES_PER_GB - usage.usedBytes)),
      used: formatBytes(usage.usedBytes),
      limit: `${limitGB} GB`,
    },
  });
}
