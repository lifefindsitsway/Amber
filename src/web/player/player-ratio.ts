import { useLayoutEffect, useState } from "react";
import { PLAYER_PORTRAIT_MAX_VIEWPORT_RATIO, PLAYER_RATIO_MEMORY_MAX } from "../../shared/defaults.ts";

/** Width over height of the 16:9 frame every landscape video keeps. */
export const LANDSCAPE_RATIO = 16 / 9;
/** The narrowest aspect ratio remembered; anything taller is held to the viewport cap anyway. */
export const MIN_REMEMBERED_RATIO = 0.25;

const STORAGE_KEY = "amber.player.ratios";

/** Which video a remembered ratio belongs to. A replaced cache file gets a new asset id, so it never inherits the old ratio. */
export interface PlayerRatioScope {
  userId: string;
  contentId: string;
  assetId: string;
}

interface RatioEntry extends PlayerRatioScope {
  ratio: number;
}

/** Whether a ratio is one the memory may hold: finite and between the narrowest kept and 16:9. */
export function isRememberableRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_REMEMBERED_RATIO && value <= LANDSCAPE_RATIO;
}

function isEntry(value: unknown): value is RatioEntry {
  if (typeof value !== "object" || value === null) return false;
  const { userId, contentId, assetId, ratio } = value as Record<string, unknown>;
  return typeof userId === "string" && typeof contentId === "string" && typeof assetId === "string" && isRememberableRatio(ratio);
}

function sameScope(entry: PlayerRatioScope, scope: PlayerRatioScope): boolean {
  return entry.userId === scope.userId && entry.contentId === scope.contentId && entry.assetId === scope.assetId;
}

/** Oldest first. Storage that throws, a damaged value or a foreign entry all read as nothing remembered. */
function readAll(): RatioEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function readPlayerRatio(scope: PlayerRatioScope): number | undefined {
  return readAll().find((entry) => sameScope(entry, scope))?.ratio;
}

/**
 * Remembers the ratio of a video as the newest entry; past `PLAYER_RATIO_MEMORY_MAX` entries
 * the oldest ones go. A value the memory may not hold is not written. Full or unavailable
 * storage simply leaves it unremembered.
 */
export function rememberPlayerRatio(scope: PlayerRatioScope, ratio: number): void {
  if (!isRememberableRatio(ratio)) return;
  const all = readAll();
  const newest = all.at(-1);
  if (newest !== undefined && sameScope(newest, scope) && newest.ratio === ratio) return;
  const entries = all.filter((entry) => !sameScope(entry, scope));
  entries.push({ ...scope, ratio });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-PLAYER_RATIO_MEMORY_MAX)));
  } catch {
    // Not remembered.
  }
}

/**
 * The player's height: a landscape video keeps the 16:9 frame; a portrait or square one grows
 * to show its whole picture, but never past `PLAYER_PORTRAIT_MAX_VIEWPORT_RATIO` of the
 * column's visible height (so the chat below stays within reach), and never below 16:9.
 */
export function playerHeight(width: number, ratio: number, viewportHeight: number): number {
  const landscape = (width * 9) / 16;
  return Math.max(landscape, Math.min(width / ratio, PLAYER_PORTRAIT_MAX_VIEWPORT_RATIO * viewportHeight));
}

/** The nearest ancestor that scrolls vertically: the column whose visible height caps a tall player. */
function scrollParentOf(element: HTMLElement): HTMLElement | undefined {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return node;
  }
  return undefined;
}

interface FrameSize {
  width: number;
  viewport: number;
}

/**
 * The height the player frame takes for a video of `ratio`, in px, kept current as the player's
 * width or the scrolling column's visible height changes (a window resize, the splitter, the
 * layout switching). Measured in a layout effect, so the first painted frame already has it.
 * A video whose ratio is not known yet counts as landscape. Undefined while it cannot apply
 * (`enabled` off: fullscreen or an audio-only file; no layout to measure), and the frame then
 * keeps its plain 16:9.
 */
export function usePlayerFrameHeight(root: HTMLElement | null, ratio: number | undefined, enabled: boolean): number | undefined {
  const [size, setSize] = useState<FrameSize | undefined>(undefined);
  useLayoutEffect(() => {
    if (root === null || !enabled) return undefined;
    const scroller = scrollParentOf(root);
    const measure = (): void => {
      const next: FrameSize = { width: root.clientWidth, viewport: scroller === undefined ? window.innerHeight : scroller.clientHeight };
      setSize((previous) => (previous !== undefined && previous.width === next.width && previous.viewport === next.viewport ? previous : next));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(root);
    if (scroller !== undefined) observer?.observe(scroller);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [root, enabled]);
  if (!enabled || size === undefined || size.width <= 0) return undefined;
  return playerHeight(size.width, ratio ?? LANDSCAPE_RATIO, size.viewport);
}
