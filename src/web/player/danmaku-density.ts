import type { DanmakuItem } from "../../shared/dto/danmaku.ts";

/** The stretch of media time over which density is judged. */
const DENSITY_WINDOW_MS = 1000;
/** A window holding no more than this many items is sparse and keeps them all, whatever the density. */
const SPARSE_WINDOW_ITEMS = 2;

/**
 * A fixed pseudo-random rank for ties of weight, so equal-weight items are thinned evenly
 * rather than first come first kept. It depends only on the item's place in the snapshot, so
 * a lower density always keeps a subset of what a higher one keeps.
 */
function tieRank(index: number): number {
  let x = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * The items shown at `density` (the share kept in dense stretches, 1 = all), in time order.
 * Within each window of media time, a sparse window keeps everything; a denser one keeps
 * `ceil(density × n)` items (never fewer than a sparse window would), the platform's higher
 * weights first.
 */
export function thinByWeight(items: readonly DanmakuItem[], density: number): DanmakuItem[] {
  if (density >= 1) return [...items];
  const kept = new Set<number>();
  let start = 0;
  while (start < items.length) {
    const window = Math.floor((items[start] as DanmakuItem).timeMs / DENSITY_WINDOW_MS);
    let end = start;
    while (end < items.length && Math.floor((items[end] as DanmakuItem).timeMs / DENSITY_WINDOW_MS) === window) end += 1;
    const count = end - start;
    const keep = count <= SPARSE_WINDOW_ITEMS ? count : Math.max(SPARSE_WINDOW_ITEMS, Math.ceil(density * count));
    const ranked: number[] = [];
    for (let index = start; index < end; index += 1) ranked.push(index);
    ranked.sort((a, b) => (items[b] as DanmakuItem).weight - (items[a] as DanmakuItem).weight || tieRank(a) - tieRank(b));
    for (const index of ranked.slice(0, keep)) kept.add(index);
    start = end;
  }
  return items.filter((_, index) => kept.has(index));
}
