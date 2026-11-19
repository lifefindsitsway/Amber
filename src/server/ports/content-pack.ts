import type { CollectionsDocument, ContentDocument, ContentPackHeader, RevisionDocument } from "../domain/content-pack/document.ts";

/**
 * Everything a preview needs, read and validated from a content pack: the header, the
 * collections and every Content's documents. `digests` maps each document entry to the hex
 * SHA-256 of its bytes as read, so the import's second read can prove it saw the same documents.
 */
export interface PackDocuments {
  header: ContentPackHeader;
  collections: CollectionsDocument;
  /** `revisions` is keyed by the revision document's entry name (`PackRevision.entry`). */
  contents: ReadonlyArray<{ entry: string; document: ContentDocument; revisions: ReadonlyMap<string, RevisionDocument> }>;
  digests: ReadonlyMap<string, string>;
}

/** Where one chosen file entry goes during the import's sequential read. */
export interface PackStagingTarget {
  /** A temporary file beside the final place, created by the reader; the caller moves it into place on commit. */
  path: string;
}

/** A staged file as written by `readAll`. */
export interface StagedPackFile {
  sizeBytes: number;
  sha256: string;
}

export interface PackReadAllOptions {
  /** Image entries whose bytes to return; every image is still checked. All of them when absent. */
  keepImages?: ReadonlySet<string>;
  /**
   * A directory (existing, the caller's) to write the kept images to instead of returning
   * their bytes: `imageFiles` then names the file of each, and `images` stays empty.
   */
  imageDir?: string;
}

/** What the single read produced. */
export interface PackReadAllResult {
  images: ReadonlyMap<string, Uint8Array>;
  imageFiles: ReadonlyMap<string, string>;
  staged: ReadonlyMap<string, StagedPackFile>;
  /**
   * Staged entries whose target could not be written (a missing folder, a name the file
   * system refuses, a full disk), by entry, with the system error code. The pack itself was
   * fine: the entry was read past and nothing of it is left at its target.
   */
  failed: ReadonlyMap<string, string>;
}

/**
 * Where an import's documents and files come from. The import engine sees only this; a
 * `.amberpack` file is the one source this release has (a full backup is a planned second one).
 *
 * `readDocuments` validates entry names, types, order, declared sizes and caps, and parses
 * every JSON document strictly; images and media are not staged. `readAll` is the single
 * sequential read before commit: documents must hash as in `expectedDigests`
 * (`backup_invalid.pack_changed` otherwise), every image entry passes the structural WebP /
 * avatar check and the kept ones are returned (as bytes, or as files in `imageDir`), the
 * entries named in `stage` are streamed to their targets while hashed (a target that cannot be
 * written is reported in `failed` and the read goes on), and the trailing manifest must match
 * every entry. Nothing is written to the library before `readAll` resolves.
 */
export interface ContentPackSource {
  readDocuments(signal: AbortSignal): Promise<PackDocuments>;
  readAll(
    expectedDigests: ReadonlyMap<string, string>,
    stage: ReadonlyMap<string, PackStagingTarget>,
    onProgress: (bytesDone: number) => void,
    signal: AbortSignal,
    options?: PackReadAllOptions,
  ): Promise<PackReadAllResult>;
  /** Total size of the pack file, for progress and disk checks. */
  sizeBytes(): Promise<number>;
}

/** One entry of a pack being written, after the header and before the manifest. */
export type PackWriteEntry =
  | { name: string; bytes: Uint8Array }
  | {
      name: string;
      size: number;
      /** Hex SHA-256 the copy must have, as recorded in the Content document. */
      sha256: string;
      /** The Content the file belongs to; named when the file changed while it was copied. */
      contentId: string;
      /** Runs `work` with the file's path while the file cannot be replaced (under its cache lock). */
      withFile<T>(work: (path: string) => Promise<T>): Promise<T>;
    };

export interface PackWriteRequest {
  /** The final path; the pack is written to `<target>.partial` (created exclusively) and renamed when complete. */
  target: string;
  header: Omit<ContentPackHeader, "entries">;
  entries: PackWriteEntry[];
  signal: AbortSignal;
  /** Bytes of entry data written so far. */
  onProgress?: (bytesDone: number) => void;
}

export type PackWriteResult = { ok: true; sizeBytes: number } | { ok: false; changedContentId: string; entry: string };

/**
 * Writes a content pack: header, the entries in the given order, manifest. A media file is
 * copied inside its `withFile` and must have exactly its recorded size and SHA-256, else
 * nothing is kept and the result names the Content. Only a complete pack is renamed into place.
 */
export interface ContentPackWriter {
  write(request: PackWriteRequest): Promise<PackWriteResult>;
}
