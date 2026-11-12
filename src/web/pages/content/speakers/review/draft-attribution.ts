import type { SpeakerReviewResolution } from "../../../../../shared/speakers.ts";
import type { DraftSegment } from "../../speaker-draft.ts";

/** A sentence of the revision the draft was started from. */
export interface BaseSentence {
  id: string;
  speakerId?: string;
}

/**
 * The speaker a draft sentence is committed with: the one it states (`null` = none), else
 * its first source's; a sentence still waiting for review keeps its suggestion only when the
 * suggestions are accepted, and is otherwise committed without a speaker.
 */
export function committedSpeaker(segment: DraftSegment, base: ReadonlyMap<string, BaseSentence>, resolution: SpeakerReviewResolution): string | undefined {
  let speakerId: string | undefined;
  if (segment.speakerId === undefined) {
    const first = segment.sourceSegmentIds[0];
    speakerId = first === undefined ? undefined : base.get(first)?.speakerId;
  } else {
    speakerId = segment.speakerId ?? undefined;
  }
  if (segment.speakerReview === "needs_review" && resolution !== "accept_suggestions") return undefined;
  return speakerId;
}

/** How a commit of the draft would stand against the revision it was started from. */
export interface DraftAttribution {
  /** Sentences of the base whose speaker changes, plus new sentences (no source) that name one. */
  changed: number;
  /** Whether any committed sentence names a speaker; a revision naming nobody is never marked reviewed. */
  namesSpeakers: boolean;
}

/**
 * Counts who-said-what changes between the base revision and the draft as it would be
 * committed. A base sentence counts once, however its pieces moved: it is changed when any
 * draft sentence made from it (whole, split, or merged with others) names a different speaker
 * (both unassigned is the same); a deleted sentence is not a change. A draft sentence with no
 * source that names a speaker counts too, because nobody vouched for who says it. This is the
 * same comparison the server makes before deciding whether a review carries over to the new
 * revision, so the number shown is the number the decision is about.
 */
export function draftAttribution(base: readonly BaseSentence[], draft: readonly DraftSegment[], resolution: SpeakerReviewResolution): DraftAttribution {
  const byId = new Map(base.map((sentence) => [sentence.id, sentence]));
  const descendants = new Map<string, Array<string | undefined>>();
  let unsourcedAssigned = 0;
  let namesSpeakers = false;
  for (const segment of draft) {
    const speakerId = committedSpeaker(segment, byId, resolution);
    if (speakerId !== undefined) namesSpeakers = true;
    const sources = new Set(segment.sourceSegmentIds.filter((source) => byId.has(source)));
    if (sources.size === 0 && speakerId !== undefined) unsourcedAssigned += 1;
    for (const source of sources) {
      let speakers = descendants.get(source);
      if (speakers === undefined) {
        speakers = [];
        descendants.set(source, speakers);
      }
      speakers.push(speakerId);
    }
  }
  let changed = 0;
  for (const sentence of base) {
    const speakers = descendants.get(sentence.id);
    if (speakers !== undefined && speakers.some((speakerId) => speakerId !== sentence.speakerId)) changed += 1;
  }
  return { changed: changed + unsourcedAssigned, namesSpeakers };
}
