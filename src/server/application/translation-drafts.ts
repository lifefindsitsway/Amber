import { monotonicFactory } from "ulid";
import type { TranscriptRevisionDto } from "../../shared/dto/content.ts";
import type { TranslationDraftCommitRequest, TranslationDraftDto, TranslationDraftRequest } from "../../shared/dto/translation.ts";
import type { SegmentId } from "../../shared/ids.ts";
import type { TranslationArtifact } from "../domain/artifact.ts";
import { amberError } from "../domain/errors.ts";
import {
  hasRevisionBlockers,
  revisionBlockers,
  timingFidelityFor,
  type ManualTranslationOrigin,
  type TranscriptDraft,
  type TranscriptRevision,
  type TranscriptSegment,
} from "../domain/transcript.ts";
import { normalizeTargetLanguages } from "../domain/translation.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { transcriptRevisionDto } from "./contents.ts";
import { discardStoredDraft, draftChanged, ownedContent } from "./transcripts.ts";

export interface TranslationDraftServiceOptions {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

function draftDto(draft: TranscriptDraft, targetLanguage: string): TranslationDraftDto {
  return {
    id: draft.id,
    contentId: draft.contentId,
    targetLanguage,
    baseRevisionId: draft.baseRevisionId,
    version: draft.version,
    segments: draft.segments.map((segment) => ({ id: segment.id ?? "", text: segment.text })),
    updatedAt: draft.updatedAt,
  };
}

function invalid(detail: string, reason: string): never {
  throw amberError("invalid_request", `translation draft refused: ${reason}`, { params: { detail } });
}

function translationChanged(currentRevisionId: string | undefined, reason: string): never {
  throw amberError("conflict", reason, {
    code: "conflict.translation_changed",
    ...(currentRevisionId === undefined ? {} : { details: { currentRevisionId } }),
  });
}

/**
 * Hand edits of a translation, one draft per Content and target language (Draft → Commit).
 * The editor only changes text: a draft holds the base translation's sentence ids in order
 * with their edited text, and a commit rebuilds every other property — timing, order,
 * speakers, paragraph marks, sources, language and parent — from the base, never from the
 * client. Drafts are versioned like the transcript draft, so a second window or a late save
 * cannot overwrite or revive one.
 */
export class TranslationDraftService {
  private readonly options: TranslationDraftServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: TranslationDraftServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  get(principal: RequestPrincipal, contentId: string, language: string): TranslationDraftDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const artifact = translationOf(scope, owner, contentId, language);
      const draft = scope.transcripts.getDraft(owner, contentId, artifact.targetLanguage);
      if (draft === undefined) {
        throw amberError("not_found", "no draft for this translation");
      }
      return draftDto(draft, artifact.targetLanguage);
    });
  }

  /**
   * Autosave. The base must be a translation of this Content in the draft's language that is
   * not archived, and a new draft (`expectedVersion` null) can only start from the current
   * one. The sentence ids must be the base's, in its order; text may be empty while editing.
   */
  put(principal: RequestPrincipal, contentId: string, language: string, body: TranslationDraftRequest): TranslationDraftDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const artifact = translationOf(scope, owner, contentId, language);
      const base = editableTranslation(scope, owner, contentId, artifact.targetLanguage, body.baseRevisionId);
      if (body.expectedVersion === null && base.id !== artifact.currentRevisionId) {
        invalid("baseRevisionId", "a new draft starts from the current translation");
      }
      const baseSegments = scope.transcripts.listSegments(owner, base.id);
      if (!sameSentences(baseSegments, body.segments)) {
        invalid("segments", "sentences must be the base translation's, in order");
      }
      const draft: TranscriptDraft = {
        id: this.newId(),
        contentId,
        baseRevisionId: base.id,
        targetLanguage: artifact.targetLanguage,
        version: (body.expectedVersion ?? 0) + 1,
        segments: baseSegments.map((segment, index) => ({
          id: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: body.segments[index]?.text ?? "",
          sourceSegmentIds: [...segment.sourceSegmentIds],
        })),
        updatedAt: this.now(),
      };
      const result = scope.transcripts.putDraft(owner, draft, body.expectedVersion);
      if (!("written" in result)) {
        draftChanged(result.currentVersion);
      }
      return draftDto(result.written, artifact.targetLanguage);
    });
  }

  /** Discards the language's draft: at `version` when given, otherwise whatever it is. */
  discard(principal: RequestPrincipal, contentId: string, language: string, version?: number): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      const artifact = translationOf(scope, owner, contentId, language);
      discardStoredDraft(scope, owner, contentId, artifact.targetLanguage, version);
    });
  }

  /**
   * Commits the draft as a new `translated` revision, made the language's current translation,
   * and removes the draft — all in one transaction. Refused while the draft is not at
   * `draftVersion`, while the current translation is not `expectedRevisionId`, and, without
   * `allowOutdatedBase`, while the draft's base is no longer the current translation (another
   * translation finished meanwhile). The replaced current translation is deleted with it only
   * when it was itself a hand edit and nothing at all refers to it; machine translations are
   * always kept.
   */
  commit(principal: RequestPrincipal, contentId: string, language: string, body: TranslationDraftCommitRequest): TranscriptRevisionDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const artifact = translationOf(scope, owner, contentId, language);
      const targetLanguage = artifact.targetLanguage;
      const draft = scope.transcripts.getDraft(owner, contentId, targetLanguage);
      if (draft?.version !== body.draftVersion) {
        draftChanged(draft?.version ?? null);
      }
      const currentId = artifact.currentRevisionId;
      if (currentId !== body.expectedRevisionId) {
        translationChanged(currentId, "the current translation changed since the editor loaded it");
      }
      if (draft.baseRevisionId !== currentId && body.allowOutdatedBase !== true) {
        translationChanged(currentId, "the draft was edited from a translation that is no longer current");
      }
      const base = editableTranslation(scope, owner, contentId, targetLanguage, draft.baseRevisionId);
      const baseSegments = scope.transcripts.listSegments(owner, base.id);
      if (!sameSentences(baseSegments, draft.segments)) {
        invalid("segments", "sentences must be the base translation's, in order");
      }
      const texts = draft.segments.map((segment) => segment.text.trim());
      const empty = texts.findIndex((text) => text.length === 0);
      if (empty >= 0) {
        invalid(`segments.${empty}.text`, "every sentence needs a translation");
      }

      const revisionId = this.newId();
      const segments: TranscriptSegment[] = baseSegments.map((segment, index) => ({
        id: this.newId() as SegmentId,
        revisionId,
        ordinal: segment.ordinal,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: texts[index] as string,
        ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
        ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
        sourceSegmentIds: [...segment.sourceSegmentIds],
      }));
      const origin = originOf(base);
      const revision: TranscriptRevision = {
        id: revisionId,
        contentId,
        kind: "translated",
        ...(base.parentRevisionId === undefined ? {} : { parentRevisionId: base.parentRevisionId }),
        language: base.language,
        timingFidelity: timingFidelityFor("translated"),
        generation: origin === undefined ? { kind: "manual" } : { kind: "manual", origin },
        segmentCount: segments.length,
        createdAt: this.now(),
      };
      // The insert checks the transcript invariants (timing, ordinals, one source per
      // translated sentence, sources in the parent, paragraph marks) and refuses a violation.
      scope.transcripts.insertRevision(owner, revision, segments);
      scope.translations.setCurrent(owner, contentId, targetLanguage, revisionId, artifact.id);
      scope.transcripts.deleteDraft(owner, contentId, targetLanguage);
      if (currentId !== undefined) {
        dropReplacedHandEdit(scope, owner, contentId, currentId);
      }
      return transcriptRevisionDto(revision);
    });
  }
}

/**
 * The language's TranslationArtifact of an owned Content outside the trash. `language` is
 * canonicalized the way translation requests are, so `EN-us` names `en-US`.
 */
function translationOf(scope: RepositoryScope, owner: string, contentId: string, language: string): TranslationArtifact {
  ownedContent(scope, owner, contentId);
  // An empty source language never matches a tag's primary subtag, so only malformed tags fail.
  const normalized = normalizeTargetLanguages([language], "");
  const targetLanguage = "languages" in normalized ? normalized.languages[0] : undefined;
  if (targetLanguage === undefined) {
    throw amberError("not_found", "translation not found");
  }
  const artifact = scope.translations.getArtifact(owner, contentId, targetLanguage);
  if (artifact === undefined) {
    throw amberError("not_found", "translation not found");
  }
  return artifact;
}

/** A translation of the Content in `targetLanguage` that is not archived: what a draft may be edited from. */
function editableTranslation(scope: RepositoryScope, owner: string, contentId: string, targetLanguage: string, revisionId: string): TranscriptRevision {
  const revision = scope.transcripts.getRevision(owner, revisionId);
  if (revision === undefined || revision.contentId !== contentId) {
    throw amberError("not_found", "transcript revision not found");
  }
  if (revision.kind !== "translated" || revision.language !== targetLanguage) {
    invalid("baseRevisionId", `the base must be a ${targetLanguage} translation`);
  }
  if (scope.transcripts.listArchived(owner, contentId).some((entry) => entry.revisionId === revisionId)) {
    invalid("baseRevisionId", "an archived translation cannot be edited");
  }
  return revision;
}

/** Whether `drafted` names exactly the base's sentences, each once and in the base's order. */
function sameSentences(base: readonly TranscriptSegment[], drafted: ReadonlyArray<{ id?: string }>): boolean {
  return base.length === drafted.length && base.every((segment, index) => drafted[index]?.id === segment.id);
}

/**
 * Where a hand edit of `base` comes from: the machine translation itself, or the origin a
 * hand-edited base already carries; none when the base has neither. The speakers the
 * machine translation was given travel with it, so the hand edit still says what it was
 * built on after that translation is cleaned up.
 */
function originOf(base: TranscriptRevision): ManualTranslationOrigin | undefined {
  const generation = base.generation;
  if (generation.kind === "llm") {
    return {
      revisionId: base.id,
      modelRef: generation.modelRef,
      promptRef: generation.promptRef,
      ...(generation.speakerContext === undefined ? {} : { speakerContext: generation.speakerContext }),
    };
  }
  return generation.kind === "manual" ? generation.origin : undefined;
}

/**
 * A hand-edited translation replaced by a newer hand edit is only an intermediate state, so
 * it is deleted with its sentences and the idempotency records naming it — but only when no
 * note, artifact, conversation, history version, task, draft or child refers to it. Anything
 * else (a machine translation, a referenced hand edit) stays in the history.
 */
function dropReplacedHandEdit(scope: RepositoryScope, owner: string, contentId: string, revisionId: string): void {
  const replaced = scope.transcripts.getRevision(owner, revisionId);
  if (replaced?.kind !== "translated" || replaced.generation.kind !== "manual") {
    return;
  }
  const blockers = revisionBlockers(scope.revisionReferences.listReferences(owner, contentId), new Set([revisionId]));
  if (hasRevisionBlockers(blockers)) {
    return;
  }
  scope.transcripts.deleteRevision(owner, revisionId);
  scope.idempotency.deleteReferencingRevisions(owner, [revisionId]);
}
