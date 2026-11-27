import { createHash } from "node:crypto";
import { IMPORT_BATCH_MAX } from "../../shared/defaults.ts";
import type {
  ContentPackExportPlanDto,
  ContentPackExportPlanRequest,
  ContentPackSelection,
  ExportPlanCollection,
  ExportPlanContent,
  ExportPlanMedia,
  PackMediaUnavailableReason,
  PackSelectionProblem,
} from "../../shared/dto/content-pack.ts";
import type { SpeakerAvatarMime } from "../../shared/dto/speaker.ts";
import { isComparisonRevision } from "../domain/comparison-revision.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import {
  PACK_COVER_LIMITS,
  packCoverEntry,
  type CollectionsDocument,
  type ContentDocument,
  type PackFigure,
  type PackMedia,
  type PackNote,
  type PackRevision,
  type PackSegment,
  type PackSpeaker,
  type RevisionDocument,
} from "../domain/content-pack/document.ts";
import { packGenerationOf } from "../domain/content-pack/generation.ts";
import { originOf, speakerOriginOf } from "../domain/content-pack/identity.ts";
import { amberError } from "../domain/errors.ts";
import { inspectPackAvatar, inspectPackWebp } from "../domain/figure-image.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { PackExportBuild, PackExportBuildHooks, PackExportMedia } from "./content-pack-engine.ts";

/**
 * The export half of the content pack engine: what each Content can carry (the wizard's
 * plan), the server-side check of a selection, and every document of the pack. Only reads.
 */

export type RunMode = "server" | "local";

/** Media kinds a pack carries as the user's original in each run mode; `extracted_audio` / `temporary` never travel. */
const ORIGINAL_KIND: Record<RunMode, MediaAsset["kind"]> = { local: "external_local", server: "managed_upload" };

function selectionProblem(reason: PackSelectionProblem, contentId?: string): never {
  throw amberError("invalid_request", `content pack selection refused: ${reason}`, {
    code: "invalid_request.pack_selection",
    params: { detail: reason },
    details: { reason, ...(contentId === undefined ? {} : { contentId }) },
  });
}

function contentNotFound(): never {
  throw amberError("not_found", "content not found");
}

/** A Content of the owner outside the trash; another user's or a trashed one is unknown. */
function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  return scope.contents.get(owner, contentId) ?? contentNotFound();
}

/** Revisions a pack may carry: every one but comparison transcriptions, oldest first. */
function carryableRevisions(scope: RepositoryScope, owner: string, contentId: string): TranscriptRevision[] {
  return scope.transcripts.listRevisions(owner, contentId).filter((revision) => !isComparisonRevision(revision));
}

/** The media a pack may carry: the run mode's originals and platform caches. */
function carryableMedia(scope: RepositoryScope, owner: string, contentId: string, mode: RunMode): MediaAsset[] {
  return scope.mediaAssets.listByContent(owner, contentId).filter((asset) => asset.kind === ORIGINAL_KIND[mode] || asset.kind === "platform_cache");
}

/** Why a media file cannot be carried: gone from its place, or removed by its retention policy. */
function unavailableReason(asset: MediaAsset): PackMediaUnavailableReason | undefined {
  if (asset.availability === "available") return undefined;
  if (asset.kind === "managed_upload" && asset.availability === "evicted") return "discarded";
  return "missing";
}

function isLocalSource(content: Content): boolean {
  return content.source.kind === "local";
}

export function exportPlan(repository: Repository, mode: RunMode, owner: string, request: ContentPackExportPlanRequest): ContentPackExportPlanDto {
  return repository.withTransaction((scope) => {
    const contentIds = [...new Set(request.contentIds)];
    const contents = contentIds.map((id) => ownedContent(scope, owner, id));
    const unfinished = scope.tasks.listUnfinishedOf(owner);
    const planned = contents.map((content): ExportPlanContent => {
      const revisions = carryableRevisions(scope, owner, content.id);
      const archived = new Set(scope.transcripts.listArchived(owner, content.id).map((entry) => entry.revisionId));
      const currentTranslations = new Set(scope.translations.listArtifacts(owner, content.id).flatMap((artifact) => (artifact.currentRevisionId === undefined ? [] : [artifact.currentRevisionId])));
      const figures = scope.figures.listByContent(owner, content.id).filter((figure) => figure.deletedAt === undefined);
      const notes = scope.notes.listByContent(owner, content.id);
      const comparisonOnly = scope.speakers.comparisonOnlyIds(owner, content.id);
      const speakers = scope.speakers.list(owner, content.id).filter((speaker) => !comparisonOnly.has(speaker.id));
      const media = carryableMedia(scope, owner, content.id, mode).map((asset): ExportPlanMedia => {
        const unavailable = unavailableReason(asset);
        return {
          assetId: asset.id,
          kind: asset.kind === "platform_cache" ? "cache" : "original",
          ...(asset.displayName === undefined ? {} : { displayName: asset.displayName }),
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          ...(asset.kind === "platform_cache" && asset.quality !== undefined ? { quality: asset.quality } : {}),
          ...(unavailable === undefined ? {} : { unavailable }),
        };
      });
      const nothingToCarry = isLocalSource(content) && revisions.length === 0 && !media.some((item) => item.unavailable === undefined);
      const busy = unfinished.find((task) => task.contentId === content.id)?.id;
      const title = displayTitle(content);
      return {
        contentId: content.id,
        ...(title === undefined ? {} : { title }),
        sourceKind: content.source.kind,
        ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
        revisions: revisions.map((revision) => ({
          id: revision.id,
          kind: revision.kind,
          ...(revision.parentRevisionId === undefined ? {} : { parentRevisionId: revision.parentRevisionId }),
          language: revision.language,
          timingFidelity: revision.timingFidelity,
          generation: { ...revision.generation },
          segmentCount: revision.segmentCount,
          createdAt: revision.createdAt,
          primary: content.primaryTranscriptRevisionId === revision.id,
          archived: archived.has(revision.id),
          currentTranslation: revision.kind === "translated" && currentTranslations.has(revision.id),
          anchoredFigures: figures.filter((figure) => figure.anchor?.revisionId === revision.id).length,
          notes: notes.filter((note) => note.transcriptRevisionId === revision.id).length,
        })),
        figures: figures.length,
        notes: notes.length,
        speakers: speakers.length,
        platformChapters: scope.chapters.hasPlatformChapters(owner, content.id),
        media,
        ...(nothingToCarry ? { blocked: "nothing_to_carry" as const } : busy === undefined ? {} : { blocked: "busy" as const, busyTaskId: busy }),
      };
    });

    const preselected = request.collectionId;
    if (preselected !== undefined && scope.collections.get(owner, preselected) === undefined) {
      throw amberError("not_found", "collection not found");
    }
    const memberships = scope.collections.membershipsOf(owner, contentIds);
    const collectionIds = [...new Set([...(preselected === undefined ? [] : [preselected]), ...[...memberships.values()].flatMap((list) => list.map((entry) => entry.id))])];
    const collections = collectionIds.flatMap((collectionId): ExportPlanCollection[] => {
      const collection = scope.collections.get(owner, collectionId);
      if (collection === undefined) return [];
      const planned = new Set(contentIds);
      return [
        {
          collectionId,
          name: collection.name,
          memberCount: scope.collections.listVisibleItems(owner, collectionId).length,
          contentIds: scope.collections.listItems(owner, collectionId).flatMap((item) => (planned.has(item.contentId) ? [item.contentId] : [])),
        },
      ];
    });
    return { contents: planned, collections };
  });
}

/**
 * The server's own check of what the wizard sent, before anything is read: every Content is
 * the owner's and idle, every revision and media file is carryable and belongs to it, every
 * translation comes with its original, every Content carries something usable, and every
 * collection holds one of the Contents.
 */
export function validateSelection(scope: RepositoryScope, mode: RunMode, owner: string, selection: ContentPackSelection): void {
  if (selection.contents.length === 0) selectionProblem("empty");
  if (selection.contents.length > IMPORT_BATCH_MAX) selectionProblem("too_many_contents");
  const seen = new Set<string>();
  const unfinished = scope.tasks.listUnfinishedOf(owner);
  for (const picked of selection.contents) {
    const content = ownedContent(scope, owner, picked.contentId);
    if (seen.has(content.id)) selectionProblem("not_carryable", content.id);
    seen.add(content.id);
    const revisions = new Map(carryableRevisions(scope, owner, content.id).map((revision) => [revision.id, revision]));
    const chosen = new Set(picked.revisionIds);
    if (chosen.size !== picked.revisionIds.length) selectionProblem("not_carryable", content.id);
    for (const revisionId of chosen) {
      const revision = revisions.get(revisionId);
      if (revision === undefined) selectionProblem("not_carryable", content.id);
      if (revision.kind === "translated" && (revision.parentRevisionId === undefined || !chosen.has(revision.parentRevisionId))) {
        selectionProblem("translation_without_parent", content.id);
      }
    }
    const media = new Map(carryableMedia(scope, owner, content.id, mode).map((asset) => [asset.id, asset]));
    const pickedMedia = new Set(picked.mediaAssetIds);
    if (pickedMedia.size !== picked.mediaAssetIds.length) selectionProblem("not_carryable", content.id);
    for (const assetId of pickedMedia) {
      const asset = media.get(assetId);
      if (asset === undefined || unavailableReason(asset) !== undefined) selectionProblem("not_carryable", content.id);
    }
    if (isLocalSource(content) && chosen.size === 0 && pickedMedia.size === 0) selectionProblem("nothing_to_carry", content.id);
    const busy = unfinished.find((task) => task.contentId === content.id);
    if (busy !== undefined) {
      throw amberError("conflict", "a Content of the pack has an unfinished Task", { code: "conflict.pack_content_busy", details: { contentId: content.id, taskId: busy.id } });
    }
  }
  const collectionIds = new Set(selection.collectionIds);
  if (collectionIds.size !== selection.collectionIds.length) selectionProblem("not_carryable");
  for (const collectionId of collectionIds) {
    if (scope.collections.get(owner, collectionId) === undefined) {
      throw amberError("not_found", "collection not found");
    }
    if (!scope.collections.listItems(owner, collectionId).some((item) => seen.has(item.contentId))) selectionProblem("not_carryable");
  }
}

// ---------------------------------------------------------------------------------------------
// Building the documents

/** A speaker photo read in the transaction, checked or re-encoded after it. */
interface PendingAvatar {
  speakerIndex: number;
  bytes: Uint8Array;
  mime: SpeakerAvatarMime;
}

/** A media file read in the transaction; its digest is computed afterwards when not recorded. */
interface PendingMedia {
  asset: MediaAsset;
  entry: string;
  pack: Omit<PackMedia, "sha256">;
  sha256?: string;
}

interface ReadContent {
  content: Content;
  entry: string;
  document: Omit<ContentDocument, "speakers" | "media">;
  speakers: PackSpeaker[];
  revisions: Array<{ entry: string; document: RevisionDocument }>;
  /** The local cover copy and figure images, in archive order. */
  figureImages: Array<{ entry: string; bytes: Uint8Array }>;
  avatars: PendingAvatar[];
  media: PendingMedia[];
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-flv": "flv",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
};

/** The extension a media entry gets: the file's own when it is a plain one, else the MIME type's. */
function mediaExtension(name: string | undefined, mimeType: string): string {
  const own = name?.match(/\.([A-Za-z0-9]{1,8})$/u)?.[1]?.toLowerCase();
  return own ?? MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
}

function baseName(path: string): string {
  return path.split(/[\\/]/u).filter((part) => part !== "").at(-1) ?? path;
}

const AVATAR_EXTENSIONS: Record<SpeakerAvatarMime, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" };

/** `sha256:<hex>` → `<hex>`, when it is one. */
function hexOfFingerprint(fingerprint: string | undefined): string | undefined {
  const match = fingerprint?.match(/^sha256:([0-9a-f]{64})$/u);
  return match?.[1];
}

/**
 * Every document of a pack for a selection checked by `validateSelection`. The library is read
 * in one transaction (a consistent snapshot); photo re-encoding and media hashing run after it.
 */
export async function buildExport(
  repository: Repository,
  mode: RunMode,
  owner: string,
  selection: ContentPackSelection,
  hooks: PackExportBuildHooks,
  logger: Logger | undefined,
): Promise<PackExportBuild> {
  const { collections, contents } = repository.withTransaction((scope) => {
    validateSelection(scope, mode, owner, selection);
    const read = selection.contents.map((picked, index) => readContent(scope, mode, owner, picked, index, logger));
    const keys = new Map(read.map((item) => [item.content.id, item.document.key]));
    const document: CollectionsDocument = {
      collections: selection.collectionIds.map((collectionId) => {
        const collection = scope.collections.get(owner, collectionId) ?? contentNotFound();
        const contentKeys = scope.collections.listItems(owner, collectionId).flatMap((item) => {
          const key = keys.get(item.contentId);
          return key === undefined ? [] : [key];
        });
        return {
          key: originOf(collection),
          name: collection.name,
          ...(collection.description === undefined ? {} : { description: collection.description }),
          ...(collection.platformCollectionId === undefined ? {} : { platformCollectionId: collection.platformCollectionId }),
          contentKeys: [...new Set(contentKeys)],
        };
      }),
    };
    return { collections: document, contents: read };
  });

  const built: PackExportBuild["contents"] = [];
  for (const item of contents) {
    hooks.signal.throwIfAborted();
    const images = [...item.figureImages];
    const speakers = [...item.speakers];
    for (const avatar of item.avatars) {
      const placed = await packAvatar(avatar, hooks);
      const speaker = speakers[avatar.speakerIndex] as PackSpeaker;
      if (placed === undefined) {
        logger?.warn("content_pack.avatar_left_out", { contentId: item.content.id });
        continue;
      }
      const entry = `${item.entry.slice(0, item.entry.lastIndexOf("/"))}/avatars/${avatar.speakerIndex}.${AVATAR_EXTENSIONS[placed.mime]}`;
      speakers[avatar.speakerIndex] = { ...speaker, avatar: { entry, mime: placed.mime } };
      images.push({ entry, bytes: placed.bytes });
    }
    const media: PackExportMedia[] = [];
    const packMedia: PackMedia[] = [];
    for (const pending of item.media) {
      const location = pending.asset.kind === "external_local" ? { path: pending.asset.storageRef } : { storageRef: pending.asset.storageRef };
      const base = { assetId: pending.asset.id, contentId: item.content.id, kind: pending.pack.kind, location, sizeBytes: pending.asset.sizeBytes };
      const sha256 = pending.sha256 ?? (await hooks.hashMedia(base, hooks.signal));
      media.push({ ...base, entry: pending.entry, sha256 });
      packMedia.push({ ...pending.pack, sha256 });
    }
    const document: ContentDocument = { ...item.document, speakers, media: packMedia };
    const title = displayTitle(item.content);
    built.push({ contentId: item.content.id, ...(title === undefined ? {} : { title }), entry: item.entry, document, revisions: item.revisions, images, media });
  }
  return { collections, contents: built };
}

/** A photo as the pack carries it: as stored when it passes the structural check, else re-encoded to WebP. */
async function packAvatar(avatar: PendingAvatar, hooks: PackExportBuildHooks): Promise<{ bytes: Uint8Array; mime: SpeakerAvatarMime } | undefined> {
  if (inspectPackAvatar(avatar.bytes, avatar.mime).ok) {
    return { bytes: avatar.bytes, mime: avatar.mime };
  }
  const webp = await hooks.normalizeAvatar(avatar.bytes, hooks.signal);
  return inspectPackAvatar(webp, "image/webp").ok ? { bytes: webp, mime: "image/webp" } : undefined;
}

/**
 * A platform Content's local cover copy as the pack carries it, beside the Content's document.
 * Every stored cover was made by Amber, so one that fails the pack's own check means a damaged
 * row: the cover is left out and the Content travels with its cover URL alone.
 */
function packCover(
  scope: RepositoryScope,
  owner: string,
  content: Content,
  entryOfDocument: string,
  logger: Logger | undefined,
): { entry: string; bytes: Uint8Array; document: NonNullable<ContentDocument["cover"]> } | undefined {
  if (isLocalSource(content)) return undefined;
  const stored = scope.contentCovers.get(owner, content.id);
  if (stored === undefined) return undefined;
  const checked = inspectPackWebp(stored.bytes, PACK_COVER_LIMITS);
  if (!checked.ok) {
    logger?.warn("content_pack.cover_left_out", { contentId: content.id });
    return undefined;
  }
  const entry = packCoverEntry(entryOfDocument);
  const sha256 = createHash("sha256").update(stored.bytes).digest("hex");
  return { entry, bytes: stored.bytes, document: { entry, width: checked.width, height: checked.height, bytes: stored.bytes.length, sha256 } };
}

function readContent(scope: RepositoryScope, mode: RunMode, owner: string, picked: ContentPackSelection["contents"][number], index: number, logger: Logger | undefined): ReadContent {
  const content = ownedContent(scope, owner, picked.contentId);
  const contentKey = originOf(content);
  const prefix = `contents/${index}`;
  const all = scope.transcripts.listRevisions(owner, content.id);
  const byId = new Map(all.map((revision) => [revision.id, revision]));
  const chosen = new Set(picked.revisionIds);
  const carried = all.filter((revision) => chosen.has(revision.id));
  const archived = new Map(scope.transcripts.listArchived(owner, content.id).map((entry) => [entry.revisionId, entry.archivedAt]));
  const confirmed = scope.speakerConfirmations.confirmedAmong(owner, carried.map((revision) => revision.id));
  const currentTranslations = new Set(scope.translations.listArtifacts(owner, content.id).flatMap((artifact) => (artifact.currentRevisionId === undefined ? [] : [artifact.currentRevisionId])));

  // Sentences of every carried revision and of each carried revision's parent (for sources).
  const segmentsOf = new Map<string, TranscriptSegment[]>();
  const loadSegments = (revisionId: string): TranscriptSegment[] => {
    let segments = segmentsOf.get(revisionId);
    if (segments === undefined) {
      segments = scope.transcripts.listSegments(owner, revisionId);
      segmentsOf.set(revisionId, segments);
    }
    return segments;
  };
  const position = new Map<string, { revisionId: string; ordinal: number }>();
  for (const revision of carried) {
    loadSegments(revision.id).forEach((segment, ordinal) => position.set(segment.id, { revisionId: revision.id, ordinal }));
  }

  // Speakers named by carried sentences, in the Content's ordinal order.
  const speakersAll = scope.speakers.list(owner, content.id);
  const named = new Set(carried.flatMap((revision) => loadSegments(revision.id).flatMap((segment) => (segment.speakerId === undefined ? [] : [segment.speakerId]))));
  const packedSpeakers = speakersAll.filter((speaker) => named.has(speaker.id));
  const speakerIndex = new Map(packedSpeakers.map((speaker, at) => [speaker.id, at]));
  const avatars: PendingAvatar[] = [];
  const speakers = packedSpeakers.map((speaker, at): PackSpeaker => {
    const identity = speakerOriginOf(speaker, contentKey);
    if (speaker.avatar !== undefined) {
      const stored = scope.speakers.getAvatar(owner, content.id, speaker.id);
      if (stored !== undefined) avatars.push({ speakerIndex: at, bytes: stored.bytes, mime: stored.mime });
    }
    return {
      originContentKey: identity.contentId,
      originSpeakerId: identity.speakerId,
      ordinal: speaker.ordinal,
      ...(speaker.name === undefined ? {} : { name: speaker.name }),
      ...(speaker.nameConfirmedAt === undefined ? {} : { nameConfirmedAt: speaker.nameConfirmedAt }),
      colorIndex: speaker.colorIndex,
    };
  });

  const revisionKey = (revisionId: string): string => originOf(byId.get(revisionId) ?? { id: revisionId });
  const packRevisions: PackRevision[] = [];
  const revisionDocuments: Array<{ entry: string; document: RevisionDocument }> = [];
  carried.forEach((revision, at) => {
    const entry = `${prefix}/revisions/${at}.json`;
    const key = originOf(revision);
    const parentOrdinals = new Map((revision.parentRevisionId === undefined ? [] : loadSegments(revision.parentRevisionId)).map((segment, ordinal) => [segment.id, ordinal]));
    const archivedAt = archived.get(revision.id);
    const confirmedAt = confirmed.get(revision.id);
    packRevisions.push({
      key,
      entry,
      kind: revision.kind,
      ...(revision.parentRevisionId === undefined ? {} : { parentKey: revisionKey(revision.parentRevisionId) }),
      language: revision.language,
      timingFidelity: revision.timingFidelity,
      generation: packGenerationOf(revision),
      ...(revision.looseJoin === true ? { looseJoin: true as const } : {}),
      segmentCount: revision.segmentCount,
      createdAt: revision.createdAt,
      ...(archivedAt === undefined ? {} : { archivedAt }),
      ...(confirmedAt === undefined ? {} : { speakersConfirmedAt: confirmedAt }),
      ...(revision.kind === "translated" ? { currentTranslation: currentTranslations.has(revision.id) } : {}),
    });
    const segments = loadSegments(revision.id).map((segment): PackSegment => {
      const sources = segment.sourceSegmentIds.flatMap((id) => {
        const ordinal = parentOrdinals.get(id);
        return ordinal === undefined ? [] : [ordinal];
      });
      const speaker = segment.speakerId === undefined ? undefined : speakerIndex.get(segment.speakerId);
      return {
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        ...(segment.words === undefined ? {} : { words: segment.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })) }),
        ...(speaker === undefined ? {} : { speaker }),
        ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
        ...(revision.parentRevisionId === undefined ? {} : { sources }),
      };
    });
    revisionDocuments.push({ entry, document: { key, segments } });
  });

  const notes: PackNote[] = [];
  if (picked.notes) {
    for (const note of scope.notes.listByContent(owner, content.id)) {
      const start = position.get(note.startSegmentId);
      const end = position.get(note.endSegmentId);
      if (start === undefined || end === undefined || start.revisionId !== note.transcriptRevisionId || end.revisionId !== note.transcriptRevisionId) continue;
      const key = revisionKey(note.transcriptRevisionId);
      notes.push({
        key: originOf(note),
        start: { revisionKey: key, ordinal: start.ordinal },
        startOffset: note.startOffset,
        end: { revisionKey: key, ordinal: end.ordinal },
        endOffset: note.endOffset,
        quote: note.quote,
        mark: note.mark,
        color: note.color,
        ...(note.comment === undefined ? {} : { comment: note.comment }),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
    }
  }

  const figureImages: Array<{ entry: string; bytes: Uint8Array }> = [];
  const cover = packCover(scope, owner, content, `${prefix}/content.json`, logger);
  if (cover !== undefined) figureImages.push({ entry: cover.entry, bytes: cover.bytes });

  const figures: PackFigure[] = [];
  if (picked.figures) {
    for (const figure of scope.figures.listByContent(owner, content.id)) {
      if (figure.deletedAt !== undefined) continue;
      const bytes = scope.figures.getImage(owner, figure.id);
      const checked = bytes === undefined ? undefined : inspectPackWebp(bytes);
      if (bytes === undefined || checked === undefined || !checked.ok) {
        // Every stored figure was made or checked by Amber, so this means a damaged row.
        logger?.warn("content_pack.figure_left_out", { contentId: content.id, figureId: figure.id });
        continue;
      }
      const entry = `${prefix}/figures/${figures.length}.webp`;
      const anchorAt = figure.anchor === undefined ? undefined : position.get(figure.anchor.segmentId);
      const anchor = figure.anchor !== undefined && anchorAt !== undefined && anchorAt.revisionId === figure.anchor.revisionId
        ? { revisionKey: revisionKey(anchorAt.revisionId), ordinal: anchorAt.ordinal, side: figure.anchor.side }
        : undefined;
      figures.push({
        key: originOf(figure),
        entry,
        source: figure.source,
        ...(figure.capturedAtMs === undefined ? {} : { capturedAtMs: figure.capturedAtMs }),
        displayMs: figure.displayMs,
        ...(anchor === undefined ? {} : { anchor }),
        sortKey: figure.sortKey,
        widthRatio: figure.widthRatio,
        ...(figure.caption === undefined ? {} : { caption: figure.caption }),
        image: { width: checked.width, height: checked.height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
        createdAt: figure.createdAt,
        updatedAt: figure.updatedAt,
      });
      figureImages.push({ entry, bytes });
    }
  }

  const chapterRevisions = scope.chapters.listRevisions(owner, content.id).filter((revision) => revision.origin.kind === "platform");
  const current = scope.chapters.getCurrent(owner, content.id);
  const platformChapters = (current?.origin.kind === "platform" ? current : chapterRevisions.at(-1))?.chapters.map((chapter) => ({ startMs: chapter.startMs, endMs: chapter.endMs, title: chapter.title }));

  const assets = scope.mediaAssets.listByContent(owner, content.id);
  const chosenMedia = new Set(picked.mediaAssetIds);
  const originalFingerprint = assets.find((asset) => (asset.kind === "external_local" || asset.kind === "managed_upload") && hexOfFingerprint(asset.fingerprint) !== undefined)?.fingerprint;
  const media = carryableMedia(scope, owner, content.id, mode)
    .filter((asset) => chosenMedia.has(asset.id))
    .map((asset, at): PendingMedia => {
      const cache = asset.kind === "platform_cache";
      const fileName = cache ? baseName(asset.storageRef) : (asset.displayName ?? baseName(asset.storageRef));
      const sha256 = hexOfFingerprint(asset.fingerprint);
      const entry = `media/${index}/${at}.${mediaExtension(fileName, asset.mimeType)}`;
      return {
        asset,
        entry,
        pack: {
          key: asset.id,
          entry,
          kind: cache ? "cache" : "original",
          ...(cache ? {} : { displayName: fileName }),
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
          ...(cache && asset.quality !== undefined ? { quality: asset.quality } : {}),
          ...(cache ? { cacheFileName: fileName } : {}),
        },
        ...(sha256 === undefined ? {} : { sha256 }),
      };
    });

  const primary = content.primaryTranscriptRevisionId;
  const title = content.title;
  return {
    content,
    entry: `${prefix}/content.json`,
    document: {
      key: contentKey,
      source: {
        kind: content.source.kind,
        ...(content.source.sourceUrl === undefined ? {} : { sourceUrl: content.source.sourceUrl }),
        ...(content.source.platformContentId === undefined ? {} : { platformContentId: content.source.platformContentId }),
        ...(content.source.platformPartId === undefined ? {} : { platformPartId: content.source.platformPartId }),
        ...(content.source.platformCollectionId === undefined ? {} : { platformCollectionId: content.source.platformCollectionId }),
        ...(content.source.channelId === undefined ? {} : { channelId: content.source.channelId }),
        ...(content.source.channelTitle === undefined ? {} : { channelTitle: content.source.channelTitle }),
      },
      ...(title === undefined ? {} : { title }),
      ...(content.customTitle === undefined ? {} : { customTitle: content.customTitle }),
      // Only a platform Content has a cover on the web; a local file's is never carried.
      ...(content.coverUrl === undefined || isLocalSource(content) ? {} : { coverUrl: content.coverUrl }),
      ...(cover === undefined ? {} : { cover: cover.document }),
      ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
      ...(content.publishedAt === undefined ? {} : { publishedAt: content.publishedAt }),
      ...(content.rawLanguage === undefined ? {} : { rawLanguage: content.rawLanguage }),
      ...(content.description === undefined ? {} : { description: content.description }),
      ...(content.descriptionTruncated === true ? { descriptionTruncated: true as const } : {}),
      ...(originalFingerprint === undefined ? {} : { fingerprint: originalFingerprint }),
      ...(primary !== undefined && chosen.has(primary) ? { primaryRevisionKey: revisionKey(primary) } : {}),
      revisions: packRevisions,
      notes,
      figures,
      ...(platformChapters === undefined || platformChapters.length === 0 ? {} : { platformChapters }),
      createdAt: content.createdAt,
    },
    speakers,
    revisions: revisionDocuments,
    figureImages,
    avatars,
    media,
  };
}
