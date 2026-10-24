/**
 * Process-wide mutual exclusion per cache file path. Everything that replaces or removes a
 * file in the cache directory takes the lock of its ref first: publishing a new cache,
 * `DELETE /media`, the pending-file worker and the removal of a replaced cache's old file.
 * Only one of them decides at a time whether the file at a path is still the one a row
 * describes, so a check is never invalidated between reading and acting.
 *
 * Keys fold case: Windows treats `A.mp4` and `a.mp4` as one file.
 */
export class CachePathLocks {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `work` once every earlier holder of `ref`'s lock is done; the lock is released however `work` ends. */
  async withLock<T>(ref: string, work: () => Promise<T>): Promise<T> {
    const key = ref.toLowerCase();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      // The last waiter cleans up, so the map only holds paths someone is waiting on.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Whether some caller holds or waits for `ref`'s lock; for tests and diagnostics. */
  isLocked(ref: string): boolean {
    return this.tails.has(ref.toLowerCase());
  }
}
