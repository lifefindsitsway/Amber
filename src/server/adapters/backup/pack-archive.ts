import { createHash } from "node:crypto";
import { open, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
  CONTENT_PACK_DOCUMENT_MAX_BYTES,
  CONTENT_PACK_DOCUMENTS_TOTAL_MAX_BYTES,
  CONTENT_PACK_ENTRIES_MAX,
  FIGURE_IMAGE_MAX_BYTES,
  SPEAKER_AVATAR_MAX_BYTES,
} from "../../../shared/defaults.ts";
import type { SpeakerAvatarMime } from "../../../shared/dto/speaker.ts";
import {
  collectionsDocumentSchema,
  CONTENT_PACK_COVER_FORMAT_VERSION,
  CONTENT_PACK_FORMAT,
  CONTENT_PACK_FORMAT_VERSION,
  contentDocumentSchema,
  contentPackHeaderSchema,
  PACK_COLLECTIONS_ENTRY,
  PACK_COVER_LIMITS,
  PACK_ENTRY_NAME,
  PACK_HEADER_ENTRY,
  PACK_MANIFEST_ENTRY,
  packCoverEntry,
  packManifestSchema,
  revisionDocumentSchema,
  type CollectionsDocument,
  type ContentDocument,
  type ContentPackHeader,
  type PackManifest,
  type RevisionDocument,
} from "../../domain/content-pack/document.ts";
import { amberError, type AmberError } from "../../domain/errors.ts";
import { inspectPackAvatar, inspectPackWebp } from "../../domain/figure-image.ts";
import type {
  ContentPackSource,
  ContentPackWriter,
  PackDocuments,
  PackReadAllOptions,
  PackReadAllResult,
  PackStagingTarget,
  PackWriteEntry,
  PackWriteRequest,
  PackWriteResult,
  StagedPackFile,
} from "../../ports/content-pack.ts";
import { readTarHeader, TAR_BLOCK, TAR_END_BYTES, tarEntryBytes, tarHeader, tarPadding } from "./pack-tar.ts";

/**
 * Reading and writing content packs (`.amberpack`). The archive is the tar subset of
 * `pack-tar.ts`; its entries and their order are fixed by the header, which lists every
 * entry after it with its size, and the trailing manifest, which lists the SHA-256 of each.
 * Nothing is ever extracted by a tar library: every header is judged before a byte of its
 * entry is used, so links, directories, extension headers, unlisted names and path
 * traversal can only be refused. Reads go through an async file handle chunk by chunk and
 * yield between documents, so a large pack never blocks the server's other requests.
 */

/** Why an entry, or the archive around it, is refused (`backup_invalid.pack_entry` `reason`). */
export const PACK_ENTRY_PROBLEMS = [
  /** Not where the header puts it, or the header / manifest is not first / last. */
  "order",
  /** A name outside the entry whitelist. */
  "name",
  /** A name that climbs out of the archive (`..`, absolute, drive or backslash). */
  "traversal",
  "link",
  "directory",
  /** Any other tar entry type, extension headers included. */
  "type",
  /** A tar header block that is not a valid ustar header. */
  "header",
  "duplicate",
  /** The size in the tar header differs from what the header document declares. */
  "size",
  "count",
  "too_large",
  "truncated",
  /** A JSON document that is not valid JSON or does not fit its schema, or contradicts another. */
  "document",
  /** The manifest is missing, or does not list exactly the declared entries. */
  "manifest",
  /** A document or file whose SHA-256 differs from what the manifest or its document records. */
  "digest",
  /** An entry no document refers to. */
  "unreferenced",
  /** A document refers to an entry the pack does not hold, or to one of the wrong kind. */
  "missing",
  /** Data after the end of the archive. */
  "trailing",
  /** The documents together are larger than a pack may carry. */
  "documents_too_large",
  /** A media file whose leading bytes are not the container its document declares. */
  "container",
  /** A cover outside its own Content's directory, or in a format version that has no covers. */
  "cover",
] as const;
export type PackEntryProblem = (typeof PACK_ENTRY_PROBLEMS)[number];

export function packEntryError(reason: PackEntryProblem, entry?: string): AmberError {
  return amberError("backup_invalid", `content pack entry refused: ${reason}`, {
    code: "backup_invalid.pack_entry",
    details: { reason, ...(entry === undefined ? {} : { entry }) },
  });
}

function packChanged(): AmberError {
  return amberError("backup_invalid", "content pack changed since its preview", { code: "backup_invalid.pack_changed" });
}

function packImage(entry: string): AmberError {
  return amberError("backup_invalid", "content pack image fails its structural check", { code: "backup_invalid.pack_image", details: { entry } });
}

/** Read size of one chunk of a streamed entry. */
const CHUNK_BYTES = 1024 * 1024;
/** Zero padding a tar writer may leave after the end marker (npm `tar` pads to 10 KiB records). */
const TRAILING_MAX_BYTES = 1024 * 1024;

type EntryKind = "header" | "collections" | "manifest" | "content" | "cover" | "revision" | "avatar" | "figure" | "media";

function kindOf(name: string): EntryKind {
  if (name === PACK_HEADER_ENTRY) return "header";
  if (name === PACK_COLLECTIONS_ENTRY) return "collections";
  if (name === PACK_MANIFEST_ENTRY) return "manifest";
  if (name.startsWith("media/")) return "media";
  if (name.endsWith("/content.json")) return "content";
  if (name.endsWith("/cover.webp")) return "cover";
  if (name.includes("/revisions/")) return "revision";
  if (name.includes("/avatars/")) return "avatar";
  return "figure";
}

function isDocument(kind: EntryKind): boolean {
  return kind === "header" || kind === "collections" || kind === "manifest" || kind === "content" || kind === "revision";
}

/** A name outside the whitelist is a traversal attempt when it could climb out, else just a wrong name. */
function nameProblem(name: string): PackEntryProblem | undefined {
  if (PACK_ENTRY_NAME.test(name)) return undefined;
  if (name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/u.test(name) || name.split("/").some((part) => part === ".." || part === ".")) {
    return "traversal";
  }
  return "name";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function parseJsonDocument<T>(bytes: Uint8Array, schema: z.ZodType<T>, entry: string): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw packEntryError("document", entry);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw packEntryError("document", entry);
  }
  return parsed.data;
}

/**
 * The header is checked for its format and version before its strict schema: a newer pack
 * may carry fields this build does not know, and must answer `invalid_request.pack_newer`.
 */
function parseHeader(bytes: Uint8Array): ContentPackHeader {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw packEntryError("document", PACK_HEADER_ENTRY);
  }
  const head = value as { format?: unknown; formatVersion?: unknown } | null;
  if (typeof head !== "object" || head === null || head.format !== CONTENT_PACK_FORMAT) {
    throw packEntryError("document", PACK_HEADER_ENTRY);
  }
  if (typeof head.formatVersion === "number" && Number.isInteger(head.formatVersion) && head.formatVersion > CONTENT_PACK_FORMAT_VERSION) {
    throw amberError("invalid_request", "content pack written by a newer format", {
      code: "invalid_request.pack_newer",
      details: { formatVersion: head.formatVersion, supportedVersion: CONTENT_PACK_FORMAT_VERSION },
    });
  }
  const parsed = contentPackHeaderSchema.safeParse(value);
  if (!parsed.success) {
    throw packEntryError("document", PACK_HEADER_ENTRY);
  }
  return parsed.data;
}

/** The header's entry list: whitelisted names, each once, within the count limit, documents within their size. */
function checkDeclaredEntries(header: ContentPackHeader): void {
  // Header and manifest are entries too.
  if (header.entries.length + 2 > CONTENT_PACK_ENTRIES_MAX) {
    throw packEntryError("count");
  }
  const seen = new Set<string>();
  // Documents are held in memory while a pack is previewed; together they have a cap of their own.
  let documentBytes = 0;
  for (const [index, entry] of header.entries.entries()) {
    const problem = nameProblem(entry.name);
    if (problem !== undefined) throw packEntryError(problem, entry.name);
    if (seen.has(entry.name)) throw packEntryError("duplicate", entry.name);
    seen.add(entry.name);
    const kind = kindOf(entry.name);
    if (kind === "header" || kind === "manifest" || (kind === "collections") !== (index === 0)) {
      throw packEntryError("order", entry.name);
    }
    if (isDocument(kind) && entry.size > CONTENT_PACK_DOCUMENT_MAX_BYTES) {
      throw packEntryError("too_large", entry.name);
    }
    if (isDocument(kind)) documentBytes += entry.size;
  }
  if (documentBytes > CONTENT_PACK_DOCUMENTS_TOTAL_MAX_BYTES) {
    throw packEntryError("documents_too_large");
  }
  if (header.entries.length === 0) {
    throw packEntryError("order", PACK_COLLECTIONS_ENTRY);
  }
}

/** Sequential reads of the pack file through one handle. */
class Cursor {
  position = 0;
  private readonly handle: FileHandle;
  readonly size: number;
  private scratch: Buffer | undefined;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async readExact(length: number, entry?: string): Promise<Buffer> {
    if (this.position + length > this.size) {
      throw packEntryError("truncated", entry);
    }
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buffer, done, length - done, this.position + done);
      if (bytesRead === 0) throw packEntryError("truncated", entry);
      done += bytesRead;
    }
    this.position += length;
    return buffer;
  }

  skip(length: number, entry?: string): void {
    if (this.position + length > this.size) {
      throw packEntryError("truncated", entry);
    }
    this.position += length;
  }

  /** Feeds `length` bytes to `onChunk` in chunks of one reused buffer; `onChunk` must be done with a chunk when it resolves. */
  async stream(length: number, entry: string, signal: AbortSignal, onChunk: (chunk: Buffer) => Promise<void> | void): Promise<void> {
    if (this.position + length > this.size) {
      throw packEntryError("truncated", entry);
    }
    this.scratch ??= Buffer.allocUnsafe(CHUNK_BYTES);
    let left = length;
    while (left > 0) {
      signal.throwIfAborted();
      const want = Math.min(left, CHUNK_BYTES);
      const { bytesRead } = await this.handle.read(this.scratch, 0, want, this.position);
      if (bytesRead === 0) throw packEntryError("truncated", entry);
      await onChunk(this.scratch.subarray(0, bytesRead));
      this.position += bytesRead;
      left -= bytesRead;
    }
  }

  /** The next entry's header: a regular file with a whitelisted name, or a refusal. */
  async next(): Promise<{ name: string; size: number }> {
    if (this.position + TAR_BLOCK > this.size) {
      throw packEntryError("truncated");
    }
    const read = readTarHeader(await this.readExact(TAR_BLOCK));
    if (read.kind === "end") {
      throw packEntryError("truncated");
    }
    if (read.kind === "refused") {
      const traversal = read.reason === "name" && read.name !== undefined && nameProblem(read.name) === "traversal";
      // A refused entry's name is echoed back only when it is one of ours.
      const named = read.name !== undefined && PACK_ENTRY_NAME.test(read.name) ? read.name : undefined;
      throw packEntryError(traversal ? "traversal" : read.reason, named);
    }
    const problem = nameProblem(read.name);
    if (problem !== undefined) {
      throw packEntryError(problem);
    }
    return { name: read.name, size: read.size };
  }

  /** After the manifest: the end marker and nothing but zero padding. */
  async end(): Promise<void> {
    const rest = this.size - this.position;
    if (rest < TAR_END_BYTES) {
      throw packEntryError("truncated");
    }
    if (rest > TRAILING_MAX_BYTES) {
      throw packEntryError("trailing");
    }
    const bytes = await this.readExact(rest);
    if (bytes.some((byte) => byte !== 0)) {
      throw packEntryError("trailing");
    }
  }
}

/** Reads the first entry, which must be the header document. */
async function readHeaderEntry(cursor: Cursor): Promise<{ header: ContentPackHeader; sha256: string }> {
  const first = await cursor.next();
  if (first.name !== PACK_HEADER_ENTRY) {
    throw packEntryError("order", first.name);
  }
  if (first.size > CONTENT_PACK_DOCUMENT_MAX_BYTES) {
    throw packEntryError("too_large", PACK_HEADER_ENTRY);
  }
  const bytes = await cursor.readExact(first.size, PACK_HEADER_ENTRY);
  cursor.skip(tarPadding(first.size), PACK_HEADER_ENTRY);
  const header = parseHeader(bytes);
  checkDeclaredEntries(header);
  return { header, sha256: sha256Hex(bytes) };
}

/** The next entry must be the declared one, at its declared size. */
async function nextDeclared(cursor: Cursor, declared: { name: string; size: number }, seen: Set<string>): Promise<void> {
  const entry = await cursor.next();
  if (seen.has(entry.name)) {
    throw packEntryError("duplicate", entry.name);
  }
  seen.add(entry.name);
  if (entry.name !== declared.name) {
    throw packEntryError("order", entry.name);
  }
  if (entry.size !== declared.size) {
    throw packEntryError("size", entry.name);
  }
}

async function readManifestEntry(cursor: Cursor): Promise<{ manifest: PackManifest; sha256: string }> {
  const entry = await cursor.next();
  if (entry.name !== PACK_MANIFEST_ENTRY) {
    throw packEntryError("manifest", entry.name);
  }
  if (entry.size > CONTENT_PACK_DOCUMENT_MAX_BYTES) {
    throw packEntryError("too_large", PACK_MANIFEST_ENTRY);
  }
  const bytes = await cursor.readExact(entry.size, PACK_MANIFEST_ENTRY);
  cursor.skip(tarPadding(entry.size), PACK_MANIFEST_ENTRY);
  return { manifest: parseJsonDocument(bytes, packManifestSchema, PACK_MANIFEST_ENTRY), sha256: sha256Hex(bytes) };
}

/** The manifest must list exactly the header's entries, in order and at their sizes. */
function checkManifest(header: ContentPackHeader, manifest: PackManifest): Map<string, string> {
  if (manifest.entries.length !== header.entries.length) {
    throw packEntryError("manifest");
  }
  const digests = new Map<string, string>();
  for (const [index, listed] of manifest.entries.entries()) {
    const declared = header.entries[index];
    if (declared === undefined || declared.name !== listed.name || declared.size !== listed.size) {
      throw packEntryError("manifest", listed.name);
    }
    digests.set(listed.name, listed.sha256);
  }
  return digests;
}

/** What one content document refers to, by entry. */
interface References {
  /** Avatar entry → declared type. */
  avatars: Map<string, SpeakerAvatarMime>;
  /** Figure entry → declared bytes and SHA-256. */
  figures: Map<string, { bytes: number; sha256: string }>;
  /** Cover entry → what its document declares of it. */
  covers: Map<string, { width: number; height: number; bytes: number; sha256: string }>;
}

function addReferences(refs: References, document: ContentDocument): void {
  for (const speaker of document.speakers) {
    if (speaker.avatar !== undefined) refs.avatars.set(speaker.avatar.entry, speaker.avatar.mime);
  }
  for (const figure of document.figures) {
    refs.figures.set(figure.entry, { bytes: figure.image.bytes, sha256: figure.image.sha256 });
  }
  if (document.cover !== undefined) {
    const { entry, ...declared } = document.cover;
    refs.covers.set(entry, declared);
  }
}

/**
 * Every entry the header declares is used by exactly one reference of the right kind, and
 * every reference names a declared entry: no hidden payload rides along, and no document
 * points at something the pack does not hold. Files are pinned to their documents through
 * the manifest digests, so a later read that matches the manifest matches the documents.
 */
function crossCheck(header: ContentPackHeader, documents: PackDocuments, manifestDigests: ReadonlyMap<string, string>): void {
  const declared = new Map(header.entries.map((entry) => [entry.name, entry.size]));
  const used = new Set<string>([PACK_COLLECTIONS_ENTRY]);
  const use = (entry: string, kind: EntryKind): void => {
    if (!declared.has(entry) || kindOf(entry) !== kind) throw packEntryError("missing", entry);
    if (used.has(entry)) throw packEntryError("duplicate", entry);
    used.add(entry);
  };
  const contentKeys = new Set<string>();
  for (const [index, item] of header.contents.entries()) {
    const content = documents.contents[index];
    if (content === undefined || content.entry !== item.entry || content.document.key !== item.key || contentKeys.has(item.key)) {
      throw packEntryError("document", item.entry);
    }
    contentKeys.add(item.key);
    use(item.entry, "content");
    for (const revision of content.document.revisions) {
      use(revision.entry, "revision");
      if (content.revisions.get(revision.entry)?.key !== revision.key) throw packEntryError("document", revision.entry);
    }
    for (const speaker of content.document.speakers) {
      if (speaker.avatar !== undefined) use(speaker.avatar.entry, "avatar");
    }
    const cover = content.document.cover;
    if (cover !== undefined) {
      // A version 1 reader would skip the field and drop the image unseen; a cover elsewhere
      // than beside its own document could belong to, or be taken for, another Content's.
      if (header.formatVersion < CONTENT_PACK_COVER_FORMAT_VERSION || cover.entry !== packCoverEntry(item.entry)) {
        throw packEntryError("cover", item.entry);
      }
      use(cover.entry, "cover");
      if (declared.get(cover.entry) !== cover.bytes || manifestDigests.get(cover.entry) !== cover.sha256) {
        throw packEntryError("digest", cover.entry);
      }
    }
    for (const figure of content.document.figures) {
      use(figure.entry, "figure");
      if (declared.get(figure.entry) !== figure.image.bytes || manifestDigests.get(figure.entry) !== figure.image.sha256) {
        throw packEntryError("digest", figure.entry);
      }
    }
    for (const media of content.document.media) {
      use(media.entry, "media");
      if (declared.get(media.entry) !== media.sizeBytes || manifestDigests.get(media.entry) !== media.sha256) {
        throw packEntryError("digest", media.entry);
      }
    }
  }
  const unused = header.entries.find((entry) => !used.has(entry.name));
  if (unused !== undefined) throw packEntryError("unreferenced", unused.name);
  for (const collection of documents.collections.collections) {
    if (collection.contentKeys.some((key) => !contentKeys.has(key))) throw packEntryError("document", PACK_COLLECTIONS_ENTRY);
  }
}


/**
 * One `.amberpack` file as a content pack source. The file is opened anew for every read and
 * never held open between them, so the import's second read sees what is on disk then.
 */
export class PackFileSource implements ContentPackSource {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch {
      throw packEntryError("truncated");
    }
  }

  async readDocuments(signal: AbortSignal): Promise<PackDocuments> {
    return this.withCursor(async (cursor) => {
      const { header, sha256: headerSha } = await readHeaderEntry(cursor);
      const digests = new Map<string, string>([[PACK_HEADER_ENTRY, headerSha]]);
      const seen = new Set<string>([PACK_HEADER_ENTRY]);
      let collections: CollectionsDocument | undefined;
      const contents = new Map<string, ContentDocument>();
      const revisions = new Map<string, RevisionDocument>();
      for (const declared of header.entries) {
        signal.throwIfAborted();
        await nextDeclared(cursor, declared, seen);
        const kind = kindOf(declared.name);
        if (!isDocument(kind)) {
          cursor.skip(declared.size + tarPadding(declared.size), declared.name);
          continue;
        }
        const bytes = await cursor.readExact(declared.size, declared.name);
        cursor.skip(tarPadding(declared.size), declared.name);
        digests.set(declared.name, sha256Hex(bytes));
        if (kind === "collections") {
          collections = parseJsonDocument(bytes, collectionsDocumentSchema, declared.name);
        } else if (kind === "content") {
          contents.set(declared.name, parseJsonDocument(bytes, contentDocumentSchema, declared.name));
        } else {
          revisions.set(declared.name, parseJsonDocument(bytes, revisionDocumentSchema, declared.name));
        }
        // A large pack's documents must not hold up other requests between them.
        await yieldToLoop();
      }
      const { manifest, sha256: manifestSha } = await readManifestEntry(cursor);
      await cursor.end();
      digests.set(PACK_MANIFEST_ENTRY, manifestSha);
      const manifestDigests = checkManifest(header, manifest);
      for (const [name, sha] of digests) {
        if (name !== PACK_HEADER_ENTRY && name !== PACK_MANIFEST_ENTRY && manifestDigests.get(name) !== sha) {
          throw packEntryError("digest", name);
        }
      }
      if (collections === undefined) {
        throw packEntryError("order", PACK_COLLECTIONS_ENTRY);
      }
      const documents: PackDocuments = {
        header,
        collections,
        contents: header.contents.map((item) => {
          const document = contents.get(item.entry);
          if (document === undefined) throw packEntryError("missing", item.entry);
          return {
            entry: item.entry,
            document,
            revisions: new Map(document.revisions.flatMap((revision) => {
              const found = revisions.get(revision.entry);
              return found === undefined ? [] : [[revision.entry, found] as const];
            })),
          };
        }),
        digests,
      };
      crossCheck(header, documents, manifestDigests);
      return documents;
    });
  }

  /**
   * The import's single read. Every document must hash as at the preview; the images are
   * checked structurally and against their figure's declared digest; the staged media are
   * written while hashed; the manifest, pinned by its own digest, must then agree with
   * every entry that was read. Media not staged are skipped unread: nothing of them reaches
   * the library. On any failure the staged files written so far are removed again.
   */
  async readAll(
    expectedDigests: ReadonlyMap<string, string>,
    stage: ReadonlyMap<string, PackStagingTarget>,
    onProgress: (bytesDone: number) => void,
    signal: AbortSignal,
    options: PackReadAllOptions = {},
  ): Promise<PackReadAllResult> {
    const created: string[] = [];
    try {
      return await this.withCursor(async (cursor) => {
        const { header, sha256: headerSha } = await readHeaderEntry(cursor);
        if (expectedDigests.get(PACK_HEADER_ENTRY) !== headerSha) {
          throw packChanged();
        }
        // Each content document precedes its images, so the references are known when they are read.
        const refs: References = { avatars: new Map(), figures: new Map(), covers: new Map() };
        const seen = new Set<string>([PACK_HEADER_ENTRY]);
        const read = new Map<string, StagedPackFile>();
        const images = new Map<string, Uint8Array>();
        const imageFiles = new Map<string, string>();
        const staged = new Map<string, StagedPackFile>();
        const failed = new Map<string, string>();
        for (const declared of header.entries) {
          signal.throwIfAborted();
          await nextDeclared(cursor, declared, seen);
          const kind = kindOf(declared.name);
          if (isDocument(kind)) {
            const bytes = await cursor.readExact(declared.size, declared.name);
            const sha256 = sha256Hex(bytes);
            if (expectedDigests.get(declared.name) !== sha256) {
              throw packChanged();
            }
            if (kind === "content") {
              addReferences(refs, parseJsonDocument(bytes, contentDocumentSchema, declared.name));
            }
            read.set(declared.name, { sizeBytes: declared.size, sha256 });
            await yieldToLoop();
          } else if (kind === "avatar" || kind === "figure" || kind === "cover") {
            const bytes = await this.readImage(cursor, declared, kind, refs);
            read.set(declared.name, { sizeBytes: declared.size, sha256: sha256Hex(bytes) });
            if (options.keepImages === undefined || options.keepImages.has(declared.name)) {
              if (options.imageDir === undefined) {
                images.set(declared.name, bytes);
              } else {
                // On disk until its Content commits: a pack's images together may be large.
                const path = join(options.imageDir, `${imageFiles.size + 1}.img`);
                await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
                created.push(path);
                imageFiles.set(declared.name, path);
              }
            }
          } else {
            const target = stage.get(declared.name);
            if (target === undefined) {
              cursor.skip(declared.size, declared.name);
            } else {
              const written = await writeStaged(cursor, declared, target.path, signal, (path) => created.push(path));
              if (written.ok) {
                read.set(declared.name, written.file);
                staged.set(declared.name, written.file);
              } else {
                failed.set(declared.name, written.code);
              }
            }
          }
          cursor.skip(tarPadding(declared.size), declared.name);
          onProgress(cursor.position);
        }
        const { manifest, sha256: manifestSha } = await readManifestEntry(cursor);
        if (expectedDigests.get(PACK_MANIFEST_ENTRY) !== manifestSha) {
          throw packChanged();
        }
        await cursor.end();
        const listed = checkManifest(header, manifest);
        for (const [name, file] of read) {
          if (listed.get(name) !== file.sha256) {
            // The documents and the manifest are the ones the preview saw: an entry that fails
            // the pack's own manifest means the pack is damaged, and picking it again won't help.
            throw packEntryError("digest", name);
          }
        }
        const unknown = [...stage.keys()].find((name) => !staged.has(name) && !failed.has(name));
        if (unknown !== undefined) {
          throw packEntryError("missing", unknown);
        }
        onProgress(cursor.size);
        return { images, imageFiles, staged, failed };
      });
    } catch (error) {
      await Promise.all(created.map((path) => rm(path, { force: true })));
      throw error;
    }
  }

  private async readImage(cursor: Cursor, declared: { name: string; size: number }, kind: "avatar" | "figure" | "cover", refs: References): Promise<Buffer> {
    const limit = kind === "figure" ? FIGURE_IMAGE_MAX_BYTES : kind === "cover" ? PACK_COVER_LIMITS.maxBytes : SPEAKER_AVATAR_MAX_BYTES;
    if (declared.size > limit) {
      throw packImage(declared.name);
    }
    const bytes = await cursor.readExact(declared.size, declared.name);
    if (kind === "cover") {
      const cover = refs.covers.get(declared.name);
      const checked = inspectPackWebp(bytes, PACK_COVER_LIMITS);
      if (!checked.ok) {
        throw packImage(declared.name);
      }
      // Structurally a still WebP, but not the picture its document describes.
      if (cover === undefined || cover.sha256 !== sha256Hex(bytes) || cover.bytes !== bytes.length || cover.width !== checked.width || cover.height !== checked.height) {
        throw packEntryError("digest", declared.name);
      }
    } else if (kind === "figure") {
      const figure = refs.figures.get(declared.name);
      if (figure === undefined || !inspectPackWebp(bytes).ok || figure.sha256 !== sha256Hex(bytes)) {
        throw packImage(declared.name);
      }
    } else {
      const mime = refs.avatars.get(declared.name);
      if (mime === undefined || !inspectPackAvatar(bytes, mime).ok) {
        throw packImage(declared.name);
      }
    }
    return bytes;
  }

  private async withCursor<T>(work: (cursor: Cursor) => Promise<T>): Promise<T> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch {
      throw packEntryError("truncated");
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw packEntryError("type");
      }
      return await work(new Cursor(handle, stats.size));
    } finally {
      await handle.close();
    }
  }
}

/**
 * Streams one entry into a new file at `path` (created exclusively), hashed, synced before
 * close. `onCreated` hears of the path only once this call created it, so a failure never
 * leads anyone to remove a file someone else put there. A failure of the target (as opposed
 * to the pack) is returned rather than thrown: the rest of the entry is read past, the
 * partial file removed, and the other entries go on.
 */
async function writeStaged(
  cursor: Cursor,
  declared: { name: string; size: number },
  path: string,
  signal: AbortSignal,
  onCreated: (path: string) => void,
): Promise<{ ok: true; file: StagedPackFile } | { ok: false; code: string }> {
  const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException | undefined)?.code ?? "EIO";
  let out: FileHandle;
  try {
    out = await open(path, "wx", 0o600);
  } catch (error) {
    cursor.skip(declared.size, declared.name);
    return { ok: false, code: codeOf(error) };
  }
  onCreated(path);
  const hash = createHash("sha256");
  let failure: string | undefined;
  try {
    await cursor.stream(declared.size, declared.name, signal, async (chunk) => {
      if (failure !== undefined) return;
      hash.update(chunk);
      try {
        await writeFully(out, chunk);
      } catch (error) {
        failure = codeOf(error);
      }
    });
    if (failure === undefined) {
      try {
        await out.sync();
      } catch (error) {
        failure = codeOf(error);
      }
    }
  } finally {
    await out.close().catch(() => undefined);
  }
  if (failure !== undefined) {
    await rm(path, { force: true });
    return { ok: false, code: failure };
  }
  return { ok: true, file: { sizeBytes: declared.size, sha256: hash.digest("hex") } };
}

async function writeFully(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done);
    done += bytesWritten;
  }
}

/** Opens a pack file as a source; nothing is read until a method is called. */
export function openPackFile(path: string): PackFileSource {
  return new PackFileSource(path);
}

// ---------------------------------------------------------------------------------------------
// Writing


/** A media file that no longer matches its document. */
class ChangedMedia extends Error {
  readonly contentId: string;
  readonly entry: string;

  constructor(contentId: string, entry: string) {
    super("content pack media changed while it was copied");
    this.contentId = contentId;
    this.entry = entry;
  }
}

function entrySize(entry: PackWriteEntry): number {
  return "bytes" in entry ? entry.bytes.length : entry.size;
}

/** Bytes the pack will take on disk: every entry with its tar header and padding, the end marker excluded from neither. */
export function packFileBytes(entries: ReadonlyArray<{ size: number }>, headerBytes: number, manifestBytes: number): number {
  return tarEntryBytes(headerBytes) + entries.reduce((sum, entry) => sum + tarEntryBytes(entry.size), 0) + tarEntryBytes(manifestBytes) + TAR_END_BYTES;
}

/**
 * Writes a content pack: header, the entries in the given order, manifest, end marker. A
 * media file is copied inside its `withFile` and must have exactly its recorded size and
 * SHA-256, else nothing is kept and the result names the Content (`ok: false`). The partial
 * file is removed on every failure; only a complete, synced pack is renamed into place.
 */
export class TarPackWriter implements ContentPackWriter {
  async write(request: PackWriteRequest): Promise<PackWriteResult> {
    const header: ContentPackHeader = { ...request.header, entries: request.entries.map((entry) => ({ name: entry.name, size: entrySize(entry) })) };
    const checked = contentPackHeaderSchema.safeParse(header);
    if (!checked.success) {
      throw new TypeError("content pack header does not fit its schema");
    }
    checkDeclaredEntries(checked.data);
    const headerBytes = Buffer.from(JSON.stringify(checked.data), "utf8");
    if (headerBytes.length > CONTENT_PACK_DOCUMENT_MAX_BYTES) {
      throw packEntryError("too_large", PACK_HEADER_ENTRY);
    }
    const partial = `${request.target}.partial`;
    const out = await open(partial, "wx", 0o600);
    let closed = false;
    const mtime = request.header.createdAt;
    let bytesDone = 0;
    const put = async (bytes: Uint8Array): Promise<void> => {
      request.signal.throwIfAborted();
      await writeFully(out, bytes);
    };
    const pad = (size: number): Promise<void> => put(new Uint8Array(tarPadding(size)));
    try {
      await put(tarHeader(PACK_HEADER_ENTRY, headerBytes.length, mtime));
      await put(headerBytes);
      await pad(headerBytes.length);
      const manifest: PackManifest = { entries: [] };
      for (const entry of request.entries) {
        const size = entrySize(entry);
        await put(tarHeader(entry.name, size, mtime));
        let sha256: string;
        if ("bytes" in entry) {
          await put(entry.bytes);
          sha256 = sha256Hex(entry.bytes);
          bytesDone += size;
          request.onProgress?.(bytesDone);
        } else {
          sha256 = await entry.withFile((path) =>
            copyMedia(path, entry, request.signal, async (chunk) => {
              await put(chunk);
              bytesDone += chunk.length;
              request.onProgress?.(bytesDone);
            }),
          );
        }
        await pad(size);
        manifest.entries.push({ name: entry.name, size, sha256 });
        if (isDocument(kindOf(entry.name))) await yieldToLoop();
      }
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      await put(tarHeader(PACK_MANIFEST_ENTRY, manifestBytes.length, mtime));
      await put(manifestBytes);
      await pad(manifestBytes.length);
      await put(new Uint8Array(TAR_END_BYTES));
      await out.sync();
      const sizeBytes = (await out.stat()).size;
      await out.close();
      closed = true;
      await rename(partial, request.target);
      return { ok: true, sizeBytes };
    } catch (error) {
      if (!closed) await out.close().catch(() => undefined);
      await rm(partial, { force: true });
      if (error instanceof ChangedMedia) {
        return { ok: false, changedContentId: error.contentId, entry: error.entry };
      }
      throw error;
    }
  }
}

/** Streams one media file through `put`, failing as changed on any difference from its record. */
async function copyMedia(
  path: string,
  entry: Extract<PackWriteEntry, { withFile: unknown }>,
  signal: AbortSignal,
  put: (chunk: Buffer) => Promise<void>,
): Promise<string> {
  const changed = (): ChangedMedia => new ChangedMedia(entry.contentId, entry.name);
  let source: FileHandle;
  try {
    source = await open(path, "r");
    const stats = await source.stat();
    if (!stats.isFile() || stats.size !== entry.size) {
      await source.close();
      throw changed();
    }
  } catch (error) {
    throw error instanceof ChangedMedia ? error : changed();
  }
  const hash = createHash("sha256");
  // One buffer for the whole file: memory stays flat however large the media is.
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, entry.size)));
  let position = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      let bytesRead: number;
      try {
        ({ bytesRead } = await source.read(buffer, 0, buffer.length, position));
      } catch {
        // A read failure means the file is not what the document says any more.
        throw changed();
      }
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > entry.size) throw changed();
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await put(chunk);
    }
  } finally {
    await source.close();
  }
  if (position !== entry.size) throw changed();
  const sha256 = hash.digest("hex");
  if (sha256 !== entry.sha256) throw changed();
  return sha256;
}
