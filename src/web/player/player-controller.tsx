import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { CAPABILITIES, type PlayerCapabilities } from "./capabilities.ts";

/** What a concrete player plugs into the controller. */
export interface PlayerDriver {
  capabilities: PlayerCapabilities;
  seek(ms: number): void;
  /** Starts playback; offered by players that may be started from a button press. */
  play?(): void;
}

/**
 * Where a requested position comes from, lowest rank first: the position remembered from an
 * earlier visit, the one carried across a player or quality switch, and one the user chose
 * (a seek, or a deep link to a segment).
 */
export type SeekPriority = "resume" | "carry" | "user";

const RANK: Readonly<Record<SeekPriority, number>> = { resume: 0, carry: 1, user: 2 };

/** What players tell the page about playback, besides the time. `restart` is the 「从头播放」 button. */
export type PlaybackEvent = "play" | "pause" | "ended" | "detach" | "restart";

type Listener = () => void;

/**
 * The page-wide handle to whichever player is mounted: citations, chapters and sentences
 * call `seek`; players report their time, which only exists when time tracking is
 * supported. With no player mounted, a requested position is remembered and applied on attach.
 *
 * Only one position is pending at a time and the highest priority wins: a lower request never
 * replaces a higher one, a user seek (or deep link) voids the remembered position for good, and
 * the remembered position is handed out once. The remembered position goes only to a player that
 * remembers positions (the local one); any other player leaves it waiting. A carried position
 * (the time of the player that just went away) goes only to a player that can read time, so it
 * never makes a Bilibili iframe reload with autoplay. One controller serves one Content: the
 * page creates it per Content.
 */
export class PlayerController {
  private driver: PlayerDriver | undefined;
  private pending: { ms: number; priority: SeekPriority } | undefined;
  private navigated = false;
  private timeMs: number | undefined;
  private durationValue: number | undefined;
  private noticeMs: number | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly playbackListeners = new Set<(event: PlaybackEvent) => void>();

  get capabilities(): PlayerCapabilities {
    return this.driver?.capabilities ?? CAPABILITIES.none;
  }

  attach(driver: PlayerDriver): () => void {
    this.driver = driver;
    this.timeMs = undefined;
    this.applyPending(driver);
    this.emit();
    return () => {
      if (this.driver === driver) {
        const leftAt = driver.capabilities.timeTracking === "supported" ? this.timeMs : undefined;
        this.driver = undefined;
        this.timeMs = undefined;
        if (leftAt !== undefined) this.request(leftAt, "carry");
        this.emitPlayback("detach");
        this.emit();
      }
    };
  }

  /** A position the user chose: a citation, chapter, sentence or the like. */
  seek(ms: number): void {
    this.request(ms, "user");
  }

  /**
   * Asks for a position. A request that ranks below the pending one is dropped. With a player
   * mounted it is applied at once if that player can take it, otherwise it waits for one.
   */
  request(ms: number, priority: SeekPriority): void {
    if (priority === "user") {
      this.navigated = true;
      if (this.pending?.priority === "resume") this.pending = undefined;
    } else if (priority === "resume" && this.navigated) {
      return;
    }
    if (this.pending !== undefined && RANK[this.pending.priority] > RANK[priority]) return;
    this.pending = { ms, priority };
    if (this.driver === undefined) return;
    this.applyPending(this.driver);
    // A seek nobody can perform is not kept for the next player.
    if (priority === "user" && this.pending?.priority === "user") this.pending = undefined;
    this.emit();
  }

  /**
   * Offers the position remembered from an earlier visit. It is applied to the first player that
   * remembers positions (the local one), unless the user (or a deep link) already chose where to
   * be; an online player never takes it and it keeps waiting.
   */
  offerResume(ms: number): void {
    this.request(ms, "resume");
  }

  /** The page was opened on a deep link: it decides where to look, so nothing is resumed. */
  suppressResume(): void {
    this.navigated = true;
    if (this.pending?.priority === "resume") this.pending = undefined;
  }

  /** The 「从头播放」 button: back to 0 and playing, and the remembered position is let go. */
  restart(): void {
    this.noticeMs = undefined;
    this.emitPlayback("restart");
    this.seek(0);
    this.driver?.play?.();
    this.emit();
  }

  /** The position the 「已从 … 继续播放」 card names, while it is shown. */
  get resumeNotice(): number | undefined {
    return this.noticeMs;
  }

  dismissResumeNotice(): void {
    if (this.noticeMs === undefined) return;
    this.noticeMs = undefined;
    this.emit();
  }

  /** Called by players that track time; ignored for those that cannot. */
  reportTime(ms: number): void {
    if (this.driver?.capabilities.timeTracking !== "supported" || ms === this.timeMs) {
      return;
    }
    this.timeMs = ms;
    this.emit();
  }

  currentTimeMs(): number | undefined {
    return this.capabilities.timeTracking === "supported" ? this.timeMs : undefined;
  }

  /** The media length once a player knows it. */
  reportDuration(ms: number | undefined): void {
    this.durationValue = ms;
  }

  durationMs(): number | undefined {
    return this.durationValue;
  }

  reportPlayback(event: Exclude<PlaybackEvent, "detach" | "restart">): void {
    this.emitPlayback(event);
  }

  onPlayback(listener: (event: PlaybackEvent) => void): () => void {
    this.playbackListeners.add(listener);
    return () => this.playbackListeners.delete(listener);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyPending(driver: PlayerDriver): void {
    const pending = this.pending;
    if (pending === undefined || driver.capabilities.seekMode === "unsupported") return;
    // The remembered position waits for a player that remembers positions.
    if (pending.priority === "resume" && !driver.capabilities.remembersPosition) return;
    if (pending.priority !== "user" && driver.capabilities.timeTracking !== "supported") {
      // A carried time is stale by the time a player that cannot read time is left again.
      if (pending.priority === "carry") this.pending = undefined;
      return;
    }
    this.pending = undefined;
    driver.seek(pending.ms);
    if (pending.priority === "resume") this.noticeMs = pending.ms;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private emitPlayback(event: PlaybackEvent): void {
    for (const listener of this.playbackListeners) {
      listener(event);
    }
  }
}

const ControllerContext = createContext<PlayerController | undefined>(undefined);

export function PlayerControllerProvider(props: { controller: PlayerController; children: ReactNode }) {
  return <ControllerContext.Provider value={props.controller}>{props.children}</ControllerContext.Provider>;
}

export function usePlayerController(): PlayerController {
  const controller = useContext(ControllerContext);
  if (controller === undefined) {
    throw new Error("PlayerControllerProvider missing");
  }
  return controller;
}

/** The controller when a page provides one, else `undefined`; for views that also work without a player. */
export function useOptionalPlayerController(): PlayerController | undefined {
  return useContext(ControllerContext);
}

/** Current playback time, or undefined when the player cannot report it. */
export function usePlayerTime(): number | undefined {
  const controller = usePlayerController();
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.currentTimeMs(),
  );
}

export function usePlayerCapabilities(): PlayerCapabilities {
  const controller = usePlayerController();
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.capabilities,
  );
}
