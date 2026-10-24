import { Maximize, Minimize, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { PLAYER_CONTROLS_IDLE_MS, PLAYER_SKIP_SECONDS, PLAYER_VOLUME_STEP } from "../../shared/defaults.ts";
import { BASIS_POINTS } from "../../shared/subtitle-style.ts";
import { formatDuration } from "../format.ts";
import { useAutoDismiss } from "../use-auto-dismiss.ts";
import { hasCommandModifier } from "../shortcut-registry.tsx";
import { CAPABILITIES } from "./capabilities.ts";
import { ClockInput } from "./clock-input.tsx";
import type { AdvanceResult, LoopCollectionChoice } from "./list-loop.ts";
import { PlaybackRateMenu, PlayerSettingsMenu, QualityMenu, type QualitySource } from "./player-menus.tsx";
import { usePlayerController, usePlayerTime } from "./player-controller.tsx";
import { usePlayerSettings } from "./player-settings.ts";
import { SeekBar, type ChapterEntry } from "./seek-bar.tsx";
import { SubtitleEditor } from "./subtitle-editor.tsx";
import { SubtitleMenu } from "./subtitle-menu.tsx";
import { SubtitleOverlay, usePictureRect, type SubtitleTrackModel } from "./subtitle-overlay.tsx";
import { useVolumeSetting, VolumeControl } from "./volume-control.tsx";

/** Space between the subtitle editor panel and the picture's edge or the control bar. */
const PANEL_GAP_PX = 8;

/**
 * The playback state carried from one source file to the next. `toId` is the source whose
 * new element restores it; `fromId` is where a failed switch goes back to, and `fallback`
 * marks that return trip, which never bounces again.
 */
interface SourceSwap {
  fromId: string | undefined;
  toId: string;
  timeMs: number;
  wasPlaying: boolean;
  fallback: boolean;
}

function snapshotOf(element: HTMLVideoElement | null): { timeMs: number; wasPlaying: boolean } {
  return element === null ? { timeMs: 0, wasPlaying: false } : { timeMs: element.currentTime * 1000, wasPlaying: !element.paused };
}

/** Whether keyboard focus (not a mouse click) is on the element; focus-visible is the browser's call. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Local `<video>` player with its controls laid over the bottom of the
 * picture: the seek bar (chapters drawn into it) and one row of play/pause · time · speed
 * on the left and volume · settings · fullscreen on the right. While playing, the controls
 * hide when the pointer leaves or rests for PLAYER_CONTROLS_IDLE_MS, leaving a thin progress
 * line; they stay while paused, while a menu is open or while keyboard focus is in them.
 * Keys act only while the player has focus, so they never fight page
 * shortcuts. An audio-only file still plays in the `<video>` element, which keeps one code
 * path for time tracking and seeking; `audioOnly` covers the empty picture with a
 * placeholder, keeps the controls shown and offers no fullscreen.
 *
 * `autoplay` starts playback regardless of the autoplay setting (a list-loop navigation);
 * at the end, the settings' play mode loops this file or asks `onEndedAdvance` for the next
 * one, replaying this one when the list has nothing else to play.
 * `loopCollection` lets the settings menu pick which collection that list is.
 *
 * `subtitles` adds the 「字幕」 menu and the subtitle overlay with its editor:
 * the player times and draws what the page assembled. While a subtitle is dragged or the
 * final look is previewed, the controls step aside.
 *
 * `sources` (the cached qualities of one video) adds the quality menu; `activeSourceId` is
 * the file `src` plays and `onSelectSource` asks the page for another. Each source gets a
 * fresh `<video>` element, so even a new file at the same path is loaded anew. Switching keeps
 * the position (clamped to the new length) and whether it was playing; meanwhile nothing
 * autoplays and an end does not step the list loop; a file that fails to load goes back to
 * the previous one with a notice. Speed, volume, subtitles and fullscreen carry over.
 */
export function LocalPlayer(props: {
  src: string;
  audioOnly?: boolean;
  chapters?: readonly ChapterEntry[];
  autoplay?: boolean;
  onEndedAdvance?: () => Promise<AdvanceResult>;
  loopCollection?: LoopCollectionChoice | undefined;
  subtitles?: SubtitleTrackModel | undefined;
  sources?: readonly QualitySource[] | undefined;
  activeSourceId?: string | undefined;
  onSelectSource?: ((assetId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const controller = usePlayerController();
  const settings = usePlayerSettings();
  const volume = useVolumeSetting();
  const video = useRef<HTMLVideoElement>(null);
  // The subtitle overlay listens to the element itself, so it needs it as state too.
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
    setVideoElement(element);
  }, []);
  // State, not a ref: the menus portal into the player root, so they need it rendered.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<number>(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [swap, setSwap] = useState<SourceSwap | undefined>(undefined);
  // A source the player switched to never autoplays, not even once its data arrives after the restore.
  const [switchedTo, setSwitchedTo] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  useAutoDismiss(notice, () => setNotice(undefined));
  // The page may switch the file by itself (a replaced cache); the position carries over then too.
  const [shownSourceId, setShownSourceId] = useState(props.activeSourceId);
  if (props.activeSourceId !== shownSourceId) {
    setShownSourceId(props.activeSourceId);
    if (props.activeSourceId === undefined) {
      setSwap(undefined);
    } else if (swap === undefined && shownSourceId !== undefined) {
      // Read while the old element is still mounted: this render has not been committed yet.
      setSwap({ fromId: shownSourceId, toId: props.activeSourceId, ...snapshotOf(video.current), fallback: false });
      setSwitchedTo(props.activeSourceId);
    } else if (swap !== undefined && swap.toId !== props.activeSourceId) {
      setSwap({ ...swap, toId: props.activeSourceId });
      setSwitchedTo(props.activeSourceId);
    }
  }
  const [controlsFocused, setControlsFocused] = useState(false);
  const subtitles = props.subtitles;
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
  const [subtitleDragging, setSubtitleDragging] = useState(false);
  const [subtitlePreview, setSubtitlePreview] = useState(false);
  const subtitleEditing = subtitles !== undefined && subtitles.editing && subtitles.mode !== "off";
  const controlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const time = usePlayerTime();
  const [durationMs, setDurationMs] = useState<number | undefined>(undefined);
  // While the bar is dragged it shows the dragged position, not the video's lagging time.
  const [scrubMs, setScrubMs] = useState<number | undefined>(undefined);
  const position = scrubMs ?? time ?? 0;
  const audioOnly = props.audioOnly === true;
  const picture = usePictureRect(subtitles === undefined ? null : videoElement, audioOnly);
  const onDuration = (seconds: number): void => setDurationMs(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined);
  // A seek while a quality switch is under way is where the user wants the new file to be,
  // so it replaces the position taken at the switch instead of being overwritten by it.
  const seekTo = (ms: number): void => {
    const element = video.current;
    if (element !== null) element.currentTime = ms / 1000;
    setSwap((current) => (current === undefined ? current : { ...current, timeMs: ms }));
  };
  const scrubTo = (ms: number): void => {
    setScrubMs(ms);
    seekTo(ms);
  };
  const endScrub = (): void => setScrubMs(undefined);

  useEffect(
    () =>
      controller.attach({
        capabilities: CAPABILITIES.local,
        seek: (ms) => {
          const element = video.current;
          if (element !== null) element.currentTime = ms / 1000;
          setSwap((current) => (current === undefined ? current : { ...current, timeMs: ms }));
        },
      }),
    [controller],
  );

  // Both follow the element too: switching quality mounts a new one.
  useEffect(() => {
    if (videoElement === null) return;
    videoElement.volume = volume.volume;
    videoElement.muted = volume.muted;
  }, [volume.volume, volume.muted, videoElement]);

  useEffect(() => {
    if (videoElement === null) return;
    // A new source resets playbackRate to defaultPlaybackRate, so set both.
    videoElement.defaultPlaybackRate = rate;
    videoElement.playbackRate = rate;
  }, [rate, videoElement]);

  useEffect(() => {
    if (root === null) return undefined;
    const onChange = (): void => setFullscreen(document.fullscreenElement === root);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [root]);

  useEffect(() => () => clearTimeout(idleTimer.current), []);

  useEffect(() => {
    if (!subtitleEditing) setSubtitlePreview(false);
  }, [subtitleEditing]);

  // The editor panel stops above the control bar.
  useLayoutEffect(() => {
    if (!subtitleEditing) return;
    setControlsHeight(controlsRef.current?.offsetHeight ?? 0);
  }, [subtitleEditing, picture.height]);

  const wake = (): void => {
    setPointerActive(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setPointerActive(false), PLAYER_CONTROLS_IDLE_MS);
  };
  const sleep = (): void => {
    clearTimeout(idleTimer.current);
    setPointerActive(false);
  };

  const toggle = (): void => {
    const element = video.current;
    if (element === null) return;
    if (swap !== undefined) {
      // During a quality switch the element may be the old file or a new one still loading;
      // the press decides whether the new file plays once it is ready.
      const wasPlaying = !swap.wasPlaying;
      setSwap({ ...swap, wasPlaying });
      setPlaying(wasPlaying);
      if (!wasPlaying) element.pause();
      return;
    }
    // A source that cannot play rejects play(); the player simply stays paused.
    if (element.paused) element.play().catch(() => undefined);
    else element.pause();
  };
  const skip = (seconds: number): void => {
    const element = video.current;
    if (element === null) return;
    // A file still loading reads 0; while switching, the step starts from the carried position.
    const fromMs = swap === undefined ? element.currentTime * 1000 : swap.timeMs;
    seekTo(Math.max(0, fromMs + seconds * 1000));
  };
  const toggleFullscreen = (): void => {
    if (audioOnly || root === null) return;
    if (document.fullscreenElement === root) {
      if (typeof document.exitFullscreen === "function") document.exitFullscreen().catch(() => undefined);
    } else if (typeof root.requestFullscreen === "function") {
      root.requestFullscreen().catch(() => undefined);
    }
  };
  const selectSource = (assetId: string): void => {
    if (assetId === props.activeSourceId || props.onSelectSource === undefined) return;
    if (swap === undefined) {
      // Taken at the click: the old file may play on until the new one is ready.
      setSwap({ fromId: props.activeSourceId, toId: assetId, ...snapshotOf(video.current), fallback: false });
    } else {
      // Another pick before the last one loaded: the element now may be a file still loading
      // (time 0, paused), so the position and play state of the first click stay. A failure
      // goes back to the last file that did play: the origin, or the target of a fallback.
      const lastGood = swap.fallback ? swap.toId : swap.fromId;
      setSwap({ ...swap, fromId: lastGood === assetId ? undefined : lastGood, toId: assetId, fallback: false });
    }
    setSwitchedTo(assetId);
    setNotice(undefined);
    props.onSelectSource(assetId);
  };
  const restoreSwap = (element: HTMLVideoElement): void => {
    if (swap === undefined || swap.toId !== props.activeSourceId) return;
    setSwap(undefined);
    const duration = element.duration;
    const atEnd = Number.isFinite(duration) && swap.timeMs / 1000 >= duration;
    element.currentTime = atEnd ? duration : swap.timeMs / 1000;
    if (swap.wasPlaying && !atEnd) {
      element.play().catch(() => setPlaying(false));
    } else {
      // A play pressed and then undone during the switch may have started this element.
      if (!element.paused) element.pause();
      setPlaying(false);
    }
  };
  const failSwap = (): void => {
    if (swap === undefined || swap.toId !== props.activeSourceId) return;
    if (swap.fallback || swap.fromId === undefined || props.onSelectSource === undefined) {
      setSwap(undefined);
      setNotice(t("contentView.player.quality.loadFailed"));
      return;
    }
    const back = props.sources?.find((source) => source.assetId === swap.fromId);
    if (back === undefined) {
      // The previous file is gone too (deleted or replaced meanwhile): there is nothing to go
      // back to. A swap left waiting for it would hold off the end of the video and autoplay.
      setSwap(undefined);
      setNotice(t("contentView.player.quality.loadFailed"));
      return;
    }
    setSwap({ ...swap, fromId: swap.toId, toId: swap.fromId, fallback: true });
    setSwitchedTo(swap.fromId);
    setNotice(t("contentView.player.quality.fellBack", { label: back.label }));
    props.onSelectSource(swap.fromId);
  };
  const onEnded = (): void => {
    // The old file ending while the new one loads is not the end of the video.
    if (swap !== undefined) return;
    if (settings.endBehavior !== "loop_list" || props.onEndedAdvance === undefined) return;
    void props
      .onEndedAdvance()
      .then((result) => {
        const element = video.current;
        if (result !== "replay" || element === null) return;
        element.currentTime = 0;
        element.play().catch(() => undefined);
      })
      .catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || hasCommandModifier(event)) return;
    const target = event.target;
    // Form controls (the seek and volume bars included) and the open menus keep their own keys.
    if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (target instanceof Element && target.closest("[role='menu']") !== null) return;
    switch (event.key) {
      case " ":
        event.preventDefault();
        toggle();
        break;
      case "ArrowLeft":
        event.preventDefault();
        skip(-PLAYER_SKIP_SECONDS);
        break;
      case "ArrowRight":
        event.preventDefault();
        skip(PLAYER_SKIP_SECONDS);
        break;
      case "ArrowUp":
        event.preventDefault();
        volume.setVolume(volume.volume + PLAYER_VOLUME_STEP);
        break;
      case "ArrowDown":
        event.preventDefault();
        volume.setVolume(volume.volume - PLAYER_VOLUME_STEP);
        break;
      case "f":
      case "F":
        event.preventDefault();
        toggleFullscreen();
        break;
      case "Escape":
        if (subtitlePreview) setSubtitlePreview(false);
        // The browser normally leaves fullscreen on Escape itself; this covers hosts that do not.
        if ((document.fullscreenElement ?? null) !== null && typeof document.exitFullscreen === "function") document.exitFullscreen().catch(() => undefined);
        break;
      default:
        return;
    }
    wake();
  };
  const onControlsFocus = (event: FocusEvent<HTMLDivElement>): void => setControlsFocused(focusVisible(event.target));
  const onControlsBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setControlsFocused(false);
  };
  // Clicks on the controls never reach the picture's play / fullscreen toggles.
  const stop = (event: SyntheticEvent): void => event.stopPropagation();

  // Dragging a subtitle or previewing its final look shows the picture without the controls.
  const subtitleOnly = subtitleDragging || subtitlePreview;
  const shown = !subtitleOnly && (audioOnly || !playing || pointerActive || rateMenuOpen || settingsMenuOpen || qualityMenuOpen || subtitleMenuOpen || controlsFocused);
  const sources = audioOnly || props.sources === undefined || props.sources.length === 0 ? undefined : props.sources;
  const autoplay = (settings.autoplay || props.autoplay === true) && swap === undefined && (switchedTo === undefined || switchedTo !== props.activeSourceId);
  const progress = durationMs === undefined ? 0 : Math.min(100, Math.max(0, (position / durationMs) * 100));

  return (
    <div
      ref={setRoot}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={wake}
      onPointerEnter={wake}
      onPointerLeave={sleep}
      className={`@container relative aspect-video w-full overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-accent ${fullscreen ? "" : "rounded-md"} ${!shown && fullscreen ? "cursor-none" : ""}`}
      data-testid="player-local"
      data-controls={shown ? "shown" : "hidden"}
    >
      <video
        key={props.activeSourceId ?? "single"}
        ref={videoRef}
        src={props.src}
        autoPlay={autoplay}
        loop={settings.endBehavior === "loop_one"}
        className={`absolute inset-0 h-full w-full object-contain ${!shown && fullscreen ? "cursor-none" : "cursor-pointer"}`}
        onClick={toggle}
        onDoubleClick={toggleFullscreen}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        onTimeUpdate={(event) => controller.reportTime(Math.round(event.currentTarget.currentTime * 1000))}
        onSeeked={(event) => controller.reportTime(Math.round(event.currentTarget.currentTime * 1000))}
        onLoadedMetadata={(event) => {
          onDuration(event.currentTarget.duration);
          restoreSwap(event.currentTarget);
        }}
        onError={failSwap}
        onDurationChange={(event) => onDuration(event.currentTarget.duration)}
      />
      {notice === undefined ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-[2] flex justify-center px-2">
          <p className="rounded bg-black/75 px-3 py-1.5 text-xs text-white" role="status" data-testid="player-notice">
            {notice}
          </p>
        </div>
      )}
      {audioOnly ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/80" data-testid="player-audio-only">
          {t("contentView.player.audioOnly")}
        </div>
      ) : null}
      {subtitles === undefined ? null : (
        <SubtitleOverlay
          model={subtitles}
          video={videoElement}
          audioOnly={audioOnly}
          picture={picture}
          mode={subtitlePreview ? "preview" : subtitleEditing ? "edit" : "view"}
          onDraggingChange={setSubtitleDragging}
        />
      )}
      {shown || subtitleOnly ? null : (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/20" data-testid="player-progress-line">
          <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col bg-linear-to-t from-black/75 via-black/40 to-transparent px-1.5 pt-10 pb-1 text-white @sm:px-3 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
        data-testid="player-overlay"
      >
        <div
          ref={controlsRef}
          className={`flex flex-col ${shown ? "pointer-events-auto" : ""}`}
          onClick={stop}
          onDoubleClick={stop}
          onFocus={onControlsFocus}
          onBlur={onControlsBlur}
          data-testid="player-controls"
        >
          <SeekBar durationMs={durationMs} positionMs={position} chapters={props.chapters ?? []} onScrub={scrubTo} onScrubEnd={endScrub} />
          {/* A narrow player tightens the gaps, then drops the total time; the clock is the
              only part allowed to shrink, so the right-hand buttons are never clipped. */}
          <div className="flex items-center gap-0.5 text-xs @sm:gap-1">
            <button
              type="button"
              className="player-button"
              aria-label={playing ? t("contentView.player.pause") : t("contentView.player.play")}
              title={playing ? t("contentView.player.pause") : t("contentView.player.play")}
              onClick={toggle}
              data-control="play"
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <span className="min-w-0 overflow-hidden px-1 font-mono text-ellipsis whitespace-nowrap tabular-nums" data-testid="player-clock" data-control="clock">
              <ClockInput positionMs={position} durationMs={durationMs} onSeek={seekTo} onDone={() => root?.focus({ preventScroll: true })} />
              <span className="@max-xs:hidden" data-testid="player-clock-total">{` / ${durationMs === undefined ? "--:--" : formatDuration(durationMs)}`}</span>
            </span>
            <span className="flex shrink-0" data-control="rate">
              <PlaybackRateMenu rate={rate} onRate={setRate} container={root} onOpenChange={setRateMenuOpen} />
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5 @sm:gap-1">
              {sources === undefined ? null : (
                <span className="flex" data-control="quality">
                  <QualityMenu sources={sources} activeId={props.activeSourceId} onSelect={selectSource} container={root} onOpenChange={setQualityMenuOpen} />
                </span>
              )}
              <span className="flex" data-control="volume">
                <VolumeControl setting={volume} />
              </span>
              {subtitles === undefined ? null : (
                <span className="flex" data-subtitle-control="">
                  <SubtitleMenu model={subtitles} container={root} onOpenChange={setSubtitleMenuOpen} />
                </span>
              )}
              <span className="flex" data-control="settings">
                <PlayerSettingsMenu settings={settings} container={root} onOpenChange={setSettingsMenuOpen} loopCollection={props.loopCollection} />
              </span>
              {audioOnly ? null : (
                <button
                  type="button"
                  className="player-button"
                  aria-label={fullscreen ? t("contentView.player.exitFullscreen") : t("contentView.player.fullscreen")}
                  title={fullscreen ? t("contentView.player.exitFullscreen") : t("contentView.player.fullscreen")}
                  onClick={toggleFullscreen}
                  data-control="fullscreen"
                  data-testid="player-fullscreen"
                >
                  {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
      {subtitles !== undefined && subtitleEditing && !subtitlePreview ? (
        <SubtitleEditor
          model={subtitles}
          // Docked away from the subtitles, so the panel never covers what is being placed.
          side={subtitles.placement.xBp > BASIS_POINTS / 2 ? "left" : "right"}
          top={picture.y + PANEL_GAP_PX}
          maxHeight={picture.height - controlsHeight - 2 * PANEL_GAP_PX > 0 ? picture.height - controlsHeight - 2 * PANEL_GAP_PX : undefined}
          onPreview={() => setSubtitlePreview(true)}
        />
      ) : null}
      {subtitlePreview ? (
        <button
          type="button"
          className="absolute inset-0 z-[3] cursor-default"
          aria-label={t("contentView.player.subtitles.editor.previewHint")}
          title={t("contentView.player.subtitles.editor.previewHint")}
          autoFocus
          onClick={(event) => {
            event.stopPropagation();
            setSubtitlePreview(false);
          }}
          onDoubleClick={stop}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setSubtitlePreview(false);
          }}
          data-testid="subtitle-preview-exit"
        />
      ) : null}
    </div>
  );
}
