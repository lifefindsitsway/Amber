import { TRASH_RETENTION_DAYS } from "../../shared/defaults.ts";
import type { ContentProcessingStatus } from "../../shared/enums.ts";
import { isPlatform, type ContentSourceKind } from "./platform.ts";

export interface ContentSource {
  kind: ContentSourceKind;
  /** Platform: canonical URL (bilibili multi-part keeps `p=`). Local: absent. */
  sourceUrl?: string;
  /** bilibili: bvid of the submission; youtube: videoId. */
  platformContentId?: string;
  /** bilibili: cid identifying one part; youtube: absent. */
  platformPartId?: string;
  /** Recorded when imported from a platform collection or playlist. */
  platformCollectionId?: string;
  channelId?: string;
  channelTitle?: string;
}

export interface Content {
  id: string;
  userId: string;
  source: ContentSource;
  /**
   * Metadata may be missing right after creation; title and duration become known once
   * the `source` stage (platform) or `media` probe (local) succeeds.
   */
  title?: string;
  coverUrl?: string;
  durationMs?: number;
  publishedAt?: number;
  rawLanguage?: string;
  /**
   * The platform video's description, normalized and capped. Absent when none is stored:
   * never read, last read unreadable, or the platform said there is none (then
   * `descriptionCheckedAt` is set). Written apart from the other metadata and without
   * touching `updatedAt`.
   */
  description?: string;
  /** Present (and true) only when the stored description was cut to the length limit. */
  descriptionTruncated?: boolean;
  /**
   * When the request whose answer is stored was sent (from `DescriptionClock`), not when it
   * returned; an answer to an earlier request never replaces a later one.
   */
  descriptionCheckedAt?: number;
  /**
   * The user's own title. Kept apart from `title` because the `source` stage rewrites the
   * platform title on every run and the original must stay restorable; readers show
   * `displayTitle()`.
   */
  customTitle?: string;
  /** When the user pinned the Content; pinned Contents list first. */
  pinnedAt?: number;
  /**
   * When the Content went to the trash. While set, every list, search, collection, note
   * page, task view and `/contents/:id` endpoint treats it as unknown; it can be restored
   * until `trashPurgeAt(trashedAt)` and is purged by the sweep afterwards.
   */
  trashedAt?: number;
  /** The single "current transcript" pointer used by search, chapters, summaries and highlights. */
  primaryTranscriptRevisionId?: string;
  importBatchId?: string;
  /**
   * Projection of the latest `process_content` Task; derived tasks (reproofread,
   * translate, regenerate_summary, ...) never change it. Not a source of truth. `none` for
   * a Content that has never had a processing Task (one created by a content pack import).
   */
  processingStatus: ContentProcessingStatus;
  /**
   * The id this Content had on the device it was carried from by a content pack; absent for
   * a Content created here. Its transfer identity is `originId ?? id`.
   */
  originId?: string;
  createdAt: number;
  updatedAt: number;
}

/** What the user sees as the title: their own name for the Content, else the platform's or file's. */
export function displayTitle(content: Pick<Content, "title" | "customTitle">): string | undefined {
  return content.customTitle ?? content.title;
}

const MS_PER_DAY = 86_400_000;

/** How long a Content stays restorable in the trash. */
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * MS_PER_DAY;

/** When a Content trashed at `trashedAt` stops being restorable and becomes due for purging. */
export function trashPurgeAt(trashedAt: number): number {
  return trashedAt + TRASH_RETENTION_MS;
}

/** `displayTitle` of a Content that may be missing. */
export function displayTitleOf(content: Pick<Content, "title" | "customTitle"> | undefined): string | undefined {
  return content === undefined ? undefined : displayTitle(content);
}

export const IMPORT_SOURCE_TYPES = [
  "links",
  "platform_collection",
  "upload",
  "local_file",
] as const;
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export interface ImportBatch {
  id: string;
  userId: string;
  createdAt: number;
  sourceType: ImportSourceType;
  totalItems: number;
}

/**
 * Canonical identity of platform content: `(userId, platform, platformContentId,
 * platformPartId ?? "")`. Re-submitting the same video reuses the same Content; each
 * bilibili part is its own Content. Local files have no canonical key (duplicates are
 * detected by fingerprint and may be kept deliberately), so this returns `null`.
 */
export function platformContentKey(userId: string, source: ContentSource): string | null {
  if (!isPlatform(source.kind) || source.platformContentId === undefined) {
    return null;
  }
  return JSON.stringify([userId, source.kind, source.platformContentId, source.platformPartId ?? ""]);
}
