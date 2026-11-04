import { useEffect } from "react";
import { PLAYBACK_RESUME_END_MARGIN_MS, PLAYBACK_RESUME_MIN_MS, PLAYBACK_RESUME_SAVE_MS } from "../../shared/defaults.ts";
import { deletePlaybackPosition, readPlaybackPosition, writePlaybackPosition } from "./playback-positions.ts";
import type { PlayerController } from "./player-controller.tsx";

/** A time report this close to where playback finished is the old position still being reported. */
const STALE_REPORT_MS = 2000;

/** Whether a position this close to the end counts as watched through. */
function inEndRegion(positionMs: number, durationMs: number | undefined): boolean {
  return durationMs !== undefined && positionMs >= durationMs - PLAYBACK_RESUME_END_MARGIN_MS;
}

/**
 * The position remembered for a Content, or undefined when there is none worth resuming: a
 * record already inside the end region (the video was finished, or its length changed since)
 * is not offered.
 */
export function rememberedPosition(userId: string, contentId: string, contentDurationMs: number | undefined): number | undefined {
  const record = readPlaybackPosition(userId, contentId);
  if (record === undefined || record.positionMs < PLAYBACK_RESUME_MIN_MS) return undefined;
  return inEndRegion(record.positionMs, record.durationMs ?? contentDurationMs) ? undefined : record.positionMs;
}

/**
 * Decides what of the playing position is written down. Positions before the first
 * `PLAYBACK_RESUME_MIN_MS` are not worth resuming. Reaching the end region, the end of the
 * media or the restart button deletes the record and marks the playback finished: from then
 * on nothing is written (a late timer, the page being hidden, the player unmounting) until the
 * position is observed in the middle again. Reports still showing the position playback
 * finished at do not count as that: a time report already on its way when the restart button
 * was pressed, or the resting time of a video whose length is unknown, cannot revive the record.
 */
export class PlaybackRecorder {
  private readonly userId: string;
  private readonly contentId: string;
  private readonly controller: PlayerController;
  private readonly contentDurationMs: number | undefined;
  private readonly now: () => number;
  private lastMs: number | undefined;
  private lastSavedAt = Number.NEGATIVE_INFINITY;
  private finished = false;
  private staleMs: number | undefined;

  constructor(options: { userId: string; contentId: string; controller: PlayerController; contentDurationMs?: number | undefined; now?: () => number }) {
    this.userId = options.userId;
    this.contentId = options.contentId;
    this.controller = options.controller;
    this.contentDurationMs = options.contentDurationMs;
    this.now = options.now ?? Date.now;
  }

  /** A new time from the player. */
  time(positionMs: number): void {
    this.lastMs = positionMs;
    if (this.staleMs !== undefined) {
      if (Math.abs(positionMs - this.staleMs) < STALE_REPORT_MS) return;
      this.staleMs = undefined;
    }
    if (inEndRegion(positionMs, this.duration())) {
      this.finish();
      return;
    }
    if (positionMs < PLAYBACK_RESUME_MIN_MS) return;
    this.finished = false;
    if (this.now() - this.lastSavedAt >= PLAYBACK_RESUME_SAVE_MS) this.save(positionMs);
  }

  /** Pause, page hidden, player gone: writes the last known position now. */
  flush(): void {
    const positionMs = this.lastMs;
    if (positionMs === undefined) return;
    if (inEndRegion(positionMs, this.duration())) {
      this.finish();
      return;
    }
    if (this.finished || positionMs < PLAYBACK_RESUME_MIN_MS) return;
    this.save(positionMs);
  }

  /** The player went away: its time does not describe the next player. */
  detached(): void {
    this.flush();
    this.lastMs = undefined;
  }

  /** The video played to its end. */
  ended(): void {
    this.staleMs = this.lastMs;
    this.finish();
  }

  /** 「从头播放」. */
  restart(): void {
    this.staleMs = this.lastMs;
    this.finish();
    this.lastMs = 0;
  }

  private duration(): number | undefined {
    return this.controller.durationMs() ?? this.contentDurationMs;
  }

  private save(positionMs: number): void {
    const duration = this.duration();
    const rounded = Math.round(positionMs);
    this.lastSavedAt = this.now();
    writePlaybackPosition(this.userId, this.contentId, { positionMs: rounded, ...(duration === undefined ? {} : { durationMs: duration }), updatedAt: this.lastSavedAt });
  }

  private finish(): void {
    if (!this.finished) {
      deletePlaybackPosition(this.userId, this.contentId);
    }
    this.finished = true;
  }
}

/**
 * Remembers where the user is in a Content, per user in this browser: writes while the local
 * player plays (throttled), and when playback pauses, the player goes away, the page is hidden
 * or left. Online players neither write nor delete the record: their time and events are
 * ignored. Without a user id nothing is written. `durationMs` is the Content's own length, used
 * until a player reports the media's.
 */
export function usePlaybackResume(controller: PlayerController, options: { userId: string | undefined; contentId: string; durationMs?: number | undefined }): void {
  const { userId, contentId, durationMs } = options;
  useEffect(() => {
    if (userId === undefined) return undefined;
    const recorder = new PlaybackRecorder({ userId, contentId, controller, contentDurationMs: durationMs });
    const offTime = controller.subscribe(() => {
      if (!controller.capabilities.remembersPosition) return;
      const time = controller.currentTimeMs();
      if (time !== undefined) recorder.time(time);
    });
    const offPlayback = controller.onPlayback((event) => {
      // The driver is already gone when `detach` fires, so it cannot be filtered by capability: an
      // online player never fed the recorder a time, which leaves nothing for it to flush.
      if (event === "detach") {
        recorder.detached();
        return;
      }
      if (!controller.capabilities.remembersPosition) return;
      if (event === "pause") recorder.flush();
      else if (event === "ended") recorder.ended();
      else if (event === "restart") recorder.restart();
    });
    const onHide = (): void => {
      if (document.visibilityState === "hidden") recorder.flush();
    };
    const onPageHide = (): void => recorder.flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      offTime();
      offPlayback();
      recorder.flush();
    };
  }, [controller, userId, contentId, durationMs]);
}
