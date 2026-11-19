import { useCallback, useSyncExternalStore } from "react";
import { DANMAKU_PREFS_DEFAULT, DANMAKU_PREFS_KEY, danmakuPrefsSchema, type DanmakuPrefs } from "../../shared/danmaku-prefs.ts";

export type { DanmakuPrefs };

const listeners = new Set<() => void>();
/** Storage can be unavailable (private mode): the choice then lasts for the page only. */
let unsaved: DanmakuPrefs | undefined;
let cached: { raw: string | null; prefs: DanmakuPrefs } | undefined;

function readRaw(): string | null {
  try {
    return localStorage.getItem(DANMAKU_PREFS_KEY);
  } catch {
    return null;
  }
}

/** A damaged or outdated entry reads as the defaults, so a bad value never breaks the player. */
function parse(raw: string | null): DanmakuPrefs {
  if (raw === null) return DANMAKU_PREFS_DEFAULT;
  try {
    const parsed = danmakuPrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DANMAKU_PREFS_DEFAULT;
  } catch {
    return DANMAKU_PREFS_DEFAULT;
  }
}

/** The stored preferences; the same object while the stored text is unchanged, as `useSyncExternalStore` needs. */
export function readDanmakuPrefs(): DanmakuPrefs {
  if (unsaved !== undefined) return unsaved;
  const raw = readRaw();
  if (cached === undefined || cached.raw !== raw) cached = { raw, prefs: parse(raw) };
  return cached.prefs;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Merges `change` into the stored preferences; values outside the schema's ranges are clamped first. */
export function writeDanmakuPrefs(change: Partial<DanmakuPrefs>): void {
  const merged = { ...readDanmakuPrefs(), ...change };
  const next: DanmakuPrefs = {
    enabled: merged.enabled,
    density: clampTo(DANMAKU_PREF_RANGES.density, merged.density),
    opacity: clampTo(DANMAKU_PREF_RANGES.opacity, merged.opacity),
    fontScale: clampTo(DANMAKU_PREF_RANGES.fontScale, merged.fontScale),
  };
  const raw = JSON.stringify(next);
  try {
    localStorage.setItem(DANMAKU_PREFS_KEY, raw);
    unsaved = undefined;
    cached = { raw, prefs: next };
  } catch {
    unsaved = next;
  }
  notify();
}

type Range = { min: number; max: number };

const rangeOf = (schema: { minValue: number | null; maxValue: number | null }): Range => ({ min: schema.minValue ?? 0, max: schema.maxValue ?? 1 });

/** The ranges the stored preferences allow, read from their schema so the sliders and the store never disagree with it. */
export const DANMAKU_PREF_RANGES = {
  density: rangeOf(danmakuPrefsSchema.shape.density),
  opacity: rangeOf(danmakuPrefsSchema.shape.opacity),
  fontScale: rangeOf(danmakuPrefsSchema.shape.fontScale),
} as const;

function clampTo(range: Range, value: number): number {
  return Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : range.min;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window of the app changed them: every player follows.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === DANMAKU_PREFS_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The danmaku preferences of the local player, shared by its button, popover and layer and kept in local storage. */
export function useDanmakuPrefs(): [DanmakuPrefs, (change: Partial<DanmakuPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, readDanmakuPrefs, () => DANMAKU_PREFS_DEFAULT);
  const update = useCallback((change: Partial<DanmakuPrefs>) => writeDanmakuPrefs(change), []);
  return [prefs, update];
}
