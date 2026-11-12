import { monotonicFactory } from "ulid";
import type {
  DraftCommitRequest,
  SegmentMapDto,
  TranscriptDraftDto,
  TranscriptDraftRequest,
  TranscriptSegmentDto,
  TranscriptSegmentPageDto,
} from "../../shared/dto/transcript.ts";
import type { TranscriptRevisionDto, TranscriptRevisionListItemDto } from "../../shared/dto/content.ts";
import type { SegmentId } from "../../shared/ids.ts";
import type { Content } from "../domain/content.ts";
import { isComparisonRevision, isPermanentRevision, isRecyclableSpeaker } from "../domain/comparison-revision.ts";
import { amberError } from "../domain/errors.ts";
import { mapSegment } from "../domain/segment-map.ts";
import { attributionChangeCounts, countAttributionChanges } from "../domain/speaker-lineage.ts";
import {
  deletionOrder,
  descendantsOf,
  emptyRevisionBlockers,
  hasRevisionBlockers,
  historyArtifactsOf,
  inheritedParagraphStarts,
  manualMergeChain,
  remapSourcesThroughChain,
  revisionBlockers,
  timingFidelityFor,
  type RevisionBlockerCategory,
  type TranscriptDraft,
  type TranscriptRevision,
  type TranscriptSegment,
} from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { transcriptRevisionDto } from "./contents.ts";
import { revisionListItems } from "./revision-references.ts";

/** The draft being committed is the one that disappears with the commit, so it never blocks merging its base. */
const MERGE_IGNORES: ReadonlySet<RevisionBlockerCategory> = new Set(["draft"]);
/** What a delete with `withHistory` removes instead of being blocked by. */
const HISTORY_ONLY: ReadonlySet<RevisionBlockerCategory> = new Set(["history"]);

export interface TranscriptServiceOptions {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

export function transcriptSegmentDto(segment: TranscriptSegment): TranscriptSegmentDto {
  return {
    id: segment.id,
    revisionId: segment.revisionId,
    ordinal: segment.ordinal,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    ...(segment.words === undefined ? {} : { words: segment.words.map((word) => ({ ...word })) }),
    ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
    ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
    sourceSegmentIds: [...segment.sourceSegmentIds],
  };
}

function draftDto(draft: TranscriptDraft): TranscriptDraftDto {
  return {
    id: draft.id,
    contentId: draft.contentId,
    baseRevisionId: draft.baseRevisionId,
    version: draft.version,
    segments: draft.segments.map((segment) => ({
      ...(segment.id === undefined ? {} : { id: segment.id }),
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      sourceSegmentIds: [...segment.sourceSegmentIds],
      ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
      ...(segment.speakerReview === undefined ? {} : { speakerReview: segment.speakerReview }),
    })),
    updatedAt: draft.updatedAt,
  };
}

function encodeCursor(ordinal: number): string {
  return Buffer.from(JSON.stringify([ordinal])).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const [ordinal] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof ordinal === "number" && Number.isInteger(ordinal)) {
      return ordinal;
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

/**
 * A draft write, discard or commit named a version that is not the stored one: another window
 * saved since, or the draft was committed or discarded (`currentVersion` null, sent as no
 * `details.currentVersion` since error details carry no nulls). Nothing is overwritten or
 * recreated.
 */
export function draftChanged(currentVersion: number | null): never {
  throw amberError("conflict", "the draft changed since this version", {
    code: "conflict.draft_changed",
    ...(currentVersion === null ? {} : { details: { currentVersion } }),
  });
}

function invalidDraft(detail: string, reason: string): never {
  throw amberError("invalid_request", `draft cannot be committed: ${reason}`, { params: { detail } });
}

/**
 * Reading transcript segments, the Draft → Commit cycle of manual revisions and the
 * "same sentence" mapping between revisions. Every read
 * and write is scoped to the principal; another user's ids are `not_found`.
 */
export class TranscriptService {
  private readonly options: TranscriptServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: TranscriptServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /** One page of a revision's segments in `ordinal` order; the cursor is the last ordinal seen. */
  segments(principal: RequestPrincipal, revisionId: string, page: { limit: number; cursor?: string }): TranscriptSegmentPageDto {
    const owner = principal.userId;
    const afterOrdinal = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    return this.options.repository.withTransaction((scope) => {
      const revision = scope.transcripts.getRevision(owner, revisionId);
      if (revision === undefined || scope.contents.get(owner, revision.contentId) === undefined) {
        throw amberError("not_found", "transcript revision not found");
      }
      const segments = scope.transcripts.listSegments(owner, revisionId, {
        ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
        limit: page.limit + 1,
      });
      const items = segments.slice(0, page.limit);
      const last = items.at(-1);
      return {
        revision: transcriptRevisionDto(revision),
        items: items.map(transcriptSegmentDto),
        ...(segments.length > page.limit && last !== undefined ? { nextCursor: encodeCursor(last.ordinal) } : {}),
      };
    });
  }

  getDraft(principal: RequestPrincipal, contentId: string): TranscriptDraftDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const draft = scope.transcripts.getDraft(owner, contentId);
      if (draft === undefined) {
        throw amberError("not_found", "no draft for this content");
      }
      return draftDto(draft);
    });
  }

  /**
   * Autosave: replaces the Content's single draft, but only at the version the editor last
   * saw (`null`: there must be no draft yet), so a second window or a save arriving after a
   * commit or discard is refused instead of overwriting or reviving the draft. Only the shape
   * and the base revision are checked here; timing, sources and speakers are checked when the
   * draft is committed, so a draft may pass through intermediate states while it is being
   * edited. Speaker fields are stored exactly as sent.
   */
  putDraft(principal: RequestPrincipal, contentId: string, body: TranscriptDraftRequest): TranscriptDraftDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      editableBase(scope, owner, contentId, body.baseRevisionId);
      const draft: TranscriptDraft = {
        id: this.newId(),
        contentId,
        baseRevisionId: body.baseRevisionId,
        version: (body.expectedVersion ?? 0) + 1,
        segments: body.segments.map((segment) => ({
          ...(segment.id === undefined ? {} : { id: segment.id }),
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          sourceSegmentIds: segment.sourceSegmentIds as SegmentId[],
          ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
          ...(segment.speakerReview === undefined ? {} : { speakerReview: segment.speakerReview }),
        })),
        updatedAt: this.now(),
      };
      const result = scope.transcripts.putDraft(owner, draft, body.expectedVersion);
      if (!("written" in result)) {
        draftChanged(result.currentVersion);
      }
      return draftDto(result.written);
    });
  }

  /**
   * Commit: the draft becomes an immutable `manual` revision whose
   * parent is the draft's base, and the new primary — but only when the client saw the
   * primary that is current now. A different primary means someone switched it after the
   * editor was opened; that is a conflict for the user to resolve, never a silent
   * overwrite. The draft must still be at `draftVersion`, so what is committed is what the
   * editor last saved. Revision, primary pointer and draft removal commit together.
   *
   * Speakers: a sentence takes the speaker its draft names (`null` = unassigned); a draft
   * saved before drafts carried speakers has none named, and the sentence keeps its first
   * source's speaker. Every named speaker must belong to this Content. A sentence still
   * waiting for review keeps its suggested speaker only when the request accepts the
   * suggestions (counted in the revision's generation); otherwise it is committed unassigned,
   * so an unconfirmed speaker never passes for a confirmed one.
   *
   * Speaker review: the new revision is reviewed only if its base is. The base is what the
   * user reviewed and edited, so the new revision inherits the mark by itself when no sentence
   * changes hands compared with the base — even when the base is folded away below, which only
   * tidies the history; otherwise only when the request keeps it (`speakersConfirmed: true`),
   * which an unreviewed base refuses. A revision in which no sentence names a speaker is never
   * marked, whatever the request says. Sentences still waiting for review are compared as they
   * are committed (suggested or unassigned). Separately, the revision records how many
   * sentences changed hands compared with its parent (the anchor, when revisions are folded),
   * for the history only; the two counts answer different questions and are never mixed.
   */
  commitDraft(principal: RequestPrincipal, contentId: string, body: DraftCommitRequest): TranscriptRevisionDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = ownedContent(scope, owner, contentId);
      const draft = scope.transcripts.getDraft(owner, contentId);
      if (draft?.version !== body.draftVersion) {
        draftChanged(draft?.version ?? null);
      }
      const current = content.primaryTranscriptRevisionId;
      if (body.expectedPrimaryRevisionId !== current) {
        throw amberError("conflict", "the primary transcript changed since the draft was opened", {
          code: "conflict.primary_changed",
          ...(current === undefined ? {} : { details: { currentPrimaryRevisionId: current } }),
        });
      }
      const base = editableBase(scope, owner, contentId, draft.baseRevisionId);
      const baseSegments = new Map(scope.transcripts.listSegments(owner, base.id).map((segment) => [segment.id as string, segment]));
      if (draft.segments.length === 0) {
        invalidDraft("segments", "a revision needs at least one segment");
      }
      const baseConfirmedAt = scope.speakerConfirmations.confirmedAt(owner, base.id);
      if (body.speakersConfirmed === true && baseConfirmedAt === undefined) {
        invalidDraft("speakersConfirmed", "the base revision's speakers are not reviewed");
      }
      const contentSpeakers = new Set(scope.speakers.list(owner, contentId).map((speaker) => speaker.id));
      let previousStart = -Infinity;
      draft.segments.forEach((segment, index) => {
        const at = `segments.${index}`;
        if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs) || segment.startMs < 0 || segment.startMs >= segment.endMs) {
          invalidDraft(at, "segment timing must satisfy 0 <= start < end");
        }
        if (segment.startMs < previousStart) {
          invalidDraft(at, "segment start times must not decrease");
        }
        previousStart = segment.startMs;
        if (segment.sourceSegmentIds.some((source) => !baseSegments.has(source))) {
          invalidDraft(`${at}.sourceSegmentIds`, "sources must be sentences of the base revision");
        }
        if (typeof segment.speakerId === "string" && !contentSpeakers.has(segment.speakerId)) {
          invalidDraft(`${at}.speakerId`, "speakers must be speakers of this content");
        }
      });

      // Manual revisions directly above the draft that nothing else uses are folded into the
      // new one: it descends from the first revision that has to stay (the anchor) and its
      // sources are carried up through the folded revisions. The primary does not count as a
      // use because the new revision takes it over before the old ones are deleted. An
      // unfinished Task of the Content counts as a use of every revision (its stages may read
      // the primary as their base when they run), so nothing is merged while one is running.
      const revisions = scope.transcripts.listRevisions(owner, contentId);
      const references = scope.revisionReferences.listReferences(owner, contentId);
      const { chain, anchorId } = manualMergeChain(
        base.id,
        revisions,
        (_id, candidate) => !hasRevisionBlockers(revisionBlockers(references, new Set(candidate)), MERGE_IGNORES),
      );
      const levels = chain.map((id) =>
        id === base.id
          ? new Map([...baseSegments].map(([segmentId, segment]) => [segmentId, segment.sourceSegmentIds]))
          : new Map(scope.transcripts.listSegments(owner, id).map((segment) => [segment.id as string, segment.sourceSegmentIds])),
      );

      const revisionId = this.newId();
      // The editor works sentence by sentence; paragraphing is carried over from the base.
      const paragraphStarts = inheritedParagraphStarts(baseSegments, draft.segments);
      const acceptSuggestions = body.speakerReview === "accept_suggestions";
      let acceptedSuggestions = 0;
      const segments: TranscriptSegment[] = draft.segments.map((segment, ordinal) => {
        const first = segment.sourceSegmentIds[0];
        let speakerId: string | undefined;
        if (segment.speakerId === undefined) {
          speakerId = first === undefined ? undefined : baseSegments.get(first)?.speakerId;
        } else {
          speakerId = segment.speakerId ?? undefined;
        }
        if (segment.speakerReview === "needs_review") {
          if (acceptSuggestions) {
            // Only a speaker the draft names is a suggestion; one inherited from the source
            // sentence was never put up for review.
            acceptedSuggestions += typeof segment.speakerId === "string" ? 1 : 0;
          } else {
            speakerId = undefined;
          }
        }
        const paragraphStart = paragraphStarts[ordinal];
        return {
          id: this.newId() as SegmentId,
          revisionId,
          ordinal,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          ...(speakerId === undefined ? {} : { speakerId }),
          ...(paragraphStart === undefined ? {} : { paragraphStart }),
          sourceSegmentIds: remapSourcesThroughChain(segment.sourceSegmentIds, levels),
        };
      });
      const now = this.now();
      // Whether the review carries over: the committed speakers against the base's, with the
      // sources as the draft names them (sentences of the base), before they are carried up.
      const changedFromBase = countAttributionChanges(
        [...baseSegments.values()],
        segments.map((segment, index) => ({ ...segment, sourceSegmentIds: draft.segments[index]?.sourceSegmentIds ?? [] })),
      );
      // For the history: sentences of the parent (whose sentences the stored sources now name)
      // that changed hands. New sentences without a source are not a change of hands there.
      const anchorSegments = anchorId === base.id ? [...baseSegments.values()] : scope.transcripts.listSegments(owner, anchorId);
      const changedFromParent = attributionChangeCounts(anchorSegments, segments).changed;
      const generation: TranscriptRevision["generation"] =
        acceptedSuggestions > 0 || changedFromParent > 0
          ? { kind: "manual", speakerReview: { acceptedSuggestions, ...(changedFromParent > 0 ? { changedFromParent } : {}) } }
          : { kind: "manual" };
      const revision: TranscriptRevision = {
        id: revisionId,
        contentId,
        kind: "manual",
        parentRevisionId: anchorId,
        language: base.language,
        timingFidelity: timingFidelityFor("manual"),
        generation,
        segmentCount: segments.length,
        createdAt: now,
      };
      // A revision whose sentences name nobody has no speakers to vouch for, and the mark
      // could never be withdrawn from it (a review needs a named speaker), so it never gets one.
      const namesSpeakers = segments.some((segment) => segment.speakerId !== undefined);
      const keepsReview = namesSpeakers && baseConfirmedAt !== undefined && (body.speakersConfirmed === true || changedFromBase === 0);
      scope.transcripts.insertRevision(owner, revision, segments);
      if (keepsReview) {
        scope.speakerConfirmations.set(owner, contentId, revisionId, now);
      }
      scope.contents.setPrimaryTranscript(owner, contentId, revisionId, now);
      scope.transcripts.deleteDraft(owner, contentId, undefined);
      // Base first: each folded revision is a leaf once the one below it is gone.
      for (const id of chain) {
        scope.transcripts.deleteRevision(owner, id);
      }
      scope.idempotency.deleteReferencingRevisions(owner, chain);
      scope.search.syncContent(owner, contentId);
      return { ...transcriptRevisionDto(revision), ...(keepsReview ? { speakersConfirmedAt: now } : {}) };
    });
  }

  /**
   * `DELETE /contents/:id/transcript/draft`: "discard draft". The draft is the only thing
   * lost; its base revision is untouched. The editor names the version it last saw; without
   * one (the revision dialog's explicit discard) the draft goes whatever its version.
   */
  discardDraft(principal: RequestPrincipal, contentId: string, version?: number): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      discardStoredDraft(scope, owner, contentId, undefined, version);
    });
  }

  /**
   * Archives or restores one revision; only the mark changes, never the revision. The
   * current transcript cannot be archived, nor a revision any draft (the transcript draft or a
   * translation draft) is being edited from. A current translation itself may be archived.
   */
  setArchived(principal: RequestPrincipal, revisionId: string, archived: boolean): TranscriptRevisionListItemDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const { revision, content } = ownedRevision(scope, owner, revisionId);
      if (archived) {
        if (content.primaryTranscriptRevisionId === revision.id) {
          throw amberError("conflict", "the primary transcript cannot be archived", { code: "conflict.revision_is_primary" });
        }
        if (scope.transcripts.listDrafts(owner, content.id).some((draft) => draft.baseRevisionId === revision.id)) {
          throw amberError("conflict", "a draft is based on this revision", {
            code: "conflict.revision_referenced",
            details: { ...emptyRevisionBlockers(), draft: 1 },
          });
        }
      }
      scope.transcripts.setArchived(owner, revision.id, archived ? this.now() : undefined);
      const revisions = scope.transcripts.listRevisions(owner, content.id);
      return revisionListItems(scope, owner, content, revisions).find((item) => item.id === revision.id) as TranscriptRevisionListItemDto;
    });
  }

  /**
   * Permanent deletion of a revision, with its descendants when asked. Everything is checked
   * against the whole set in one transaction and nothing is deleted unless all checks pass:
   * platform and ASR originals are evidence and only archivable (a transcription made only
   * for comparison excepted), the primary has to be switched first, and any row that would be
   * left pointing into the set blocks the delete. Deleting a comparison transcription also
   * reclaims the speaker rows only it named that the user gave no name or photo.
   * A deleted translation that is its language's current one hands over to the latest
   * remaining translation of that language; idempotency records naming the set go too, so a
   * replayed request runs again instead of answering with a deleted id. With `withHistory`,
   * earlier summary, chapter and highlight revisions that only history holds and that cite
   * the set go first, in the same transaction; the current ones still block.
   */
  deleteRevision(principal: RequestPrincipal, revisionId: string, options: { withDescendants: boolean; withHistory?: boolean }): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      const { revision, content } = ownedRevision(scope, owner, revisionId);
      const revisions = scope.transcripts.listRevisions(owner, content.id);
      const ids = new Set([revision.id, ...(options.withDescendants ? descendantsOf(revisions, revision.id) : [])]);
      const members = revisions.filter((candidate) => ids.has(candidate.id));
      if (members.some(isPermanentRevision)) {
        throw amberError("invalid_request", "platform and ASR originals can only be archived", { code: "invalid_request.revision_kind_protected" });
      }
      if (content.primaryTranscriptRevisionId !== undefined && ids.has(content.primaryTranscriptRevisionId)) {
        throw amberError("conflict", "the primary transcript cannot be deleted", { code: "conflict.revision_is_primary" });
      }
      const references = scope.revisionReferences.listReferences(owner, content.id);
      const blockers = revisionBlockers(references, ids);
      if (hasRevisionBlockers(blockers, options.withHistory === true ? HISTORY_ONLY : undefined)) {
        throw amberError("conflict", "the revision is still referenced", { code: "conflict.revision_referenced", details: { ...blockers } });
      }
      for (const history of options.withHistory === true ? historyArtifactsOf(references, ids) : []) {
        scope.revisionReferences.deleteHistoryArtifact(owner, history);
      }
      for (const artifact of scope.translations.listArtifacts(owner, content.id)) {
        if (artifact.currentRevisionId === undefined || !ids.has(artifact.currentRevisionId)) {
          continue;
        }
        const successor = revisions
          .filter((candidate) => candidate.kind === "translated" && candidate.language === artifact.targetLanguage && !ids.has(candidate.id))
          .at(-1);
        if (successor === undefined) {
          scope.translations.deleteArtifact(owner, content.id, artifact.targetLanguage);
        } else {
          scope.translations.setCurrent(owner, content.id, artifact.targetLanguage, successor.id, artifact.id);
        }
      }
      // Read before the sentences go: the speakers the comparison transcriptions in the set name.
      const recyclable = comparisonSpeakersOf(scope, owner, content.id, members);
      for (const id of deletionOrder(revisions, ids)) {
        scope.transcripts.deleteRevision(owner, id);
      }
      if (recyclable.length > 0) {
        const kept = scope.speakers.referencedAmong(owner, content.id, recyclable);
        scope.speakers.delete(owner, content.id, recyclable.filter((id) => !kept.has(id)));
      }
      scope.idempotency.deleteReferencingRevisions(owner, [...ids]);
      scope.search.syncContent(owner, content.id);
    });
  }

  /** `GET /transcript/segments/:sid/map`: both ends must be the principal's and belong to one Content. */
  map(principal: RequestPrincipal, segmentId: string, targetRevisionId: string): SegmentMapDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const source = scope.transcripts.getSegment(owner, segmentId);
      const sourceRevision = source === undefined ? undefined : scope.transcripts.getRevision(owner, source.revisionId);
      if (source === undefined || sourceRevision === undefined || scope.contents.get(owner, sourceRevision.contentId) === undefined) {
        throw amberError("not_found", "segment not found");
      }
      const target = scope.transcripts.getRevision(owner, targetRevisionId);
      if (target === undefined || target.contentId !== sourceRevision.contentId) {
        throw amberError("not_found", "target revision not found");
      }
      const revisions = new Map(scope.transcripts.listRevisions(owner, target.contentId).map((revision) => [revision.id, revision]));
      const loaded = new Map<string, TranscriptSegment[]>();
      const segmentsOf = (revisionId: string): TranscriptSegment[] => {
        let segments = loaded.get(revisionId);
        if (segments === undefined) {
          segments = scope.transcripts.listSegments(owner, revisionId);
          loaded.set(revisionId, segments);
        }
        return segments;
      };
      return mapSegment({ source, targetRevisionId, revisions, segmentsOf });
    });
  }
}

/**
 * Removes a stored draft for a discard request: with `version`, only at that version (a draft
 * that is gone or newer is `conflict.draft_changed`); without, whatever it is (none is
 * `not_found`).
 */
export function discardStoredDraft(scope: RepositoryScope, owner: string, contentId: string, targetLanguage: string | undefined, version: number | undefined): void {
  const result = scope.transcripts.deleteDraft(owner, contentId, targetLanguage, version);
  if ("currentVersion" in result) {
    draftChanged(result.currentVersion);
  }
  if (!result.deleted) {
    if (version !== undefined) {
      draftChanged(null);
    }
    throw amberError("not_found", "no draft for this content");
  }
}

export function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  return content;
}

/**
 * The speakers a delete of comparison transcriptions may reclaim: those their sentences name
 * that hold nothing of the user's (no name, no photo). Whether another revision or a draft
 * still names one is checked once the set is gone.
 */
function comparisonSpeakersOf(scope: RepositoryScope, owner: string, contentId: string, members: readonly TranscriptRevision[]): string[] {
  const named = new Set<string>();
  for (const member of members) {
    if (!isComparisonRevision(member)) continue;
    for (const segment of scope.transcripts.listSegments(owner, member.id)) {
      if (segment.speakerId !== undefined) named.add(segment.speakerId);
    }
  }
  return [...named].filter((id) => {
    const speaker = scope.speakers.get(owner, contentId, id);
    return speaker !== undefined && isRecyclableSpeaker(speaker);
  });
}

/** A revision of a Content that is the principal's and outside the trash. */
function ownedRevision(scope: RepositoryScope, owner: string, revisionId: string): { revision: TranscriptRevision; content: Content } {
  const revision = scope.transcripts.getRevision(owner, revisionId);
  const content = revision === undefined ? undefined : scope.contents.get(owner, revision.contentId);
  if (revision === undefined || content === undefined) {
    throw amberError("not_found", "transcript revision not found");
  }
  return { revision, content };
}

/**
 * A manual revision is edited from one of the Content's own transcripts; a translation never
 * serves as its base, and neither does an archived revision until it is restored.
 */
function editableBase(scope: RepositoryScope, owner: string, contentId: string, revisionId: string): TranscriptRevision {
  const revision = scope.transcripts.getRevision(owner, revisionId);
  if (revision === undefined || revision.contentId !== contentId) {
    throw amberError("not_found", "transcript revision not found");
  }
  if (revision.kind === "translated") {
    throw amberError("invalid_request", "a translation cannot be the base of a manual revision", { params: { detail: "baseRevisionId" } });
  }
  if (scope.transcripts.listArchived(owner, contentId).some((entry) => entry.revisionId === revisionId)) {
    throw amberError("invalid_request", "an archived revision cannot be the base of a manual revision", { params: { detail: "baseRevisionId" } });
  }
  return revision;
}
