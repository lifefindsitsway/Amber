import type { SpeakerContextState } from "../../shared/dto/speaker-context.ts";
import { ancestry } from "./segment-map.ts";
import type { SpeakerContextSnapshot } from "./speaker-context.ts";

/**
 * Comparing who said each sentence of an earlier revision ("from") with a revision derived
 * from it ("to", usually the current primary): does every sentence still belong to the
 * same speaker? Only the two ends count — a sentence moved to someone else and back is
 * unchanged — and the answer is independent of how sentences map for jumping or notes,
 * which follow other rules.
 *
 * Pure: the caller supplies the revisions and their sentences.
 */

export interface LineageRevision {
  id: string;
  parentRevisionId?: string;
}

export interface LineageSegment {
  id: string;
  speakerId?: string;
  sourceSegmentIds: readonly string[];
}

export interface SpeakerLineageInput {
  fromRevisionId: string;
  toRevisionId: string;
  /** The Content's revisions by id. */
  revisions: ReadonlyMap<string, LineageRevision>;
  /** A revision's sentences; `undefined` when they cannot be read. */
  segmentsOf: (revisionId: string) => readonly LineageSegment[] | undefined;
}

/**
 * The outcome of a comparison. `untraceable`: "from" is not reached from "to" along the
 * parents, a revision on the way or its sentences are missing, or a sentence names a source
 * that is not a sentence of its parent — nothing can be said sentence by sentence.
 */
export type SpeakerLineageComparison =
  | { kind: "untraceable" }
  | {
      kind: "compared";
      /** Sentences of "from" with a descendant in "to" that names another speaker (or none where it had one, or the reverse). */
      changed: ReadonlySet<string>;
      /** Sentences of "from" with no descendant in "to". */
      removed: ReadonlySet<string>;
      /** Sentences of "to" that name a speaker but descend from no sentence of "from". */
      unsourcedAssigned: number;
    };

/**
 * Walks every sentence of "to" through all its sources, level by level, up to "from", and
 * collects the descendants of each sentence of "from". A sentence of "from" is changed when
 * any descendant names a different speaker (both unassigned counts as the same), whether the
 * sentence was reassigned whole, split with one part reassigned, or merged with a sentence
 * of someone else; it is removed when it has no descendant at all.
 */
export function compareSpeakerLineage(input: SpeakerLineageInput): SpeakerLineageComparison {
  const from = input.segmentsOf(input.fromRevisionId);
  if (from === undefined) {
    return { kind: "untraceable" };
  }
  if (input.fromRevisionId === input.toRevisionId) {
    return { kind: "compared", changed: new Set(), removed: new Set(), unsourcedAssigned: 0 };
  }
  // `to` first, `from` last.
  const chain = ancestry(input.toRevisionId, input.revisions);
  const fromIndex = chain.indexOf(input.fromRevisionId);
  if (fromIndex <= 0) {
    return { kind: "untraceable" };
  }

  // Each sentence of the current level mapped to the sentences of "from" it descends from.
  let origins = new Map<string, ReadonlySet<string>>(from.map((segment) => [segment.id, new Set([segment.id])]));
  let to: readonly LineageSegment[] = from;
  for (let level = fromIndex - 1; level >= 0; level -= 1) {
    const segments = input.segmentsOf(chain[level] as string);
    if (segments === undefined) {
      return { kind: "untraceable" };
    }
    const next = new Map<string, ReadonlySet<string>>();
    for (const segment of segments) {
      const reached = new Set<string>();
      for (const source of segment.sourceSegmentIds) {
        const above = origins.get(source);
        if (above === undefined) {
          return { kind: "untraceable" };
        }
        for (const origin of above) reached.add(origin);
      }
      next.set(segment.id, reached);
    }
    origins = next;
    to = segments;
  }

  const descendants = new Map<string, Array<string | undefined>>();
  let unsourcedAssigned = 0;
  for (const segment of to) {
    const reached = origins.get(segment.id) ?? new Set<string>();
    if (reached.size === 0 && segment.speakerId !== undefined) {
      unsourcedAssigned += 1;
    }
    for (const origin of reached) {
      let speakers = descendants.get(origin);
      if (speakers === undefined) {
        speakers = [];
        descendants.set(origin, speakers);
      }
      speakers.push(segment.speakerId);
    }
  }
  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const segment of from) {
    const speakers = descendants.get(segment.id);
    if (speakers === undefined) {
      removed.add(segment.id);
    } else if (speakers.some((speakerId) => speakerId !== segment.speakerId)) {
      changed.add(segment.id);
    }
  }
  return { kind: "compared", changed, removed, unsourcedAssigned };
}

/**
 * How a new transcript commit changes who says what compared with a revision it descends
 * from. `changed`: sentences of `parent` that changed hands (as `compareSpeakerLineage` counts
 * them). `unsourcedAssigned`: new sentences that name a speaker without coming from any
 * sentence of `parent`. `child` sources name sentences of `parent` directly. Deleted sentences
 * count in neither.
 */
export function attributionChangeCounts(parent: readonly LineageSegment[], child: readonly LineageSegment[]): { changed: number; unsourcedAssigned: number } {
  const parentId = "parent";
  const childId = "child";
  const comparison = compareSpeakerLineage({
    fromRevisionId: parentId,
    toRevisionId: childId,
    revisions: new Map([
      [parentId, { id: parentId }],
      [childId, { id: childId, parentRevisionId: parentId }],
    ]),
    segmentsOf: (revisionId) => (revisionId === parentId ? parent : child),
  });
  // Every source of a committed sentence is a sentence of the parent, so the comparison
  // succeeds; were it ever untraceable, no sentence could be taken as unchanged.
  return comparison.kind === "compared"
    ? { changed: comparison.changed.size, unsourcedAssigned: comparison.unsourcedAssigned }
    : { changed: Math.max(parent.length, 1), unsourcedAssigned: 0 };
}

/**
 * Whether a commit can keep a review: the sentences that changed hands plus the new sentences
 * that name a speaker, since nobody reviewed who says those either. 0 means every speaker of
 * the commit is one the reviewed revision already gave.
 */
export function countAttributionChanges(parent: readonly LineageSegment[], child: readonly LineageSegment[]): number {
  const counts = attributionChangeCounts(parent, child);
  return counts.changed + counts.unsourcedAssigned;
}

/** The part of a result's speaker state that only depends on its revision and the primary. */
export interface LineageVerdict {
  state: Extract<SpeakerContextState, "attribution_changed" | "evidence_removed" | "unknown" | "consistent">;
  changedSentences: number;
  removedCitations: number;
}

/**
 * The lineage part of a result's speaker state, most severe first: sentences it read that
 * changed hands, then sentences it cites that are gone, then a comparison that cannot be
 * made. Deleting a sentence the result does not cite never counts, so clearing filler words
 * leaves results alone.
 */
export function lineageVerdict(comparison: SpeakerLineageComparison, citedSegmentIds: Iterable<string>): LineageVerdict {
  if (comparison.kind === "untraceable") {
    return { state: "unknown", changedSentences: 0, removedCitations: 0 };
  }
  const cited = new Set(citedSegmentIds);
  let removedCitations = 0;
  for (const segmentId of cited) {
    if (comparison.removed.has(segmentId)) removedCitations += 1;
  }
  const changedSentences = comparison.changed.size;
  if (changedSentences > 0) return { state: "attribution_changed", changedSentences, removedCitations };
  if (removedCitations > 0) return { state: "evidence_removed", changedSentences, removedCitations };
  if (comparison.unsourcedAssigned > 0) return { state: "unknown", changedSentences, removedCitations };
  return { state: "consistent", changedSentences, removedCitations };
}

/** A speaker of a snapshot whose label would read differently now. */
export interface RenamedSpeaker {
  id: string;
  was: string;
  now: string;
}

export interface SpeakerContextStateResult {
  state: SpeakerContextState;
  /** With `attribution_changed`. */
  changedSentences?: number;
  /** With `evidence_removed`. */
  removedCitations?: number;
  /** With `names_changed`. */
  renamed?: RenamedSpeaker[];
}

/**
 * The full speaker state of a result generated with `snapshot`, taking the first that holds:
 * the lineage verdict, then any speaker whose label would differ given the names and name
 * confirmations as they are now (`currentLabels`, by speaker id; a speaker missing from it is
 * not compared), then a current primary whose speakers are not reviewed, else consistent.
 * Nothing here is stored: it is recomputed whenever names or reviews change.
 */
export function deriveSpeakerContextState(
  verdict: LineageVerdict,
  snapshot: SpeakerContextSnapshot,
  currentLabels: ReadonlyMap<string, string>,
  primaryConfirmed: boolean,
): SpeakerContextStateResult {
  if (verdict.state === "attribution_changed") return { state: verdict.state, changedSentences: verdict.changedSentences };
  if (verdict.state === "evidence_removed") return { state: verdict.state, removedCitations: verdict.removedCitations };
  if (verdict.state === "unknown") return { state: verdict.state };
  const renamed: RenamedSpeaker[] = [];
  for (const speaker of snapshot.speakers) {
    const now = currentLabels.get(speaker.id);
    if (now !== undefined && now !== speaker.label) renamed.push({ id: speaker.id, was: speaker.label, now });
  }
  if (renamed.length > 0) return { state: "names_changed", renamed };
  if (!primaryConfirmed) return { state: "unconfirmed" };
  return { state: "consistent" };
}
