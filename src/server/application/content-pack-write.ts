import { createHash } from "node:crypto";
import { FIGURES_PER_CONTENT_MAX, NOTES_PER_CONTENT_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import type { z } from "zod";
import type { PackContentResult, packContentDecisionSchema } from "../../shared/dto/content-pack.ts";
import type { SegmentId } from "../../shared/ids.ts";
import type { Content } from "../domain/content.ts";
import { PACK_COVER_LIMITS } from "../domain/content-pack/document.ts";
import { inspectPackAvatar, inspectPackWebp } from "../domain/figure-image.ts";
import { amberError } from "../domain/errors.ts";
import type { ContentFigure } from "../domain/figure.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import { isPlatform, type Platform } from "../domain/platform.ts";
import { noteAnchorProblem, noteQuote } from "../domain/note.ts";
import { normalizePlatformChapters } from "../domain/platform-subtitle.ts";
import { capDescription, normalizeDescription } from "../domain/content-description.ts";
import { cacheRowsAt } from "../pipeline/cache-swap.ts";
import type { TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { ParsedPlatformUrl } from "../ports/platform-source.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import type { PackImportMediaPlan, PlacedPackMedia } from "./content-pack-engine.ts";
import {
  analyzeContent,
  carriedCoverUrl,
  figureFieldsOf,
  packSpeakerName,
  sameFigureFields,
  speakersToCreate,
  type AnalysisChoices,
  type CheckedContent,
  type FigureFields,
  type NoteFields,
  type RevisionAnalysis,
} from "./content-pack-preview.ts";

/**
 * Writes one carried Content in the caller's transaction: the record (for a new Content),
 * speakers, revisions with their archive and speaker review marks, the primary and current
 * translations, notes, figures, platform chapters, media rows, the merge map and the search
 * projection. The library is analysed again first, so the write follows what is here now;
 * whatever the preview recorded is only used to tell what changed since. Any failure throws
 * and the transaction takes everything back.
 */

/**
 * Each platform's own rules for its source links, through which a carried link is checked
 * before it is stored: the pack is untrusted, and a source link is opened and handed to the
 * platform's adapter later.
 */
export interface PackSourceLinks {
  /** The platform adapter's `parse`; `null` when it does not accept the URL. */
  parse(platform: Platform, url: string): ParsedPlatformUrl | null;
  /** The canonical link of a platform Content, from its identity alone. */
  canonicalUrl(platform: Platform, platformContentId: string): string;
}

/** A decision with its defaults applied. */
export type ParsedDecision = z.output<typeof packContentDecisionSchema>;

/** What the preview saw of a target, compared again inside the commit. */
export interface TargetSnapshot {
  primaryRevisionId?: string;
  notes: ReadonlyMap<string, NoteFields>;
  figures: ReadonlyMap<string, FigureFields>;
}

export interface PackContentWrite {
  checked: CheckedContent;
  decision: ParsedDecision;
  /** The target of a merge, or the id assigned to the new Content. */
  contentId: string;
  isNew: boolean;
  snapshot?: TargetSnapshot;
  /** The target's identity differs from the carried one: remember the merge. */
  rememberMerge: boolean;
  media: readonly PackImportMediaPlan[];
  images: ReadonlyMap<string, Uint8Array>;
  placed: ReadonlyMap<string, PlacedPackMedia>;
  /** Absent: a carried source link is stored as it is. */
  sourceLinks?: PackSourceLinks;
  newId: () => string;
  now: number;
}

export function choicesOf(decision: ParsedDecision): AnalysisChoices {
  return {
    revisions: decision.revisions,
    excludedRevisions: new Set(decision.excludeRevisionKeys),
    notes: decision.notes,
    figures: decision.figures,
    sameSpeakers: new Map(decision.sameSpeakers.map((entry) => [Number(entry.speakerKey), entry.localSpeakerId])),
  };
}

function targetChanged(contentId: string, why: string): never {
  throw amberError("conflict", `content pack target changed: ${why}`, { code: "conflict.pack_target_changed", details: { contentId } });
}

/** Refuses a target that is gone, in the trash, or busy with an unfinished Task. */
export function checkTarget(scope: RepositoryScope, owner: string, contentId: string): Content {
  const target = scope.contents.getIncludingTrashed(owner, contentId);
  if (target === undefined) targetChanged(contentId, "gone");
  if (target.trashedAt !== undefined) targetChanged(contentId, "in the trash");
  const busy = scope.tasks.listUnfinishedOf(owner).find((task) => task.contentId === contentId);
  if (busy !== undefined) {
    throw amberError("conflict", "a merge target has an unfinished Task", { code: "conflict.pack_content_busy", details: { contentId, taskId: busy.id } });
  }
  return target;
}

function emptyResult(key: string, title: string | undefined): PackContentResult {
  return {
    key,
    ...(title === undefined ? {} : { title }),
    status: "skipped",
    added: { revisions: 0, speakers: 0, figures: 0, notes: 0, media: 0 },
    updated: { figures: 0, notes: 0 },
    conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 },
    placedByTime: 0,
  };
}

export function skippedResult(key: string, title: string | undefined): PackContentResult {
  return emptyResult(key, title);
}

export function failedResult(key: string, title: string | undefined, error: PackContentResult["error"]): PackContentResult {
  return { ...emptyResult(key, title), status: "failed", ...(error === undefined ? {} : { error }) };
}

export function writePackContent(scope: RepositoryScope, owner: string, input: PackContentWrite): PackContentResult {
  const { checked, decision, newId, now } = input;
  const { document } = checked;
  const title = document.customTitle ?? document.title;
  const result = emptyResult(decision.key, title);
  result.status = input.isNew ? "imported" : "merged";
  result.contentId = input.contentId;

  let target: Content;
  if (input.isNew) {
    target = insertContent(scope, owner, input);
  } else {
    target = checkTarget(scope, owner, input.contentId);
    if (decision.setPrimaryRevisionKey !== undefined && target.primaryTranscriptRevisionId !== input.snapshot?.primaryRevisionId) {
      targetChanged(target.id, "the primary transcript moved since the preview");
    }
  }

  const choices = choicesOf(decision);
  const analysis = analyzeContent(scope, owner, checked, target, choices);

  // Limits: a category over its limit is refused whole, never cut.
  const created = speakersToCreate(analysis);
  if (analysis.counts.speakers + created.length > SPEAKERS_PER_CONTENT_MAX) {
    throw amberError("conflict", "not enough room for the carried speakers", {
      code: "conflict.speaker_capacity",
      details: { room: Math.max(0, SPEAKERS_PER_CONTENT_MAX - analysis.counts.speakers), required: created.length },
    });
  }
  const newNotes = decision.notes ? analysis.notes.filter((note) => note.state === "new" && note.placeable) : [];
  if (analysis.counts.notes + newNotes.length > NOTES_PER_CONTENT_MAX) {
    throw amberError("invalid_request", "the carried notes exceed the limit", { code: "invalid_request.note_limit", details: { limit: NOTES_PER_CONTENT_MAX } });
  }
  const newFigures = decision.figures ? analysis.figures.filter((figure) => figure.state === "new" && input.images.has(figure.pack.entry)) : [];
  if (analysis.counts.figures + newFigures.length > FIGURES_PER_CONTENT_MAX) {
    throw amberError("invalid_request", "the carried figures exceed the limit", { code: "invalid_request.figure_limit", details: { limit: FIGURES_PER_CONTENT_MAX } });
  }

  // Speakers: identity matches and same-name merges reuse the local speaker untouched.
  const speakerIds = new Map<number, string>();
  for (const speaker of analysis.speakers) {
    if (speaker.mappedTo !== undefined) {
      if (speaker.mappedByName && scope.speakers.get(owner, target.id, speaker.mappedTo) === undefined) targetChanged(target.id, "a chosen speaker is gone");
      speakerIds.set(speaker.index, speaker.mappedTo);
    }
  }
  const name = (speaker: { pack: { name?: string } }): string | undefined => packSpeakerName(speaker.pack);
  if (created.length > 0) {
    const taken = new Set(scope.speakers.list(owner, target.id).map((speaker) => speaker.ordinal));
    const rows = created.map((speaker) => {
      const keepOrdinal = !taken.has(speaker.pack.ordinal) && speaker.pack.ordinal <= SPEAKERS_PER_CONTENT_MAX;
      if (keepOrdinal) taken.add(speaker.pack.ordinal);
      return {
        id: newId(),
        ...(name(speaker) === undefined ? {} : { name: name(speaker) as string }),
        ...(speaker.pack.nameConfirmedAt === undefined ? {} : { nameConfirmedAt: speaker.pack.nameConfirmedAt }),
        colorIndex: speaker.pack.colorIndex,
        ...(keepOrdinal ? { ordinal: speaker.pack.ordinal } : {}),
        origin: { contentId: speaker.pack.originContentKey, speakerId: speaker.pack.originSpeakerId },
      };
    });
    // Ordinals kept from the pack go first so the automatic ones never take them.
    const ordered = [...rows.filter((row) => row.ordinal !== undefined), ...rows.filter((row) => row.ordinal === undefined)];
    scope.speakers.insert(owner, target.id, ordered, now);
    created.forEach((speaker, at) => {
      const row = rows[at] as (typeof rows)[number];
      speakerIds.set(speaker.index, row.id);
      const avatar = speaker.pack.avatar;
      const bytes = avatar === undefined ? undefined : input.images.get(avatar.entry);
      if (avatar !== undefined && bytes !== undefined && inspectPackAvatar(bytes, avatar.mime).ok) {
        scope.speakers.update(owner, target.id, row.id, { avatar: { mime: avatar.mime, bytes } }, now);
      }
    });
    result.added.speakers = created.length;
  }

  // Revisions, parents first.
  const revisionIds = new Map<string, string>();
  const segmentsById = new Map<string, TranscriptSegment[]>();
  const segmentsOf = (revisionId: string): TranscriptSegment[] => {
    let segments = segmentsById.get(revisionId);
    if (segments === undefined) {
      segments = scope.transcripts.listSegments(owner, revisionId);
      segmentsById.set(revisionId, segments);
    }
    return segments;
  };
  const localIdOf = (key: string): string | undefined => {
    const revision = analysis.revisions.find((item) => item.pack.key === key);
    if (revision === undefined) return undefined;
    // A revision already here anchors notes and figures whether or not revisions were chosen.
    if (revision.state === "existing") return revision.localId;
    return revision.included ? revisionIds.get(key) : undefined;
  };
  const written: RevisionAnalysis[] = [];
  for (const revision of analysis.revisions) {
    if (!revision.included) continue;
    if (revision.state === "differs") {
      result.conflicts.revisions += 1;
      continue;
    }
    if (revision.state !== "new" || revision.rejected) continue;
    const parentId = revision.parent === undefined ? undefined : "local" in revision.parent ? revision.parent.local : revisionIds.get(revision.parent.carried);
    if (revision.parent !== undefined && parentId === undefined) continue;
    const parentSegments = parentId === undefined ? [] : segmentsOf(parentId);
    const id = newId();
    const segments = revision.document.segments.map((segment, ordinal): TranscriptSegment => {
      const speakerId = segment.speaker === undefined ? undefined : speakerIds.get(segment.speaker);
      return {
        id: newId() as SegmentId,
        revisionId: id,
        ordinal,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        ...(segment.words === undefined ? {} : { words: segment.words.map((word) => ({ ...word })) }),
        ...(speakerId === undefined ? {} : { speakerId }),
        ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
        sourceSegmentIds: parentId === undefined ? [] : (segment.sources ?? []).map((source) => (parentSegments[source] as TranscriptSegment).id),
      };
    });
    const row: TranscriptRevision = {
      id,
      contentId: target.id,
      kind: revision.kind,
      ...(parentId === undefined ? {} : { parentRevisionId: parentId }),
      language: revision.pack.language,
      timingFidelity: revision.timingFidelity,
      generation: revision.pack.generation,
      segmentCount: segments.length,
      ...(revision.pack.looseJoin === true ? { looseJoin: true } : {}),
      originId: revision.pack.key,
      createdAt: revision.pack.createdAt,
    };
    // The insert checks the transcript invariants and that every source is a parent sentence.
    scope.transcripts.insertRevision(owner, row, segments);
    segmentsById.set(id, segments.map((segment) => ({ ...segment, ...(row.looseJoin === true ? { looseJoin: true as const } : {}) })));
    revisionIds.set(revision.pack.key, id);
    written.push(revision);
    if (revision.pack.archivedAt !== undefined) scope.transcripts.setArchived(owner, id, revision.pack.archivedAt);
    if (revision.pack.speakersConfirmedAt !== undefined) {
      // The review travels only when every speaker it covered is the very same person here:
      // matched by identity or created now, never merged by name.
      const named = new Set(revision.document.segments.flatMap((segment) => (segment.speaker === undefined ? [] : [segment.speaker])));
      const byName = [...named].some((index) => analysis.speakers[index]?.mappedByName === true);
      if (!byName) scope.speakerConfirmations.set(owner, target.id, id, revision.pack.speakersConfirmedAt);
    }
  }
  result.added.revisions = written.length;

  // Primary and current translations.
  const archivedHere = new Set(scope.transcripts.listArchived(owner, target.id).map((entry) => entry.revisionId));
  if (input.isNew) {
    const candidates = written.filter((revision) => revision.pack.kind !== "translated" && revision.pack.archivedAt === undefined);
    const flagged = candidates.find((revision) => revision.pack.key === (decision.setPrimaryRevisionKey ?? document.primaryRevisionKey));
    const primary = flagged ?? [...candidates].sort((a, b) => b.pack.createdAt - a.pack.createdAt)[0];
    if (primary !== undefined) scope.contents.setPrimaryTranscript(owner, target.id, revisionIds.get(primary.pack.key) as string, now);
  } else if (decision.setPrimaryRevisionKey !== undefined) {
    const id = localIdOf(decision.setPrimaryRevisionKey);
    const revision = id === undefined ? undefined : scope.transcripts.getRevision(owner, id);
    if (revision === undefined || revision.kind === "translated" || archivedHere.has(revision.id)) targetChanged(target.id, "the chosen primary cannot be the primary");
    scope.contents.setPrimaryTranscript(owner, target.id, revision.id, now);
  }
  const chosenTranslations = new Set(decision.currentTranslationKeys);
  for (const revision of written) {
    if (revision.pack.kind !== "translated" || revision.pack.archivedAt !== undefined) continue;
    if (revision.becomesCurrentTranslation || chosenTranslations.has(revision.pack.key)) {
      scope.translations.setCurrent(owner, target.id, revision.pack.language, revisionIds.get(revision.pack.key) as string, newId());
    }
  }

  // Notes: new ones on a revision that is here; the pack's version of changed ones when adopted.
  for (const note of newNotes) {
    const revisionId = localIdOf(note.pack.start.revisionKey);
    if (revisionId === undefined) continue;
    const revision = scope.transcripts.getRevision(owner, revisionId) as TranscriptRevision;
    const segments = segmentsOf(revisionId);
    const start = segments[note.pack.start.ordinal];
    const end = segments[note.pack.end.ordinal];
    const anchor = { transcriptRevisionId: revisionId, startSegmentId: start?.id ?? "", startOffset: note.pack.startOffset, endSegmentId: end?.id ?? "", endOffset: note.pack.endOffset };
    if (start === undefined || end === undefined || noteAnchorProblem(anchor, revision, start, end) !== undefined) {
      throw amberError("invalid_request", "a carried note does not fit its revision", { code: "invalid_request.note_anchor" });
    }
    scope.notes.insert({
      id: newId(),
      userId: owner,
      contentId: target.id,
      ...anchor,
      // The quote is cut from the sentences written here, never taken from the pack.
      quote: noteQuote(segments.slice(start.ordinal, end.ordinal + 1), note.pack.startOffset, note.pack.endOffset),
      mark: note.pack.mark,
      color: note.pack.color,
      ...(note.pack.comment === undefined ? {} : { comment: note.pack.comment }),
      originId: note.pack.key,
      createdAt: note.pack.createdAt,
      updatedAt: note.pack.updatedAt,
    });
    result.added.notes += 1;
  }
  if (decision.adoptPack && decision.notes) {
    for (const note of analysis.notes) {
      if (note.state !== "differs" || note.localId === undefined || note.local === undefined) continue;
      const seen = input.snapshot?.notes.get(note.pack.key);
      if (seen === undefined || seen.mark !== note.local.mark || seen.color !== note.local.color || seen.comment !== note.local.comment) {
        result.conflicts.notes += 1;
        continue;
      }
      // Only what the pack states is taken: a pack note without a comment keeps the local one.
      scope.notes.update(owner, note.localId, { mark: note.pack.mark, color: note.pack.color, ...(note.pack.comment === undefined ? {} : { comment: note.pack.comment }) }, now);
      result.updated.notes += 1;
    }
  }

  // Figures: a carried anchor becomes the local revision and sentence, else the figure goes by time.
  const anchorOf = (anchor: { revisionKey: string; ordinal: number; side: "before" | "after" } | undefined): ContentFigure["anchor"] => {
    if (anchor === undefined) return undefined;
    const revisionId = localIdOf(anchor.revisionKey);
    const segment = revisionId === undefined ? undefined : segmentsOf(revisionId)[anchor.ordinal];
    return revisionId === undefined || segment === undefined ? undefined : { revisionId, segmentId: segment.id, side: anchor.side };
  };
  for (const figure of newFigures) {
    const bytes = input.images.get(figure.pack.entry) as Uint8Array;
    const checkedImage = inspectPackWebp(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!checkedImage.ok || sha256 !== figure.pack.image.sha256 || bytes.length !== figure.pack.image.bytes) {
      throw amberError("backup_invalid", "a carried figure image does not match its document", { code: "backup_invalid.pack_image", details: { entry: figure.pack.entry } });
    }
    const anchor = anchorOf(figure.pack.anchor);
    const id = newId();
    scope.figures.insert(
      {
        id,
        contentId: target.id,
        userId: owner,
        source: figure.pack.source,
        ...(figure.pack.capturedAtMs === undefined ? {} : { capturedAtMs: figure.pack.capturedAtMs }),
        displayMs: figure.pack.displayMs,
        ...(anchor === undefined ? {} : { anchor }),
        sortKey: figure.pack.sortKey,
        widthRatio: figure.pack.widthRatio,
        ...(figure.pack.caption === undefined ? {} : { caption: figure.pack.caption }),
        image: { width: checkedImage.width, height: checkedImage.height, bytes: bytes.length, sha256 },
        version: 1,
        originId: figure.pack.key,
        createdAt: figure.pack.createdAt,
        updatedAt: figure.pack.updatedAt,
      },
      bytes,
    );
    scope.search.syncFigure(owner, target.id, id);
    result.added.figures += 1;
    if (anchor === undefined) result.placedByTime += 1;
  }
  for (const figure of analysis.figures) {
    if (figure.state !== "differs" || figure.localId === undefined) continue;
    if (figure.imageConflict) {
      result.conflicts.figures += 1;
      continue;
    }
    if (!decision.adoptPack || !decision.figures) continue;
    const current = scope.figures.get(owner, figure.localId);
    const seen = input.snapshot?.figures.get(figure.pack.key);
    if (current === undefined || current.deletedAt !== undefined || seen === undefined || !sameFigureFields(figureFieldsOf(current), seen)) {
      result.conflicts.figures += 1;
      continue;
    }
    // Where the pack does not say where the figure is, the local place stays; adopting never
    // removes anything, so a pack without a caption leaves the local one.
    const place = figure.positionKnown ? { displayMs: figure.pack.displayMs, sortKey: figure.pack.sortKey, anchor: anchorOf(figure.pack.anchor) ?? null } : {};
    const updated = scope.figures.update(owner, current.id, current.version, { ...(figure.pack.caption === undefined ? {} : { caption: figure.pack.caption }), widthRatio: figure.pack.widthRatio, ...place }, now);
    if (updated === undefined || "conflict" in updated) {
      result.conflicts.figures += 1;
      continue;
    }
    scope.search.syncFigure(owner, target.id, current.id);
    result.updated.figures += 1;
  }

  // Platform chapters: never over the Content's own, never moving a chosen chapter revision.
  const chapters = document.platformChapters ?? [];
  if (chapters.length > 0 && !scope.chapters.hasPlatformChapters(owner, target.id)) {
    const duration = target.durationMs ?? document.durationMs ?? chapters.reduce((latest, chapter) => Math.max(latest, chapter.endMs ?? chapter.startMs + 1), 1);
    const entries = normalizePlatformChapters(chapters, duration);
    if (entries.length > 0) {
      const { revisionId } = scope.chapters.insertPlatformRevision(owner, target.id, { id: newId(), artifactId: newId(), chapters: entries, createdAt: now });
      if (scope.chapters.getCurrent(owner, target.id) === undefined) scope.chapters.setCurrent(owner, target.id, revisionId);
    }
  }

  // The cover: a new Content gets the carried one; a local copy is never replaced.
  const cover = carriedCover(document, input.images);
  if (cover !== undefined) {
    if (input.isNew) scope.contentCovers.put(owner, target.id, cover, now);
    else scope.contentCovers.putIfAbsent(owner, target.id, cover, now);
  }

  // Media rows for the files the job has put in place.
  result.conflicts.media = analysis.media.filter((item) => item.state === "conflict").length;
  for (const plan of input.media) {
    const placed = input.placed.get(plan.entry);
    if (placed === undefined) throw amberError("internal", "a staged media file was not placed");
    if (placed.sha256 !== plan.media.sha256 || placed.sizeBytes !== plan.media.sizeBytes) {
      throw amberError("backup_invalid", "a carried media file does not match its document", { code: "backup_invalid.pack_entry", details: { entry: plan.entry, reason: "media" } });
    }
    writeMedia(scope, owner, target.id, plan, placed, now);
    result.added.media += 1;
  }

  if (input.rememberMerge) scope.transferOrigins.addContentTarget(owner, document.key, target.id, now);
  scope.search.syncContent(owner, target.id);
  return result;
}

/**
 * The carried cover of a platform Content, checked once more against its document: the bytes
 * were checked when the pack was read, and are only taken as what the document says they are.
 */
function carriedCover(document: CheckedContent["document"], images: ReadonlyMap<string, Uint8Array>): { bytes: Uint8Array; width: number; height: number; sha256: string } | undefined {
  const declared = document.cover;
  // A local file has no cover; a pack claiming one for it is not believed.
  if (declared === undefined || !isPlatform(document.source.kind)) return undefined;
  const bytes = images.get(declared.entry);
  if (bytes === undefined) return undefined;
  const checked = inspectPackWebp(bytes, PACK_COVER_LIMITS);
  if (!checked.ok) {
    throw amberError("backup_invalid", "a carried cover fails its structural check", { code: "backup_invalid.pack_image", details: { entry: declared.entry } });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== declared.sha256 || bytes.length !== declared.bytes || checked.width !== declared.width || checked.height !== declared.height) {
    throw amberError("backup_invalid", "a carried cover does not match its document", { code: "backup_invalid.pack_entry", details: { entry: declared.entry, reason: "digest" } });
  }
  return { bytes, width: checked.width, height: checked.height, sha256 };
}

/**
 * The source link a new Content keeps. A platform Content's link must be one its platform's
 * `parse` accepts and must name the Content's own identity; anything else (only an altered
 * pack has it) becomes the canonical link of that identity, or no link when the identity is
 * not one the platform could name. A valid link is kept as carried,
 * access parameters included: some platforms cannot open the page without them.
 */
function checkedSourceUrl(source: CheckedContent["document"]["source"], links: PackSourceLinks | undefined): string | undefined {
  const { kind, sourceUrl, platformContentId } = source;
  if (links === undefined || !isPlatform(kind)) return sourceUrl;
  if (platformContentId === undefined) return undefined;
  const parsed = sourceUrl === undefined ? null : links.parse(kind, sourceUrl);
  if (parsed !== null && parsed.platformContentId === platformContentId) return sourceUrl;
  // The identity is carried too: a link made from one the platform would not name is none.
  const canonical = links.canonicalUrl(kind, platformContentId);
  return links.parse(kind, canonical)?.platformContentId === platformContentId ? canonical : undefined;
}

function insertContent(scope: RepositoryScope, owner: string, input: PackContentWrite): Content {
  const { document } = input.checked;
  const { sourceUrl: _carried, ...rest } = document.source;
  const sourceUrl = checkedSourceUrl(document.source, input.sourceLinks);
  const source = { ...rest, ...(sourceUrl === undefined ? {} : { sourceUrl }) };
  const cover = carriedCoverUrl(document);
  const holder = scope.contents.findByPlatformIdentity(owner, source);
  if (holder !== undefined) targetChanged(holder.id, "the platform identity is taken");
  const content: Content = {
    id: input.contentId,
    userId: owner,
    source,
    ...(document.title === undefined ? {} : { title: document.title }),
    ...(document.customTitle === undefined ? {} : { customTitle: document.customTitle }),
    ...(cover === undefined ? {} : { coverUrl: cover }),
    ...(document.durationMs === undefined ? {} : { durationMs: document.durationMs }),
    ...(document.publishedAt === undefined ? {} : { publishedAt: document.publishedAt }),
    ...(document.rawLanguage === undefined ? {} : { rawLanguage: document.rawLanguage }),
    // No Task ever processed it here; transcription and the rest stay available on demand.
    processingStatus: "none",
    originId: document.key,
    createdAt: input.now,
    updatedAt: input.now,
  };
  scope.contents.insert(content);
  // Stored exactly as a description read from the platform is: normalized, then capped.
  const description = document.description === undefined ? "" : normalizeDescription(document.description);
  if (description !== "") {
    const capped = capDescription(description);
    scope.contents.setDescription(owner, content.id, { description: capped.text, truncated: document.descriptionTruncated === true || capped.truncated, checkedAt: input.now }, input.now);
  }
  return scope.contents.get(owner, content.id) as Content;
}

function writeMedia(scope: RepositoryScope, owner: string, contentId: string, plan: PackImportMediaPlan, placed: PlacedPackMedia, now: number): void {
  const storageRef = "path" in placed.location ? placed.location.path : placed.location.storageRef;
  const fingerprint = `sha256:${placed.sha256}`;
  if (plan.targetKind === "platform_cache") {
    const holders = cacheRowsAt(scope, storageRef).filter((row) => row.id !== plan.assetId);
    if (holders.some((row) => row.userId !== owner || row.contentId !== contentId)) {
      throw amberError("conflict", "the cache file name is taken", { code: "conflict.cache_name_taken", details: { fileName: plan.media.cacheFileName ?? storageRef } });
    }
  }
  if (plan.fills) {
    const asset = scope.mediaAssets.get(owner, plan.assetId);
    if (asset === undefined || asset.contentId !== contentId) targetChanged(contentId, "the media file to fill in is gone");
    scope.mediaAssets.update(owner, { ...asset, storageRef, sizeBytes: placed.sizeBytes, fingerprint, availability: "available" });
    return;
  }
  const asset: MediaAsset = {
    id: plan.assetId,
    userId: owner,
    contentId,
    kind: plan.targetKind,
    storageRef,
    ...(plan.media.displayName === undefined ? {} : { displayName: plan.media.displayName }),
    mimeType: plan.media.mimeType,
    sizeBytes: placed.sizeBytes,
    ...(plan.media.durationMs === undefined ? {} : { durationMs: plan.media.durationMs }),
    // The carried quality is a claim; marked unverified, the start-up probe reads it from the file.
    ...(plan.targetKind === "platform_cache" && plan.media.quality !== undefined ? { quality: plan.media.quality, qualityVerified: false } : {}),
    fingerprint,
    availability: "available",
    retentionPolicy: plan.targetKind === "external_local" ? "never_delete" : plan.targetKind === "managed_upload" ? "keep" : "evictable",
    createdAt: now,
  };
  scope.mediaAssets.insert(asset);
}
