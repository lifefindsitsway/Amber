import type { ScrollAnchor } from "./scroll-anchor.ts";
import type { DraftSegment } from "./speaker-draft.ts";

/**
 * Where the transcript editor opens and where the reader comes back to afterwards. Two records
 * are taken when 「编辑」 is clicked, each for that one editing session only: the sentence the
 * editor is to open on, and the reader's whole screen to put back once the editor closes.
 */

/** A sentence by identity and time. */
export interface SentenceRef {
  segmentId: string;
  startMs: number;
  endMs: number;
}

/** The sentence the editor is to open on, and how far below the reader's top edge it was seen. */
export interface EditTarget extends SentenceRef {
  offset: number;
  /** The playing or the clicked sentence, on screen: the editor also puts the cursor in it. */
  strong: boolean;
}

/** The reader's screen when editing started. */
export interface ReturnPosition {
  /** The revision being read. */
  revisionId: string;
  /** The first visible row and its top edge's distance from the reader's top: back in the same revision, the screen comes back to the pixel. */
  anchor: ScrollAnchor | undefined;
  /**
   * The topmost sentence on screen and its first line's distance below the reader's top
   * (negative when the sentence starts above it): back in another revision, this sentence is
   * put at that height.
   */
  top: (SentenceRef & { offset: number }) | undefined;
  /** The page's `navigation` count when editing started; any later navigation cancels the return. */
  navigation: number;
}

/** Where the editor's list opens: the row at `index` (of the draft) `offset` px below the list's top. */
export interface InitialScroll {
  index: number;
  offset: number;
  /** Put the cursor at the start of that sentence once it is in place. */
  focus: boolean;
}

/** How the editor's opening scroll ended; written on its list as `data-initial-scroll`. */
export type InitialScrollOutcome = "settled" | "edge" | "capped" | "cancelled";
export const INITIAL_SCROLL_ATTRIBUTE = "data-initial-scroll";

/** How the reader's return ended; written on the reader as `data-return-restore`. */
export type ReturnRestoreOutcome = "exact" | "approximate" | "unavailable" | "cancelled";
export const RETURN_RESTORE_ATTRIBUTE = "data-return-restore";

/** How a transcript editing session ended, as the editor reports it once, on closing. */
export type EditorCloseResult =
  | { kind: "discarded" }
  | { kind: "exited" }
  /** The primary changed meanwhile and the user chose to reload instead of committing. */
  | { kind: "reload" }
  | {
      kind: "committed";
      /** The new revision and its sentence count, as the commit returned them. */
      revisionId: string;
      segmentCount: number;
      /** The draft's base revision. */
      baseRevisionId: string;
      /** The draft exactly as committed, in order: the new revision's sentences follow it one to one. */
      committed: readonly DraftSegment[];
    };

type Locatable = Pick<DraftSegment, "id" | "startMs" | "endMs" | "sourceSegmentIds">;

function overlap(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/**
 * The draft sentence standing for `target`, by index, or `undefined` for an empty draft:
 *
 * 1. the sentence carrying the target's id;
 * 2. else, of the sentences made from it (`sourceSegmentIds`), the one overlapping it the
 *    longest, the earlier on a tie;
 * 3. else, of all sentences, the one overlapping it the longest, then the one starting
 *    nearest to it, then the earlier;
 * 4. else (nothing overlaps) the one starting nearest to it, the earlier on a tie.
 *
 * A draft's sources all belong to its base revision, so a draft based on another revision than
 * the target's never matches by 1 or 2 and is matched by time.
 */
export function locateDraftTarget(draft: readonly Locatable[], target: SentenceRef): number | undefined {
  if (draft.length === 0) return undefined;
  const byId = draft.findIndex((segment) => segment.id === target.segmentId);
  if (byId >= 0) return byId;
  let best: number | undefined;
  let bestOverlap = -1;
  draft.forEach((segment, index) => {
    if (!segment.sourceSegmentIds.includes(target.segmentId)) return;
    const shared = overlap(segment, target);
    if (shared > bestOverlap) {
      best = index;
      bestOverlap = shared;
    }
  });
  if (best !== undefined) return best;
  let bestDistance = Number.POSITIVE_INFINITY;
  bestOverlap = 0;
  draft.forEach((segment, index) => {
    const shared = overlap(segment, target);
    const distance = Math.abs(segment.startMs - target.startMs);
    if (shared > bestOverlap || (shared === bestOverlap && distance < bestDistance)) {
      best = index;
      bestOverlap = shared;
      bestDistance = distance;
    }
  });
  return best;
}
