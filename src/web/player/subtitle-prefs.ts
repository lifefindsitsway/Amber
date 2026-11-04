import { useCallback, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  defaultSubtitleAppearance,
  defaultSubtitlePlacement,
  subtitleAppearanceSchema,
  subtitlePlacementSchema,
  type SubtitleAppearance,
  type SubtitlePlacement,
} from "../../shared/subtitle-style.ts";
import { subtitlePrefKeys, trackPrefSchema, type StoredSubtitleTrackPref, type SubtitleTrackPref } from "../../shared/subtitle-prefs.ts";

export {
  SUBTITLE_DISPLAY_MODES,
  subtitlePrefKeys,
  upgradeTrackPref,
  type StoredSubtitleTrackPref,
  type SubtitleDisplayMode,
  type SubtitleTrackPref,
  type SubtitleTranslationPref,
} from "../../shared/subtitle-prefs.ts";

const OFF_TRACK: SubtitleTrackPref = { version: 2, mode: "off" };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Damaged or outdated values read as absent, so a bad entry never breaks the player. */
function readParsed<T>(key: string, schema: z.ZodType<T>): T | undefined {
  const raw = read(key);
  if (raw === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Storage can be unavailable (private mode): the value then lasts for the page only. */
const memory = new Map<string, string | null>();

function write(key: string, value: string | null): void {
  memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Kept in memory only.
  }
  changed();
}

function parsedKey<T>(key: string, schema: z.ZodType<T>): T | undefined {
  if (memory.has(key)) {
    const raw = memory.get(key);
    if (raw === null || raw === undefined) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }
  return readParsed(key, schema);
}

export function readAppearance(userId: string): SubtitleAppearance {
  return parsedKey(subtitlePrefKeys.appearance(userId), subtitleAppearanceSchema) ?? defaultSubtitleAppearance();
}

/** The appearance is global for the user and takes effect at once. */
export function writeAppearance(userId: string, appearance: SubtitleAppearance): void {
  write(subtitlePrefKeys.appearance(userId), JSON.stringify(appearance));
}

/** 「恢复系统默认样式」: the appearance only; no placement is touched. */
export function resetAppearance(userId: string): void {
  write(subtitlePrefKeys.appearance(userId), null);
}

export function readDefaultPlacement(userId: string): SubtitlePlacement {
  return parsedKey(subtitlePrefKeys.defaultPlacement(userId), subtitlePlacementSchema) ?? defaultSubtitlePlacement();
}

/** 「设为默认位置」. */
export function writeDefaultPlacement(userId: string, placement: SubtitlePlacement): void {
  write(subtitlePrefKeys.defaultPlacement(userId), JSON.stringify(placement));
}

/** Placement precedence: this Content's override, then the user's default, then the system default. */
export function readPlacement(userId: string, contentId: string): SubtitlePlacement {
  return parsedKey(subtitlePrefKeys.placement(userId, contentId), subtitlePlacementSchema) ?? readDefaultPlacement(userId);
}

export function hasPlacementOverride(userId: string, contentId: string): boolean {
  return parsedKey(subtitlePrefKeys.placement(userId, contentId), subtitlePlacementSchema) !== undefined;
}

/** A drag or a typed position writes this Content's override. */
export function writePlacement(userId: string, contentId: string, placement: SubtitlePlacement): void {
  write(subtitlePrefKeys.placement(userId, contentId), JSON.stringify(placement));
}

/** 「恢复默认位置」: drops this Content's override. */
export function clearPlacement(userId: string, contentId: string): void {
  write(subtitlePrefKeys.placement(userId, contentId), null);
}

/**
 * The stored track preference, in whichever format it was written; `upgradeTrackPref` turns
 * it into the current one once the Content's revisions are known.
 */
export function readTrack(userId: string, contentId: string): StoredSubtitleTrackPref {
  return parsedKey(subtitlePrefKeys.track(userId, contentId), trackPrefSchema) ?? OFF_TRACK;
}

/** Writes only the current format. */
export function writeTrack(userId: string, contentId: string, track: SubtitleTrackPref): void {
  write(subtitlePrefKeys.track(userId, contentId), JSON.stringify(track));
}

/**
 * After a translation edit is committed as `toRevisionId`: a preference locked to the edited
 * base `fromRevisionId` moves its lock to the new revision. One following a language already
 * shows the new current translation, and one locked to another version stays as it is.
 */
export function relockTranslation(userId: string, contentId: string, fromRevisionId: string, toRevisionId: string): void {
  const track = readTrack(userId, contentId);
  if (track.version !== 2 || track.translation?.lockedRevisionId !== fromRevisionId) return;
  writeTrack(userId, contentId, { ...track, translation: { ...track.translation, lockedRevisionId: toRevisionId } });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forgets in-memory fallbacks; tests use it between cases. */
export function resetSubtitlePrefsMemory(): void {
  memory.clear();
  changed();
}

export interface SubtitlePrefs {
  appearance: SubtitleAppearance;
  placement: SubtitlePlacement;
  placementOverridden: boolean;
  /** As stored; see `readTrack`. */
  track: StoredSubtitleTrackPref;
  setAppearance(appearance: SubtitleAppearance): void;
  resetAppearance(): void;
  setPlacement(placement: SubtitlePlacement): void;
  setDefaultPlacement(): void;
  resetPlacement(): void;
  setTrack(track: SubtitleTrackPref): void;
}

/**
 * The subtitle preferences of one user and Content, shared by every component that shows or
 * edits them (player overlay, editor, export dialog): a write anywhere re-renders them all.
 */
export function useSubtitlePrefs(userId: string, contentId: string): SubtitlePrefs {
  // Any preference write bumps the version; values are re-read only then, so they keep their identity between writes.
  const current = useSyncExternalStore(subscribe, () => version);
  const { appearance, placement, placementOverridden, track } = useMemo(() => {
    void current;
    return {
      appearance: readAppearance(userId),
      placement: readPlacement(userId, contentId),
      placementOverridden: hasPlacementOverride(userId, contentId),
      track: readTrack(userId, contentId),
    };
  }, [current, userId, contentId]);
  return {
    appearance,
    placement,
    placementOverridden,
    track,
    setAppearance: useCallback((value: SubtitleAppearance) => writeAppearance(userId, value), [userId]),
    resetAppearance: useCallback(() => resetAppearance(userId), [userId]),
    setPlacement: useCallback((value: SubtitlePlacement) => writePlacement(userId, contentId, value), [userId, contentId]),
    setDefaultPlacement: useCallback(() => writeDefaultPlacement(userId, readPlacement(userId, contentId)), [userId, contentId]),
    resetPlacement: useCallback(() => clearPlacement(userId, contentId), [userId, contentId]),
    setTrack: useCallback((value: SubtitleTrackPref) => writeTrack(userId, contentId, value), [userId, contentId]),
  };
}
