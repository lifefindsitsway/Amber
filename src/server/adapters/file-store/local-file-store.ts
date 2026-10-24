import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CACHE_DIR_NAME } from "../../../shared/app-identity.ts";
import type { AtomicWriteSource, FileStore, StoredFile, WriteAtomicOptions } from "../../ports/file-store.ts";
import { hashFile, isNotFound, PARTIAL_SUFFIX, writeAtomically } from "./atomic-write.ts";
import { dataDirDiskUsage, type DataDirDiskUsageOptions } from "./disk-usage.ts";

/** Ref segments are ids and fixed names; anything else (separators, `..`, drive letters) is rejected. */
const REF_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** FileStore over the data directory. */
export class LocalFileStore implements FileStore {
  private readonly root: string;
  private readonly usage: Pick<FileStore, "diskUsage">;

  /**
   * `usageExclude` lists the subtrees `diskUsage()` leaves out of the data directory's total:
   * the media cache directory, which has no size cap of its own and must not count against
   * the data directory's.
   */
  constructor(root: string, options: { usageExclude?: DataDirDiskUsageOptions["exclude"] } = {}) {
    this.root = root;
    this.usage = dataDirDiskUsage(root, options.usageExclude === undefined ? {} : { exclude: options.usageExclude });
  }

  pathOf(ref: string): string {
    const segments = ref.split("/");
    if (segments.length === 0 || !segments.every((segment) => REF_SEGMENT.test(segment))) {
      throw new TypeError("invalid storage ref");
    }
    return join(this.root, ...segments);
  }

  async writeAtomic(ref: string, data: AtomicWriteSource, options: WriteAtomicOptions = {}): Promise<StoredFile> {
    const target = this.pathOf(ref);
    await mkdir(dirname(target), { recursive: true });
    return writeAtomically(target, data, options);
  }

  read(ref: string, range?: { start: number; end?: number }): AsyncIterable<Uint8Array> {
    const path = this.pathOf(ref);
    return createReadStream(path, range === undefined ? {} : { start: range.start, ...(range.end === undefined ? {} : { end: range.end }) });
  }

  async stat(ref: string): Promise<{ sizeBytes: number } | null> {
    try {
      const stats = await stat(this.pathOf(ref));
      return stats.isFile() ? { sizeBytes: stats.size } : null;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async digest(ref: string): Promise<string | null> {
    try {
      return (await hashFile(this.pathOf(ref))).digest;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async remove(ref: string): Promise<void> {
    await rm(this.pathOf(ref), { recursive: true, force: true });
  }

  async removeEmptyDirs(prefix: string, options: { olderThan?: number } = {}): Promise<number> {
    let removed = 0;
    /** Whether `dir` is gone afterwards. */
    const prune = async (dir: string): Promise<boolean> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) {
          return true;
        }
        throw error;
      }
      let empty = true;
      for (const entry of entries) {
        if (!entry.isDirectory() || !(await prune(join(dir, entry.name)))) {
          empty = false;
        }
      }
      if (!empty) {
        return false;
      }
      try {
        if (options.olderThan !== undefined && (await stat(dir)).mtimeMs >= options.olderThan) {
          return false;
        }
        await rmdir(dir);
      } catch (error) {
        // Something was written into it meanwhile: it stays.
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY") {
          return false;
        }
        if (!isNotFound(error)) {
          throw error;
        }
      }
      removed += 1;
      return true;
    };
    await prune(this.pathOf(prefix));
    return removed;
  }

  async list(prefix: string): Promise<string[]> {
    const refs: string[] = [];
    const walk = async (dir: string, refPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const ref = `${refPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), ref);
        } else if (entry.isFile()) {
          refs.push(ref);
        }
      }
    };
    await walk(this.pathOf(prefix), prefix);
    return refs.sort();
  }

  async usedBytes(prefix: string): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && !entry.name.endsWith(PARTIAL_SUFFIX)) {
          try {
            total += (await stat(path)).size;
          } catch (error) {
            // Removed between listing and stat: it no longer uses space.
            if (!isNotFound(error)) {
              throw error;
            }
          }
        }
      }
    };
    await walk(this.pathOf(prefix));
    return total;
  }

  /**
   * Every `.partial` file under the data directory except in the default cache directory
   * `media/`, which belongs to the flat cache store and its stricter rules for files the
   * user may have put there.
   */
  async removePartials(): Promise<number> {
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        // A directory removed while the walk was on its way (a purge's files going): nothing left in it.
        if (dir !== this.root && isNotFound(error)) {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (dir === this.root && entry.name === CACHE_DIR_NAME) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && entry.name.endsWith(PARTIAL_SUFFIX)) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
    };
    await walk(this.root);
    return removed;
  }

  diskUsage(): ReturnType<FileStore["diskUsage"]> {
    return this.usage.diskUsage();
  }
}
