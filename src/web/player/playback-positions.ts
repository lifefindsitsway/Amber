import { PLAYBACK_RESUME_MAX_ENTRIES } from "../../shared/defaults.ts";

/** Where a Content was last left, as remembered in this browser. */
export interface PlaybackPosition {
  positionMs: number;
  durationMs?: number;
  /** Unix ms of the last save; the oldest entries are dropped first. */
  updatedAt: number;
}

type Positions = Record<string, PlaybackPosition>;

/** One key per user, so accounts sharing a browser never see each other's positions. */
export function playbackStorageKey(userId: string): string {
  return `amber.playback.${userId}`;
}

function isPosition(value: unknown): value is PlaybackPosition {
  if (typeof value !== "object" || value === null) return false;
  const { positionMs, durationMs, updatedAt } = value as Record<string, unknown>;
  const finite = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
  return finite(positionMs) && positionMs >= 0 && finite(updatedAt) && (durationMs === undefined || (finite(durationMs) && durationMs > 0));
}

/** A damaged or foreign value reads as empty, so a bad entry never breaks the player. */
function readAll(userId: string): Positions {
  try {
    const raw = localStorage.getItem(playbackStorageKey(userId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const positions: Positions = {};
    for (const [contentId, value] of Object.entries(parsed)) {
      if (isPosition(value)) positions[contentId] = value;
    }
    return positions;
  } catch {
    return {};
  }
}

/** Storage can be full or unavailable (private mode): the position is then simply not remembered. */
function writeAll(userId: string, positions: Positions): void {
  try {
    if (Object.keys(positions).length === 0) localStorage.removeItem(playbackStorageKey(userId));
    else localStorage.setItem(playbackStorageKey(userId), JSON.stringify(positions));
  } catch {
    // Not remembered.
  }
}

export function readPlaybackPosition(userId: string, contentId: string): PlaybackPosition | undefined {
  return readAll(userId)[contentId];
}

/** Saves a position; past `PLAYBACK_RESUME_MAX_ENTRIES` entries the least recently saved ones go. */
export function writePlaybackPosition(userId: string, contentId: string, position: PlaybackPosition): void {
  const positions = readAll(userId);
  delete positions[contentId];
  positions[contentId] = position;
  const entries = Object.entries(positions);
  if (entries.length > PLAYBACK_RESUME_MAX_ENTRIES) {
    // The entry just written is last in insertion order, so on a timestamp tie it must win.
    const ranked = entries.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry[1].updatedAt - a.entry[1].updatedAt || b.index - a.index);
    writeAll(userId, Object.fromEntries(ranked.slice(0, PLAYBACK_RESUME_MAX_ENTRIES).map((item) => item.entry)));
    return;
  }
  writeAll(userId, positions);
}

export function deletePlaybackPosition(userId: string, contentId: string): void {
  const positions = readAll(userId);
  if (!(contentId in positions)) return;
  delete positions[contentId];
  writeAll(userId, positions);
}
