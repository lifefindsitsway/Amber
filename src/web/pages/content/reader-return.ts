import { locateDraftTarget, type EditTarget, type ReturnPosition, type SentenceRef } from "./edit-position.ts";
import { captureAnchor } from "./scroll-anchor.ts";
import type { DraftSegment } from "./speaker-draft.ts";
import type { FilteredRow } from "./speaker-filter.ts";
import { firstLineRect } from "./virtual-rows.tsx";

interface TimedSentence {
  id: string;
  startMs: number;
  endMs: number;
}

/** A sentence element as the reader shows it, measured against the scroller's visible box. */
interface SeenSentence {
  ref: SentenceRef;
  onScreen: boolean;
  firstLineFullyVisible: boolean;
  /** Its first line's top below the scroller's top; negative when it starts above. */
  offset: number;
}

/** The rects a sentence takes on screen: one per line it wraps over, empty ones left out. */
function linesOf(element: Element): DOMRect[] {
  const lines = Array.from(element.getClientRects()).filter((rect) => rect.height > 0);
  if (lines.length > 0) return lines;
  const box = element.getBoundingClientRect();
  return box.height > 0 ? [box] : [];
}

function seenSentences(scroller: HTMLElement, byId: ReadonlyMap<string, TimedSentence>): SeenSentence[] {
  const view = scroller.getBoundingClientRect();
  const seen: SeenSentence[] = [];
  for (const element of Array.from(scroller.querySelectorAll("[data-segment-id]"))) {
    const sentence = byId.get(element.getAttribute("data-segment-id") ?? "");
    // An element of another revision, or a hidden one, cannot stand for a place in this one.
    const lines = linesOf(element);
    if (sentence === undefined || lines.length === 0) continue;
    const first = firstLineRect(element);
    seen.push({
      ref: { segmentId: sentence.id, startMs: sentence.startMs, endMs: sentence.endMs },
      onScreen: lines.some((line) => line.bottom > view.top && line.top < view.bottom),
      firstLineFullyVisible: first.top >= view.top && first.bottom <= view.bottom,
      offset: first.top - view.top,
    });
  }
  return seen;
}

/**
 * Taken when 「编辑」 is clicked: the sentence the editor is to open on, and the reader's screen
 * to put back once it closes. Read off the layout, as the user saw it.
 *
 * The target is the first of: the playing sentence, on screen (strong); with no playback time
 * known, the last clicked sentence, on screen (strong); the first sentence on screen whose first
 * line is wholly visible, else the first one partly visible (weak); none when no sentence is on
 * screen. While the player reports a time the clicked sentence is passed over: the user's
 * attention follows playback, and a click may be long stale.
 */
export function captureEditEntry(
  scroller: HTMLElement,
  input: {
    revisionId: string;
    navigation: number;
    segments: ReadonlyArray<TimedSentence>;
    playback: { known: true; currentId: string | undefined } | { known: false };
    clickedId: string | undefined;
  },
): { target: EditTarget | undefined; back: ReturnPosition } {
  const byId = new Map(input.segments.map((segment) => [segment.id, segment]));
  const onScreen = seenSentences(scroller, byId).filter((sentence) => sentence.onScreen);
  const strongId = input.playback.known ? input.playback.currentId : input.clickedId;
  const strong = strongId === undefined ? undefined : onScreen.find((sentence) => sentence.ref.segmentId === strongId);
  const weak = onScreen.find((sentence) => sentence.firstLineFullyVisible) ?? onScreen[0];
  const chosen = strong ?? weak;
  const target: EditTarget | undefined = chosen === undefined ? undefined : { ...chosen.ref, offset: chosen.offset, strong: strong !== undefined };
  const top = onScreen[0];
  return {
    target,
    back: {
      revisionId: input.revisionId,
      anchor: captureAnchor(scroller),
      top: top === undefined ? undefined : { ...top.ref, offset: top.offset },
      navigation: input.navigation,
    },
  };
}

function overlap(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/**
 * The candidate standing for `ref` by time: the one overlapping it the longest, then the one
 * starting nearest to it, then the earlier. `undefined` for no candidates.
 */
export function nearestByTime(candidates: ReadonlyArray<TimedSentence>, ref: { startMs: number; endMs: number }): string | undefined {
  let best: string | undefined;
  let bestOverlap = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const shared = overlap(candidate, ref);
    const distance = Math.abs(candidate.startMs - ref.startMs);
    if (shared > bestOverlap || (shared === bestOverlap && distance < bestDistance)) {
      best = candidate.id;
      bestOverlap = shared;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * After a commit: the new revision's sentence standing for `ref`. The new revision is written
 * one sentence per draft sentence, in draft order, with the draft's times, so the draft sentence
 * standing for `ref` maps to the new sentence at the same index, exactly. When the new revision
 * does not line up with the draft (another count, other times), the sentence is found by time
 * and the result is approximate.
 */
export function mapAfterCommit(input: {
  committed: ReadonlyArray<DraftSegment>;
  next: ReadonlyArray<TimedSentence>;
  ref: SentenceRef;
}): { segmentId: string; approximate: boolean } | undefined {
  const { committed, next, ref } = input;
  if (next.length === 0) return undefined;
  const index = locateDraftTarget(committed, ref);
  const draft = index === undefined ? undefined : committed[index];
  const counterpart = index === undefined ? undefined : next[index];
  if (draft !== undefined && counterpart !== undefined && next.length === committed.length && counterpart.startMs === draft.startMs && counterpart.endMs === draft.endMs) {
    // Exact only when the draft still holds that sentence (by id or as a source); one deleted in
    // the draft was stood in for by time, and the place is only near it.
    const kept = draft.id === ref.segmentId || draft.sourceSegmentIds.includes(ref.segmentId);
    return { segmentId: counterpart.id, approximate: !kept };
  }
  const id = nearestByTime(next, draft ?? ref);
  return id === undefined ? undefined : { segmentId: id, approximate: true };
}

/**
 * With the speaker filter on: the shown sentence nearest in time to `ref`, so a sentence the
 * filter hides is stood in for by its nearest shown neighbour. Only paragraph rows hold
 * sentences; gap and chapter rows are skipped. `undefined` when no sentence is shown.
 */
export function nearestShownSentence(rows: readonly FilteredRow[], ref: { startMs: number; endMs: number }): string | undefined {
  const shown: TimedSentence[] = [];
  for (const row of rows) if (row.kind === "paragraph") shown.push(...row.paragraph.segments);
  return nearestByTime(shown, ref);
}
