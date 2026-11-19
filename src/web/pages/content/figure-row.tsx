import { ArrowDown, ArrowDownToLine, ArrowUp, Camera, GripVertical, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import type { TFunction } from "i18next";
import { Dialog, DropdownMenu } from "radix-ui";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FIGURE_CAPTION_MAX_CHARS, FIGURE_WIDTH_LARGE, FIGURE_WIDTH_MEDIUM, FIGURE_WIDTH_MIN_RATIO, FIGURE_WIDTH_SMALL } from "../../../shared/defaults.ts";
import type { FigureDto } from "../../../shared/dto/figure.ts";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import { formatDuration } from "../../format.ts";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, useContextMenuTarget, type MenuEntry } from "../../ui/context-menu.tsx";
import { Spinner } from "../../ui/feedback.tsx";
import { blockedComboOf } from "../../shortcut-registry.tsx";
import type { FigureChangeResult } from "./figure-data.ts";
import { CAPTION_SIZE_EM, FIGURE_INNER_GAP_EM, type FigureRow } from "./reader-figures.ts";
import { speakerColorVars } from "./speakers/speaker-colors.ts";
import { AVATAR_EM_SIZE } from "./speakers/speaker-avatar.tsx";
import { TURN_KEY_ATTRIBUTE, TURN_SPEAKER_ATTRIBUTE } from "./reader-sticky.ts";
import { READER_GUTTER } from "./reader-turns.tsx";
import { useFigureImage } from "./use-figure-image.ts";

/** Marks a figure's root, with its id; reveals and drops find figures by it. */
export const FIGURE_ID_ATTRIBUTE = "data-figure-id";
/** Marks the move handle inside a figure, so focus can be put back on it after a move. */
export const FIGURE_GRIP_ATTRIBUTE = "data-figure-grip";

/** The three widths, smallest first. */
export const FIGURE_WIDTH_PRESETS = [
  { id: "small", ratio: FIGURE_WIDTH_SMALL },
  { id: "medium", ratio: FIGURE_WIDTH_MEDIUM },
  { id: "large", ratio: FIGURE_WIDTH_LARGE },
] as const;

/** A dragged width this close to a preset (as a share of the column) lands on the preset. */
const SNAP_RATIO = 0.04;
/** Saving a caption: Ctrl+Enter, or ⌘+Enter, the main key or the keypad's. */
const SAVE_COMBOS = new Set(["Ctrl+Enter", "Meta+Enter", "Ctrl+NumpadEnter", "Meta+NumpadEnter"]);
/** The turn line's column beside a figure: the turn layout's own gutter, so the line runs on exactly where it does beside the text. */
const TURN_GRID: CSSProperties = { gridTemplateColumns: [READER_GUTTER, `minmax(${["0", "1fr"].join(", ")})`].join(" ") };
/** How long 「已保存」 stays after a caption was saved. */
const SAVED_SHOWN_MS = 2000;

/**
 * The width a drag of the resize handle comes to: the image is centred, so its width is twice
 * the pointer's distance from the centre, as a share of the column; clamped to the allowed
 * range and snapped to a preset when close to one.
 */
export function draggedWidth(input: { pointerX: number; centerX: number; columnPx: number }): number {
  if (input.columnPx <= 0) return FIGURE_WIDTH_LARGE;
  const raw = (2 * Math.abs(input.pointerX - input.centerX)) / input.columnPx;
  const clamped = Math.min(1, Math.max(FIGURE_WIDTH_MIN_RATIO, raw));
  const preset = FIGURE_WIDTH_PRESETS.find((candidate) => Math.abs(candidate.ratio - clamped) <= SNAP_RATIO);
  return preset === undefined ? Math.round(clamped * 100) / 100 : preset.ratio;
}

/** Ways a figure can be moved; each is offered only where it would move it. */
export type FigureMove = "up" | "down" | "playback" | "capture";

/** What the moves of one figure can do now. `blocked` turns every move off, with the reason. */
export interface FigureMoves {
  up: boolean;
  down: boolean;
  /** Absent: the player tells no time (the reason is in `playbackReason`). */
  playback: boolean;
  playbackReason?: string;
  /** Only a frame has a capture time to go back to. */
  capture: boolean;
  blocked?: string;
}

/** What a figure row asks of the reading view. One object for every row, through context. */
export interface FigureRowController {
  contentId: string;
  speakers: ReadonlyMap<string, SpeakerDto>;
  /** The speaker layout's gutter is shown: figures inside a turn run its line on beside them. */
  gutter: boolean;
  moves(figure: FigureDto): FigureMoves;
  move(figure: FigureDto, move: FigureMove): void;
  seek(ms: number): void;
  saveCaption(figure: FigureDto, caption: string | null): Promise<FigureChangeResult>;
  setWidth(figure: FigureDto, ratio: number): void;
  remove(figure: FigureDto): void;
  undo(figure: FigureDto): void;
  /** A caption is being edited (or no longer): its row stays mounted meanwhile, so the draft is not lost to the windowing. */
  holdCaption(figureId: string, editing: boolean): void;
  /** Starts dragging the figure from its move handle; the reader tracks the pointer from here on. */
  startDrag(figure: FigureDto, event: ReactPointerEvent<HTMLElement>): void;
  /** The figure being dragged, if any. */
  dragging: string | undefined;
  /** The figure just revealed, highlighted for a moment. */
  highlighted: string | undefined;
  /** A message about the figure's last change (a conflict, a failure), if any. */
  notice(figureId: string): string | undefined;
}

const FigureRowContext = createContext<FigureRowController | undefined>(undefined);

export function FigureRowProvider(props: { value: FigureRowController; children: ReactNode }) {
  return <FigureRowContext.Provider value={props.value}>{props.children}</FigureRowContext.Provider>;
}

function useFigureRowController(): FigureRowController {
  const controller = useContext(FigureRowContext);
  if (controller === undefined) throw new Error("FigureRowView outside FigureRowProvider");
  return controller;
}

/**
 * Revealed on hovering or focusing the figure and kept while its menu is open. Touch screens,
 * which cannot hover, always show the toolbar, holding only its 「⋯」 menu there: the menu
 * offers every action, the widths included.
 */
const REVEAL_CLASS = "opacity-0 group-hover/figure:opacity-100 group-focus-within/figure:opacity-100 data-[open=true]:opacity-100 pointer-coarse:opacity-100";
/** Toolbar controls a touch screen reaches through the menu instead. */
const POINTER_ONLY_CLASS = "pointer-coarse:hidden";
const TOOL_BUTTON_CLASS =
  "flex size-7 items-center justify-center rounded text-muted hover:bg-sunken hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";
const ACCENT_TEXT = "text-xs text-muted";

const isApple = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent);

function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * A figure between paragraphs: the image at its width of the reading column (its box reserves
 * the height from the aspect ratio before the image arrives), the capture time for a frame and
 * the caption when it has one. Moving, resizing and the menu show on hover, focus and touch;
 * every action is reachable from the keyboard. A figure deleted here shows 「已删除 · 撤销」.
 */
export function FigureRowView(props: { row: FigureRow; typography: { fontSize: number; lineHeight: number } }) {
  const controller = useFigureRowController();
  const { row } = props;
  const turnSpeaker = row.turn?.speakerId === undefined ? undefined : controller.speakers.get(row.turn.speakerId);
  const style: CSSProperties = { fontSize: `${props.typography.fontSize}px`, lineHeight: props.typography.lineHeight, paddingBottom: `${row.spaceAfterEm}em` };
  const turnMarks = row.turn === undefined ? {} : { [TURN_KEY_ATTRIBUTE]: row.turn.key, [TURN_SPEAKER_ATTRIBUTE]: row.turn.speakerId ?? "" };
  const body = row.deleted ? <DeletedFigure figure={row.figure} /> : <FigureBody figure={row.figure} />;
  if (row.turn !== undefined && controller.gutter) {
    const color = turnSpeaker === undefined ? "var(--color-line)" : `color-mix(${["in srgb", `${speakerColorVars(turnSpeaker.colorIndex).fg} 55%`, "transparent"].join(", ")})`;
    return (
      <div {...turnMarks} className="relative grid" style={{ ...style, ...TURN_GRID }}>
        {/* The turn's line runs on through the figure, down into the space below it. */}
        <div className="relative" aria-hidden="true">
          <span className="absolute w-0.5 rounded-full" style={{ left: `calc(${AVATAR_EM_SIZE} / 2 - 1px)`, top: 0, bottom: `-${row.spaceAfterEm}em`, backgroundColor: color }} />
        </div>
        {body}
      </div>
    );
  }
  return (
    <div {...turnMarks} style={style}>
      {body}
    </div>
  );
}

function DeletedFigure(props: { figure: FigureDto }) {
  const { t } = useTranslation();
  const controller = useFigureRowController();
  const notice = controller.notice(props.figure.id);
  const undo = useRef<HTMLButtonElement>(null);
  // The figure the user just deleted had focus (its menu): the way back takes it.
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) undo.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="mx-auto flex w-fit max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-line px-3 py-1.5 text-sm text-muted select-none" {...{ [FIGURE_ID_ATTRIBUTE]: props.figure.id }} data-testid="figure-deleted">
      <span>{t("figures.deleted.text")}</span>
      <span aria-hidden="true">·</span>
      <button
        ref={undo}
        type="button"
        className="rounded text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        aria-label={t("figures.deleted.undoLabel")}
        onClick={() => controller.undo(props.figure)}
        data-testid="figure-undo"
      >
        {t("figures.deleted.undo")}
      </button>
      {notice === undefined ? null : (
        <span role="status" className="text-danger">
          {notice}
        </span>
      )}
    </div>
  );
}

function FigureBody(props: { figure: FigureDto }) {
  const { t } = useTranslation();
  const controller = useFigureRowController();
  const { figure } = props;
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const image = useFigureImage(figure, frame);
  const [zoomed, setZoomed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // A width being dragged: shown at once, saved when the pointer is let go.
  const [liveWidth, setLiveWidth] = useState<number | undefined>(undefined);
  const width = liveWidth ?? figure.widthRatio;
  const caption = useCaptionEditor(figure);
  const moves = controller.moves(figure);
  const notice = controller.notice(figure.id);
  const dragging = controller.dragging === figure.id;
  const label = figure.caption === undefined ? t("figures.block.label") : t("figures.block.labelWithCaption", { caption: figure.caption });
  const entries = menuEntries(t, controller, figure, moves, caption.start);
  const contextTarget = useContextMenuTarget<HTMLElement>(() => ({ kind: "object", entries }));

  const onResizeStart = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || frame === null) return;
    // Not a text selection, and not a drag of the image.
    event.preventDefault();
    event.stopPropagation();
    const column = frame.parentElement;
    if (column === null) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const columnRect = column.getBoundingClientRect();
    const centerX = columnRect.left + columnRect.width / 2;
    let latest = figure.widthRatio;
    const onMove = (move: PointerEvent): void => {
      latest = draggedWidth({ pointerX: move.clientX, centerX, columnPx: columnRect.width });
      setLiveWidth(latest);
    };
    const finish = (commit: boolean): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      setLiveWidth(undefined);
      if (commit && latest !== figure.widthRatio) controller.setWidth(figure, latest);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
  };

  const onGripKey = (event: KeyboardEvent<HTMLElement>): void => {
    // Only the bare arrows: combinations belong to the shortcut registry and the browser.
    const combo = blockedComboOf(event);
    const direction = combo === "ArrowUp" ? "up" : combo === "ArrowDown" ? "down" : undefined;
    if (direction === undefined) return;
    // The list would scroll by the same key.
    event.preventDefault();
    if (moves.blocked === undefined && moves[direction]) controller.move(figure, direction);
  };

  return (
    <figure
      ref={contextTarget}
      role="group"
      aria-label={label}
      className={`group/figure relative m-0 flex min-w-0 flex-col items-center select-none ${dragging ? "opacity-50" : ""}`}
      {...{ [FIGURE_ID_ATTRIBUTE]: figure.id }}
      data-testid="figure-row"
      data-figure-source={figure.source}
    >
      <div ref={setFrame} className={`relative min-w-0 rounded-md transition-shadow motion-reduce:transition-none ${controller.highlighted === figure.id ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""}`} style={{ width: `${width * 100}%` }} data-testid="figure-frame" data-width={width}>
        <button
          type="button"
          className="block w-full overflow-hidden rounded-md border border-line bg-sunken focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          style={{ aspectRatio: `${figure.image.width} / ${figure.image.height}` }}
          aria-label={t("figures.zoom.open")}
          onClick={() => setZoomed(true)}
          disabled={image.state.status !== "loaded"}
          data-testid="figure-zoom-open"
        >
          {image.state.status === "loaded" ? (
            <img src={image.state.url} alt={figure.caption ?? t("figures.block.alt")} draggable={false} decoding="async" className="block size-full object-contain" data-testid="figure-image" />
          ) : image.state.status === "loading" ? (
            <span className="flex size-full items-center justify-center text-muted" role="img" aria-label={t("figures.block.loading")}>
              <Spinner />
            </span>
          ) : null}
        </button>
        {image.state.status === "failed" ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted" role="alert">
            {t("figures.block.loadFailed")}
            <button type="button" className="rounded text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none" onClick={image.retry}>
              {t("figures.block.retry")}
            </button>
          </span>
        ) : null}
        {liveWidth === undefined ? null : (
          <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-surface px-1.5 py-0.5 font-mono text-xs shadow-sm" data-testid="figure-width-live">
            {t("figures.width.percent", { percent: Math.round(liveWidth * 100) })}
          </span>
        )}
        {/* Pointer only: the width presets in the toolbar are the keyboard's way. */}
        <span
          aria-hidden="true"
          title={t("figures.width.handle")}
          className={`absolute top-1/2 -right-1.5 flex h-10 w-3 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center ${POINTER_ONLY_CLASS} ${liveWidth === undefined ? REVEAL_CLASS : "opacity-100"}`}
          onPointerDown={onResizeStart}
          data-testid="figure-width-handle"
        >
          <span className="h-8 w-1.5 rounded-full border border-line bg-surface shadow-sm" />
        </span>
        <div
          className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-sm ${REVEAL_CLASS}`}
          data-open={menuOpen ? "true" : "false"}
          data-testid="figure-toolbar"
        >
          <button
            type="button"
            className={`${TOOL_BUTTON_CLASS} ${POINTER_ONLY_CLASS} cursor-grab touch-none active:cursor-grabbing`}
            aria-label={moves.blocked ?? t("figures.move.handle")}
            title={moves.blocked ?? t("figures.move.handle")}
            aria-disabled={moves.blocked !== undefined}
            onPointerDown={(event) => {
              if (event.button !== 0 || moves.blocked !== undefined) return;
              // Starting here never starts a text selection, nor drags the image.
              event.preventDefault();
              controller.startDrag(figure, event);
            }}
            onKeyDown={onGripKey}
            {...{ [FIGURE_GRIP_ATTRIBUTE]: "" }}
            data-testid="figure-grip"
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
          <div role="group" aria-label={t("figures.width.group")} className={`flex items-center ${POINTER_ONLY_CLASS}`}>
            {FIGURE_WIDTH_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`${TOOL_BUTTON_CLASS} text-xs font-medium ${Math.abs(width - preset.ratio) < 0.001 ? "bg-sunken text-ink" : ""}`}
                aria-label={t(`figures.width.${preset.id}Label`)}
                aria-pressed={Math.abs(width - preset.ratio) < 0.001}
                title={t(`figures.width.${preset.id}Label`)}
                onClick={() => {
                  if (preset.ratio !== figure.widthRatio) controller.setWidth(figure, preset.ratio);
                }}
                data-testid={`figure-width-${preset.id}`}
              >
                {t(`figures.width.${preset.id}`)}
              </button>
            ))}
          </div>
          <button type="button" className={`${TOOL_BUTTON_CLASS} ${POINTER_ONLY_CLASS}`} aria-label={figure.caption === undefined ? t("figures.caption.add") : t("figures.caption.edit")} title={figure.caption === undefined ? t("figures.caption.add") : t("figures.caption.edit")} onClick={caption.start} data-testid="figure-caption-add">
            <Pencil size={14} aria-hidden="true" />
          </button>
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger className={TOOL_BUTTON_CLASS} aria-label={t("figures.menu.more")} title={t("figures.menu.more")} data-testid="figure-menu">
              <MoreHorizontal size={14} aria-hidden="true" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
                <FigureMenuEntries entries={entries} />
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      {figure.capturedAtMs === undefined && caption.view === null && notice === undefined ? null : (
        <div className="flex min-w-0 flex-col items-start" style={{ width: `${width * 100}%`, paddingTop: `${FIGURE_INNER_GAP_EM}em` }}>
          {figure.capturedAtMs === undefined ? null : (
            <button
              type="button"
              className="rounded font-mono text-xs leading-6 text-muted hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              aria-label={t("figures.time.seek", { time: formatDuration(figure.capturedAtMs) })}
              title={t("figures.time.seek", { time: formatDuration(figure.capturedAtMs) })}
              onClick={() => controller.seek(figure.capturedAtMs as number)}
              data-testid="figure-time"
            >
              <Camera size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
              {formatDuration(figure.capturedAtMs)}
            </button>
          )}
          {caption.view}
          {notice === undefined ? null : (
            <p role="status" className="text-xs text-danger" data-testid="figure-notice">
              {notice}
            </p>
          )}
        </div>
      )}
      <FigureZoom open={zoomed} onOpenChange={setZoomed} url={image.state.status === "loaded" ? image.state.url : undefined} figure={figure} />
    </figure>
  );
}

function menuEntries(t: TFunction, controller: FigureRowController, figure: FigureDto, moves: FigureMoves, editCaption: () => void): MenuEntry[] {
  const blocked = moves.blocked !== undefined;
  const entries: MenuEntry[] = [
    { id: "up", label: moves.up || blocked ? t("figures.move.up") : t("figures.move.atTop"), icon: <ArrowUp size={14} aria-hidden="true" />, disabled: blocked || !moves.up, onSelect: () => controller.move(figure, "up") },
    { id: "down", label: moves.down || blocked ? t("figures.move.down") : t("figures.move.atBottom"), icon: <ArrowDown size={14} aria-hidden="true" />, disabled: blocked || !moves.down, onSelect: () => controller.move(figure, "down") },
    {
      id: "playback",
      label: moves.playback || blocked ? t("figures.move.toPlayback") : (moves.playbackReason ?? t("figures.move.toPlayback")),
      icon: <ArrowDownToLine size={14} aria-hidden="true" />,
      disabled: blocked || !moves.playback,
      onSelect: () => controller.move(figure, "playback"),
    },
  ];
  if (figure.source === "capture") {
    entries.push({ id: "capture", label: t("figures.move.toCapture"), icon: <Camera size={14} aria-hidden="true" />, disabled: blocked || !moves.capture, onSelect: () => controller.move(figure, "capture") });
  }
  if (blocked) entries.push({ id: "blocked", label: moves.blocked as string, disabled: true, onSelect: () => undefined });
  entries.push("separator");
  for (const preset of FIGURE_WIDTH_PRESETS) {
    const current = Math.abs(figure.widthRatio - preset.ratio) < 0.001;
    entries.push({ id: `width-${preset.id}`, label: t(`figures.width.${preset.id}Label`), disabled: current, onSelect: () => controller.setWidth(figure, preset.ratio) });
  }
  entries.push("separator");
  entries.push({ id: "caption", label: figure.caption === undefined ? t("figures.caption.add") : t("figures.caption.edit"), icon: <Pencil size={14} aria-hidden="true" />, onSelect: editCaption });
  entries.push({ id: "delete", label: t("figures.menu.delete"), icon: <Trash2 size={14} aria-hidden="true" />, onSelect: () => controller.remove(figure) });
  return entries;
}

function FigureMenuEntries(props: { entries: readonly MenuEntry[] }) {
  return (
    <>
      {props.entries.map((entry, index) =>
        entry === "separator" ? (
          <DropdownMenu.Separator key={`separator-${index}`} className="my-1 h-px bg-line" />
        ) : (
          <DropdownMenu.Item key={entry.id} className={MENU_ITEM_CLASS} disabled={entry.disabled === true} onSelect={() => entry.onSelect()} data-testid={`figure-menu-${entry.id}`}>
            {entry.icon}
            {entry.label}
          </DropdownMenu.Item>
        ),
      )}
    </>
  );
}

type CaptionStatus = "idle" | "saving" | "saved" | "failed";

/**
 * The caption, shown as a figure caption and edited in place: a click, focus or 「添加备注」
 * opens a multi-line field. Enter breaks the line; Ctrl/⌘+Enter or leaving the field saves;
 * Esc gives up the edit. Saving shows its state; a failed save keeps the text to try again.
 */
function useCaptionEditor(figure: FigureDto): { view: ReactNode; start: () => void } {
  const { t } = useTranslation();
  const controller = useFigureRowController();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<CaptionStatus>("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<HTMLElement>(null);
  // Set while Esc or a save is closing the field, so the blur that follows does not save again.
  const closing = useRef(false);
  const saving = useRef(false);
  // Set while focus is put back on the caption after an edit, which must not open it again.
  const returning = useRef(false);

  // While the field is open its row stays mounted, so scrolling far away keeps the draft. Should
  // the reading view itself go away (another tab, the editor) with a changed draft, it is saved,
  // as leaving the field would have done.
  const latest = useRef({ controller, figure, draft, editing });
  latest.current = { controller, figure, draft, editing };
  const figureId = figure.id;
  useEffect(() => {
    if (!editing) return undefined;
    latest.current.controller.holdCaption(figureId, true);
    return () => latest.current.controller.holdCaption(figureId, false);
  }, [editing, figureId]);
  useEffect(
    () => () => {
      const now = latest.current;
      if (!now.editing || closing.current || saving.current) return;
      const next = now.draft.trim() === "" ? null : now.draft;
      if (next !== (now.figure.caption ?? null)) void now.controller.saveCaption(now.figure, next);
    },
    [],
  );

  useEffect(() => {
    if (status !== "saved") return undefined;
    const timer = setTimeout(() => setStatus("idle"), SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useLayoutEffect(() => {
    const element = field.current;
    if (!editing || element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [editing, draft]);

  const start = (): void => {
    if (editing) {
      field.current?.focus();
      return;
    }
    closing.current = false;
    setDraft(figure.caption ?? "");
    setStatus("idle");
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const element = field.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  const finish = (): void => {
    closing.current = true;
    setEditing(false);
  };

  const save = async (): Promise<void> => {
    if (saving.current) return;
    const next = draft.trim() === "" ? null : draft;
    if (next === (figure.caption ?? null)) {
      finish();
      return;
    }
    saving.current = true;
    setStatus("saving");
    const result = await controller.saveCaption(figure, next);
    saving.current = false;
    if (result.kind === "saved") {
      setStatus("saved");
      finish();
    } else if (result.kind === "conflict") {
      // The other window's caption is what shows now; the notice says why.
      setStatus("idle");
      finish();
    } else {
      setStatus("failed");
    }
  };

  const cancel = (): void => {
    finish();
    setStatus("idle");
    // Back where editing started: the caption, else the figure's own add button.
    requestAnimationFrame(() => {
      const root = field.current?.closest(`[${FIGURE_ID_ATTRIBUTE}]`) ?? document.querySelector(`[${FIGURE_ID_ATTRIBUTE}="${CSS.escape(figure.id)}"]`);
      returning.current = true;
      (shown.current ?? root?.querySelector<HTMLElement>('[data-testid="figure-caption-add"]'))?.focus({ preventScroll: true });
      returning.current = false;
    });
  };

  const statusLine =
    status === "idle" ? null : (
      <span role="status" className={`inline-flex items-center gap-1 text-xs ${status === "failed" ? "text-danger" : "text-muted"}`} data-testid="figure-caption-status" data-status={status}>
        {status === "saving" ? <Spinner size={12} /> : null}
        {t(`figures.caption.${status}`)}
        {status === "failed" ? (
          <button type="button" className="text-accent hover:underline" onMouseDown={(event) => event.preventDefault()} onClick={() => void save()}>
            {t("figures.caption.retry")}
          </button>
        ) : null}
      </span>
    );

  if (editing) {
    const nearLimit = draft.length >= FIGURE_CAPTION_MAX_CHARS * 0.8;
    return {
      start,
      view: (
        <div className="flex w-full min-w-0 flex-col gap-1" style={{ fontSize: `${CAPTION_SIZE_EM}em` }}>
          <textarea
            ref={field}
            value={draft}
            rows={1}
            maxLength={FIGURE_CAPTION_MAX_CHARS}
            aria-label={t("figures.caption.label")}
            placeholder={t("figures.caption.placeholder")}
            className="w-full resize-none overflow-hidden rounded-md border border-line bg-surface px-2 py-1 leading-normal select-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isComposing(event)) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              } else if (SAVE_COMBOS.has(blockedComboOf(event))) {
                event.preventDefault();
                void save();
              }
            }}
            onBlur={() => {
              if (closing.current) return;
              void save();
            }}
            data-testid="figure-caption-input"
          />
          <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <span className={ACCENT_TEXT}>{t(isApple() ? "figures.caption.hintMeta" : "figures.caption.hintCtrl")}</span>
            <span className="flex items-center gap-2">
              {statusLine}
              {nearLimit ? (
                <span className={`${ACCENT_TEXT} font-mono`} aria-live="polite">
                  {draft.length >= FIGURE_CAPTION_MAX_CHARS ? t("figures.caption.tooLong", { max: FIGURE_CAPTION_MAX_CHARS }) : t("figures.caption.count", { count: draft.length, max: FIGURE_CAPTION_MAX_CHARS })}
                </span>
              ) : null}
            </span>
          </span>
        </div>
      ),
    };
  }
  if (figure.caption === undefined) return { start, view: statusLine };
  return {
    start,
    view: (
      <span className="flex w-full min-w-0 flex-col items-start">
        <span
          ref={shown}
          role="button"
          tabIndex={0}
          aria-label={t("figures.caption.editLabel", { caption: figure.caption })}
          className="w-full cursor-text rounded leading-normal break-words whitespace-pre-wrap text-muted hover:bg-sunken focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          style={{ fontSize: `${CAPTION_SIZE_EM}em` }}
          onClick={start}
          onFocus={(event) => {
            // Focus from the keyboard opens the field; a click opens it through `onClick`.
            if (!returning.current && event.currentTarget.matches(":focus-visible")) start();
          }}
          data-testid="figure-caption"
        >
          {figure.caption}
        </span>
        {statusLine}
      </span>
    ),
  };
}

/** The figure enlarged over the page: the whole image within the window, its caption below; any click or Esc closes it. */
function FigureZoom(props: { open: boolean; onOpenChange: (open: boolean) => void; url: string | undefined; figure: FigureDto }) {
  const { t } = useTranslation();
  if (props.url === undefined) return null;
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-6 outline-none"
          aria-describedby={undefined}
          onClick={() => props.onOpenChange(false)}
          data-testid="figure-zoom"
        >
          <Dialog.Title className="sr-only">{t("figures.zoom.title")}</Dialog.Title>
          <img src={props.url} alt={props.figure.caption ?? t("figures.block.alt")} className="max-h-[85vh] max-w-[92vw] rounded-md object-contain shadow-xl" draggable={false} />
          {props.figure.caption === undefined ? null : <p className="max-w-[92vw] text-center text-sm whitespace-pre-wrap text-white">{props.figure.caption}</p>}
          <Dialog.Close className="absolute top-4 right-4 rounded p-1.5 text-white hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none" aria-label={t("figures.zoom.close")}>
            <X size={18} aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
