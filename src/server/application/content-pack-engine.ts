import type { MediaAssetKind } from "../../shared/enums.ts";
import type {
  ContentPackExportPlanDto,
  ContentPackExportPlanRequest,
  ContentPackImportDecisions,
  ContentPackPreviewDto,
  ContentPackSelection,
  PackCollectionDecision,
  PackCollectionResult,
  PackContentDiff,
  PackContentResult,
  PackPreviewCollection,
} from "../../shared/dto/content-pack.ts";
import type { CollectionsDocument, ContentDocument, PackMedia, RevisionDocument } from "../domain/content-pack/document.ts";
import type { PackDocuments } from "../ports/content-pack.ts";

/**
 * The seam between the content pack jobs (archive, streaming, journal, file placement) and the
 * library side (what goes into a pack, how a pack relates to the library, and the per-Content
 * transaction). The job services hold an engine and never read or write library tables
 * themselves; the engine never touches archive bytes or chooses where files go.
 */

/** A media file of the library the export copies into the pack. */
export interface PackExportMedia {
  /** Archive entry name, assigned by the engine. */
  entry: string;
  assetId: string;
  contentId: string;
  kind: "original" | "cache";
  /** Where the bytes are: an absolute path (`external_local`) or a FileStore ref. */
  location: { path: string } | { storageRef: string };
  sizeBytes: number;
  /** As written into the Content document; the copy is hashed again and must match. */
  sha256: string;
}

/** Everything an export writes, in archive order, documents and small files already final. */
export interface PackExportBuild {
  collections: CollectionsDocument;
  contents: Array<{
    contentId: string;
    title?: string;
    entry: string;
    document: ContentDocument;
    revisions: Array<{ entry: string; document: RevisionDocument }>;
    /** The cover copy, figure images and speaker photos, already passing the pack's structural checks. */
    images: Array<{ entry: string; bytes: Uint8Array }>;
    media: PackExportMedia[];
  }>;
}

export interface PackExportBuildHooks {
  /**
   * Hex SHA-256 of a media file, computed by the job under the file's lock; the engine calls it
   * for every chosen media file whose digest the library does not already record.
   */
  hashMedia(media: Omit<PackExportMedia, "sha256" | "entry">, signal: AbortSignal): Promise<string>;
  /** Re-encodes a speaker photo that fails the pack's avatar check to WebP. */
  normalizeAvatar(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  signal: AbortSignal;
}

/**
 * One chosen media entry of an import and the asset it becomes. Ids are assigned by the engine
 * before anything is read so the job can journal and place files first; the job decides the
 * final location from `targetKind` and the run mode and reports it back in `PlacedPackMedia`.
 */
export interface PackImportMediaPlan {
  entry: string;
  contentKey: string;
  /** The local Content it lands in (new Contents have their id assigned already). */
  contentId: string;
  /** The asset row to create, or the registered asset whose missing file this fills in. */
  assetId: string;
  fills: boolean;
  /** `external_local` (local-mode original), `managed_upload` (server-mode original) or `platform_cache`. */
  targetKind: Extract<MediaAssetKind, "external_local" | "managed_upload" | "platform_cache">;
  media: PackMedia;
  /** For a fill: the registered asset's current location, where the file must go back. */
  existingLocation?: { path: string } | { storageRef: string };
}

/** Where the job put a staged media file, moved into place just before the Content commits. */
export interface PlacedPackMedia {
  location: { path: string } | { storageRef: string };
  sizeBytes: number;
  sha256: string;
}

/** The engine's own state for one previewed pack; opaque to the job, kept with it in memory. */
export interface PackPreviewState {
  readonly _packPreview: unique symbol;
}

/** One carried Content ready to commit; opaque to the job. */
export interface PreparedPackContent {
  readonly key: string;
  readonly title?: string;
  readonly action: "skip" | "import" | "merge";
}

export interface PreparedPackImport {
  contents: PreparedPackContent[];
  /** Media entries to stage during the single read. */
  media: PackImportMediaPlan[];
  /** Image entries (figures, photos, covers) whose bytes the commits need. */
  imageEntries: ReadonlySet<string>;
  /** Contents refused before any read (target in the trash, busy, …), already as results. */
  refused: PackContentResult[];
}

export interface ContentPackEngine {
  /** The export wizard's data. */
  exportPlan(ownerUserId: string, request: ContentPackExportPlanRequest): ContentPackExportPlanDto;
  /** Checks a selection again (`invalid_request.pack_selection`, `conflict.pack_content_busy`); nothing is read yet. */
  validateSelection(ownerUserId: string, selection: ContentPackSelection): void;
  /** Builds every document of the pack for a valid selection. */
  buildExport(ownerUserId: string, selection: ContentPackSelection, hooks: PackExportBuildHooks): Promise<PackExportBuild>;

  /** Relates a read pack to the library: the preview's Contents (collections come from `collections.preview`). */
  analyzeImport(ownerUserId: string, documents: PackDocuments): { contents: ContentPackPreviewDto["contents"]; state: PackPreviewState };
  /** The diff against a target the user picked by hand; remembered in `state` for the commit. */
  compare(ownerUserId: string, documents: PackDocuments, state: PackPreviewState, key: string, targetContentId: string): PackContentDiff;
  /** Turns the user's decisions into per-Content work and the media to stage; throws `invalid_request` on decisions that do not fit the preview. */
  prepareImport(ownerUserId: string, documents: PackDocuments, state: PackPreviewState, decisions: ContentPackImportDecisions): PreparedPackImport;
  /**
   * Writes one carried Content in a single transaction (record, speakers, platform chapters,
   * revisions and their state, notes, figures, media rows, search index), re-checking its
   * target first. Never throws for a problem of this Content: it returns a `failed` result.
   */
  commitContent(
    ownerUserId: string,
    documents: PackDocuments,
    prepared: PreparedPackContent,
    inputs: { images: ReadonlyMap<string, Uint8Array>; media: ReadonlyMap<string, PlacedPackMedia>; now: number },
  ): PackContentResult;

  collections: PackCollectionsEngine;
}

/** Collections carried by a pack: matched at preview, written after every Content, one transaction each. */
export interface PackCollectionsEngine {
  preview(ownerUserId: string, documents: PackDocuments): PackPreviewCollection[];
  /** `contentIds` maps carried Content keys to the local Contents they were imported or merged into. */
  commit(
    ownerUserId: string,
    documents: PackDocuments,
    decisions: readonly PackCollectionDecision[],
    contentIds: ReadonlyMap<string, string>,
    now: number,
  ): PackCollectionResult[];
}
