import type { SwapRecord } from "./cache-swap.ts";

/** An interrupted cache replacement the start-up recovery could not settle on its own. */
export interface CacheHold {
  /** The scratch directory id under `.amber-tmp`, which is the new asset's id. */
  scratchId: string;
  record: SwapRecord;
  /** Size of the file at the target path when the hold was taken; absent when there was none. */
  currentSizeBytes?: number;
  /** Size of the displaced copy kept in the scratch directory; absent when there is none. */
  displacedSizeBytes?: number;
}

/**
 * The replacements waiting for the user, in memory: rebuilt by every start-up recovery from
 * the `swap.json` files that are still on disk, so nothing is lost when the process ends
 * with holds open. While a path is held, no cache is published to it.
 */
export class CacheHoldRegistry {
  private readonly holds = new Map<string, CacheHold>();

  add(hold: CacheHold): void {
    this.holds.set(hold.scratchId, hold);
  }

  remove(scratchId: string): void {
    this.holds.delete(scratchId);
  }

  get(scratchId: string): CacheHold | undefined {
    return this.holds.get(scratchId);
  }

  list(): CacheHold[] {
    return [...this.holds.values()];
  }

  /** Whether a replacement of `ref` waits for the user; names compare as Windows compares them. */
  isHeld(ref: string): boolean {
    const key = ref.toLowerCase();
    return this.list().some((hold) => hold.record.targetRef.toLowerCase() === key);
  }
}
