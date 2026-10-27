import { SEEK_MATCH_TOLERANCE_MS } from "../../shared/defaults.ts";
import type { TranscriptRevision, TranscriptSegment } from "./transcript.ts";

export type SegmentMapMethod = "lineage" | "overlap" | "nearest" | "none";

export interface SegmentMapping {
  segmentId: string | null;
  method: SegmentMapMethod;
}

type MapRevision = Pick<TranscriptRevision, "id" | "parentRevisionId">;
type MapSegment = Pick<TranscriptSegment, "id" | "ordinal" | "startMs" | "endMs" | "sourceSegmentIds">;

export interface SegmentMapInput {
  source: MapSegment & { revisionId: string };
  targetRevisionId: string;
  /** Every revision of the Content, by id. */
  revisions: ReadonlyMap<string, MapRevision>;
  /** Segments of one revision of the Content, in `ordinal` order. */
  segmentsOf(revisionId: string): readonly MapSegment[];
}

/**
 * "The same sentence" in another revision of the same Content: within one
 * lineage the `sourceSegmentIds` links are followed up to the common ancestor and down to
 * the target (first source when a sentence has several, lowest ordinal when it has several
 * children); across lineages, or where a link is missing (a manual edit dropped the
 * sentence), the target sentence overlapping it most in time; without any overlap, the one
 * starting nearest within `SEEK_MATCH_TOLERANCE_MS`; otherwise nothing, rather than a jump
 * to an unrelated place.
 */
export function mapSegment(input: SegmentMapInput): SegmentMapping {
  const linked = followLineage(input);
  if (linked !== undefined) {
    return { segmentId: linked, method: "lineage" };
  }
  const targets = input.segmentsOf(input.targetRevisionId);
  const { source } = input;
  let best: { segment: MapSegment; overlap: number } | undefined;
  for (const segment of targets) {
    const overlap = Math.min(segment.endMs, source.endMs) - Math.max(segment.startMs, source.startMs);
    if (overlap > 0 && (best === undefined || overlap > best.overlap || (overlap === best.overlap && segment.ordinal < best.segment.ordinal))) {
      best = { segment, overlap };
    }
  }
  if (best !== undefined) {
    return { segmentId: best.segment.id, method: "overlap" };
  }
  let nearest: { segment: MapSegment; distance: number } | undefined;
  for (const segment of targets) {
    const distance = Math.abs(segment.startMs - source.startMs);
    if (
      distance <= SEEK_MATCH_TOLERANCE_MS &&
      (nearest === undefined || distance < nearest.distance || (distance === nearest.distance && segment.ordinal < nearest.segment.ordinal))
    ) {
      nearest = { segment, distance };
    }
  }
  return nearest === undefined ? { segmentId: null, method: "none" } : { segmentId: nearest.segment.id, method: "nearest" };
}

/** The revision and its ancestors, nearest first; stops at a missing parent or a cycle. */
export function ancestry(revisionId: string, revisions: ReadonlyMap<string, MapRevision>): string[] {
  const chain: string[] = [];
  for (let id: string | undefined = revisionId; id !== undefined && !chain.includes(id); id = revisions.get(id)?.parentRevisionId) {
    if (!revisions.has(id)) {
      break;
    }
    chain.push(id);
  }
  return chain;
}

/** The target sentence reached through lineage links, or `undefined` when the revisions are unrelated or a link is missing. */
function followLineage(input: SegmentMapInput): string | undefined {
  const sourceChain = ancestry(input.source.revisionId, input.revisions);
  const targetChain = ancestry(input.targetRevisionId, input.revisions);
  const ancestor = sourceChain.find((id) => targetChain.includes(id));
  if (ancestor === undefined) {
    return undefined;
  }
  let current: MapSegment | undefined = input.source;
  for (const revisionId of sourceChain.slice(1, sourceChain.indexOf(ancestor) + 1)) {
    const parentId: string | undefined = current.sourceSegmentIds[0];
    current = parentId === undefined ? undefined : input.segmentsOf(revisionId).find((segment) => segment.id === parentId);
    if (current === undefined) {
      return undefined;
    }
  }
  const down = targetChain.slice(0, targetChain.indexOf(ancestor)).reverse();
  for (const revisionId of down) {
    const parentId: string = current.id;
    current = input.segmentsOf(revisionId).find((segment) => (segment.sourceSegmentIds as readonly string[]).includes(parentId));
    if (current === undefined) {
      return undefined;
    }
  }
  return current.id;
}
