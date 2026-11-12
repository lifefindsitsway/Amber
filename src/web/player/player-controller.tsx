import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { PLAYER_SEEK_TOLERANCE_MS } from "../../shared/defaults.ts";
import { CAPABILITIES, type PlayerCapabilities } from "./capabilities.ts";
import { PLAYBACK_RATES } from "./player-menus.tsx";

/** What a concrete player plugs into the controller. */
export interface PlayerDriver {
  capabilities: PlayerCapabilities;
  seek(ms: number): void;
  /** Starts playback; offered by players that may be started from a button press. */
  play?(): void;
  /** Pauses playback; offered by players that can be paused by script (needed to stop at the end of a range). */
  pause?(): void;
}

/** What 「播放一段」 does with the mounted player; see `PlayerCapabilities.rangePlayback`. */
export type RangePlayback = PlayerCapabilities["rangePlayback"];

/** A range being played: where it ends, as `playRange` was asked. */
export interface PlayingRange {
  readonly id: number;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The fastest a player plays: a reported time further ahead of the last one than this rate
 * over the wall-clock time between them (plus the seek tolerance) was a jump, not playback.
 */
const fastestRate = (): number => Math.max(...PLAYBACK_RATES);

interface RangeState {
  view: PlayingRange;
  /** Whether the player is (known to be) playing it; a pause only cancels once it is. */
  playing: boolean;
  /** When `playRange` asked for the jump, on the controller's clock. */
  requestedAt: number;
  /** The last time reported inside the range and when; absent until the jump to its start has landed. */
  last?: { ms: number; at: number };
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
  private range: RangeState | undefined;
  private rangeSeq = 0;
  private playing = false;
  private readonly now: () => number;

  /** `now` is the wall clock used to tell playback from a jump; tests pass their own. */
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  get capabilities(): PlayerCapabilities {
    return this.driver?.capabilities ?? CAPABILITIES.none;
  }

  attach(driver: PlayerDriver): () => void {
    // Another player: whatever range the previous one was playing is over.
    this.clearRange();
    this.driver = driver;
    this.timeMs = undefined;
    this.playing = false;
    this.applyPending(driver);
    this.emit();
    return () => {
      if (this.driver === driver) {
        const leftAt = driver.capabilities.timeTracking === "supported" ? this.timeMs : undefined;
        this.driver = undefined;
        this.timeMs = undefined;
        this.playing = false;
        this.clearRange();
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
      // The user chose another place: a range still playing does not stop there any more.
      this.clearRange();
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

  /**
   * What 「播放一段」 does with the mounted player: `play` needs a player that declares it and
   * can both be started and paused by script; one that cannot pause only jumps.
   */
  get rangePlayback(): RangePlayback {
    const driver = this.driver;
    if (driver === undefined || driver.capabilities.seekMode === "unsupported") return "unsupported";
    if (driver.capabilities.rangePlayback === "play" && (driver.play === undefined || driver.pause === undefined)) return "jump";
    return driver.capabilities.rangePlayback;
  }

  /**
   * 「播放一段」: jumps to `startMs` and plays, pausing once playback reaches `endMs`. The user
   * always wins over the pending pause: a seek from the page (another sentence, a citation)
   * or inside the player, pausing, another range, a different player, `restart` and
   * `cancelRange` (a caller going away) all drop it, after which playback is the user's
   * again. Following the time (highlighting the current sentence) only reads it. A player
   * that cannot pause or tell its time only jumps. Returns the range's handle for
   * `cancelRange`.
   */
  playRange(startMs: number, endMs: number): number {
    this.rangeSeq += 1;
    const id = this.rangeSeq;
    // The jump is the user's: it replaces any pending range and the remembered position.
    this.request(startMs, "user");
    const driver = this.driver;
    if (driver !== undefined && endMs > startMs && this.rangePlayback === "play") {
      this.range = { view: { id, startMs, endMs }, playing: this.playing, requestedAt: this.now() };
      driver.play?.();
    }
    this.emit();
    return id;
  }

  /** Drops the pending pause of the range `id` (any range when omitted); playback goes on as it is. */
  cancelRange(id?: number): void {
    if (this.range === undefined || (id !== undefined && this.range.view.id !== id)) return;
    this.clearRange();
    this.emit();
  }

  /** The range whose end will pause playback, if any. */
  playingRange(): PlayingRange | undefined {
    return this.range?.view;
  }

  /** Called by players that track time; ignored for those that cannot. */
  reportTime(ms: number): void {
    if (this.driver?.capabilities.timeTracking !== "supported" || ms === this.timeMs) {
      return;
    }
    this.timeMs = ms;
    this.followRange(ms);
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
    this.playing = event === "play";
    const range = this.range;
    if (range !== undefined) {
      if (event === "play") {
        range.playing = true;
      } else if (event === "ended" || range.playing) {
        // A pause before the range began playing is the player settling after the jump (an
        // embed may report one), not the user; once it played, a pause is the user's.
        this.clearRange();
        this.emit();
      }
    }
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

  /**
   * Pauses at the end of the range. Times from before the jump landed are ignored; after it,
   * a time behind the last one or further ahead than playback could have got is a seek the
   * player made for the user (its own seek bar), which ends the range like any other.
   */
  private followRange(ms: number): void {
    const range = this.range;
    if (range === undefined) return;
    const at = this.now();
    const { startMs, endMs } = range.view;
    if (range.last === undefined) {
      // The jump has landed once a time near `startMs` is reported. Anywhere else in the range
      // is not enough: replaying the sentence already playing, a poll taken before the seek is
      // reflected still reports the old position, and the jump's own time after it would then
      // read as the user seeking backwards. Playback may have moved on from `startMs` before
      // the first report after the jump (a polling player, a fast rate), but never further than
      // the fastest rate over the time since the jump was asked for, so that much is allowed
      // past the seek tolerance; a stale report comes right after the request and gets nearly none.
      const reach = (at - range.requestedAt) * fastestRate() + PLAYER_SEEK_TOLERANCE_MS;
      if (ms < startMs - PLAYER_SEEK_TOLERANCE_MS || ms > Math.min(startMs + reach, endMs + PLAYER_SEEK_TOLERANCE_MS)) return;
    } else {
      const reach = (at - range.last.at) * fastestRate() + PLAYER_SEEK_TOLERANCE_MS;
      if (ms < range.last.ms - PLAYER_SEEK_TOLERANCE_MS || ms > range.last.ms + reach) {
        this.clearRange();
        return;
      }
    }
    range.last = { ms, at };
    if (ms >= endMs) {
      // Cleared first: the pause this causes is ours, not the user's.
      this.clearRange();
      this.driver?.pause?.();
    }
  }

  private clearRange(): void {
    this.range = undefined;
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

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/**
 * 「播放一段」 for a view: `mode` says whether its entry points read 「播放」 (`play`), 「跳到」
 * (`jump`) or are left out (`unsupported`, also without a player). A range this view started
 * stops being paused at its end once the view unmounts, so playback is never stopped by
 * something no longer on screen. `playing` is the range the player will pause at, whoever
 * started it.
 */
export function usePlayRange(): { mode: RangePlayback; playing: PlayingRange | undefined; playRange: (startMs: number, endMs: number) => void } {
  const controller = useOptionalPlayerController();
  const subscribe = useCallback((listener: () => void) => (controller === undefined ? NO_SUBSCRIPTION() : controller.subscribe(listener)), [controller]);
  const mode = useSyncExternalStore(subscribe, () => controller?.rangePlayback ?? "unsupported");
  const playing = useSyncExternalStore(subscribe, () => controller?.playingRange());
  const started = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (started.current !== undefined) controller?.cancelRange(started.current);
    },
    [controller],
  );
  const playRange = useCallback(
    (startMs: number, endMs: number) => {
      if (controller !== undefined) started.current = controller.playRange(startMs, endMs);
    },
    [controller],
  );
  return { mode, playing, playRange };
}

export function usePlayerCapabilities(): PlayerCapabilities {
  const controller = usePlayerController();
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.capabilities,
  );
}
