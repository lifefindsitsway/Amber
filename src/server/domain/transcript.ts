import type { TimingFidelity, TranscriptKind } from "../../shared/enums.ts";
import { isUlid, type SegmentId } from "../../shared/ids.ts";
import type { ModelRefSnapshot, PromptRef } from "./model-ref.ts";

/** Who produced a revision. */
export type TranscriptGeneration =
  | { kind: "platform"; acquisition: "guest" | "authenticated" }
  | { kind: "imported"; format: "srt" | "vtt" }
  | { kind: "asr"; asrProfileId: string; modelId: string }
  /**
   * A snapshot, so a proofread or translated revision stays explainable after its Profile is
   * gone. `promptRefs` lists every prompt version that produced the accepted text; absent on
   * revisions stored before it was recorded.
   */
  | { kind: "llm"; modelRef: ModelRefSnapshot; promptRef: PromptRef; promptRefs?: PromptRef[]; promptSnapshot: string }
  | { kind: "manual" };

/**
 * Invariant: a committed revision and its segments are immutable. Edits create a new
 * revision (Draft → Commit); nothing is rewritten in place.
 */
export interface TranscriptRevision {
  id: string;
  contentId: string;
  kind: TranscriptKind;
  /** corrected / manual / translated point at their parent; translated freshness is derived from it. */
  parentRevisionId?: string;
  /** BCP-47 tag. */
  language: string;
  timingFidelity: TimingFidelity;
  generation: TranscriptGeneration;
  segmentCount: number;
  createdAt: number;
}

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Invariant: immutable once committed; `id` is a globally unique ULID so a
 * `?segment=` deep link needs no other context. Invariant: every citable
 * segment has valid timing (`0 <= startMs < endMs`), so `startMs` / `endMs` are never nullable.
 */
export interface TranscriptSegment {
  id: SegmentId;
  revisionId: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  /** Full-text search corpus. */
  text: string;
  /** Only present on `exact_words` revisions. */
  words?: TranscriptWord[];
  speakerId?: string;
  /**
   * Semantic paragraph start, marked by the proofreading model. Absent on revisions
   * without marks; within a revision marks are all-or-nothing and the first sentence is
   * always a start, so readers tell "not a start" from "never paragraphed".
   */
  paragraphStart?: boolean;
  /** Source sentences in the parent revision: exactly one for proofreading and translation, possibly several for manual merges. */
  sourceSegmentIds: SegmentId[];
}

/** Persisted as a relation rather than a JSON array to keep lineage queries and foreign keys clean. */
export interface TranscriptSegmentSource {
  childSegmentId: SegmentId;
  parentSegmentId: SegmentId;
  position: number;
}

/** Edit-time state of a manual revision; autosaved, and turned into an immutable `manual` revision on commit. */
export interface TranscriptDraft {
  id: string;
  contentId: string;
  baseRevisionId: string;
  segments: Array<{
    /** The client's handle for the sentence across autosaves; commit always mints new segment ids. */
    id?: string;
    startMs: number;
    endMs: number;
    text: string;
    sourceSegmentIds: SegmentId[];
  }>;
  updatedAt: number;
}

/** Imported text without a timeline. Not a transcript and never eligible as primary. */
export interface ReferenceText {
  id: string;
  contentId: string;
  origin: "txt_import" | "md_import";
  text: string;
  createdAt: number;
}

/**
 * Timing precision each kind may claim. Only ASR originals carry real word timing;
 * proofreading changes words and translation has no word correspondence, so both fall
 * back to sentence timing rather than fabricating word alignment.
 */
export function timingFidelityFor(kind: TranscriptKind): TimingFidelity {
  switch (kind) {
    case "asr":
      return "exact_words";
    case "corrected":
    case "manual":
      return "inherited_segment";
    case "platform":
    case "imported":
    case "translated":
      return "segment_only";
  }
}

/** Revisions produced from a parent that maps sentence to sentence. */
const SINGLE_SOURCE_KINDS: ReadonlySet<TranscriptKind> = new Set(["corrected", "translated"]);
/** Revisions that start a lineage and therefore reference no parent sentences. */
const ROOT_KINDS: ReadonlySet<TranscriptKind> = new Set(["platform", "imported", "asr"]);

export interface TranscriptInvariantViolation {
  segmentId?: string;
  rule:
    | "segment_count_mismatch"
    | "segment_revision_mismatch"
    | "segment_id_not_ulid"
    | "invalid_timing"
    | "ordinal_not_increasing"
    | "words_without_exact_timing"
    | "source_count_mismatch"
    | "paragraph_marks_inconsistent";
}

/**
 * Checks a revision about to be committed: the segment count matches, every segment
 * belongs to the revision, has a ULID id and valid integer timing, ordinals strictly
 * increase, only `exact_words` revisions carry words, corrected and translated sentences
 * have exactly one source while root kinds have none, and paragraph marks are
 * all-or-nothing with the first sentence marked. Returns every violation found rather
 * than throwing, so callers can report them together.
 */
export function checkTranscriptInvariants(
  revision: TranscriptRevision,
  segments: readonly TranscriptSegment[],
): TranscriptInvariantViolation[] {
  const violations: TranscriptInvariantViolation[] = [];
  if (revision.segmentCount !== segments.length) {
    violations.push({ rule: "segment_count_mismatch" });
  }
  let previousOrdinal = -Infinity;
  for (const segment of segments) {
    const at = { segmentId: segment.id };
    if (segment.revisionId !== revision.id) {
      violations.push({ ...at, rule: "segment_revision_mismatch" });
    }
    if (!isUlid(segment.id)) {
      violations.push({ ...at, rule: "segment_id_not_ulid" });
    }
    if (!isValidSpan(segment.startMs, segment.endMs)) {
      violations.push({ ...at, rule: "invalid_timing" });
    }
    if (!(segment.ordinal > previousOrdinal)) {
      violations.push({ ...at, rule: "ordinal_not_increasing" });
    }
    previousOrdinal = segment.ordinal;
    if (segment.words !== undefined && revision.timingFidelity !== "exact_words") {
      violations.push({ ...at, rule: "words_without_exact_timing" });
    }
    const sources = segment.sourceSegmentIds.length;
    if (
      (SINGLE_SOURCE_KINDS.has(revision.kind) && sources !== 1) ||
      (ROOT_KINDS.has(revision.kind) && sources !== 0)
    ) {
      violations.push({ ...at, rule: "source_count_mismatch" });
    }
  }
  // Paragraph marks are all-or-nothing and the first sentence always opens a paragraph, so
  // a revision without marks is distinguishable from one whose first sentence is unmarked.
  const marked = segments.filter((segment) => segment.paragraphStart !== undefined).length;
  if (marked > 0 && (marked !== segments.length || segments[0]?.paragraphStart !== true)) {
    violations.push({ rule: "paragraph_marks_inconsistent" });
  }
  return violations;
}

/**
 * The paragraph marks a manual revision inherits from its base: a sentence
 * takes the mark of its first source sentence; when one source was split into several
 * sentences only the first of them may open a paragraph; a sentence without sources opens
 * none; the first sentence always does. A base without marks yields none, so an edit never
 * invents paragraphs the model did not see.
 */
export function inheritedParagraphStarts(
  base: ReadonlyMap<string, Pick<TranscriptSegment, "paragraphStart">>,
  drafted: ReadonlyArray<{ sourceSegmentIds: readonly string[] }>,
): Array<boolean | undefined> {
  let marked = false;
  for (const segment of base.values()) {
    marked ||= segment.paragraphStart !== undefined;
  }
  if (!marked) {
    return drafted.map(() => undefined);
  }
  let previousFirst: string | undefined;
  return drafted.map((segment, index) => {
    const first = segment.sourceSegmentIds[0];
    const inherited = first !== undefined && first !== previousFirst && base.get(first)?.paragraphStart === true;
    previousFirst = first;
    return index === 0 || inherited;
  });
}

function isValidSpan(startMs: number, endMs: number): boolean {
  return Number.isInteger(startMs) && Number.isInteger(endMs) && startMs >= 0 && startMs < endMs;
}

/**
 * Whether a newly published root revision (the subtitle stage's `platform` working copy
 * or an `asr` original) becomes primary: only when there is no
 * primary yet or the current one is itself a root working copy. Manual, imported and
 * corrected revisions are never displaced by it.
 */
export function rootRevisionTakesPrimary(currentPrimaryKind: TranscriptKind | undefined): boolean {
  return currentPrimaryKind === undefined || currentPrimaryKind === "platform" || currentPrimaryKind === "asr";
}

/**
 * Whether publishing `revision` moves the Content's primary pointer: an
 * imported or committed manual revision always takes it (manual commits check their
 * expected base separately); a corrected one only when it corrects the current primary; a
 * root revision only as `rootRevisionTakesPrimary` allows; a translation never.
 */
export function revisionTakesPrimary(
  revision: Pick<TranscriptRevision, "kind" | "parentRevisionId">,
  currentPrimary: Pick<TranscriptRevision, "id" | "kind"> | undefined,
): boolean {
  switch (revision.kind) {
    case "imported":
    case "manual":
      return true;
    case "corrected":
      return currentPrimary !== undefined && revision.parentRevisionId === currentPrimary.id;
    case "platform":
    case "asr":
      return rootRevisionTakesPrimary(currentPrimary?.kind);
    case "translated":
      return false;
  }
}

/** The kinds the pipeline keeps as evidence: they can be archived but never permanently deleted. */
export const PROTECTED_REVISION_KINDS: ReadonlySet<TranscriptKind> = new Set(["platform", "asr"]);

/**
 * What can keep a transcript revision from being deleted, by category. `history` is an
 * earlier summary, chapter or highlight revision that is no longer current and that nothing
 * builds on: it blocks like the others unless the user chooses to delete it along.
 */
export const REVISION_BLOCKER_CATEGORIES = ["children", "draft", "notes", "highlights", "chatMessages", "artifacts", "activeTasks", "history"] as const;
export type RevisionBlockerCategory = (typeof REVISION_BLOCKER_CATEGORIES)[number];
export type RevisionBlockers = Record<RevisionBlockerCategory, number>;

/**
 * One stored row that points at transcript revisions of a Content, directly or through one
 * of their sentences. `revisionIds` are the revisions it reaches (sentence references are
 * already resolved to their revision). `holderRevisionId` is set when the row is itself a
 * revision of the Content, i.e. a child: deleting it together with its parent removes the
 * reference instead of breaking it. `history` names the artifact revision of a `history`
 * reference, which a delete may remove along with the transcript revisions.
 */
export interface RevisionReference {
  category: RevisionBlockerCategory;
  revisionIds: readonly string[];
  holderRevisionId?: string;
  history?: HistoryArtifactRef;
}

/** An artifact revision only history holds (see `REVISION_BLOCKER_CATEGORIES`). */
export interface HistoryArtifactRef {
  kind: "summary" | "chapter" | "highlight";
  revisionId: string;
  /** The summary template, for summaries. */
  templateId?: string;
  createdAt: number;
}

type Lineage = Pick<TranscriptRevision, "id" | "parentRevisionId">;

export function emptyRevisionBlockers(): RevisionBlockers {
  return { children: 0, draft: 0, notes: 0, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 0 };
}

export function hasRevisionBlockers(blockers: RevisionBlockers, ignore: ReadonlySet<RevisionBlockerCategory> = new Set()): boolean {
  return REVISION_BLOCKER_CATEGORIES.some((category) => !ignore.has(category) && blockers[category] > 0);
}

/**
 * Counts, per category, the referencing rows that would be left dangling if every revision
 * in `ids` were deleted: a row counts once however many of the ids it reaches, and a child
 * revision that is itself in `ids` does not count.
 */
export function revisionBlockers(references: readonly RevisionReference[], ids: ReadonlySet<string>): RevisionBlockers {
  const blockers = emptyRevisionBlockers();
  for (const reference of references) {
    if (reference.holderRevisionId !== undefined && ids.has(reference.holderRevisionId)) {
      continue;
    }
    if (reference.revisionIds.some((id) => ids.has(id))) {
      blockers[reference.category] += 1;
    }
  }
  return blockers;
}

/** The history artifact revisions that reach any of `ids`, each once, oldest first. */
export function historyArtifactsOf(references: readonly RevisionReference[], ids: ReadonlySet<string>): HistoryArtifactRef[] {
  const found = new Map<string, HistoryArtifactRef>();
  for (const reference of references) {
    if (reference.history !== undefined && reference.revisionIds.some((id) => ids.has(id))) {
      found.set(reference.history.revisionId, reference.history);
    }
  }
  return [...found.values()].sort((a, b) => a.createdAt - b.createdAt || a.revisionId.localeCompare(b.revisionId));
}

/** Every revision derived from `rootId`, nearest first; the root itself is not included. */
export function descendantsOf(revisions: readonly Lineage[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const revision of revisions) {
    if (revision.parentRevisionId !== undefined) {
      const list = children.get(revision.parentRevisionId) ?? [];
      list.push(revision.id);
      children.set(revision.parentRevisionId, list);
    }
  }
  const found: string[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

/**
 * The order in which a set of revisions can be deleted one by one: every revision after all
 * of its descendants in the set, so no statement ever removes a parent that still has a
 * child (the parent key is checked at the end of each statement).
 */
export function deletionOrder(revisions: readonly Lineage[], ids: ReadonlySet<string>): string[] {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const depth = (id: string): number => {
    let level = 0;
    for (let parent = byId.get(id)?.parentRevisionId; parent !== undefined; parent = byId.get(parent)?.parentRevisionId) {
      level += 1;
      if (level > byId.size) break;
    }
    return level;
  };
  return [...ids].map((id) => ({ id, depth: depth(id) })).sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((entry) => entry.id);
}

/**
 * The run of manual revisions a manual commit replaces: starting from the draft's base and
 * walking up the parents, each `manual` revision joins while its only child (if any) is the
 * chain member below it and `unreferenced(id, chainWithIt)` holds; the first revision that
 * does not qualify (or is not manual) is the anchor the new revision descends from. A manual
 * revision without a parent never joins, so a non-empty chain always has an anchor. `chain`
 * lists the base first, i.e. in a safe deletion order.
 */
export function manualMergeChain(
  baseId: string,
  revisions: readonly Pick<TranscriptRevision, "id" | "parentRevisionId" | "kind">[],
  unreferenced: (revisionId: string, chain: readonly string[]) => boolean,
): { chain: string[]; anchorId: string } {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const chain: string[] = [];
  let cursor = byId.get(baseId);
  while (cursor !== undefined && cursor.kind === "manual") {
    const parent = cursor.parentRevisionId === undefined ? undefined : byId.get(cursor.parentRevisionId);
    if (parent === undefined) {
      break;
    }
    const id = cursor.id;
    const below = chain.at(-1);
    const otherChild = revisions.some((revision) => revision.parentRevisionId === id && revision.id !== below);
    if (otherChild || !unreferenced(id, [...chain, id])) {
      break;
    }
    chain.push(id);
    cursor = parent;
  }
  return { chain, anchorId: cursor?.id ?? baseId };
}

/**
 * Re-expresses sentence sources of the base through the revisions being merged away:
 * `levels[i]` maps each sentence of the i-th chain member (base first) to its own sources
 * one level up. Order is kept, repeats dropped, and a sentence whose sources have none at
 * some level ends with none.
 */
export function remapSourcesThroughChain(
  sources: readonly SegmentId[],
  levels: ReadonlyArray<ReadonlyMap<string, readonly SegmentId[]>>,
): SegmentId[] {
  let current: SegmentId[] = [...sources];
  for (const level of levels) {
    const next: SegmentId[] = [];
    const seen = new Set<string>();
    for (const source of current) {
      for (const parent of level.get(source) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    current = next;
  }
  return current;
}
