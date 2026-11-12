import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { SUBTITLE_ASS_EM_RATIO, SUBTITLE_NUDGE_BP, SUBTITLE_NUDGE_FAST_BP, SUBTITLE_WRAP_RATIO } from "../../shared/defaults.ts";
import type { BurnMode } from "../../shared/enums.ts";
import {
  pictureRect,
  placementFromBlock,
  sliceIndexAt,
  speakerLabelFontSize,
  subtitleGlyphText,
  subtitleUnitLines,
  type Rect,
  type Size,
  type SlicedSubtitleUnit,
  type SlicedUnitSubtitle,
  type SubtitleUnit,
  type TimedSubtitle,
  type UnitSubtitle,
} from "../../shared/subtitle-geometry.ts";
import { BASIS_POINTS, boxedLines, lineBoxPadding, type SubtitleAppearance, type SubtitlePlacement } from "../../shared/subtitle-style.ts";
import { hasCommandModifier } from "../shortcut-registry.tsx";
import { SUBTITLE_FONT_STACK } from "./subtitle-font.ts";
import type { SubtitleDisplayMode } from "./subtitle-prefs.ts";

/** Where the overlay's data stands: off, being read, failed (retryable), truly empty, or shown. */
export type SubtitleStatus = "off" | "loading" | "error" | "empty" | "ready";

export interface SubtitleOption {
  id: string;
  label: string;
}

/** One translation language of the chosen original. */
export interface SubtitleTranslationLanguage {
  language: string;
  /** The language's display name. */
  label: string;
  /** The version following this language shows. */
  currentId: string;
  /** The language's other versions, newest first, each of which can be locked. */
  history: readonly SubtitleOption[];
}

/**
 * Everything the local player needs to overlay and edit subtitles. The
 * Content page assembles it; the player only times and draws it and never reads Content data.
 */
export interface SubtitleTrackModel {
  mode: SubtitleDisplayMode;
  setMode(mode: SubtitleDisplayMode): void;
  /** The original-language revisions to pick from (no translations). */
  originals: readonly SubtitleOption[];
  originalId: string | undefined;
  setOriginal(id: string): void;
  /** The translations of the chosen original, one entry per language. */
  translations: readonly SubtitleTranslationLanguage[];
  /** The translation shown with the original. */
  translationId: string | undefined;
  /** Whether `translationId` is a version the user locked, rather than the one its language follows. */
  translationLocked: boolean;
  /** Follows a language: always its current translation, including a hand edit committed later. */
  followTranslation(language: string): void;
  /** Locks one version of a translation. */
  lockTranslation(id: string): void;
  /** Opens the translation tab, offered when the chosen original has no translation. */
  goTranslate(): void;
  status: SubtitleStatus;
  retry(): void;
  /**
   * Time-ordered, non-overlapping slices of the chosen mode, cut as the styled ASS export
   * cuts them: every sentence start and end splits the timeline, and a slice holds all
   * sentences active during it in ordinal order.
   */
  slices: readonly TimedSubtitle[];
  /**
   * With speaker labels on, the same slices with every sentence kept as a unit of its own
   * and its label; the overlay then draws these instead of `slices`. Absent with labels off.
   */
  units?: readonly SlicedUnitSubtitle[];
  /** The bundled font could not be loaded, so the preview uses a system font. */
  fontFallback: boolean;
  appearance: SubtitleAppearance;
  setAppearance(appearance: SubtitleAppearance): void;
  resetAppearance(): void;
  placement: SubtitlePlacement;
  placementOverridden: boolean;
  setPlacement(placement: SubtitlePlacement): void;
  setDefaultPlacement(): void;
  resetPlacement(): void;
  editing: boolean;
  /** Enters the style and position editor, switching subtitles on first when they are off. */
  startEditing(): void;
  stopEditing(): void;
}

const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * The picture rectangle inside the `<video>` box: `object-fit: contain`
 * without the letterbox bars, the whole box for audio. Re-measured when the box resizes, the
 * metadata arrives, the intrinsic size changes and fullscreen toggles.
 */
export function usePictureRect(video: HTMLVideoElement | null, audioOnly: boolean): Rect {
  const [rect, setRect] = useState<Rect>(EMPTY_RECT);
  useLayoutEffect(() => {
    if (video === null) return undefined;
    const measure = (): void => {
      const box: Size = { width: video.clientWidth, height: video.clientHeight };
      const next = pictureRect(box, audioOnly ? undefined : { width: video.videoWidth, height: video.videoHeight });
      setRect((previous) =>
        previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(video);
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      observer?.disconnect();
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", measure);
    };
  }, [video, audioOnly]);
  return rect;
}

const NO_CUES: readonly string[] = [];

/** A cue of a slice as seeks follow it: an identity that survives re-reading the same subtitles, and whether it can carry a name at all. */
interface SliceCue {
  id: string;
  nameable: boolean;
}

/** Where a slice clock stands: the slice on screen and, when seeks are tracked, the cues on screen holding a seek's name. */
interface ClockState<T> {
  slices: readonly T[];
  index: number;
  sought: readonly string[];
}

/**
 * What a seek-following clock knows about the screen. It outlives a change of the slices
 * followed, so re-reading the same subtitles (a rename, a new avatar) neither adds nor
 * removes a name on a cue already on screen, and a seek still waiting for its cue keeps waiting.
 */
interface SeekMemory {
  /** The cues last shown. */
  onScreen: readonly string[];
  /** The cues on screen holding a seek's name. */
  sought: readonly string[];
  /** While the latest seek has named no cue yet: the cues on screen when it began that have stayed on screen ever since. */
  kept: ReadonlySet<string> | undefined;
  /** The time the seek in progress was taken at, so the `seeking` event of a seek a frame already took does not take it again. */
  seekAt: number | undefined;
}

const freshSeekMemory = (): SeekMemory => ({ onScreen: NO_CUES, sought: NO_CUES, kept: undefined, seekAt: undefined });

const sameCues = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((cue, index) => cue === b[index]);

/**
 * The slice on screen. While playing, the time is read once per presented video frame
 * (`requestVideoFrameCallback`, or an animation frame where there is none or no picture);
 * paused, it is re-read on the events that move the time. State changes only when the slice
 * does, so playback does not re-render the player every frame.
 *
 * With `cuesOf` (the cues of a slice) it also follows seeks by cue: after each seek, the
 * first cue to newly appear that can carry a name holds the seek's name until it leaves the
 * screen, whether it appears at the landing point or later. Cues on screen when the seek
 * began that stay on screen keep what they had, so a drag within one cue neither adds nor
 * removes a name, and the next cue to appear after it is the new one; a cue that leaves the
 * screen after the seek is new when it comes back. A later seek replaces an earlier one still
 * waiting. Slices followed this way are taken up before paint, so a re-read never flashes
 * the subtitles away.
 */
function useSliceClock<T extends { startMs: number; endMs: number }>(
  video: HTMLVideoElement | null,
  slices: readonly T[],
  enabled: boolean,
  audioOnly: boolean,
  cuesOf?: (slice: T) => readonly SliceCue[],
): { index: number; sought: readonly string[] } | undefined {
  const [shown, setShown] = useState<ClockState<T>>({ slices, index: -1, sought: NO_CUES });
  const memory = useRef<SeekMemory>(freshSeekMemory());
  // Whether seeks are followed is fixed per call site, so the hook order never changes.
  const useClockEffect = cuesOf === undefined ? useEffect : useLayoutEffect;
  useClockEffect(() => {
    if (video === null || !enabled) {
      // Subtitles not shown have left the screen: shown again, every cue is new.
      memory.current = freshSeekMemory();
      return undefined;
    }
    let index = Number.NaN;
    let sought = NO_CUES;
    let handle: number | undefined;
    let byVideoFrame = false;
    let stopped = false;
    const takeSeek = (): void => {
      const state = memory.current;
      state.kept = new Set(state.onScreen);
      state.seekAt = video.currentTime;
    };
    const update = (): void => {
      let took = false;
      if (cuesOf !== undefined) {
        // The time moves before the `seeking` event is dispatched, so a frame in between can
        // see the new time first; it then takes the seek, judged by what was on screen before.
        if (!video.seeking) memory.current.seekAt = undefined;
        else if (video.currentTime !== memory.current.seekAt) {
          takeSeek();
          took = true;
        }
      }
      const next = sliceIndexAt(slices, video.currentTime * 1000);
      if (next === index && !took) return;
      if (cuesOf === undefined) {
        index = next;
        setShown({ slices, index: next, sought: NO_CUES });
        return;
      }
      const cues = next >= 0 ? cuesOf(slices[next] as T) : [];
      const ids = cues.map((cue) => cue.id);
      const state = memory.current;
      const held = state.sought.filter((id) => ids.includes(id));
      let kept = state.kept === undefined ? undefined : new Set([...state.kept].filter((id) => ids.includes(id)));
      if (kept !== undefined) {
        const waiting = kept;
        const fresh = cues.find((cue) => cue.nameable && !waiting.has(cue.id));
        if (fresh !== undefined) {
          if (!held.includes(fresh.id)) held.push(fresh.id);
          kept = undefined;
        }
      }
      state.onScreen = ids;
      state.sought = held;
      state.kept = kept;
      if (next === index && sameCues(held, sought)) return;
      index = next;
      sought = held;
      setShown({ slices, index: next, sought: held });
    };
    const onSeeking = (): void => {
      if (cuesOf !== undefined && !(video.seeking && video.currentTime === memory.current.seekAt)) takeSeek();
      update();
    };
    const cancel = (): void => {
      if (handle === undefined) return;
      if (byVideoFrame) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      handle = undefined;
    };
    const tick = (): void => {
      handle = undefined;
      if (stopped) return;
      update();
      if (!video.paused && !video.ended) schedule();
    };
    const schedule = (): void => {
      if (handle !== undefined) return;
      // An audio-only file presents no frames, so it would never get a video-frame callback.
      byVideoFrame = !audioOnly && typeof video.requestVideoFrameCallback === "function";
      handle = byVideoFrame ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    const onPlay = (): void => {
      update();
      schedule();
    };
    const onStop = (): void => {
      cancel();
      update();
    };
    const moved = ["seeked", "loadedmetadata", "timeupdate", "emptied"] as const;
    update();
    if (!video.paused) schedule();
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onStop);
    video.addEventListener("ended", onStop);
    video.addEventListener("seeking", onSeeking);
    for (const name of moved) video.addEventListener(name, update);
    return () => {
      stopped = true;
      cancel();
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("pause", onStop);
      video.removeEventListener("ended", onStop);
      video.removeEventListener("seeking", onSeeking);
      for (const name of moved) video.removeEventListener(name, update);
    };
  }, [video, slices, enabled, audioOnly, cuesOf]);
  // A slice index from the previous track never names a cue of the new one.
  return enabled && shown.slices === slices && shown.index >= 0 ? { index: shown.index, sought: shown.sought } : undefined;
}

/** The slice on screen; see `useSliceClock`. */
export function useSubtitleClock(video: HTMLVideoElement | null, slices: readonly TimedSubtitle[], enabled: boolean, audioOnly: boolean): TimedSubtitle | undefined {
  const at = useSliceClock(video, slices, enabled, audioOnly);
  return at === undefined ? undefined : slices[at.index];
}

/** A cue's identity across re-reads of the same subtitles: its place and its lines, never its label, so a rename keeps it. */
const unitId = (unit: SlicedSubtitleUnit): string => JSON.stringify([unit.cue, unit.original ?? null, unit.translation ?? null]);

const unitCues = (slice: SlicedUnitSubtitle): readonly SliceCue[] => slice.units.map((unit) => ({ id: unitId(unit), nameable: unit.label !== undefined }));

/**
 * The units on screen with the labels they show: each cue's label where the rule shows it,
 * and also on the cue that holds a seek's name (see `useSliceClock`) — a jump lands
 * mid-conversation, so whoever starts talking there is named once.
 */
export function useUnitSubtitleClock(video: HTMLVideoElement | null, slices: readonly SlicedUnitSubtitle[], enabled: boolean, audioOnly: boolean): UnitSubtitle | undefined {
  const at = useSliceClock(video, slices, enabled, audioOnly, unitCues);
  const index = at?.index;
  const sought = at?.sought ?? NO_CUES;
  return useMemo(() => {
    const slice = index === undefined ? undefined : slices[index];
    if (slice === undefined) return undefined;
    return {
      startMs: slice.startMs,
      endMs: slice.endMs,
      units: slice.units.map((unit) => {
        const label = unit.speakerLabel ?? (sought.includes(unitId(unit)) ? unit.label : undefined);
        return {
          ...(unit.original === undefined ? {} : { original: unit.original }),
          ...(unit.translation === undefined ? {} : { translation: unit.translation }),
          ...(label === undefined ? {} : { speakerLabel: label }),
        };
      }),
    };
  }, [slices, index, sought]);
}

/** `#RRGGBB` at `opacityPct` as a CSS colour. */
function rgba(hex: string, opacityPct: number): string {
  const channel = (start: number): number => Number.parseInt(hex.slice(start, start + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${opacityPct / 100})`;
}

type LineKind = "original" | "translation";

/** The lines of a slice in the user's bilingual order, each with its own size and colour. */
function linesOf(slice: TimedSubtitle, appearance: SubtitleAppearance): Array<{ kind: LineKind; text: string }> {
  const order: LineKind[] = appearance.bilingualOrder === "original_first" ? ["original", "translation"] : ["translation", "original"];
  return order.flatMap((kind) => {
    const text = slice[kind];
    return text === undefined || text === "" ? [] : [{ kind, text: subtitleGlyphText(text) }];
  });
}

const TRANSLATE_Y: Record<SubtitlePlacement["anchor"], string> = { top: "0", center: "-50%", bottom: "-100%" };

/** Text-box styles that decide where lines wrap: shared by the text and the line-box layer so both wrap alike. */
const TEXT_LAYOUT: CSSProperties = { textAlign: "center", textWrap: "balance", whiteSpace: "pre-line", fontFamily: SUBTITLE_FONT_STACK };

/** The box around every line, spreading outwards from the text box as libass's `BorderStyle 4` does. */
function BlockBox(props: { appearance: SubtitleAppearance; unit: number }) {
  const { background } = props.appearance;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: -background.padding * props.unit,
        zIndex: -1,
        background: rgba(background.color, background.opacityPct),
      }}
      data-testid="subtitle-background"
    />
  );
}

/** A visible line's colour and outline. */
function inkStyle(color: string, appearance: SubtitleAppearance, unit: number): CSSProperties {
  return {
    color,
    paintOrder: "stroke fill",
    ...(appearance.outline.enabled ? { WebkitTextStroke: `${appearance.outline.width * 2 * unit}px ${appearance.outline.color}` } : {}),
  };
}

/** A line's box in the flow: `size` in 1080p picture pixels, the font sized as libass sizes it. */
function lineBoxStyle(size: number, unit: number): CSSProperties {
  return { display: "block", fontSize: size * SUBTITLE_ASS_EM_RATIO * unit, lineHeight: `${size * unit}px` };
}

/**
 * The text box: the anchored object, sized in 1080p picture pixels scaled to
 * the picture height. A box around every line spreads outwards from it as libass's
 * `BorderStyle 4` does; a box around one bilingual line is drawn by `LineBoxLayer`. Text goes
 * in as text nodes only.
 */
function SubtitleText(props: { slice: TimedSubtitle; appearance: SubtitleAppearance; picture: Rect; mode: BurnMode }) {
  const { appearance, picture } = props;
  const unit = picture.height / 1080;
  const boxed = boxedLines(appearance, props.mode);
  const lines = linesOf(props.slice, appearance);
  const lineStyle = (kind: LineKind): CSSProperties => lineBoxStyle(appearance[kind].fontSize, unit);
  return (
    <div style={{ ...TEXT_LAYOUT, position: "relative", isolation: "isolate", maxWidth: SUBTITLE_WRAP_RATIO * picture.width }} data-testid="subtitle-text">
      {boxed === "block" ? <BlockBox appearance={appearance} unit={unit} /> : null}
      {lines.map((line) => (
        <span key={line.kind} style={{ ...lineStyle(line.kind), ...inkStyle(appearance[line.kind].color, appearance, unit) }} data-line={line.kind}>
          {line.text}
        </span>
      ))}
      {/* After the text so a lookup by line finds the visible text first; z-index -1 in the isolated text box still paints it beneath. */}
      {(boxed === "original" || boxed === "translation") && lines.some((line) => line.kind === boxed) ? (
        <LineBoxLayer
          rows={lines.map((line) => ({ line: line.kind, text: line.text, boxed: line.kind === boxed, style: lineStyle(line.kind) }))}
          appearance={appearance}
          unit={unit}
        />
      ) : null}
    </div>
  );
}

/** One drawn row of labelled subtitles: a speaker label heads the line after it. */
type UnitRow = { kind: LineKind; text: string; unit: number } | { kind: "speaker"; text: string; unit: number; heads: LineKind };

/** The rows of the units on screen, unit by unit: the label (when shown), then the lines in the user's order. */
function rowsOf(units: readonly SubtitleUnit[], appearance: SubtitleAppearance): UnitRow[] {
  return units.flatMap((unit, index) => {
    const lines = subtitleUnitLines(unit, appearance.bilingualOrder);
    const rows: UnitRow[] = lines.map(({ line, text }) => ({ kind: line, text, unit: index }));
    const first = lines[0];
    return first === undefined || unit.speakerLabel === undefined ? rows : [{ kind: "speaker", text: unit.speakerLabel, unit: index, heads: first.line }, ...rows];
  });
}

/**
 * The text box with speaker labels: the units stacked in sentence order, each its label
 * line and its own lines, laid out like `SubtitleText`. A label copies the first line its
 * own unit shows — `SUBTITLE_SPEAKER_LABEL_SCALE` times its size, its colour and the subtitle
 * outline, never a speaker colour — as the exported label styles do, so a unit without a
 * translation labels in the original's look even when the translation goes first. A block box holds the labels too; a one-line box boxes a label exactly when it boxes
 * the line the label heads, and the hidden layer repeats the labels so it wraps as the text.
 */
function UnitsText(props: { units: readonly SubtitleUnit[]; appearance: SubtitleAppearance; picture: Rect; mode: BurnMode }) {
  const { appearance, picture } = props;
  const unit = picture.height / 1080;
  const boxed = boxedLines(appearance, props.mode);
  const rows = rowsOf(props.units, appearance);
  const look = (row: UnitRow): LineKind => (row.kind === "speaker" ? row.heads : row.kind);
  const rowStyle = (row: UnitRow): CSSProperties =>
    lineBoxStyle(row.kind === "speaker" ? speakerLabelFontSize(appearance[row.heads].fontSize) : appearance[row.kind].fontSize, unit);
  return (
    <div style={{ ...TEXT_LAYOUT, position: "relative", isolation: "isolate", maxWidth: SUBTITLE_WRAP_RATIO * picture.width }} data-testid="subtitle-text">
      {boxed === "block" ? <BlockBox appearance={appearance} unit={unit} /> : null}
      {rows.map((row, index) => (
        <span
          key={index}
          style={{ ...rowStyle(row), ...inkStyle(appearance[look(row)].color, appearance, unit) }}
          data-line={row.kind}
          data-unit={row.unit}
        >
          {row.text}
        </span>
      ))}
      {(boxed === "original" || boxed === "translation") && rows.some((row) => row.kind === boxed) ? (
        <LineBoxLayer
          rows={rows.map((row) => ({ line: row.kind, text: row.text, boxed: look(row) === boxed, style: rowStyle(row) }))}
          appearance={appearance}
          unit={unit}
        />
      ) : null}
    </div>
  );
}

/**
 * A box around one bilingual line, mirroring the export's `BorderStyle 3`: an
 * invisible copy of the rows lies under the text and wraps exactly as it does, and each
 * boxed row's inline background, spread by a box shadow and cloned on every wrapped visual
 * line, gives one box per visual line, all of them beneath all the text, the padding never
 * changing where lines wrap.
 */
function LineBoxLayer(props: { rows: ReadonlyArray<{ line: string; text: string; boxed: boolean; style: CSSProperties }>; appearance: SubtitleAppearance; unit: number }) {
  const { background } = props.appearance;
  const fill = rgba(background.color, background.opacityPct);
  return (
    <div aria-hidden="true" style={{ ...TEXT_LAYOUT, position: "absolute", inset: 0, zIndex: -1, pointerEvents: "none", color: "transparent" }}>
      {props.rows.map((row, index) => (
        <span key={index} style={row.style}>
          {row.boxed ? (
            <span
              style={{
                background: fill,
                boxShadow: `0 0 0 ${lineBoxPadding(props.appearance) * props.unit}px ${fill}`,
                boxDecorationBreak: "clone",
                WebkitBoxDecorationBreak: "clone",
              }}
              data-testid="subtitle-line-background"
              data-line={row.line}
            >
              {row.text}
            </span>
          ) : (
            row.text
          )}
        </span>
      ))}
    </div>
  );
}

/** What the block draws: a plain slice, or units with their labels when speaker labels are on. */
type ShownSubtitle = TimedSubtitle | UnitSubtitle;

const NO_UNITS: readonly SlicedUnitSubtitle[] = [];

interface DragState {
  pointerId: number;
  slice: ShownSubtitle;
  size: Size;
  /** Where the pointer grabbed the block, from its top-left corner: the block never snaps to the pointer. */
  grab: { x: number; y: number };
  /** The picture's viewport origin when the drag began. */
  frame: { left: number; top: number };
}

const clampBp = (value: number): number => Math.min(BASIS_POINTS, Math.max(0, value));

const NUDGES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Subtitles over the local player's picture. In `view` they are
 * pointer-transparent and appear only while a slice is current. In `edit` the block is
 * always there (sample lines when nothing is being said), the picture's edge is outlined,
 * and the block drags and nudges: a drag freezes the slice and block size, keeps the grab
 * offset, only moves in memory and saves on release; `pointercancel` puts it back. `preview`
 * draws what playback would, without the editing marks.
 */
export function SubtitleOverlay(props: {
  model: SubtitleTrackModel;
  video: HTMLVideoElement | null;
  audioOnly: boolean;
  picture: Rect;
  mode: "view" | "edit" | "preview";
  onDraggingChange: (dragging: boolean) => void;
}) {
  const { t } = useTranslation();
  const { model, picture } = props;
  const burnMode: BurnMode | undefined = model.mode === "off" ? undefined : model.mode;
  const on = burnMode !== undefined;
  const units = model.units;
  const live = useSubtitleClock(props.video, model.slices, on && units === undefined, props.audioOnly);
  const liveUnits = useUnitSubtitleClock(props.video, units ?? NO_UNITS, on && units !== undefined, props.audioOnly);
  const frameRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | undefined>(undefined);
  const [frozen, setFrozen] = useState<ShownSubtitle | undefined>(undefined);
  const [draft, setDraftState] = useState<SubtitlePlacement | undefined>(undefined);
  // Pointer events can outrun rendering; the release commits the last position, not the last rendered one.
  const draftRef = useRef<SubtitlePlacement | undefined>(undefined);
  const setDraft = (next: SubtitlePlacement | undefined): void => {
    draftRef.current = next;
    setDraftState(next);
  };
  const [outOfBounds, setOutOfBounds] = useState(false);
  const editing = props.mode === "edit";

  const sampleLines = {
    ...(model.mode === "translation" ? {} : { original: t("contentView.player.subtitles.sample.original") }),
    ...(model.mode === "original" ? {} : { translation: t("contentView.player.subtitles.sample.translation") }),
  };
  // With labels on, the sample shows a label too, so their look can be set before anyone speaks.
  const sample: ShownSubtitle =
    units === undefined
      ? { startMs: 0, endMs: 0, ...sampleLines }
      : { startMs: 0, endMs: 0, units: [{ ...sampleLines, speakerLabel: t("speakerIdentity.unnamed", { ordinal: 1 }) }] };
  const slice = frozen ?? (units === undefined ? live : liveUnits) ?? (props.mode === "view" ? undefined : sample);
  const placement = draft ?? model.placement;

  useLayoutEffect(() => {
    const block = blockRef.current;
    const frame = frameRef.current;
    if (!editing || block === null || frame === null) {
      setOutOfBounds(false);
      return;
    }
    const b = block.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const boxed = burnMode === undefined ? "none" : boxedLines(model.appearance, burnMode);
    const padding = boxed === "none" ? 0 : boxed === "block" ? model.appearance.background.padding : lineBoxPadding(model.appearance);
    const spread = (padding * f.height) / 1080;
    const out = b.left - spread < f.left - 0.5 || b.top - spread < f.top - 0.5 || b.right + spread > f.right + 0.5 || b.bottom + spread > f.bottom + 0.5;
    setOutOfBounds(out);
  });

  if (burnMode === undefined) return null;

  const finish = (): void => {
    drag.current = undefined;
    setFrozen(undefined);
    setDraft(undefined);
    props.onDraggingChange(false);
  };
  const stop = (event: SyntheticEvent): void => event.stopPropagation();
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Never reaches the picture: pressing the block must not play, pause or go fullscreen.
    event.stopPropagation();
    const frame = frameRef.current;
    if (!editing || event.button !== 0 || frame === null || slice === undefined) return;
    const block = event.currentTarget;
    const b = block.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    if (typeof block.setPointerCapture === "function") block.setPointerCapture(event.pointerId);
    block.focus({ preventScroll: true });
    drag.current = {
      pointerId: event.pointerId,
      slice,
      size: { width: b.width, height: b.height },
      grab: { x: event.clientX - b.left, y: event.clientY - b.top },
      frame: { left: f.left, top: f.top },
    };
    setFrozen(slice);
    props.onDraggingChange(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === undefined || event.pointerId !== current.pointerId) return;
    const rect: Rect = {
      x: event.clientX - current.frame.left - current.grab.x,
      y: event.clientY - current.frame.top - current.grab.y,
      ...current.size,
    };
    setDraft(placementFromBlock(rect, picture));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === undefined || event.pointerId !== current.pointerId) return;
    const released = draftRef.current;
    if (released !== undefined) model.setPlacement(released);
    finish();
  };
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === undefined || event.pointerId !== drag.current.pointerId) return;
    finish();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const direction = NUDGES[event.key];
    if (!editing || direction === undefined || hasCommandModifier(event)) return;
    // Only the keys handled here are taken from the player, whose arrows skip and set the volume.
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? SUBTITLE_NUDGE_FAST_BP : SUBTITLE_NUDGE_BP;
    model.setPlacement({ ...model.placement, xBp: clampBp(model.placement.xBp + direction[0] * step), yBp: clampBp(model.placement.yBp + direction[1] * step) });
  };

  const status = model.status;
  return (
    <div
      ref={frameRef}
      className={`pointer-events-none absolute ${editing ? "z-[1]" : ""}`}
      style={{ left: picture.x, top: picture.y, width: picture.width, height: picture.height }}
      data-testid="subtitle-overlay"
    >
      {editing ? <div className="absolute inset-0 border border-dashed border-white/60" data-testid="subtitle-picture-edge" /> : null}
      {slice === undefined ? null : (
        <div
          ref={blockRef}
          className={editing ? "pointer-events-auto cursor-move rounded-sm outline-1 outline-white/70 outline-dashed focus-visible:outline-2 focus-visible:outline-accent" : ""}
          style={{
            position: "absolute",
            left: `${placement.xBp / 100}%`,
            top: `${placement.yBp / 100}%`,
            transform: `translate(-50%, ${TRANSLATE_Y[placement.anchor]})`,
            width: "max-content",
            ...(editing ? { touchAction: "none" } : {}),
          }}
          {...(editing
            ? {
                tabIndex: 0,
                "aria-label": t("contentView.player.subtitles.editor.dragHint"),
                onPointerDown,
                onPointerMove,
                onPointerUp,
                onPointerCancel,
                onClick: stop,
                onDoubleClick: stop,
                onKeyDown,
              }
            : {})}
          data-testid="subtitle-block"
          data-anchor={placement.anchor}
        >
          {"units" in slice ? (
            <UnitsText units={slice.units} appearance={model.appearance} picture={picture} mode={burnMode} />
          ) : (
            <SubtitleText slice={slice} appearance={model.appearance} picture={picture} mode={burnMode} />
          )}
        </div>
      )}
      {editing && outOfBounds ? (
        <p className="absolute inset-x-0 top-1 mx-auto w-fit rounded bg-black/70 px-2 py-0.5 text-xs text-white" role="status" data-testid="subtitle-out-of-bounds">
          {t("contentView.player.subtitles.editor.outOfBounds")}
        </p>
      ) : null}
      {props.mode !== "preview" && (status === "loading" || status === "error" || status === "empty") ? (
        <p
          className="pointer-events-auto absolute top-1 left-1 flex items-center gap-2 rounded bg-black/70 px-2 py-0.5 text-xs text-white"
          role="status"
          onClick={stop}
          onDoubleClick={stop}
          data-testid="subtitle-status"
          data-status={status}
        >
          {status === "loading"
            ? t("contentView.player.subtitles.loading")
            : status === "error"
              ? t("contentView.player.subtitles.loadFailed")
              : t("contentView.player.subtitles.empty")}
          {status === "error" ? (
            <button type="button" className="rounded px-1 underline hover:bg-white/15" onClick={model.retry} data-testid="subtitle-retry">
              {t("contentView.player.subtitles.retry")}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
