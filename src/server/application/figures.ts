import { monotonicFactory } from "ulid";
import { FIGURE_WIDTH_DEFAULT, FIGURES_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import {
  figureUploadMetaSchema,
  type FigureCaptureRequest,
  type FigureDto,
  type FigureListDto,
  type FigurePatchRequest,
  type FigurePlacement,
  type FigureUploadMeta,
} from "../../shared/dto/figure.ts";
import type { Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { FIGURE_DELETED_RETENTION_MS, type ContentFigure } from "../domain/figure.ts";
import { isVideoCache, type MediaAsset } from "../domain/media-asset.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { MediaFiles } from "../pipeline/media-files.ts";
import { assetPath, isOriginalMedia } from "../pipeline/stages/source-media.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { LocalMediaIngest } from "../ports/local-media-ingest.ts";
import type { Logger } from "../ports/logger.ts";
import type { FigurePatch, Repository, RepositoryScope } from "../ports/repository.ts";
import { figureFrameError, FigureImageProcessor, type FigureImage } from "./figure-images.ts";

/** One part of a figure upload as the route hands it over: the `meta` field, then the `file`. */
export type FigureUploadPart = { kind: "field"; name: string; value: string } | { kind: "file"; name: string; stream: AsyncIterable<Uint8Array> };

export interface FigureServiceOptions {
  repository: Repository;
  ingest: LocalMediaIngest;
  /** Resolves a media asset of the Content to a readable file for frame capture. */
  media: MediaFiles;
  /** The data directory's file store; its scratch area holds each job's temporary files. */
  files: FileStore;
  logger?: Logger;
  now?: () => number;
  newId?: () => string;
  /** Image jobs at once; `FIGURE_PROCESS_CONCURRENCY` by default. Ignored with `images`. */
  concurrency?: number;
  /**
   * The process's one image processor, shared with Content covers so both count against one
   * decoding limit. Absent: the service makes its own over `ingest` and `files`.
   */
  images?: FigureImageProcessor;
  /**
   * False until the start-up sweep has run. It empties the scratch area image jobs work in, so
   * captures and uploads wait for it (`conflict.starting_up`). Absent means ready.
   */
  backgroundReady?: () => boolean;
}

/** Expired deleted figures purged per transaction. */
const PURGE_BATCH = 200;

export function figureDto(figure: ContentFigure): FigureDto {
  return {
    id: figure.id,
    contentId: figure.contentId,
    source: figure.source,
    ...(figure.capturedAtMs === undefined ? {} : { capturedAtMs: figure.capturedAtMs }),
    placement: { displayMs: figure.displayMs, anchor: figure.anchor ?? null, sortKey: figure.sortKey },
    widthRatio: figure.widthRatio,
    ...(figure.caption === undefined ? {} : { caption: figure.caption }),
    image: { ...figure.image },
    version: figure.version,
    ...(figure.deletedAt === undefined ? {} : { deletedAt: figure.deletedAt }),
    createdAt: figure.createdAt,
    updatedAt: figure.updatedAt,
  };
}

function startingUp(): never {
  throw amberError("conflict", "start-up sweep still running", { code: "conflict.starting_up" });
}

function notFound(): never {
  throw amberError("not_found", "figure not found");
}

function purged(): never {
  throw amberError("not_found", "the figure was purged", { code: "not_found.figure_purged" });
}

function changed(currentVersion: number): never {
  throw amberError("conflict", "the figure changed since this version", { code: "conflict.figure_changed", details: { currentVersion } });
}

function invalid(detail: string, message = `invalid ${detail}`): never {
  throw amberError("invalid_request", message, { params: { detail } });
}

function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  return content;
}

/**
 * Figures of the reading view: frames captured from the Content's own video and images the
 * user uploaded or pasted, with caption, width and place. Like notes they are the user's own
 * learning layer: created, changed and deleted only by explicit actions, never derived.
 *
 * Every read and write is scoped to the principal and to a Content outside the trash; any
 * other figure is `not_found`. The image never changes after it was stored; caption, width
 * and place do, each change naming the version it read. Deleting is soft: a deleted figure
 * stays restorable for `FIGURE_DELETED_RETENTION_DAYS` and keeps counting against
 * `FIGURES_PER_CONTENT_MAX` until it is purged. Each write updates the figure's search entry
 * in the same transaction.
 */
export class FigureService {
  private readonly options: FigureServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly images: FigureImageProcessor;

  constructor(options: FigureServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.images =
      options.images ??
      new FigureImageProcessor({
        ingest: options.ingest,
        files: options.files,
        newId: this.newId,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      });
  }

  /** Live figures in no particular order, and the restorable deleted ones, newest deletion first. */
  list(principal: RequestPrincipal, contentId: string): FigureListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const now = this.now();
      const figures = scope.figures.listByContent(owner, contentId);
      return {
        items: figures.filter((figure) => figure.deletedAt === undefined).map(figureDto),
        recentlyDeleted: figures
          .filter((figure) => figure.deletedAt !== undefined && this.restorable(figure, now))
          .sort((a, b) => (b.deletedAt as number) - (a.deletedAt as number) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .map(figureDto),
        limit: FIGURES_PER_CONTENT_MAX,
      };
    });
  }

  /**
   * A frame of one of the Content's videos: the original file, or a video cache, available
   * now. `atMs` is clamped to the media's length. Without `placement` the figure is placed by
   * its capture time, after the figures already there.
   */
  async capture(principal: RequestPrincipal, contentId: string, body: FigureCaptureRequest, signal: AbortSignal): Promise<FigureDto> {
    const owner = principal.userId;
    const source = this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      this.ensureStarted();
      this.ensureRoom(scope, owner, contentId);
      if (body.placement !== undefined) this.checkAnchor(scope, owner, contentId, body.placement);
      const asset = captureSource(scope, owner, contentId, body.assetId);
      const atMs = asset.durationMs === undefined ? body.atMs : Math.min(body.atMs, asset.durationMs);
      return { path: assetPath(asset, this.options.media), atMs };
    });
    const image = await this.images.capture(owner, source, signal);
    return this.store(owner, contentId, image, {
      source: "capture",
      capturedAtMs: source.atMs,
      ...(body.placement === undefined ? {} : { placement: body.placement }),
      ...(body.widthRatio === undefined ? {} : { widthRatio: body.widthRatio }),
    });
  }

  /**
   * An uploaded or pasted image (multipart: `meta`, then `file`). The Content, the per-Content
   * cap and the placement are settled before the file is read, so a refused upload costs no
   * transfer; a refused image leaves nothing behind.
   */
  async upload(principal: RequestPrincipal, contentId: string, parts: AsyncIterable<FigureUploadPart>, signal: AbortSignal): Promise<FigureDto> {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      this.ensureStarted();
      this.ensureRoom(scope, owner, contentId);
    });
    let meta: FigureUploadMeta | undefined;
    let image: FigureImage | undefined;
    for await (const part of parts) {
      if (meta === undefined) {
        if (part.kind !== "field" || part.name !== "meta") invalid("meta", "the upload starts with its meta field");
        meta = parseMeta(part.value);
        const placement = meta.placement;
        this.options.repository.withTransaction((scope) => this.checkAnchor(scope, owner, contentId, placement));
        continue;
      }
      if (image !== undefined || part.kind !== "file" || part.name !== "file") invalid("file", `unexpected part ${JSON.stringify(part.name)}`);
      image = await this.images.upload(owner, part.stream, signal);
    }
    if (meta === undefined) invalid("meta", "the meta field is missing");
    if (image === undefined) invalid("file", "the image file is missing");
    return this.store(owner, contentId, image, {
      source: "upload",
      placement: meta.placement,
      ...(meta.widthRatio === undefined ? {} : { widthRatio: meta.widthRatio }),
    });
  }

  /**
   * Caption, width and place of a live figure, at the version the client read. `caption: null`
   * or a blank caption removes it. A deleted figure is reported as changed, like any other
   * figure that moved on since the client read it.
   */
  patch(principal: RequestPrincipal, figureId: string, body: FigurePatchRequest): FigureDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const figure = visibleFigure(scope, owner, figureId);
      if (figure.deletedAt !== undefined) changed(figure.version);
      if (body.placement !== undefined) this.checkAnchor(scope, owner, figure.contentId, body.placement);
      const patch: FigurePatch = {
        ...(body.caption === undefined ? {} : { caption: body.caption === null || body.caption.trim() === "" ? null : body.caption }),
        ...(body.widthRatio === undefined ? {} : { widthRatio: body.widthRatio }),
        ...(body.placement === undefined ? {} : { displayMs: body.placement.displayMs, anchor: body.placement.anchor, sortKey: body.placement.sortKey }),
      };
      const updated = scope.figures.update(owner, figureId, body.version, patch, this.now());
      if (updated === undefined) notFound();
      if ("conflict" in updated) changed(updated.currentVersion);
      scope.search.syncFigure(owner, updated.contentId, updated.id);
      return figureDto(updated);
    });
  }

  /** Soft delete; deleting a deleted figure again changes nothing. */
  delete(principal: RequestPrincipal, figureId: string): FigureDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const figure = visibleFigure(scope, owner, figureId);
      if (figure.deletedAt !== undefined) return figureDto(figure);
      const deleted = scope.figures.setDeleted(owner, figureId, this.now(), this.now()) ?? notFound();
      scope.search.syncFigure(owner, deleted.contentId, deleted.id);
      return figureDto(deleted);
    });
  }

  /**
   * Brings a deleted figure back within its retention; a live one is returned as it is. One
   * past retention, or one no longer stored at all, is `not_found.figure_purged`: a purged
   * figure leaves no trace to tell it from an id that never existed, and both answer alike.
   */
  restore(principal: RequestPrincipal, figureId: string): FigureDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const figure = scope.figures.get(owner, figureId);
      if (figure === undefined) purged();
      ownedContent(scope, owner, figure.contentId);
      if (figure.deletedAt === undefined) return figureDto(figure);
      const now = this.now();
      if (!this.restorable(figure, now)) purged();
      const restored = scope.figures.setDeleted(owner, figureId, undefined, now) ?? purged();
      scope.search.syncFigure(owner, restored.contentId, restored.id);
      return figureDto(restored);
    });
  }

  /** The stored WebP of a live or still restorable figure, with its SHA-256 for the ETag. */
  image(principal: RequestPrincipal, figureId: string): { bytes: Uint8Array; sha256: string } {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const figure = visibleFigure(scope, owner, figureId);
      if (figure.deletedAt !== undefined && !this.restorable(figure, this.now())) notFound();
      const bytes = scope.figures.getImage(owner, figureId) ?? notFound();
      return { bytes, sha256: figure.image.sha256 };
    });
  }

  /**
   * Removes, for every user, the deleted figures whose retention has run out, with their
   * images and search entries, `PURGE_BATCH` per transaction. Returns how many went. Safe to
   * call at any time and repeatedly; a timer or the start-up sweep calls it.
   */
  purgeExpired(): number {
    // `purgeDeleted` takes deletions strictly before the cutoff; a figure stops being
    // restorable exactly at `deletedAt + retention`, so that moment is purged too.
    const cutoff = this.now() - FIGURE_DELETED_RETENTION_MS + 1;
    let total = 0;
    for (;;) {
      const removed = this.options.repository.withTransaction((scope) => {
        const gone = scope.figures.purgeDeleted(cutoff, PURGE_BATCH);
        for (const entry of gone) scope.search.syncFigure(entry.userId, entry.contentId, entry.figureId);
        return gone.length;
      });
      total += removed;
      if (removed < PURGE_BATCH) break;
    }
    if (total > 0) this.options.logger?.info("figures_purged", { count: total });
    return total;
  }

  /** Checked after the Content's ownership, so another user's request still learns nothing but `not_found`. */
  private ensureStarted(): void {
    if (this.options.backgroundReady?.() === false) startingUp();
  }

  private restorable(figure: ContentFigure, now: number): boolean {
    return figure.deletedAt === undefined || figure.deletedAt + FIGURE_DELETED_RETENTION_MS > now;
  }

  /** The cap counts live figures and those still restorable; expired ones only await their purge. */
  private ensureRoom(scope: RepositoryScope, owner: string, contentId: string): void {
    const now = this.now();
    const held = scope.figures.listByContent(owner, contentId).filter((figure) => this.restorable(figure, now)).length;
    if (held >= FIGURES_PER_CONTENT_MAX) {
      throw amberError("invalid_request", "the Content holds the most figures allowed", {
        code: "invalid_request.figure_limit",
        params: { limit: String(FIGURES_PER_CONTENT_MAX) },
        details: { limit: FIGURES_PER_CONTENT_MAX },
      });
    }
  }

  /** A placement may only name a revision of this Content and a sentence of that revision. */
  private checkAnchor(scope: RepositoryScope, owner: string, contentId: string, placement: FigurePlacement): void {
    const anchor = placement.anchor;
    if (anchor === null) return;
    const revision = scope.transcripts.getRevision(owner, anchor.revisionId);
    const segment = scope.transcripts.getSegment(owner, anchor.segmentId);
    if (revision === undefined || revision.contentId !== contentId || segment === undefined || segment.revisionId !== revision.id) {
      throw amberError("invalid_request", "the figure placement names a sentence outside this Content", { code: "invalid_request.figure_anchor" });
    }
  }

  /**
   * Inserts a processed image as a new figure. The Content, the cap and the placement are
   * checked again: the image work ran outside any transaction, and meanwhile the Content may
   * have gone to the trash, other figures may have filled it up, or a revision may be gone.
   */
  private store(
    owner: string,
    contentId: string,
    image: FigureImage,
    input: { source: ContentFigure["source"]; capturedAtMs?: number; placement?: FigurePlacement; widthRatio?: number },
  ): FigureDto {
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      this.ensureRoom(scope, owner, contentId);
      const placement = input.placement ?? {
        displayMs: input.capturedAtMs ?? 0,
        anchor: null,
        sortKey: nextSortKey(scope.figures.listByContent(owner, contentId)),
      };
      this.checkAnchor(scope, owner, contentId, placement);
      const now = this.now();
      const figure: ContentFigure = {
        id: this.newId(),
        contentId,
        userId: owner,
        source: input.source,
        ...(input.capturedAtMs === undefined ? {} : { capturedAtMs: input.capturedAtMs }),
        displayMs: placement.displayMs,
        ...(placement.anchor === null ? {} : { anchor: placement.anchor }),
        sortKey: placement.sortKey,
        widthRatio: input.widthRatio ?? FIGURE_WIDTH_DEFAULT,
        image: { width: image.width, height: image.height, bytes: image.bytes.byteLength, sha256: image.sha256 },
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      scope.figures.insert(figure, image.bytes);
      scope.search.syncFigure(owner, contentId, figure.id);
      return figureDto(figure);
    });
  }
}

/** Placed by time without a placement of its own: after every figure already there. */
function nextSortKey(figures: readonly ContentFigure[]): number {
  return figures.reduce((max, figure) => Math.max(max, figure.sortKey + 1), 0);
}

function parseMeta(value: string): FigureUploadMeta {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    invalid("meta", "the meta field is not JSON");
  }
  const parsed = figureUploadMetaSchema.safeParse(json);
  if (!parsed.success) invalid("meta");
  return parsed.data;
}

/** A figure of the owner on a Content outside the trash; one of a trashed Content is as unknown as the Content. */
function visibleFigure(scope: RepositoryScope, owner: string, figureId: string): ContentFigure {
  const figure = scope.figures.get(owner, figureId);
  if (figure === undefined || scope.contents.get(owner, figure.contentId) === undefined) notFound();
  return figure;
}

/**
 * The video to capture from: an asset of this Content holding the original or a video cache
 * (`invalid_request` otherwise), available now (`media_missing` otherwise), with a picture
 * (`figure_frame` `no_video` otherwise). Which kinds exist follows the mode: the client has
 * external files and caches, the server its managed uploads and caches.
 */
function captureSource(scope: RepositoryScope, owner: string, contentId: string, assetId: string): MediaAsset {
  const asset = scope.mediaAssets.get(owner, assetId);
  if (asset === undefined || asset.contentId !== contentId || !(isOriginalMedia(asset) || isVideoCache(asset))) {
    invalid("assetId", "the asset is not an original or a video cache of this content");
  }
  if (asset.availability !== "available") {
    throw amberError("media_missing", "the video to capture from is not available");
  }
  if (!asset.mimeType.startsWith("video/")) {
    throw figureFrameError("no_video", "the media has no picture");
  }
  return asset;
}
