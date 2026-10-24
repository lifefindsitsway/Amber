import { lstat, readdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileStore } from "../../ports/file-store.ts";

export interface DataDirDiskUsageOptions {
  /**
   * Absolute paths whose whole subtree is left out of `usedBytes`. A function is read on every
   * measurement, for a subtree that moves at runtime (the media cache directory).
   */
  exclude?: readonly string[] | (() => readonly string[]);
}

/**
 * Disk usage of the data directory for the low-water mark: `usedBytes` is
 * every regular file under it except the excluded subtrees, symlinks not followed; free and
 * total space come from the volume that holds it.
 */
export function dataDirDiskUsage(root: string, options: DataDirDiskUsageOptions = {}): Pick<FileStore, "diskUsage"> {
  return {
    async diskUsage() {
      const exclude = typeof options.exclude === "function" ? options.exclude() : (options.exclude ?? []);
      const volume = await statfs(root);
      return {
        usedBytes: await directoryBytes(root, new Set(exclude.map(comparable))),
        freeBytes: volume.bavail * volume.bsize,
        totalBytes: volume.blocks * volume.bsize,
      };
    },
  };
}

/** Windows paths are case-insensitive, so an excluded `Media` must also skip `media`. */
function comparable(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function directoryBytes(dir: string, exclude: ReadonlySet<string>): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.has(comparable(path))) {
        total += await directoryBytes(path, exclude);
      }
    } else if (entry.isFile()) {
      // A file removed between listing and stat simply no longer counts.
      total += await lstat(path).then(
        (stats) => stats.size,
        () => 0,
      );
    }
  }
  return total;
}
