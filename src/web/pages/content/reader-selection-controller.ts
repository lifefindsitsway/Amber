import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SegmentId } from "../../../shared/ids.ts";
import { registerSelectionSource, type RegionSelection, type SelectionSource } from "../../ui/selection-source.ts";
import { domFromPoint, mountedRowKeys, pointFromDom, rowKeyAt } from "./reader-selection-dom.ts";
import { hasPoint, readSelection, samePoint, type ReaderPoint, type ReaderSelectionRead, type SelectionRow } from "./reader-selection.ts";

/**
 * Upper bound on the animation frames a selection whose nodes were replaced keeps being put
 * back over, while a row it ends in is pinned but not mounted yet.
 */
export const RESTORE_MAX_FRAMES = 30;

export interface ReaderSelectionInput {
  revisionId: string;
  /** Changes when the reader shows a different view of the text (another revision, speaker filter, speaker display): the selection does not carry over. */
  viewKey: string;
  /** The shown rows as text, in list order; a new array identity means the rows changed. */
  rows: readonly SelectionRow[];
  /** What stands for a gap bar in the explain text. */
  skipped: string;
}

export interface ReaderSelectionHandle {
  /** For `VirtualRows.scrollerRef`: the element the rows scroll in. Stable identity. */
  scrollerRef: (element: HTMLDivElement | null) => void;
  /** For `VirtualRows.pinnedKeys`: the rows holding the selection's ends (or the caret), and a row being pressed. */
  pinnedKeys: readonly string[];
  /** For the reader host's `onMouseDown`. Stable identity. */
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * The selection in reader terms, plus the nodes the browser selection had when it was last seen
 * agreeing with it: once those nodes leave the document, the rows under the selection were
 * re-rendered and the browser's own selection no longer says where the user's selection is.
 */
interface LogicalSelection {
  anchor: ReaderPoint;
  focus: ReaderPoint;
  version: number;
  anchorNode: Node;
  focusNode: Node;
}

/** A read of one version of the logical selection: what the rows say, and what consumers get. */
interface CachedRead {
  version: number;
  read: ReaderSelectionRead | undefined;
  value: RegionSelection | undefined;
}

const NO_PINS: readonly string[] = [];

function samePins(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function liveSelection(): Selection | null {
  return typeof window === "undefined" ? null : window.getSelection();
}

/**
 * Keeps the reader's own account of the selection while the windowed list mounts and unmounts
 * rows under it. The browser selection is only the interaction and the highlight; what the
 * selection's text is comes from the rows' data, so rows scrolled out of the window still count.
 */
export class ReaderSelectionController {
  private scroller: HTMLElement | null = null;
  private input: ReaderSelectionInput;
  private logical: LogicalSelection | undefined;
  /** Only grows, so a version is never handed out twice for different ranges. */
  private version = 0;
  private pins: readonly string[] = NO_PINS;
  private cache: CachedRead | undefined;
  private pointerDown = false;
  private restorePending = false;
  private restoreFrame: number | undefined;
  private restoreFrames = 0;
  private unregister: (() => void) | undefined;
  private readonly source: { current: SelectionSource } = { current: { read: () => this.read() } };

  private readonly onPins: (pins: readonly string[]) => void;

  constructor(input: ReaderSelectionInput, onPins: (pins: readonly string[]) => void) {
    this.input = input;
    this.onPins = onPins;
  }

  get pinnedKeys(): readonly string[] {
    return this.pins;
  }

  /** The current version of the logical selection, or undefined without one. */
  get selectionVersion(): number | undefined {
    return this.logical?.version;
  }

  /** Points the controller at the element the rows scroll in; null detaches it. */
  attach(element: HTMLElement | null): void {
    if (element === this.scroller) return;
    this.detach();
    if (element === null) return;
    this.scroller = element;
    document.addEventListener("selectionchange", this.handleSelectionChange);
    // Capture: the press has to be seen before anything below can stop it.
    document.addEventListener("mousedown", this.handleDocumentMouseDown, true);
    document.addEventListener("mouseup", this.handleDocumentMouseUp, true);
    // On the scroller itself: the copy event targets the element the selection starts in, and a
    // listener higher up would also see copies from inputs in popovers.
    element.addEventListener("copy", this.handleCopy);
    this.unregister = registerSelectionSource(element, this.source);
  }

  detach(): void {
    const element = this.scroller;
    if (element === null) return;
    // The list is going away with a selection in it: nothing announces that to whoever shows
    // the selection's actions, so drop the browser's ranges, which does. The rows may already be
    // out of the document, so the selection held decides, not where the browser's ranges are now.
    const held = this.logical !== undefined;
    this.clear();
    if (held) liveSelection()?.removeAllRanges();
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    document.removeEventListener("mousedown", this.handleDocumentMouseDown, true);
    document.removeEventListener("mouseup", this.handleDocumentMouseUp, true);
    element.removeEventListener("copy", this.handleCopy);
    this.unregister?.();
    this.unregister = undefined;
    this.cancelRestore();
    this.scroller = null;
    this.logical = undefined;
    this.pointerDown = false;
    this.setPins(NO_PINS);
  }

  /** Stops anything still scheduled; for the owner going away. */
  dispose(): void {
    this.cancelRestore();
  }

  /**
   * Brings the controller up to date with a commit. Runs after every render, and the player
   * re-renders the reader several times a second: when nothing changed this is identity checks
   * and two `isConnected` reads.
   */
  reconcile(input: ReaderSelectionInput): void {
    const previous = this.input;
    this.input = input;
    if (input.viewKey !== previous.viewKey) {
      this.clear();
      return;
    }
    const logical = this.logical;
    if (logical === undefined) return;
    if (input.rows !== previous.rows) {
      if (!hasPoint(input.rows, logical.anchor) || !hasPoint(input.rows, logical.focus)) {
        this.clear();
        return;
      }
      // Same ends, other rows: what lies between them may read differently now.
      this.version += 1;
      logical.version = this.version;
    }
    if (!logical.anchorNode.isConnected || !logical.focusNode.isConnected) this.restore();
  }

  /**
   * Pins the pressed row before the browser moves the selection into it, so the list cannot
   * unmount that row while a drag auto-scrolls. The rows the selection ends in stay pinned until
   * the selection itself moves: the press may extend it (Shift) or fall inside it, and a row
   * unmounted under the press takes the selection's end with it, leaving the browser nothing to
   * put a caret back from.
   */
  pressRow(button: number, target: EventTarget | null): void {
    const scroller = this.scroller;
    if (button !== 0 || scroller === null || !(target instanceof Node)) return;
    const pressed = rowKeyAt(scroller, target);
    if (pressed === undefined) return;
    const pins = this.selectionRows(scroller);
    if (!pins.includes(pressed)) pins.push(pressed);
    this.setPins(pins);
  }

  /** The selection as the reader reads it from its rows; cached per version. */
  read(): RegionSelection | undefined {
    // A read may come before the selectionchange of the selection it asks about has been
    // dispatched (the event is queued; a mouseup or a key can overtake it): catch up first.
    this.handleSelectionChange();
    const logical = this.logical;
    const scroller = this.scroller;
    if (logical === undefined || scroller === null) return undefined;
    if (this.cache?.version === logical.version) return this.cache.value;
    const { rows, skipped, revisionId } = this.input;
    const read = readSelection(rows, logical.anchor, logical.focus, { skipped });
    // Only names, times or gap labels selected: nothing an action could work on.
    if (read === undefined || read.explainText === "") {
      this.cache = { version: logical.version, read: undefined, value: undefined };
      return undefined;
    }
    const intact = this.intact(scroller, logical, read);
    const browserText = intact ? (liveSelection()?.toString() ?? "") : "";
    const value: RegionSelection = {
      version: logical.version,
      text: read.explainText,
      copyText: intact ? browserText.trim() : read.copyText,
      menuCopyText: intact ? browserText : read.copyText,
      sentenceCount: read.sentenceCount,
      crossesGap: read.crossesGap,
    };
    if (read.quote !== undefined) value.quote = { transcriptRevisionId: revisionId, segmentId: read.quote.id as SegmentId, text: read.quote.text };
    if (read.bounds !== undefined) value.bounds = { revisionId, ...read.bounds };
    this.cache = { version: logical.version, read, value };
    return value;
  }

  private readonly handleSelectionChange = (): void => {
    const scroller = this.scroller;
    if (scroller === null) return;
    const logical = this.logical;
    if (this.restorePending || (logical !== undefined && !this.pointerDown && (!logical.anchorNode.isConnected || !logical.focusNode.isConnected))) {
      // The nodes under the selection were replaced: whatever the browser made of its selection
      // then says nothing about the user's. Put the logical one back instead.
      this.restore();
      return;
    }
    const selection = liveSelection();
    const anchorNode = selection?.anchorNode ?? null;
    const focusNode = selection?.focusNode ?? null;
    if (selection == null || anchorNode === null || focusNode === null) {
      this.setLogical(undefined);
      this.setPins(NO_PINS);
      return;
    }
    const anchor = pointFromDom(scroller, anchorNode, selection.anchorOffset);
    const focus = pointFromDom(scroller, focusNode, selection.focusOffset);
    this.setPins(this.selectionRows(scroller));
    // A caret keeps its row pinned (above) but is no selection: a later Shift+click far away
    // still finds the row the selection starts in mounted.
    if (anchor === undefined || focus === undefined || selection.isCollapsed) {
      this.setLogical(undefined);
      return;
    }
    if (logical !== undefined && samePoint(anchor, logical.anchor) && samePoint(focus, logical.focus)) {
      // A released modifier, a context menu or a copy that moved the selection away and back:
      // the same selection, so consumers keep what they read of it.
      logical.anchorNode = anchorNode;
      logical.focusNode = focusNode;
      return;
    }
    this.version += 1;
    this.setLogical({ anchor, focus, version: this.version, anchorNode, focusNode });
  };

  private readonly handleDocumentMouseDown = (): void => {
    this.pointerDown = true;
    if (this.restorePending) {
      // The user is making a new selection; the old one is not coming back.
      this.cancelRestore();
      this.logical = undefined;
    }
  };

  private readonly handleDocumentMouseUp = (): void => {
    this.pointerDown = false;
  };

  private readonly handleCopy = (event: ClipboardEvent): void => {
    const logical = this.logical;
    const scroller = this.scroller;
    if (logical === undefined || scroller === null) return;
    const region = this.read();
    const read = this.cache?.version === logical.version ? this.cache.read : undefined;
    if (region === undefined || read === undefined) return;
    // The browser copies a selection it holds in full correctly, its HTML included.
    if (this.intact(scroller, logical, read)) return;
    // Synchronously: the clipboard data can only be written while the event is dispatched.
    event.clipboardData?.setData("text/plain", region.menuCopyText);
    event.preventDefault();
  };

  /**
   * Whether the browser's own selection is the logical one and holds all of it: both ends map
   * to the logical points and every row the selection covers is mounted.
   */
  private intact(scroller: HTMLElement, logical: LogicalSelection, read: ReaderSelectionRead): boolean {
    const selection = liveSelection();
    if (selection == null || selection.anchorNode === null || selection.focusNode === null) return false;
    const anchor = pointFromDom(scroller, selection.anchorNode, selection.anchorOffset);
    const focus = pointFromDom(scroller, selection.focusNode, selection.focusOffset);
    if (anchor === undefined || focus === undefined || !samePoint(anchor, logical.anchor) || !samePoint(focus, logical.focus)) return false;
    const covered = read.lastRow - read.firstRow + 1;
    const mounted = mountedRowKeys(scroller);
    if (covered > mounted.size) return false;
    return this.input.rows.slice(read.firstRow, read.lastRow + 1).every((row) => mounted.has(row.key));
  }

  /** The rows the browser selection's ends are in, anchor first, for the ends inside the scroller. */
  private selectionRows(scroller: HTMLElement): string[] {
    const selection = liveSelection();
    const rows: string[] = [];
    if (selection == null) return rows;
    const anchor = selection.anchorNode === null ? undefined : pointFromDom(scroller, selection.anchorNode, selection.anchorOffset)?.rowKey;
    const focus = selection.focusNode === null ? undefined : pointFromDom(scroller, selection.focusNode, selection.focusOffset)?.rowKey;
    if (anchor !== undefined) rows.push(anchor);
    if (focus !== undefined && focus !== anchor) rows.push(focus);
    return rows;
  }

  /** Puts the browser selection back where the logical one is, over later frames when a row is not mounted yet. */
  private restore(): void {
    const logical = this.logical;
    const scroller = this.scroller;
    if (logical === undefined || scroller === null) {
      this.cancelRestore();
      return;
    }
    const selection = liveSelection();
    if (selection === null || selection.rangeCount === 0) {
      // Replaced nodes move the browser's range, they never remove it: with none left, the
      // selection was dropped on purpose (an action finished with it) and must not come back.
      this.cancelRestore();
      this.logical = undefined;
      this.setPins(NO_PINS);
      return;
    }
    const anchor = domFromPoint(scroller, logical.anchor);
    const focus = domFromPoint(scroller, logical.focus);
    if (anchor !== undefined && focus !== undefined) {
      this.cancelRestore();
      // Remembered first, so the selectionchange this causes finds the same points on live nodes
      // and keeps the version: it is the same selection.
      logical.anchorNode = anchor.node;
      logical.focusNode = focus.node;
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      return;
    }
    if (!this.restorePending) {
      this.restorePending = true;
      this.restoreFrames = 0;
    }
    if (this.restoreFrame === undefined) this.restoreFrame = requestAnimationFrame(this.restoreOnFrame);
  }

  private readonly restoreOnFrame = (): void => {
    this.restoreFrame = undefined;
    if (!this.restorePending) return;
    this.restoreFrames += 1;
    this.restore();
    if (this.restorePending && this.restoreFrames >= RESTORE_MAX_FRAMES) this.clear();
  };

  private cancelRestore(): void {
    if (this.restoreFrame !== undefined) cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = undefined;
    this.restorePending = false;
    this.restoreFrames = 0;
  }

  /**
   * Drops the selection. A browser selection inside the scroller goes too: its text belongs to
   * a view that is gone, and the toolbar closes on the collapse.
   */
  private clear(): void {
    this.cancelRestore();
    this.logical = undefined;
    this.setPins(NO_PINS);
    const scroller = this.scroller;
    const selection = liveSelection();
    if (scroller === null || selection == null) return;
    const inside = (node: Node | null): boolean => node !== null && scroller.contains(node);
    if (inside(selection.anchorNode) || inside(selection.focusNode)) selection.removeAllRanges();
  }

  private setLogical(logical: LogicalSelection | undefined): void {
    if (logical !== undefined) this.cancelRestore();
    this.logical = logical;
  }

  private setPins(pins: readonly string[]): void {
    if (samePins(pins, this.pins)) return;
    this.pins = pins.length === 0 ? NO_PINS : pins;
    this.onPins(this.pins);
  }
}

/** The reader's logical selection, wired to the windowed list and the host element. */
export function useReaderSelection(input: ReaderSelectionInput): ReaderSelectionHandle {
  const [pinnedKeys, setPinnedKeys] = useState<readonly string[]>(NO_PINS);
  const controllerRef = useRef<ReaderSelectionController | undefined>(undefined);
  controllerRef.current ??= new ReaderSelectionController(input, setPinnedKeys);
  const controller = controllerRef.current;
  useLayoutEffect(() => {
    controller.reconcile(input);
  });
  useEffect(() => () => controller.dispose(), [controller]);
  const scrollerRef = useCallback((element: HTMLDivElement | null) => controller.attach(element), [controller]);
  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => controller.pressRow(event.button, event.target), [controller]);
  return useMemo(() => ({ scrollerRef, pinnedKeys, onMouseDown }), [scrollerRef, pinnedKeys, onMouseDown]);
}
