import { createHash } from "node:crypto";
import type { SpeakerReviewDto, SpeakersConfirmedRequest } from "../../shared/dto/transcript.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import { amberError } from "../domain/errors.ts";
import type { ContentSpeaker } from "../domain/speaker.ts";
import type { TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { RepositoryScope } from "../ports/repository.ts";

/**
 * The digest of the speakers a revision names, as a review shows them: in ordinal order,
 * each by id, ordinal, name and whether the name is confirmed. Speakers that only other
 * revisions name (a comparison transcription's, say) are not part of it, so registering
 * them never makes a review of this revision stale.
 */
export function speakerRosterDigest(speakers: readonly ContentSpeaker[]): string {
  const roster = [...speakers]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((speaker) => ({
      id: speaker.id,
      ordinal: speaker.ordinal,
      ...(speaker.name === undefined ? {} : { name: speaker.name }),
      nameConfirmed: nameIsConfirmed(speaker),
    }));
  return createHash("sha256").update(canonicalJson(roster), "utf8").digest("hex");
}

/** A name counts as confirmed only while there is a name to confirm. */
export function nameIsConfirmed(speaker: Pick<ContentSpeaker, "name" | "nameConfirmedAt">): boolean {
  return speaker.name !== undefined && speaker.nameConfirmedAt !== undefined;
}

interface Reviewable {
  revision: TranscriptRevision;
  segments: TranscriptSegment[];
  /** The speakers the revision's sentences name, in ordinal order. */
  speakers: ContentSpeaker[];
}

/**
 * A revision of the owner's Content (outside the trash) whose speakers can be reviewed:
 * not a translation, which follows its source and is never reviewed on its own, and with at
 * least one sentence that names a speaker.
 */
function reviewable(scope: RepositoryScope, owner: string, revisionId: string): Reviewable {
  const revision = scope.transcripts.getRevision(owner, revisionId);
  if (revision === undefined || scope.contents.get(owner, revision.contentId) === undefined) {
    throw amberError("not_found", "transcript revision not found");
  }
  if (revision.kind === "translated") {
    throw amberError("invalid_request", "a translation has no speakers of its own to review", { params: { detail: "rid" } });
  }
  const segments = scope.transcripts.listSegments(owner, revision.id);
  const named = new Set(segments.flatMap((segment) => (segment.speakerId === undefined ? [] : [segment.speakerId])));
  if (named.size === 0) {
    throw amberError("invalid_request", "the revision names no speakers", { params: { detail: "rid" } });
  }
  const speakers = scope.speakers.list(owner, revision.contentId).filter((speaker) => named.has(speaker.id));
  return { revision, segments, speakers };
}

function reviewDto(scope: RepositoryScope, owner: string, target: Reviewable): SpeakerReviewDto {
  const { revision, segments, speakers } = target;
  const tally = new Map<string, { sentences: number; assignedMs: number }>();
  let unassigned = 0;
  for (const segment of segments) {
    if (segment.speakerId === undefined) {
      unassigned += 1;
      continue;
    }
    const entry = tally.get(segment.speakerId) ?? { sentences: 0, assignedMs: 0 };
    entry.sentences += 1;
    entry.assignedMs += segment.endMs - segment.startMs;
    tally.set(segment.speakerId, entry);
  }
  const confirmedAt = scope.speakerConfirmations.confirmedAt(owner, revision.id);
  const review = revision.generation.kind === "manual" ? revision.generation.speakerReview : undefined;
  const acceptedSuggestions = review?.acceptedSuggestions ?? 0;
  const changedFromParent = review?.changedFromParent ?? 0;
  // The Content's original-language draft is reported whatever revision it was opened from:
  // its open sentences are what the next commit will ask about, and the panel is where the
  // user decides whether to review now or after finishing the draft.
  const draft = scope.transcripts.getDraft(owner, revision.contentId);
  const draftNeedsReview = draft === undefined ? 0 : draft.segments.filter((segment) => segment.speakerReview === "needs_review").length;
  return {
    revisionId: revision.id,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    rosterDigest: speakerRosterDigest(speakers),
    speakers: [...tally].map(([id, entry]) => ({ id, sentences: entry.sentences, assignedMs: entry.assignedMs })),
    unassigned,
    pendingNames: speakers.filter((speaker) => speaker.name !== undefined && !nameIsConfirmed(speaker)).length,
    ...(acceptedSuggestions > 0 ? { acceptedSuggestions } : {}),
    ...(changedFromParent > 0 ? { changedFromParent } : {}),
    ...(draftNeedsReview > 0 ? { draftNeedsReview } : {}),
  };
}

/** `GET /transcript/revisions/:rid/speaker-review`, inside the caller's transaction. */
export function speakerReviewOf(scope: RepositoryScope, owner: string, revisionId: string): SpeakerReviewDto {
  return reviewDto(scope, owner, reviewable(scope, owner, revisionId));
}

/**
 * `PUT /transcript/revisions/:rid/speakers-confirmed`, inside the caller's transaction.
 * Confirming requires the roster digest the client was shown: a rename or a name
 * confirmation since then is `conflict.speakers_changed` and nothing is written. The
 * sentences' speakers need no such check — the revision is immutable. Confirming also
 * confirms the names of every named speaker the revision names, because the user has just
 * looked at them as part of the review; names confirmed earlier keep their time.
 * Withdrawing removes the mark and nothing else: no name, no result changes.
 */
export function setSpeakersConfirmed(scope: RepositoryScope, owner: string, revisionId: string, body: SpeakersConfirmedRequest, now: number): SpeakerReviewDto {
  const target = reviewable(scope, owner, revisionId);
  const { revision } = target;
  if (!body.confirmed) {
    scope.speakerConfirmations.set(owner, revision.contentId, revision.id, undefined);
    return reviewDto(scope, owner, target);
  }
  if (body.expectedRosterDigest !== speakerRosterDigest(target.speakers)) {
    throw amberError("conflict", "the revision's speakers changed since they were shown", { code: "conflict.speakers_changed" });
  }
  for (const speaker of target.speakers) {
    if (speaker.name !== undefined && speaker.nameConfirmedAt === undefined) {
      scope.speakers.update(owner, revision.contentId, speaker.id, { nameConfirmedAt: now }, now);
    }
  }
  // Confirming again (another window that saw the same roster) keeps when it was first confirmed.
  if (scope.speakerConfirmations.confirmedAt(owner, revision.id) === undefined) {
    scope.speakerConfirmations.set(owner, revision.contentId, revision.id, now);
  }
  return reviewDto(scope, owner, reviewable(scope, owner, revisionId));
}
