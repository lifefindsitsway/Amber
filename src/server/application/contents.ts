import { monotonicFactory } from "ulid";
import { SUBTITLE_IMPORT_MAX_BYTES } from "../../shared/defaults.ts";
import type {
  ContentDetailDto,
  ContentDto,
  ContentListDto,
  ContentPatchRequest,
  MediaAssetDto,
  SubtitleImportRequest,
  SubtitleImportResponse,
  TranscriptRevisionDto,
  TranscriptRevisionListDto,
} from "../../shared/dto/content.ts";
import type { ContentSourceKind, ProcessingStatus } from "../../shared/enums.ts";
import { BYTES_PER_MB } from "../../shared/units.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import { canonicalLanguageTag, importedTranscript, parseTimedSubtitle } from "../domain/subtitle-file.ts";
import { importedSubtitleWarnings } from "../domain/subtitle-verdict.ts";
import type { TranscriptRevision } from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { ContentCursor, Repository, RepositoryScope } from "../ports/repository.ts";
import { revisionListItems } from "./revision-references.ts";

export interface ContentServiceOptions {
  repository: Repository;
  /**
   * Local mode only: resolves a managed file's absolute path so `localPath` can be filled
   * in for the desktop player. Absent in server mode, which never
   * sends a path.
   */
  localPaths?: LocalPathResolver;
  now?: () => number;
  newId?: () => string;
}

export interface ContentListRequest {
  limit: number;
  cursor?: string;
  /** Numbered page from 1, in place of `cursor`. */
  page?: number;
  status?: ProcessingStatus;
  source?: ContentSourceKind;
  collectionId?: string;
  uncollected?: boolean;
  importBatchId?: string;
  ids?: readonly string[];
}

type SubtitleImportFormat = NonNullable<SubtitleImportRequest["format"]>;

/**
 * `title` carries the display title, so every list and page shows the user's rename without
 * knowing of it. `trashedAt` never leaves: a Content shown is never in the trash.
 */
export function contentDto(content: Content, collections: ContentDto["collections"]): ContentDto {
  const { userId: _owner, title: _title, trashedAt: _trashed, ...rest } = content;
  const title = displayTitle(content);
  return { ...rest, ...(title === undefined ? {} : { title }), collections: collections.map((collection) => ({ ...collection })) };
}

/** DTOs of several Contents with their collection memberships, read in one query. */
export function contentDtos(scope: RepositoryScope, owner: string, contents: readonly Content[]): ContentDto[] {
  const memberships = scope.collections.membershipsOf(owner, contents.map((content) => content.id));
  return contents.map((content) => contentDto(content, memberships.get(content.id) ?? []));
}

/**
 * Resolves a `platform_cache` reference to an absolute path; only the local composition
 * has one. Caches are the only managed files the desktop player opens by path, and they
 * live in the cache store, which may sit on another volume.
 */
export interface LocalPathResolver {
  pathOf(ref: string): string;
  /**
   * Whether an absolute path names an existing regular file. When present, reading a
   * Content notices local files that vanished outside Amber.
   */
  isFile?(path: string): boolean;
  /**
   * Whether the cache root is mounted right now. When it answers `false`, a cache whose file
   * cannot be seen is left `available`: the volume is unplugged, not the file gone.
   */
  cacheAvailable?(): boolean;
}

/**
 * The absolute file the desktop player may open: only for available
 * originals the user owns on disk and for platform caches. Without a resolver (server
 * mode) there is never a path.
 */
function localPathOf(asset: MediaAsset, localPaths: LocalPathResolver | undefined): string | undefined {
  if (localPaths === undefined || asset.availability !== "available") {
    return undefined;
  }
  switch (asset.kind) {
    case "external_local":
      return asset.storageRef;
    case "platform_cache":
      return localPaths.pathOf(asset.storageRef);
    default:
      return undefined;
  }
}

/**
 * Media as the UI may see it: no storage reference or fingerprint. `localPath` is filled in
 * only when a resolver is given, which the local composition alone does; server mode never
 * emits the key.
 */
export function mediaAssetDto(asset: MediaAsset, localPaths?: LocalPathResolver): MediaAssetDto {
  const localPath = localPathOf(asset, localPaths);
  return {
    id: asset.id,
    ...(localPath === undefined ? {} : { localPath }),
    kind: asset.kind,
    ...(asset.displayName === undefined ? {} : { displayName: asset.displayName }),
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
    ...(asset.quality === undefined ? {} : { quality: asset.quality }),
    ...(asset.kind === "platform_cache" ? { qualityVerified: asset.qualityVerified === true } : {}),
    availability: asset.availability,
    retentionPolicy: asset.retentionPolicy,
    createdAt: asset.createdAt,
  };
}

export function transcriptRevisionDto(revision: TranscriptRevision): TranscriptRevisionDto {
  return { ...revision, generation: { ...revision.generation } };
}

function encodeCursor(position: ContentCursor): string {
  return Buffer.from(JSON.stringify([position.pinnedAt ?? null, position.createdAt, position.id])).toString("base64url");
}

function decodeCursor(cursor: string): ContentCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const [pinnedAt, createdAt, id] = Array.isArray(parsed) && parsed.length === 3 ? parsed : [];
    const pinned = pinnedAt === null || (typeof pinnedAt === "number" && Number.isInteger(pinnedAt));
    if (pinned && typeof createdAt === "number" && Number.isInteger(createdAt) && typeof id === "string" && id.length > 0) {
      return { ...(pinnedAt === null ? {} : { pinnedAt: pinnedAt as number }), createdAt, id };
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, SubtitleImportFormat>> = { srt: "srt", vtt: "vtt", txt: "txt", md: "md", markdown: "md" };

/**
 * The declared format, else the file name's extension, else the content: text with cue
 * timing is a timed subtitle, anything else plain text.
 */
function importFormat(body: SubtitleImportRequest): SubtitleImportFormat | "timed" {
  if (body.format !== undefined) {
    return body.format;
  }
  const extension = body.filename?.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  const byName = extension === undefined ? undefined : FORMAT_BY_EXTENSION[extension];
  if (byName !== undefined) {
    return byName;
  }
  try {
    parseTimedSubtitle(body.text);
    return "timed";
  } catch {
    return "txt";
  }
}

/**
 * Reading Contents and their transcripts, choosing the primary transcript, and importing
 * a subtitle or reference text into an existing Content.
 */
export class ContentService {
  private readonly options: ContentServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: ContentServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  list(principal: RequestPrincipal, query: ContentListRequest): ContentListDto {
    if (query.page !== undefined) {
      return this.numberedPage(principal.userId, query, query.page);
    }
    const owner = principal.userId;
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const { cursor: _cursor, page: _page, ...filters } = query;
    const { contents, items, total } = this.options.repository.withTransaction((scope) => {
      const page = scope.contents.page(owner, { ...filters, ...(after === undefined ? {} : { after }) });
      return { contents: page, items: contentDtos(scope, owner, page), total: scope.contents.count(owner, filters) };
    });
    const last = contents.at(-1);
    return {
      items,
      total,
      ...(last !== undefined && contents.length === query.limit ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  /**
   * Page `page` of `limit` rows in the same order the cursor walks, without `nextCursor`.
   * Counting first lets a page past the end answer empty without reading rows; the count and
   * the rows share one transaction, so `total` matches the rows returned.
   */
  private numberedPage(owner: string, query: ContentListRequest, page: number): ContentListDto {
    if (query.cursor !== undefined) {
      throw amberError("invalid_request", "page and cursor exclude each other", { params: { detail: "page" } });
    }
    if (!Number.isSafeInteger(page) || page < 1) {
      throw amberError("invalid_request", "page must be a positive integer", { params: { detail: "page" } });
    }
    const { cursor: _cursor, page: _page, limit, ...filters } = query;
    return this.options.repository.withTransaction((scope) => {
      const total = scope.contents.count(owner, filters);
      // Compared as page indexes, not offsets, so a huge `page` never multiplies past safe integers.
      if (page - 1 > Math.floor((total - 1) / limit)) {
        return { items: [], total };
      }
      const contents = scope.contents.page(owner, { ...filters, limit, offset: (page - 1) * limit });
      return { items: contentDtos(scope, owner, contents), total };
    });
  }

  /**
   * Local mode: a file moved or deleted outside Amber is noticed when its Content is opened,
   * not only when a Task next reads it, so the page can offer relinking at once.
   * The user's own original becomes `missing`; a vanished cache is simply `evicted`, since
   * caching again restores it, except while the whole cache root is unavailable, when
   * nothing can be said about any single file. A file that reappears stays as recorded
   * until relinked, which re-checks its fingerprint.
   */
  private withCurrentAvailability(scope: RepositoryScope, asset: MediaAsset): MediaAsset {
    const resolver = this.options.localPaths;
    if (resolver?.isFile === undefined || asset.availability !== "available") {
      return asset;
    }
    if (asset.kind !== "external_local" && asset.kind !== "platform_cache") {
      return asset;
    }
    if (asset.kind === "platform_cache" && resolver.cacheAvailable?.() === false) {
      return asset;
    }
    const path = asset.kind === "external_local" ? asset.storageRef : resolver.pathOf(asset.storageRef);
    if (resolver.isFile(path)) {
      return asset;
    }
    const updated: MediaAsset = { ...asset, availability: asset.kind === "external_local" ? "missing" : "evicted" };
    scope.mediaAssets.update(asset.userId, updated);
    return updated;
  }

  get(principal: RequestPrincipal, contentId: string): ContentDetailDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      const [dto] = contentDtos(scope, owner, [content]) as [ContentDto];
      const media = scope.mediaAssets.listByContent(owner, contentId).map((asset) => this.withCurrentAvailability(scope, asset));
      return { ...dto, media: media.map((asset) => mediaAssetDto(asset, this.options.localPaths)) };
    });
  }

  revisions(principal: RequestPrincipal, contentId: string): TranscriptRevisionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      return {
        ...(content.primaryTranscriptRevisionId === undefined ? {} : { primaryTranscriptRevisionId: content.primaryTranscriptRevisionId }),
        revisions: revisionListItems(scope, owner, content),
      };
    });
  }

  /** The user's explicit choice of the current transcript; translations never qualify. */
  setPrimary(principal: RequestPrincipal, contentId: string, revisionId: string): ContentDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      if (scope.contents.get(owner, contentId) === undefined) {
        throw amberError("not_found", "content not found");
      }
      const revision = scope.transcripts.getRevision(owner, revisionId);
      if (revision === undefined || revision.contentId !== contentId) {
        throw amberError("not_found", "transcript revision not found");
      }
      if (revision.kind === "translated") {
        throw amberError("invalid_request", "a translation cannot be the primary transcript", { params: { detail: "revisionId" } });
      }
      // An archived revision is out of every picker; it has to be restored before it can be current.
      if (scope.transcripts.listArchived(owner, contentId).some((entry) => entry.revisionId === revisionId)) {
        throw amberError("invalid_request", "an archived revision cannot be the primary transcript", { params: { detail: "revisionId" } });
      }
      scope.contents.setPrimaryTranscript(owner, contentId, revisionId, this.now());
      scope.search.syncContent(owner, contentId);
      return contentDtos(scope, owner, [scope.contents.get(owner, contentId) as Content])[0] as ContentDto;
    });
  }

  /**
   * The user's own title and pin. A rename re-derives the search projection in the same
   * transaction; a pin changes only the listing order.
   */
  patch(principal: RequestPrincipal, contentId: string, body: ContentPatchRequest): ContentDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      if (scope.contents.get(owner, contentId) === undefined) {
        throw amberError("not_found", "content not found");
      }
      const now = this.now();
      if (body.title !== undefined) {
        scope.contents.setCustomTitle(owner, contentId, body.title ?? undefined, now);
        scope.search.syncContent(owner, contentId);
      }
      if (body.pinned !== undefined) {
        scope.contents.setPinned(owner, contentId, body.pinned ? now : undefined);
      }
      return contentDtos(scope, owner, [scope.contents.get(owner, contentId) as Content])[0] as ContentDto;
    });
  }

  /**
   * SRT / VTT become an `imported` revision that is made primary; TXT / Markdown become a
   * ReferenceText and leave the primary alone. A timeline that does not
   * fit the known media duration is only reported as a warning.
   */
  importSubtitle(principal: RequestPrincipal, contentId: string, body: SubtitleImportRequest): SubtitleImportResponse {
    const owner = principal.userId;
    if (Buffer.byteLength(body.text, "utf8") > SUBTITLE_IMPORT_MAX_BYTES) {
      throw amberError("media_too_large", "subtitle text is too large", { params: { limit: `${SUBTITLE_IMPORT_MAX_BYTES / BYTES_PER_MB} MB` } });
    }
    const format = importFormat(body);
    const now = this.now();
    if (format === "txt" || format === "md") {
      return this.options.repository.withTransaction((scope) => {
        if (scope.contents.get(owner, contentId) === undefined) {
          throw amberError("not_found", "content not found");
        }
        const id = this.newId();
        scope.referenceTexts.insert(owner, { id, contentId, origin: format === "md" ? "md_import" : "txt_import", text: body.text, createdAt: now });
        scope.search.syncContent(owner, contentId);
        return { referenceTextId: id, warnings: [] };
      });
    }
    const language = body.language === undefined ? undefined : canonicalLanguageTag(body.language);
    if (language === undefined) {
      throw amberError("invalid_request", "a timed subtitle needs its language", { params: { detail: "language" } });
    }
    const subtitle = parseTimedSubtitle(body.text);
    if (format !== "timed" && format !== subtitle.format) {
      throw amberError("invalid_request", "subtitle content does not match its declared format", { code: "invalid_request.subtitle_format" });
    }
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      const { revision, segments } = importedTranscript({ revisionId: this.newId(), contentId, language, subtitle, newId: this.newId, createdAt: now });
      scope.transcripts.insertRevision(owner, revision, segments);
      scope.contents.setPrimaryTranscript(owner, contentId, revision.id, now);
      scope.search.syncContent(owner, contentId);
      const warnings = [
        ...(subtitle.droppedCues > 0 ? ["subtitle_cue_dropped"] : []),
        ...(content.durationMs === undefined ? [] : importedSubtitleWarnings(segments, content.durationMs)),
      ];
      return { transcriptRevisionId: revision.id, warnings };
    });
  }
}

