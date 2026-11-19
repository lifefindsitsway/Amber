import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { READER_LOCATE_PULSE_MS } from "../../../shared/defaults.ts";
import type { FigureDto, FigurePlacement } from "../../../shared/dto/figure.ts";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import { segmentMapDtoSchema, type TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { placementForGap, type FigureLayout } from "../../../shared/figure-placement.ts";
import { useApi } from "../../api/context.tsx";
import { usePlayerController } from "../../player/player-controller.tsx";
import type { Paragraph } from "./content-data.ts";
import { useFigureActions, useFigures, rememberFigureWidth, type FigureChangeResult } from "./figure-data.ts";
import { useRegisterReaderFigures, type ReaderFigureApi } from "./figure-context.ts";
import { FIGURE_GRIP_ATTRIBUTE, FIGURE_ID_ATTRIBUTE, type FigureMove, type FigureMoves, type FigureRowController } from "./figure-row.tsx";
import {
  captureSentence,
  estimateRowPx,
  figureRowKey,
  FIGURE_ROW_ATTRIBUTE,
  clearOverride,
  gapOfPlacement,
  keepWhileMapping,
  layoutReaderFigures,
  placementAtCapture,
  placementMovedBy,
  readerFigure,
  readerRowKey,
  revealStep,
  rowsWithFigures,
  setOverride,
  samePlacement,
  targetAfterSentence,
  targetForTime,
  withOverride,
  type FigureOverrides,
  type ReaderFigure,
  type ReaderRow,
} from "./reader-figures.ts";
import { locateOffset, locateTarget } from "./reader-locate.ts";
import { pointFromDom } from "./reader-selection-dom.ts";
import { avatarEmPx } from "./speakers/speaker-avatar.tsx";
import type { FilteredRow } from "./speaker-filter.ts";
import { ROW_KEY_ATTRIBUTE, type ScrollAnchor } from "./scroll-anchor.ts";
import type { VirtualRowsHandle } from "./virtual-rows.tsx";

/** The address parameter that opens the reading view on a figure (a search hit links to it). */
export const FIGURE_PARAM = "figure";

/** How long a figure asked to be revealed may take to show up in the list (a figure just created, a list still loading). */
const REVEAL_WAIT_MS = 5000;
/** How long a notice about one figure's change stays. */
const NOTICE_MS = 6000;
/** Height of the band at either edge of the list where a dragged figure scrolls the list. */
const AUTOSCROLL_EDGE_PX = 48;
/** The scroll speed at the very edge, in px per frame; it falls off towards the band's inner side. */
const AUTOSCROLL_MAX_PX = 16;

/**
 * Scroll and restore calls in terms of the text rows: the reader's controls (outline, locate,
 * the return after editing) count rows without figures, so an index is mapped to the list's
 * own before it reaches the list. Keys are the same in both.
 */
export function useTextRowsHandle(raw: RefObject<VirtualRowsHandle | null>, displayIndex: RefObject<readonly number[]>): RefObject<VirtualRowsHandle | null> {
  const handle = useMemo<VirtualRowsHandle>(
    () => ({
      scrollToIndex: (index, align) => raw.current?.scrollToIndex(displayIndex.current[index] ?? index, align),
      scrollToTop: () => raw.current?.scrollToTop(),
      scrollToBottom: () => raw.current?.scrollToBottom(),
      anchor: () => raw.current?.anchor(),
      restoreAnchor: (anchor, onDone) => {
        if (raw.current === null) onDone?.("missing");
        else raw.current.restoreAnchor(anchor, onDone);
      },
      restoreSegment: (target, onDone) => {
        if (raw.current === null) onDone?.("missing");
        else raw.current.restoreSegment(target, onDone);
      },
      cancelRestore: () => raw.current?.cancelRestore(),
    }),
    [raw, displayIndex],
  );
  return useMemo(() => ({ current: handle }), [handle]);
}

/** The sentence the selection ends in, when the browser selection ends inside the list. */
function selectedSentence(list: HTMLElement, rows: readonly FilteredRow[], textKey: (row: FilteredRow) => string): string | undefined {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!list.contains(range.endContainer)) return undefined;
  const point = pointFromDom(list, range.endContainer, range.endOffset);
  if (point === undefined) return undefined;
  if (point.part === "sentence") return point.segmentId;
  const row = rows.find((candidate) => textKey(candidate) === point.rowKey);
  return row?.kind === "paragraph" ? row.paragraph.segments.at(-1)?.id : undefined;
}

/** The first sentence at least partly in view. */
function firstVisibleSentence(list: HTMLElement): string | undefined {
  const box = list.getBoundingClientRect();
  for (const element of Array.from(list.querySelectorAll<HTMLElement>("[data-segment-id]"))) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > box.top + 1 && rect.top < box.bottom) return element.getAttribute("data-segment-id") ?? undefined;
  }
  return undefined;
}

function figureElement(list: HTMLElement, figureId: string): HTMLElement | undefined {
  return Array.from(list.querySelectorAll<HTMLElement>(`[${FIGURE_ID_ATTRIBUTE}]`)).find((element) => element.getAttribute(FIGURE_ID_ATTRIBUTE) === figureId);
}

/** The first text row (figures left out) in view and its top's distance from the list's top. */
function textAnchor(list: HTMLElement): ScrollAnchor | undefined {
  const top = list.getBoundingClientRect().top;
  for (const row of Array.from(list.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]:not([${FIGURE_ROW_ATTRIBUTE}])`))) {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;
    if (rect.bottom > top) {
      const key = row.getAttribute(ROW_KEY_ATTRIBUTE);
      return key === null ? undefined : { key, offset: rect.top - top };
    }
  }
  return undefined;
}

/** What a mounted list row stands for when a figure is dropped on it. */
type DropInfo = { kind: "paragraph"; paragraph: number } | { kind: "figure"; gap: number; id: string } | { kind: "heading"; paragraph: number };

/**
 * The gap a dragged figure would land in with the pointer at `y`: on a paragraph's upper half
 * the gap before it, on its lower half the gap after; on a figure its gap; on a heading the
 * gap before the paragraph it opens. Past the last row, after it.
 */
export function dropGapAt(rows: ReadonlyArray<{ rect: { top: number; bottom: number }; info: DropInfo }>, y: number): number | undefined {
  const gapOf = (info: DropInfo, upper: boolean): number => (info.kind === "paragraph" ? (upper ? info.paragraph : info.paragraph + 1) : info.kind === "figure" ? info.gap : info.paragraph);
  for (const row of rows) {
    if (y < row.rect.bottom) return gapOf(row.info, y < (row.rect.top + row.rect.bottom) / 2);
  }
  const last = rows.at(-1);
  return last === undefined ? undefined : gapOf(last.info, false);
}

interface Drag {
  figureId: string;
  gap: number | undefined;
}

/**
 * The figures of the reading view: the rows with the figures among them, what the figure rows
 * do, the reading view's figure API for the rest of the page (registered while the reader can
 * take figures), revealing a figure (the `figure` address parameter, a newly created one) and
 * dragging figures between paragraphs.
 */
export function useReaderFigureRows(input: {
  contentId: string;
  revisionId: string;
  /** The whole text's rows: figures are placed against these paragraphs, never the filtered ones. */
  rows: readonly FilteredRow[];
  /** The rows on screen (after the 「只看」 filter). */
  shownRows: readonly FilteredRow[];
  textKey: (row: FilteredRow) => string;
  /** False until the sentences are read; nothing is offered without them. */
  ready: boolean;
  filter: { active: boolean; clear: () => void };
  /** The list's own handle (display rows), and the mapping the text-row handle reads. */
  raw: RefObject<VirtualRowsHandle | null>;
  displayIndex: RefObject<number[]>;
  host: HTMLElement | null;
  scroller: () => HTMLElement | null;
  segments: readonly TranscriptSegmentDto[];
  /** The sentence playing now, when the player tells the time. */
  followingId: string | undefined;
  tracking: boolean;
  time: number | undefined;
  speakers: ReadonlyMap<string, SpeakerDto>;
  gutter: boolean;
  typography: { fontSize: number; lineHeight: number; sideMargin: number };
}) {
  const { t } = useTranslation();
  const client = useApi();
  const player = usePlayerController();
  const { contentId, revisionId, rows, shownRows, textKey, raw, scroller } = input;
  const figures = useFigures(contentId, input.ready);
  const actions = useFigureActions(contentId);
  const [tombstones, setTombstones] = useState<ReadonlyMap<string, FigureDto>>(new Map());
  // Changes shown before the server confirms them. Each field carries the number of the request
  // that set it, so only that request's answer clears it: a second move sent while the first is
  // in flight is not undone on screen when the first comes back.
  const [overrides, setOverrides] = useState<FigureOverrides>(new Map());
  const overrideSeq = useRef(0);
  // Figures whose row must stay mounted however far the list scrolls: one being dragged, one
  // whose caption is being edited.
  const [held, setHeld] = useState<ReadonlyMap<string, ReadonlySet<"drag" | "caption">>>(new Map());
  const hold = useCallback((figureId: string, reason: "drag" | "caption", on: boolean) => {
    setHeld((current) => {
      const reasons = new Set(current.get(figureId));
      if (on === reasons.has(reason)) return current;
      if (on) reasons.add(reason);
      else reasons.delete(reason);
      const next = new Map(current);
      if (reasons.size === 0) next.delete(figureId);
      else next.set(figureId, reasons);
      return next;
    });
  }, []);
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [indicator, setIndicator] = useState<number | undefined>(undefined);
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  const paragraphs = useMemo(() => rows.flatMap((row): Paragraph[] => (row.kind === "paragraph" ? [row.paragraph] : [])), [rows]);
  const sentenceIds = useMemo(() => new Set(input.segments.map((segment) => segment.id)), [input.segments]);
  const items = figures.data?.items;
  // What each figure stood on last, for the next layout to keep while a mapping is on its way.
  // Another revision is another reading: nothing carries over.
  /** After a change that moves a figure in the list: where it is to stay on screen, and what takes focus back. */
  const keepInPlace = useRef<{ figureId: string; offset: number; focus: string | undefined } | undefined>(undefined);
  /** A figure asked to be revealed, waiting for its row. */
  const reveal = useRef<{ figureId: string; since: number; fromLink: boolean; pulse: boolean } | undefined>(undefined);
  const previousPlaced = useRef<{ revisionId: string; figures: ReadonlyMap<string, ReaderFigure> }>({ revisionId, figures: new Map() });

  // Live figures with the changes still on their way to the server, and those deleted here.
  const shown = useMemo(() => {
    const live = (items ?? []).map((dto) => {
      return readerFigure(withOverride(dto, overrides.get(dto.id)));
    });
    const liveIds = new Set(live.map((figure) => figure.id));
    for (const dto of tombstones.values()) if (!liveIds.has(dto.id)) live.push(readerFigure(dto, true));
    return live;
  }, [items, overrides, tombstones]);

  // Anchors on another revision are mapped to this one by the same-sentence rule; until the
  // answer is in, the figure waits rather than appearing by time and then jumping.
  const foreign = useMemo(() => {
    const keys = new Map<string, { revisionId: string; segmentId: string }>();
    for (const figure of shown) {
      const anchor = figure.anchor;
      if (anchor !== null && anchor !== undefined && anchor.revisionId !== revisionId) keys.set(`${anchor.revisionId} ${anchor.segmentId}`, anchor);
    }
    return [...keys.values()];
  }, [shown, revisionId]);
  const maps = useQueries({
    queries: foreign.map((anchor) => ({
      queryKey: ["segment-map", anchor.segmentId, revisionId],
      queryFn: () => client.get(`/api/transcript/segments/${encodeURIComponent(anchor.segmentId)}/map?targetRevision=${encodeURIComponent(revisionId)}`, segmentMapDtoSchema),
      staleTime: Infinity,
      enabled: input.ready,
    })),
  });
  const mapKey = maps.map((query) => `${query.status}:${query.data?.segmentId ?? ""}`).join(",");
  const layout = useMemo((): FigureLayout<ReaderFigure> => {
    const mapped = new Map<string, string | undefined>();
    const waiting = new Set<string>();
    foreign.forEach((anchor, index) => {
      const query = maps[index];
      const key = `${anchor.revisionId} ${anchor.segmentId}`;
      if (query?.status === "pending") waiting.add(key);
      else mapped.set(key, query?.data?.method === "none" ? undefined : (query?.data?.segmentId ?? undefined));
    });
    const placeable = keepWhileMapping(shown, waiting, previousPlaced.current, revisionId);
    return layoutReaderFigures({ revisionId, paragraphs, figures: placeable, mapSentence: (from, segmentId) => mapped.get(`${from} ${segmentId}`) });
    // `maps` is a new array every render; `mapKey` says when its answers changed.
  }, [shown, foreign, mapKey, revisionId, paragraphs]);
  useLayoutEffect(() => {
    previousPlaced.current = { revisionId, figures: new Map(layout.placed.map((entry) => [entry.figure.id, entry.figure])) };
  }, [layout, revisionId]);

  const view = useMemo(() => rowsWithFigures(shownRows, paragraphs, layout), [shownRows, paragraphs, layout]);
  // A change of the figures alone (another window, a list read again) moves the rows below it;
  // the first text row in view is to stay where it is. Taken while rendering, from the screen the
  // last commit drew, and put back once the new rows are laid out. A change of the text itself
  // (another revision, a filter, the typography) is the reader's to place, and the reader's own
  // moves keep the moved figure in place instead (`holdPlace`).
  const laidOut = useRef({ layout, shownRows, paragraphs });
  const keepText = useRef<ScrollAnchor | undefined>(undefined);
  if (laidOut.current.layout !== layout) {
    const textSame = laidOut.current.shownRows === shownRows && laidOut.current.paragraphs === paragraphs;
    const list = textSame && keepInPlace.current === undefined && reveal.current === undefined ? scroller() : null;
    keepText.current = list === null ? undefined : textAnchor(list);
    laidOut.current = { layout, shownRows, paragraphs };
  } else if (laidOut.current.shownRows !== shownRows || laidOut.current.paragraphs !== paragraphs) {
    laidOut.current = { layout, shownRows, paragraphs };
  }
  useLayoutEffect(() => {
    const anchor = keepText.current;
    keepText.current = undefined;
    if (anchor !== undefined) raw.current?.restoreAnchor(anchor);
  });
  input.displayIndex.current = view.displayIndex;
  const keyOf = useCallback((row: ReaderRow) => readerRowKey(row, textKey), [textKey]);

  // Latest values for callbacks that outlive a render (the figure API, a drag in progress).
  const latest = useRef({ layout, paragraphs, view, shownRows, input, items });
  latest.current = { layout, paragraphs, view, shownRows, input, items };

  const notify = useCallback((figureId: string, message: string | undefined) => {
    setNotices((current) => {
      const next = new Map(current);
      if (message === undefined) next.delete(figureId);
      else next.set(figureId, message);
      return next;
    });
    if (message !== undefined) setTimeout(() => setNotices((current) => (current.get(figureId) === message ? new Map([...current].filter(([id]) => id !== figureId)) : current)), NOTICE_MS);
  }, []);
  const reportFailure = useCallback(
    (figureId: string, result: FigureChangeResult, failed: string) => {
      if (result.kind === "conflict") notify(figureId, t("figures.conflict"));
      else if (result.kind === "failed") notify(figureId, failed);
    },
    [notify, t],
  );

  // Read out after a move: where the figure is now. Cleared after a while, so the same place
  // reached again later is read out again rather than counting as no change.
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = (text: string): void => {
    clearTimeout(announceTimer.current);
    setAnnouncement(text);
    announceTimer.current = setTimeout(() => setAnnouncement(""), NOTICE_MS);
  };
  useEffect(() => () => clearTimeout(announceTimer.current), []);

  const holdPlace = (figureId: string): void => {
    const list = scroller();
    const element = list === null ? undefined : figureElement(list, figureId);
    if (list === null || element === undefined) return;
    const active = document.activeElement;
    const focus = active instanceof HTMLElement && element.contains(active) ? (active.hasAttribute(FIGURE_GRIP_ATTRIBUTE) ? `[${FIGURE_GRIP_ATTRIBUTE}]` : '[data-testid="figure-menu"]') : undefined;
    keepInPlace.current = { figureId, offset: element.getBoundingClientRect().top - list.getBoundingClientRect().top, focus };
  };
  useLayoutEffect(() => {
    const hold = keepInPlace.current;
    if (hold === undefined) return;
    keepInPlace.current = undefined;
    raw.current?.restoreAnchor({ key: figureRowKey(hold.figureId), offset: hold.offset }, () => {
      if (hold.focus === undefined) return;
      const list = scroller();
      const element = list === null ? undefined : figureElement(list, hold.figureId);
      element?.querySelector<HTMLElement>(hold.focus)?.focus({ preventScroll: true });
    });
  });

  const changePlacement = useCallback(
    (figure: FigureDto, placement: FigurePlacement | undefined) => {
      if (placement === undefined || samePlacement(placement, figure.placement)) return;
      holdPlace(figure.id);
      const seq = ++overrideSeq.current;
      setOverrides((current) => setOverride(current, figure.id, "placement", placement, seq));
      notify(figure.id, undefined);
      const { paragraphs: whole, input: current } = latest.current;
      const gap = gapOfPlacement(whole, current.revisionId, figure.id, placement);
      void actions.patch(figure, { placement }).then((result) => {
        setOverrides((overridden) => clearOverride(overridden, figure.id, "placement", seq));
        if (result.kind === "saved") announce(gap === 0 ? t("figures.move.movedTop") : t("figures.move.movedAfter", { paragraph: gap }));
        else reportFailure(figure.id, result, t("figures.move.failed"));
      });
    },
    // `holdPlace` and `announce` read refs and state setters only.
    [actions, notify, reportFailure, t],
  );

  const moves = useCallback(
    (figure: FigureDto): FigureMoves => {
      const { layout: now, paragraphs: whole, input: current } = latest.current;
      if (current.filter.active) return { up: false, down: false, playback: false, capture: false, blocked: t("figures.move.filtered") };
      const target = current.tracking ? locateTarget(current.segments, current.time) : undefined;
      const atCapture = figure.source === "capture" ? placementAtCapture({ layout: now, paragraphs: whole, revisionId: current.revisionId, figure }) : undefined;
      return {
        up: placementMovedBy({ layout: now, paragraphs: whole, revisionId: current.revisionId, figureId: figure.id, direction: "up" }) !== undefined,
        down: placementMovedBy({ layout: now, paragraphs: whole, revisionId: current.revisionId, figureId: figure.id, direction: "down" }) !== undefined,
        playback: target !== undefined,
        ...(target === undefined ? { playbackReason: t("figures.move.noPlayback") } : {}),
        capture: atCapture !== undefined && !samePlacement(atCapture, figure.placement),
      };
    },
    [t],
  );

  const move = useCallback(
    (figure: FigureDto, kind: FigureMove) => {
      const { layout: now, paragraphs: whole, input: current } = latest.current;
      if (current.filter.active) return;
      const revision = current.revisionId;
      let placement: FigurePlacement | undefined;
      if (kind === "up" || kind === "down") placement = placementMovedBy({ layout: now, paragraphs: whole, revisionId: revision, figureId: figure.id, direction: kind });
      else if (kind === "capture") placement = placementAtCapture({ layout: now, paragraphs: whole, revisionId: revision, figure });
      else {
        const target = current.tracking ? locateTarget(current.segments, current.time) : undefined;
        placement = target === undefined ? undefined : targetAfterSentence({ layout: now, paragraphs: whole, revisionId: revision, segmentId: target.id })?.placement;
      }
      changePlacement(figure, placement);
    },
    [changePlacement],
  );

  const setWidth = useCallback(
    (figure: FigureDto, ratio: number) => {
      rememberFigureWidth(ratio);
      const seq = ++overrideSeq.current;
      setOverrides((current) => setOverride(current, figure.id, "widthRatio", ratio, seq));
      notify(figure.id, undefined);
      void actions.patch(figure, { widthRatio: ratio }).then((result) => {
        setOverrides((current) => clearOverride(current, figure.id, "widthRatio", seq));
        reportFailure(figure.id, result, t("figures.width.failed"));
      });
    },
    [actions, notify, reportFailure, t],
  );

  const saveCaption = useCallback(
    async (figure: FigureDto, caption: string | null): Promise<FigureChangeResult> => {
      notify(figure.id, undefined);
      const result = await actions.patch(figure, { caption });
      if (result.kind === "conflict") notify(figure.id, t("figures.conflict"));
      return result;
    },
    [actions, notify, t],
  );

  const remove = useCallback(
    (figure: FigureDto) => {
      setTombstones((current) => new Map(current).set(figure.id, figure));
      notify(figure.id, undefined);
      void actions.remove(figure.id).then((result) => {
        if (result.kind === "saved") {
          setTombstones((current) => new Map(current).set(figure.id, result.figure));
          return;
        }
        setTombstones((current) => {
          const next = new Map(current);
          next.delete(figure.id);
          return next;
        });
        reportFailure(figure.id, result, t("figures.deleted.failed"));
      });
    },
    [actions, notify, reportFailure, t],
  );

  const clearFilter = input.filter.clear;
  const [revealTick, setRevealTick] = useState(0);
  const revealFigure = useCallback((figureId: string, options: { fromLink?: boolean; pulse?: boolean } = {}) => {
    reveal.current = { figureId, since: Date.now(), fromLink: options.fromLink === true, pulse: options.pulse ?? true };
    setMissing(false);
    setRevealTick((tick) => tick + 1);
  }, []);

  const undo = useCallback(
    (figure: FigureDto) => {
      notify(figure.id, undefined);
      void actions.restore(figure.id).then((result) => {
        if (result.kind === "saved") {
          setTombstones((current) => {
            const next = new Map(current);
            next.delete(figure.id);
            return next;
          });
          // Focus goes back to the figure the undo brought back.
          requestAnimationFrame(() => {
            const list = scroller();
            const element = list === null ? undefined : figureElement(list, figure.id);
            element?.querySelector<HTMLElement>('[data-testid="figure-zoom-open"]')?.focus({ preventScroll: true });
          });
          return;
        }
        reportFailure(figure.id, result, t("figures.deleted.undoFailed"));
      });
    },
    [actions, notify, reportFailure, scroller, t],
  );

  // A reveal waits for its figure: until it is in the list, until the filter shows it, then
  // scrolls it in through the list (mounting it first) and highlights it once there.
  useLayoutEffect(() => {
    const pending = reveal.current;
    if (pending === undefined) return undefined;
    const step = revealStep({
      inRows: view.rows.some((row) => row.kind === "figure" && row.figure.id === pending.figureId),
      hidden: view.hidden.has(pending.figureId),
      known: items?.some((item) => item.id === pending.figureId) === true,
      fetched: figures.isFetched,
      waitedMs: Date.now() - pending.since,
      waitMs: REVEAL_WAIT_MS,
    });
    switch (step.kind) {
      case "scroll": {
        reveal.current = undefined;
        const list = scroller();
        raw.current?.restoreAnchor({ key: figureRowKey(pending.figureId), offset: list === null ? 0 : locateOffset(list.clientHeight) }, (result) => {
          if (result === "cancelled" || result === "missing" || !pending.pulse) return;
          setHighlighted(pending.figureId);
        });
        return undefined;
      }
      case "clearFilter":
        clearFilter();
        return undefined;
      case "giveUp":
        reveal.current = undefined;
        if (pending.fromLink && !step.known) setMissing(true);
        return undefined;
      case "wait": {
        // Without a timer while the list is still being read: its arrival runs this again.
        if (step.retryInMs === undefined) return undefined;
        const timer = setTimeout(() => setRevealTick((tick) => tick + 1), step.retryInMs);
        return () => clearTimeout(timer);
      }
    }
  }, [view, revealTick, items, figures.isFetched, raw, scroller, clearFilter]);

  useEffect(() => {
    if (highlighted === undefined) return undefined;
    const timer = setTimeout(() => setHighlighted(undefined), READER_LOCATE_PULSE_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  // `?figure=<id>`: shown once the sentences are in, then spent, so the address does not keep asking.
  const [params, setParams] = useSearchParams();
  const linked = params.get(FIGURE_PARAM);
  useEffect(() => {
    if (linked === null || !input.ready) return;
    revealFigure(linked, { fromLink: true });
    const next = new URLSearchParams(params);
    next.delete(FIGURE_PARAM);
    setParams(next, { replace: true });
  }, [linked, input.ready, params, setParams, revealFigure]);

  const endDrag = useRef<(() => void) | undefined>(undefined);
  const startDrag = useCallback(
    (figure: FigureDto, event: ReactPointerEvent<HTMLElement>) => {
      const list = scroller();
      const host = latest.current.input.host;
      if (list === null || host === null || latest.current.input.filter.active) return;
      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      // The row stays mounted while it is dragged, however far the list scrolls under it.
      hold(figure.id, "drag", true);
      let y = event.clientY;
      let gap: number | undefined;
      let frame = 0;
      const infoOf = (): Map<string, DropInfo> => {
        const map = new Map<string, DropInfo>();
        let paragraph = 0;
        for (const row of latest.current.view.rows) {
          if (row.kind === "figure") map.set(figureRowKey(row.figure.id), { kind: "figure", gap: row.gap, id: row.figure.id });
          else if (row.kind === "paragraph") map.set(textKey(row), { kind: "paragraph", paragraph: paragraph++ });
          else if (row.kind === "chapter") map.set(textKey(row), { kind: "heading", paragraph });
        }
        return map;
      };
      const info = infoOf();
      const step = (): void => {
        const box = list.getBoundingClientRect();
        // Near an edge the list scrolls, faster the closer the pointer is to it.
        const fromTop = y - box.top;
        const fromBottom = box.bottom - y;
        if (fromTop < AUTOSCROLL_EDGE_PX) list.scrollTop -= Math.ceil((AUTOSCROLL_MAX_PX * (AUTOSCROLL_EDGE_PX - Math.max(0, fromTop))) / AUTOSCROLL_EDGE_PX);
        else if (fromBottom < AUTOSCROLL_EDGE_PX) list.scrollTop += Math.ceil((AUTOSCROLL_MAX_PX * (AUTOSCROLL_EDGE_PX - Math.max(0, fromBottom))) / AUTOSCROLL_EDGE_PX);
        const mounted = Array.from(list.querySelectorAll<HTMLElement>("[data-row-key]")).flatMap((element) => {
          const found = info.get(element.getAttribute("data-row-key") ?? "");
          return found === undefined ? [] : [{ element, rect: element.getBoundingClientRect(), info: found }];
        });
        gap = dropGapAt(mounted, Math.min(Math.max(y, box.top), box.bottom));
        setDrag({ figureId: figure.id, gap });
        // The line goes where the figure would land: last in its gap.
        let edge: number | undefined;
        if (gap === 0) edge = mounted.find((row) => row.info.kind === "paragraph" && row.info.paragraph === 0)?.rect.top;
        else if (gap !== undefined) {
          const inGap = mounted.filter((row) => row.info.kind === "figure" && row.info.gap === gap && row.info.id !== figure.id).at(-1);
          edge = (inGap ?? mounted.find((row) => row.info.kind === "paragraph" && row.info.paragraph === (gap as number) - 1))?.rect.bottom;
        }
        const hostTop = host.getBoundingClientRect().top;
        setIndicator(edge === undefined || edge < box.top || edge > box.bottom ? undefined : edge - hostTop);
        frame = requestAnimationFrame(step);
      };
      const onMove = (move: PointerEvent): void => {
        y = move.clientY;
      };
      const onKey = (key: KeyboardEvent): void => {
        if (key.key === "Escape") finish(false);
      };
      const finish = (commit: boolean): void => {
        if (endDrag.current === cancel) endDrag.current = undefined;
        hold(figure.id, "drag", false);
        cancelAnimationFrame(frame);
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
        setDrag(undefined);
        setIndicator(undefined);
        if (!commit || gap === undefined) return;
        const { layout: now, paragraphs: whole, input: current } = latest.current;
        const from = now.placed.find((entry) => entry.figure.id === figure.id)?.gap;
        if (from === gap) return;
        changePlacement(figure, placementForGap({ layout: now, paragraphs: whole, readingRevisionId: current.revisionId, figureId: figure.id, gap, position: "end" }));
      };
      const onUp = (): void => finish(true);
      const onCancel = (): void => finish(false);
      const cancel = (): void => finish(false);
      endDrag.current?.();
      endDrag.current = cancel;
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      frame = requestAnimationFrame(step);
    },
    [changePlacement, hold, scroller, textKey],
  );
  // The reading view going away ends a drag in progress, dropping nothing.
  useEffect(() => () => endDrag.current?.(), []);

  const controller = useMemo<FigureRowController>(
    () => ({
      contentId,
      speakers: input.speakers,
      gutter: input.gutter,
      moves,
      move,
      seek: (ms) => player.seek(ms),
      saveCaption,
      setWidth,
      remove,
      undo,
      startDrag,
      holdCaption: (figureId, editing) => hold(figureId, "caption", editing),
      dragging: drag?.figureId,
      highlighted,
      notice: (figureId) => notices.get(figureId),
    }),
    [contentId, input.speakers, input.gutter, moves, move, player, saveCaption, setWidth, remove, undo, startDrag, hold, drag?.figureId, highlighted, notices],
  );

  // The figure API for the player's capture button, the insert menu and the paste handler.
  // Registered only while there are paragraphs to place a figure by.
  const canTakeFigures = input.ready && paragraphs.length > 0;
  const api = useMemo<ReaderFigureApi | undefined>(() => {
    if (!canTakeFigures) return undefined;
    return {
      contentId,
      revisionId,
      captureTarget: () => {
        const { layout: now, paragraphs: whole, input: current, shownRows: shownNow } = latest.current;
        const list = current.scroller();
        const known = (id: string): boolean => current.segments.some((segment) => segment.id === id);
        const segmentId = captureSentence(
          {
            selected: list === null ? undefined : selectedSentence(list, shownNow, current.textKey),
            following: current.tracking && current.time !== undefined ? current.followingId : undefined,
            firstVisible: list === null ? undefined : firstVisibleSentence(list),
          },
          known,
        );
        return segmentId === undefined ? undefined : targetAfterSentence({ layout: now, paragraphs: whole, revisionId: current.revisionId, segmentId });
      },
      targetForTime: (atMs) => {
        const { layout: now, paragraphs: whole, input: current } = latest.current;
        return targetForTime({ layout: now, paragraphs: whole, revisionId: current.revisionId, atMs });
      },
      revealFigure: (figureId) => revealFigure(figureId),
    };
  }, [canTakeFigures, contentId, revisionId, revealFigure]);
  useRegisterReaderFigures(api);

  // Row heights before measuring, from the column width the host has.
  const [hostWidth, setHostWidth] = useState(0);
  useEffect(() => {
    const host = input.host;
    if (host === null) return undefined;
    setHostWidth(host.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setHostWidth(entry.contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [input.host]);
  const { fontSize, lineHeight, sideMargin } = input.typography;
  const estimate = useMemo(() => {
    // The column's own inset (see the reader's style sheet) on either side, and the gutter.
    const inset = Math.min(sideMargin, Math.max(8, (hostWidth - 320) / 2));
    const gutterPx = input.gutter ? avatarEmPx(fontSize) + 0.75 * fontSize : 0;
    const metrics = { textPx: Math.max(160, hostWidth - 2 * inset - gutterPx - 24), fontPx: fontSize, lineHeight, turnHeaderPx: input.gutter ? avatarEmPx(fontSize) : 0 };
    const rowsNow = view.rows;
    return (index: number): number => {
      const row = rowsNow[index];
      return row === undefined ? 96 : estimateRowPx(row, metrics);
    };
  }, [view.rows, hostWidth, sideMargin, fontSize, lineHeight, input.gutter]);

  const rowAttributes = useCallback((row: ReaderRow) => (row.kind === "figure" ? { [FIGURE_ROW_ATTRIBUTE]: "" } : undefined), []);

  const overlay: ReactNode = (
    <>
      {indicator === undefined ? null : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2 px-6" style={{ top: indicator }} data-testid="figure-drop-indicator">
          <div className="h-0.5 rounded-full bg-accent" />
        </div>
      )}
      <span className="sr-only" aria-live="polite" data-testid="figure-announcement">
        {announcement}
      </span>
    </>
  );

  const heldKeys = [...held.keys()].map(figureRowKey).join("\n");
  const pinnedKeys = useMemo(() => (heldKeys === "" ? [] : heldKeys.split("\n")), [heldKeys]);

  return {
    rows: view.rows,
    /** Figure rows the list must keep mounted (one dragged, one whose caption is edited); add them to the selection's pins. */
    pinnedKeys,
    keyOf,
    controller,
    estimate,
    rowAttributes,
    overlay,
    missing,
    dismissMissing: () => setMissing(false),
    loadFailed: figures.isError,
    retry: () => void figures.refetch(),
  };
}
