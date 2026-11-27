import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { monotonicFactory } from "ulid";
import { parseBilibiliUrl } from "../../../src/server/adapters/platform/bilibili/url.ts";
import { platformContentUrl } from "../../../src/server/adapters/platform/content-url.ts";
import { parseDouyinUrl } from "../../../src/server/adapters/platform/douyin/url.ts";
import { parseXiaohongshuUrl } from "../../../src/server/adapters/platform/xiaohongshu/url.ts";
import { parseYoutubeUrl } from "../../../src/server/adapters/platform/youtube/url.ts";
import type { SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { createPackCollections } from "../../../src/server/application/content-pack-collections.ts";
import type { ContentPackEngine } from "../../../src/server/application/content-pack-engine.ts";
import { createContentPackEngine } from "../../../src/server/application/content-pack-plan.ts";
import type { PackSourceLinks } from "../../../src/server/application/content-pack-write.ts";
import type { ContentSource } from "../../../src/server/domain/content.ts";
import { PACK_COVER_LIMITS } from "../../../src/server/domain/content-pack/document.ts";
import { inspectPackWebp } from "../../../src/server/domain/figure-image.ts";
import type { Platform } from "../../../src/server/domain/platform.ts";
import type { ParsedPlatformUrl } from "../../../src/server/ports/platform-source.ts";
import type { ContentPackSelection } from "../../../src/shared/dto/content-pack.ts";
import { insertRow, openTempDatabase } from "../../tools/sqlite.ts";

/**
 * A real library (migrated SQLite, repository, content pack engine) for content pack tests
 * that need what a library really stores, such as cover copies and checked source links.
 */

const T0 = 1_790_000_000_000;

const PARSERS: Readonly<Record<Platform, (url: string) => ParsedPlatformUrl | null>> = {
  bilibili: parseBilibiliUrl,
  youtube: parseYoutubeUrl,
  xiaohongshu: parseXiaohongshuUrl,
  douyin: parseDouyinUrl,
};

/** The platforms' own link rules, as the composed adapters apply them. */
export const SOURCE_LINKS: PackSourceLinks = {
  parse: (platform, url) => PARSERS[platform](url),
  canonicalUrl: platformContentUrl,
};

export interface Library {
  db: SqliteConnection;
  repository: SqliteRepository;
  engine: ContentPackEngine;
  newId: () => string;
  close(): void;
}

export function openLibrary(): Library {
  const opened = openTempDatabase();
  const repository = new SqliteRepository(opened.db);
  for (const id of ["alice", "bob"]) insertRow(opened.db, "user", { id, role: "user", status: "active", created_at: T0 });
  const newId = monotonicFactory();
  const engine = createContentPackEngine({ mode: "local", repository, collections: createPackCollections({ repository }), sourceLinks: SOURCE_LINKS, newId });
  return {
    db: opened.db,
    repository,
    engine,
    newId,
    close: () => {
      opened.db.close();
      rmSync(opened.dir, { recursive: true, force: true });
    },
  };
}

export function addPlatformContent(library: Library, owner: string, source: ContentSource, extra: { title?: string; coverUrl?: string } = {}): string {
  const id = library.newId();
  library.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: owner,
      source,
      processingStatus: "none",
      title: extra.title ?? "平台视频",
      ...(extra.coverUrl === undefined ? {} : { coverUrl: extra.coverUrl }),
      durationMs: 60_000,
      createdAt: T0,
      updatedAt: T0,
    }),
  );
  return id;
}

/** Stores a WebP as the Content's local cover copy, at the size its header states; returns the version. */
export function putCover(library: Library, owner: string, contentId: string, bytes: Uint8Array): number {
  const checked = inspectPackWebp(bytes, PACK_COVER_LIMITS);
  if (!checked.ok) throw new Error(`not a usable cover: ${checked.reason}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return library.repository.withTransaction((scope) => scope.contentCovers.put(owner, contentId, { bytes, width: checked.width, height: checked.height, sha256 }, T0));
}

/** A selection of platform Contents carrying only themselves. */
export function bareSelection(contentIds: readonly string[]): ContentPackSelection {
  return { contents: contentIds.map((contentId) => ({ contentId, revisionIds: [], figures: false, notes: false, mediaAssetIds: [] })), collectionIds: [] };
}

/** Hooks for `buildExport` when nothing needs hashing or re-encoding. */
export const NO_HOOKS = {
  hashMedia: () => Promise.reject(new Error("no media expected")),
  normalizeAvatar: () => Promise.reject(new Error("no photo expected")),
  signal: new AbortController().signal,
};
