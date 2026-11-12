import type { TranscriptDraftRequest } from "../../../shared/dto/transcript.ts";
import type { AlignedSentence } from "../../../shared/speaker-align.ts";
import type { AttributionDifferenceKind } from "../../../shared/speaker-compare.ts";

/** One sentence of the transcript draft, as the draft API stores it. */
export type DraftSegment = TranscriptDraftRequest["segments"][number];

/** The handle of a draft sentence across edits: its id, else its position (drafts the server saved always carry ids). */
export const draftKey = (segment: DraftSegment, index: number): string => segment.id ?? `new-${index}`;

/** The speaker of each base-revision sentence, for drafts saved before they stated speakers themselves. */
export type BaseSpeakers = ReadonlyMap<string, string | undefined>;

/**
 * Who a draft sentence belongs to as the commit will read it: its own `speakerId` when the
 * draft states one (`null` = unassigned), else the speaker of its first source sentence.
 */
export function effectiveSpeaker(segment: DraftSegment, base: BaseSpeakers | undefined): string | null {
  if (segment.speakerId !== undefined) return segment.speakerId;
  const first = segment.sourceSegmentIds[0];
  return (first === undefined ? undefined : base?.get(first)) ?? null;
}

export function effectiveSpeakers(segments: readonly DraftSegment[], base: BaseSpeakers | undefined): Array<string | null> {
  return segments.map((segment) => effectiveSpeaker(segment, base));
}

/** The sentence with its speaker settled by the user: stated explicitly, and no longer waiting for review. */
function settled(segment: DraftSegment, speakerId: string | null): DraftSegment {
  const { speakerReview: _review, ...rest } = segment;
  void _review;
  return { ...rest, speakerId };
}

/**
 * Gives the sentences at `indices` this speaker (`null` = unassigned) and clears their review
 * mark: choosing is the user's confirmation. Returns the same array when nothing changes, so a
 * caller can skip an empty undo step.
 */
export function assignSpeaker(segments: readonly DraftSegment[], indices: Iterable<number>, speakerId: string | null): readonly DraftSegment[] {
  let next: DraftSegment[] | undefined;
  for (const index of indices) {
    const segment = (next ?? segments)[index];
    if (segment === undefined || (segment.speakerId === speakerId && segment.speakerReview === undefined)) continue;
    next ??= [...segments];
    next[index] = settled(segment, speakerId);
  }
  return next ?? segments;
}

/** Gives every sentence of `from` to `to`; the draft only, the speaker itself stays. */
export function mergeSpeaker(segments: readonly DraftSegment[], resolved: ReadonlyArray<string | null>, from: string, to: string): readonly DraftSegment[] {
  const indices: number[] = [];
  resolved.forEach((speakerId, index) => {
    if (speakerId === from) indices.push(index);
  });
  return from === to ? segments : assignSpeaker(segments, indices, to);
}

/** What a split needs: where in the text and in time, who each half is, and the id the right half takes. */
export interface SplitRequest {
  /** UTF-16 offset into the sentence's text; both halves must keep some text. */
  offset: number;
  atMs: number;
  leftSpeakerId: string | null;
  rightSpeakerId: string | null;
  /**
   * Whether the user picked that half's speaker in the split itself. A half of a sentence
   * still waiting for review stays waiting unless its speaker was chosen on purpose.
   */
  leftChosen: boolean;
  rightChosen: boolean;
  newId: () => string;
}

/**
 * Cuts one sentence in two at a point in its text and in time: the left half keeps the id and
 * the start, the right takes the end. Both state their speaker and point at the same source
 * sentences as the original, so a commit maps both back to it. A sentence waiting for review
 * hands that on to each half whose speaker the user did not choose; any other review mark is
 * dropped. `undefined`
 * when the cut leaves a half without text or time.
 */
export function splitSegment(segments: readonly DraftSegment[], index: number, request: SplitRequest): { segments: DraftSegment[]; leftKey: string; rightKey: string } | undefined {
  const segment = segments[index];
  if (segment === undefined) return undefined;
  const left = segment.text.slice(0, request.offset).trimEnd();
  const right = segment.text.slice(request.offset).trimStart();
  if (left === "" || right === "" || !(request.atMs > segment.startMs && request.atMs < segment.endMs)) return undefined;
  const { speakerReview: _review, ...rest } = segment;
  void _review;
  const waiting = segment.speakerReview === "needs_review";
  const review = (chosen: boolean): Pick<DraftSegment, "speakerReview"> => (waiting && !chosen ? { speakerReview: "needs_review" } : {});
  const leftId = segment.id ?? request.newId();
  const rightId = request.newId();
  const halves: DraftSegment[] = [
    { ...rest, id: leftId, endMs: request.atMs, text: left, speakerId: request.leftSpeakerId, ...review(request.leftChosen) },
    { ...rest, id: rightId, startMs: request.atMs, text: right, speakerId: request.rightSpeakerId, ...review(request.rightChosen) },
  ];
  const next = [...segments];
  next.splice(index, 1, ...halves);
  return { segments: next, leftKey: leftId, rightKey: rightId };
}

/** What applying the alignment did: the new draft, which sentences got another speaker, and where speakers change inside the unsure ones. */
export interface AppliedAlignment {
  segments: DraftSegment[];
  changedKeys: Set<string>;
  /** Per sentence key, the time inside it where the source's speaker changes. */
  changeAt: Map<string, number>;
  /** Sentences left waiting for the user to confirm their speaker. */
  reviewCount: number;
  /** Sentences matched without review. */
  autoCount: number;
}

/**
 * Writes an alignment onto the draft: every sentence states its speaker, and review marks
 * follow the alignment (`auto`, `needs_review`; an unassigned sentence has none). `aligned`
 * is in draft order. A sentence counts as changed when the speaker it reads as differs.
 */
export function applyAlignment(segments: readonly DraftSegment[], resolved: ReadonlyArray<string | null>, aligned: readonly AlignedSentence[]): AppliedAlignment {
  const changedKeys = new Set<string>();
  const changeAt = new Map<string, number>();
  let reviewCount = 0;
  let autoCount = 0;
  const next = segments.map((segment, index) => {
    const result = aligned[index];
    const key = draftKey(segment, index);
    const speakerId = result?.speakerId ?? null;
    const { speakerReview: _review, ...rest } = segment;
    void _review;
    if (speakerId !== resolved[index]) changedKeys.add(key);
    // A suggestion without a speaker is nothing to confirm.
    const review = speakerId === null ? undefined : result?.review;
    if (review === "auto") autoCount += 1;
    if (review === "needs_review") {
      reviewCount += 1;
      if (result?.changeAtMs !== undefined) changeAt.set(key, result.changeAtMs);
    }
    return { ...rest, speakerId, ...(review === undefined ? {} : { speakerReview: review }) };
  });
  return { segments: next, changedKeys, changeAt, reviewCount, autoCount };
}

/** Which sentences the editor shows. */
export type SpeakerFilter =
  | { kind: "all" }
  | { kind: "speaker"; speakerId: string }
  | { kind: "review" }
  | { kind: "unassigned" }
  | { kind: "changed" }
  /** The rows a cross-recognition category lists, by row key; `category` names it. */
  | { kind: "keys"; keys: ReadonlySet<string>; category: AttributionDifferenceKind };

export const FILTER_ALL: SpeakerFilter = { kind: "all" };

export const sameFilter = (a: SpeakerFilter, b: SpeakerFilter): boolean =>
  a.kind === b.kind && (a.kind !== "speaker" || (b.kind === "speaker" && a.speakerId === b.speakerId)) && (a.kind !== "keys" || (b.kind === "keys" && a.keys === b.keys));

function matches(filter: SpeakerFilter, segment: DraftSegment, speakerId: string | null, key: string, changed: ReadonlySet<string>): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "speaker":
      return speakerId === filter.speakerId;
    case "review":
      return segment.speakerReview === "needs_review";
    case "unassigned":
      return speakerId === null;
    case "changed":
      return changed.has(key);
    case "keys":
      return filter.keys.has(key);
  }
}

/** Original indices of the sentences a filter shows; `undefined` for all of them, the editor's "no filter". */
export function filterVisible(segments: readonly DraftSegment[], resolved: ReadonlyArray<string | null>, filter: SpeakerFilter, changed: ReadonlySet<string>): Set<number> | undefined {
  if (filter.kind === "all") return undefined;
  const shown = new Set<number>();
  segments.forEach((segment, index) => {
    if (matches(filter, segment, resolved[index] ?? null, draftKey(segment, index), changed)) shown.add(index);
  });
  return shown;
}

export interface FilterCounts {
  all: number;
  review: number;
  unassigned: number;
  changed: number;
  bySpeaker: Map<string, number>;
}

export function filterCounts(segments: readonly DraftSegment[], resolved: ReadonlyArray<string | null>, changed: ReadonlySet<string>): FilterCounts {
  const counts: FilterCounts = { all: segments.length, review: 0, unassigned: 0, changed: 0, bySpeaker: new Map() };
  segments.forEach((segment, index) => {
    const speakerId = resolved[index] ?? null;
    if (segment.speakerReview === "needs_review") counts.review += 1;
    if (changed.has(draftKey(segment, index))) counts.changed += 1;
    if (speakerId === null) counts.unassigned += 1;
    else counts.bySpeaker.set(speakerId, (counts.bySpeaker.get(speakerId) ?? 0) + 1);
  });
  return counts;
}

/**
 * The sentences between two (original) indices, inclusive in either order, that are shown:
 * a range selected over a filtered draft covers what the user sees, not what is hidden.
 */
export function visibleRange(a: number, b: number, visible: ReadonlySet<number> | undefined, length: number): number[] {
  const from = Math.max(0, Math.min(a, b));
  const to = Math.min(length - 1, Math.max(a, b));
  const range: number[] = [];
  for (let index = from; index <= to; index += 1) {
    if (visible === undefined || visible.has(index)) range.push(index);
  }
  return range;
}

/** How many different speakers a list of sentences names. */
export function speakerCountOf(segments: ReadonlyArray<{ speakerId?: string | null | undefined }>): number {
  return new Set(segments.flatMap((segment) => (typeof segment.speakerId === "string" ? [segment.speakerId] : []))).size;
}
