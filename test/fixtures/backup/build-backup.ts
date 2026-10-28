import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Header } from "tar";
import {
  BACKUP_DATABASE_ENTRY,
  BACKUP_FORMAT_VERSION,
  BACKUP_HEADER_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  cacheArchivePath,
  originalArchivePath,
  type BackupHeader,
  type BackupManifest,
} from "../../../src/shared/backup.ts";
import { configureAsr, configureLlm, createHarness, createTaskOfKind, LOCAL, type Harness } from "../pipeline/harness.ts";
import { seedChatContent } from "../pipeline/chat-data.ts";
import { insertSummary } from "../pipeline/summary-data.ts";
import { insertRow, tempDataDir } from "../../tools/sqlite.ts";
import { CHAPTER_AI_PROMPT, SUMMARY_ENVELOPE_PROMPT } from "../../../src/server/domain/prompts.ts";

/**
 * Client backups for restore tests, built without the export service: a source library
 * seeded through the harness, a `VACUUM INTO` snapshot stripped in the order the
 * export uses, and a tar written entry by entry so tests can also forge malformed archives.
 */

export interface RawEntry {
  path: string;
  type?: "File" | "Directory" | "SymbolicLink" | "Link" | "CharacterDevice" | "FIFO";
  data?: Buffer;
  linkpath?: string;
}

/** A tar archive of exactly these entries, in this order, without anything tar would add on its own. */
export function rawTar(entries: readonly RawEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = new Header({
      path: entry.path,
      type: entry.type ?? "File",
      size: entry.type === undefined || entry.type === "File" ? data.length : 0,
      mode: 0o644,
      mtime: new Date(0),
      ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
    });
    const block = Buffer.alloc(512);
    header.encode(block, 0);
    blocks.push(block);
    if (data.length > 0 && (entry.type === undefined || entry.type === "File")) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface SourceOriginal {
  assetId: string;
  contentId: string;
  name: string;
  path: string;
  bytes: Buffer;
}

export interface SourceCache {
  assetId: string;
  contentId: string;
  fileName: string;
  bytes: Buffer;
}

export interface SourceLibrary {
  dir: string;
  file: string;
  contentIds: string[];
  /** Segment ids the summary and chat answer of the first Content cite. */
  citedSegmentIds: string[];
  originals: SourceOriginal[];
  caches: SourceCache[];
}

export interface SourceOptions {
  /** File names of the `external_local` originals; the first two go to the first Content. */
  originalNames?: string[];
  cacheNames?: string[];
  /** Whether the source used a relocated cache directory. */
  customCacheRoot?: boolean;
}

function mediaRow(h: Harness, row: Record<string, unknown>): void {
  insertRow(h.db, "media_asset", { user_id: LOCAL.userId, duration_ms: null, quality: null, acquisition: null, created_at: 1, ...row });
}

/**
 * A library with two Contents (transcripts, a cited summary, a chat answer, a note), a
 * collection, terminology, LLM and two ASR profiles with keys, a platform login, finished
 * failed and cancelled Tasks, usage records, originals, caches and a temporary file.
 */
export async function buildSourceLibrary(options: SourceOptions = {}): Promise<SourceLibrary> {
  const h = createHarness();
  const first = seedChatContent(h, 6);
  const second = seedChatContent(h, 3);
  const cited = [first.segments[0]?.id as string, first.segments[2]?.id as string];
  insertSummary(h, {
    contentId: first.contentId,
    transcriptRevisionId: first.revisionId,
    citations: cited.map((segmentId) => ({ transcriptRevisionId: first.revisionId, segmentId: segmentId as never })),
  });
  const threadId = h.newId();
  insertRow(h.db, "chat_thread", { id: threadId, content_id: first.contentId, created_at: 0 });
  insertRow(h.db, "chat_message", {
    id: h.newId(),
    thread_id: threadId,
    role: "assistant",
    text: `见 [[seg:${cited[1]}]]`,
    status: "complete",
    citations_json: "[]",
    created_at: 2,
  });
  insertRow(h.db, "note", {
    id: h.newId(),
    user_id: LOCAL.userId,
    content_id: first.contentId,
    transcript_revision_id: first.revisionId,
    start_segment_id: cited[0],
    start_offset: 0,
    end_segment_id: cited[0],
    end_offset: 2,
    quote: "第 1",
    mark: "background",
    color: "yellow",
    comment: "要点",
    created_at: 3,
    updated_at: 3,
  });
  const collectionId = h.newId();
  insertRow(h.db, "collection", { id: collectionId, user_id: LOCAL.userId, name: "课程", created_at: 4 });
  // Custom system prompts: one in effect at its second version, one restored to the builtin text.
  const chapter = CHAPTER_AI_PROMPT.text;
  h.prompts.update(LOCAL, "chapter.ai", { text: `${chapter}\n标题尽量短。` });
  h.prompts.update(LOCAL, "chapter.ai", { text: `${chapter}\n标题不超过 10 字。` });
  h.prompts.update(LOCAL, "summary.envelope", { text: `${SUMMARY_ENVELOPE_PROMPT.text}\n多用列表。` });
  h.prompts.restore(LOCAL, "summary.envelope");
  insertRow(h.db, "collection_item", { id: h.newId(), collection_id: collectionId, content_id: first.contentId, position: 0, added_at: 4 });
  insertRow(h.db, "collection_item", { id: h.newId(), collection_id: collectionId, content_id: second.contentId, position: 1, added_at: 4 });
  insertRow(h.db, "terminology_set", { id: h.newId(), user_id: LOCAL.userId, scope_kind: "global" });

  const model = configureLlm(h);
  configureAsr(h);
  configureAsr(h, LOCAL.userId, { asDefault: false, name: "Second", models: ["scribe_v1"] });
  const cookie = h.secrets.store(LOCAL.userId, "<placeholder-cookie>");
  insertRow(h.db, "platform_account", { id: h.newId(), user_id: LOCAL.userId, platform: "bilibili", credential_ref: cookie, status: "valid" });

  const failed = createTaskOfKind(h, "process_content", {}, { contentId: first.contentId, createdAt: 5 });
  const cancelled = createTaskOfKind(h, "process_content", {}, { contentId: second.contentId, createdAt: 6 });
  h.db.prepare("UPDATE task SET status_projection = 'failed', finished_at = 7 WHERE id = ?").run(failed);
  h.db.prepare("UPDATE task SET status_projection = 'cancelled', finished_at = 8 WHERE id = ?").run(cancelled);
  h.db.prepare("UPDATE stage_run SET status = 'failed' WHERE task_id IN (?, ?)").run(failed, cancelled);
  insertRow(h.db, "token_usage", {
    id: h.newId(), user_id: LOCAL.userId, model_ref_json: JSON.stringify(model), feature: "summary", task_id: failed, outcome: "succeeded", input_tokens: 10, output_tokens: 5, created_at: 9,
  });
  insertRow(h.db, "asr_usage", { id: h.newId(), user_id: LOCAL.userId, provider: "elevenlabs", model: "scribe_v2", outcome: "succeeded", audio_ms: 1000, task_id: failed, created_at: 9 });

  const mediaDir = join(h.dir, "user-media");
  mkdirSync(mediaDir, { recursive: true });
  const originals: SourceOriginal[] = (options.originalNames ?? ["lecture.mp4", "Lecture.MP4", "notes:1?.mp3"]).map((name, index) => {
    const bytes = Buffer.from(`original ${index} of ${name}`.repeat(50));
    const path = join(mediaDir, `${index}-${name.replace(/[:?]/gu, "_")}`);
    writeFileSync(path, bytes);
    const assetId = h.newId();
    const contentId = index < 2 ? first.contentId : second.contentId;
    mediaRow(h, {
      id: assetId, content_id: contentId, kind: "external_local", storage_ref: path, display_name: name, mime_type: "video/mp4",
      size_bytes: bytes.length, fingerprint: `sha256:${sha256(bytes)}`, availability: "available", retention_policy: "never_delete",
    });
    return { assetId, contentId, name, path, bytes };
  });
  const cacheDir = join(h.dir, "media");
  mkdirSync(cacheDir, { recursive: true });
  const caches: SourceCache[] = (options.cacheNames ?? ["第一讲.mp4"]).map((fileName, index) => {
    const bytes = Buffer.from(`cache ${index}`.repeat(80));
    writeFileSync(join(cacheDir, fileName), bytes);
    const assetId = h.newId();
    mediaRow(h, {
      id: assetId, content_id: first.contentId, kind: "platform_cache", storage_ref: `media/${fileName}`, display_name: fileName, mime_type: "video/mp4",
      size_bytes: bytes.length, availability: "available", retention_policy: "evictable",
    });
    return { assetId, contentId: first.contentId, fileName, bytes };
  });
  mediaRow(h, {
    id: h.newId(), content_id: first.contentId, kind: "extracted_audio", task_id: failed, storage_ref: `tmp/tasks/${failed}/audio.mp3`, mime_type: "audio/mpeg",
    size_bytes: 1, availability: "available", retention_policy: "ephemeral",
  });
  if (options.customCacheRoot === true) {
    h.db.prepare("UPDATE instance_settings SET cache_root = ?").run(join(h.dir, "elsewhere"));
  }
  h.repository.withTransaction((scope) => {
    const current = scope.userSettings.get(LOCAL.userId);
    scope.userSettings.put({ ...(current ?? { userId: LOCAL.userId, language: "zh-CN", shortcuts: {} }), theme: "dark", updatedAt: 10 });
  });
  const file = h.file;
  const dir = h.dir;
  await h.close();
  return { dir, file, contentIds: [first.contentId, second.contentId], citedSegmentIds: cited, originals, caches };
}

export interface BackupParts {
  header: BackupHeader;
  database: Buffer;
  /** By archive path. */
  files: Map<string, Buffer>;
}

export interface ExportChoice {
  includeOriginals: boolean;
  includeCache: boolean;
  excludeOriginals?: string[];
  uiPreferences?: Record<string, string>;
}

/** The export's strip, in its fixed order, on a snapshot. */
function strip(file: string, includedOriginals: ReadonlySet<string>, includedCaches: ReadonlySet<string>): void {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.exec(`
      UPDATE provider_profile SET credential_ref = NULL;
      UPDATE asr_provider_profile SET credential_ref = NULL;
      DELETE FROM platform_account;
      DELETE FROM secret;
      DELETE FROM session; DELETE FROM user_credential; DELETE FROM idempotency_record;
      DELETE FROM pending_file_delete; DELETE FROM network_allowlist;
      UPDATE instance_settings SET cache_root = NULL, cache_migration_json = NULL, credentials_reset_at = NULL;
      UPDATE user_settings SET platform_cookie_browser = NULL;
      DELETE FROM media_asset WHERE kind IN ('extracted_audio', 'temporary');
      UPDATE media_asset SET availability = 'missing' WHERE kind = 'managed_upload';
    `);
    const evict = db.prepare("UPDATE media_asset SET availability = 'evicted' WHERE id = ?");
    for (const row of db.prepare("SELECT id FROM media_asset WHERE kind = 'platform_cache'").all() as Array<{ id: string }>) {
      if (!includedCaches.has(row.id)) evict.run(row.id);
    }
    const miss = db.prepare("UPDATE media_asset SET availability = 'missing' WHERE id = ?");
    for (const row of db.prepare("SELECT id FROM media_asset WHERE kind = 'external_local'").all() as Array<{ id: string }>) {
      if (!includedOriginals.has(row.id)) miss.run(row.id);
    }
  })();
  db.close();
}

/** What an export of `source` would put into an archive. */
export function exportParts(source: SourceLibrary, choice: ExportChoice): BackupParts {
  const scratch = tempDataDir("amber-export-");
  const snapshot = join(scratch, "snapshot.sqlite");
  const live = new Database(source.file, { readonly: true });
  live.prepare("VACUUM INTO ?").run(snapshot);
  const schemaVersion = live.pragma("user_version", { simple: true }) as number;
  live.close();
  const excluded = new Set(choice.excludeOriginals ?? []);
  const originals = choice.includeOriginals ? source.originals.filter((original) => !excluded.has(original.assetId)) : [];
  const caches = choice.includeCache ? source.caches : [];
  strip(snapshot, new Set(originals.map((original) => original.assetId)), new Set(caches.map((cache) => cache.assetId)));
  const database = readFileSync(snapshot);
  const counted = new Database(snapshot, { readonly: true });
  const count = (table: string): number => (counted.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const counts = { contents: count("content"), collections: count("collection"), notes: count("note"), originals: originals.length, cache: caches.length };
  counted.close();
  const files = new Map<string, Buffer>();
  const header: BackupHeader = {
    formatVersion: BACKUP_FORMAT_VERSION,
    mode: "local",
    amberVersion: "0.1.0",
    schemaVersion,
    createdAt: 1_800_000_000_000,
    encryption: "none",
    includes: { originals: choice.includeOriginals, cache: choice.includeCache },
    excludedOriginals: [...excluded],
    counts,
    sizes: {
      database: database.length,
      originals: originals.reduce((sum, original) => sum + original.bytes.length, 0),
      cache: caches.reduce((sum, cache) => sum + cache.bytes.length, 0),
    },
    originals: originals.map((original) => {
      const archivePath = originalArchivePath(original.assetId, original.name);
      files.set(archivePath, original.bytes);
      return { assetId: original.assetId, archivePath, originalName: original.name, sizeBytes: original.bytes.length, fingerprint: `sha256:${sha256(original.bytes)}` };
    }),
    cache: caches.map((cache) => {
      const archivePath = cacheArchivePath(cache.fileName);
      files.set(archivePath, cache.bytes);
      return { assetId: cache.assetId, archivePath };
    }),
    uiPreferences: choice.uiPreferences ?? {},
  };
  return { header, database, files };
}

/** The entries of a well-formed archive of `parts`, for tests that forge variations of it. */
export function archiveEntries(parts: BackupParts): RawEntry[] {
  const headerBytes = Buffer.from(JSON.stringify(parts.header));
  const body: RawEntry[] = [{ path: BACKUP_DATABASE_ENTRY, data: parts.database }, ...[...parts.files].map(([path, data]) => ({ path, data }))];
  const manifest: BackupManifest = {
    headerSha256: sha256(headerBytes),
    files: body.map((entry) => ({ path: entry.path, sizeBytes: (entry.data as Buffer).length, sha256: sha256(entry.data as Buffer) })),
  };
  return [{ path: BACKUP_HEADER_ENTRY, data: headerBytes }, ...body, { path: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest)) }];
}

/** Writes a well-formed archive of `parts` to `path`. */
export function writeBackup(path: string, parts: BackupParts): void {
  writeFileSync(path, rawTar(archiveEntries(parts)));
}
