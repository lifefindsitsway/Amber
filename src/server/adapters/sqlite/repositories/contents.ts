import { platformContentKey, type Content, type ContentSource } from "../../../domain/content.ts";
import type { ContentCursor, ContentListFilters, ContentRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface ContentRow {
  id: string;
  user_id: string;
  source_kind: ContentSource["kind"];
  source_url: string | null;
  platform_content_id: string | null;
  platform_part_id: string | null;
  platform_collection_id: string | null;
  channel_id: string | null;
  channel_title: string | null;
  title: string | null;
  custom_title: string | null;
  pinned_at: number | null;
  trashed_at: number | null;
  cover_url: string | null;
  cover_image_version: number | null;
  duration_ms: number | null;
  published_at: number | null;
  raw_language: string | null;
  description: string | null;
  description_truncated: number;
  description_checked_at: number | null;
  primary_transcript_revision_id: string | null;
  import_batch_id: string | null;
  processing_status: Content["processingStatus"];
  origin_id: string | null;
  created_at: number;
  updated_at: number;
}

function toContent(row: ContentRow): Content {
  return withoutNulls<Content>({
    id: row.id,
    userId: row.user_id,
    source: withoutNulls<ContentSource>({
      kind: row.source_kind,
      sourceUrl: row.source_url,
      platformContentId: row.platform_content_id,
      platformPartId: row.platform_part_id,
      platformCollectionId: row.platform_collection_id,
      channelId: row.channel_id,
      channelTitle: row.channel_title,
    }),
    title: row.title,
    customTitle: row.custom_title,
    pinnedAt: row.pinned_at,
    trashedAt: row.trashed_at,
    coverUrl: row.cover_url,
    coverImageVersion: row.cover_image_version,
    durationMs: row.duration_ms,
    publishedAt: row.published_at,
    rawLanguage: row.raw_language,
    description: row.description,
    descriptionTruncated: row.description_truncated === 1 ? true : null,
    descriptionCheckedAt: row.description_checked_at,
    primaryTranscriptRevisionId: row.primary_transcript_revision_id,
    importBatchId: row.import_batch_id,
    processingStatus: row.processing_status,
    originId: row.origin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Rows that come after the cursor item in the pinned-first, newest-first order of `page`. */
const OLDER = "(content.created_at < @afterCreatedAt OR (content.created_at = @afterCreatedAt AND content.id < @afterId))";

/** The WHERE clause and its parameters shared by `page` and `count`; `after` only applies to `page`. */
function whereOf(ownerUserId: string, query: ContentListFilters, after?: ContentCursor): { where: string; params: Record<string, unknown> } {
  const where = ["content.user_id = @owner", "content.trashed_at IS NULL"];
  if (after !== undefined) {
    // Inside the pinned run the next rows are later pins or any unpinned row; past it, only older unpinned rows.
    where.push(
      after.pinnedAt === undefined
        ? `(content.pinned_at IS NULL AND ${OLDER})`
        : `(content.pinned_at IS NULL OR content.pinned_at < @afterPinnedAt OR (content.pinned_at = @afterPinnedAt AND ${OLDER}))`,
    );
  }
  if (query.status !== undefined) {
    where.push("content.processing_status = @status");
  }
  if (query.source !== undefined) {
    where.push("content.source_kind = @source");
  }
  if (query.importBatchId !== undefined) {
    where.push("content.import_batch_id = @importBatchId");
  }
  if (query.collectionId !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM collection_item AS item JOIN collection ON collection.id = item.collection_id
               WHERE item.content_id = content.id AND item.collection_id = @collectionId AND collection.user_id = @owner)`,
    );
  }
  if (query.ids !== undefined) {
    // One JSON array parameter keeps the statement text the same for any number of ids.
    where.push("content.id IN (SELECT value FROM json_each(@ids))");
  }
  if (query.uncollected === true) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM collection_item AS item JOIN collection ON collection.id = item.collection_id
                   WHERE item.content_id = content.id AND collection.user_id = @owner)`,
    );
  }
  return {
    where: where.join(" AND "),
    params: {
      owner: ownerUserId,
      afterPinnedAt: after?.pinnedAt ?? null,
      afterCreatedAt: after?.createdAt ?? null,
      afterId: after?.id ?? null,
      status: query.status ?? null,
      source: query.source ?? null,
      importBatchId: query.importBatchId ?? null,
      collectionId: query.collectionId ?? null,
      ids: query.ids === undefined ? null : JSON.stringify(query.ids),
    },
  };
}

export function sqliteContentRepository(db: SqliteConnection): ContentRepository {
  // Request paths read through `selectActive`; `selectAny` serves the pipeline, write guards and the trash.
  const selectActive = db.prepare("SELECT * FROM content WHERE id = ? AND user_id = ? AND trashed_at IS NULL");
  const selectAny = db.prepare("SELECT * FROM content WHERE id = ? AND user_id = ?");
  const list = db.prepare("SELECT * FROM content WHERE user_id = ? AND trashed_at IS NULL ORDER BY updated_at DESC, id DESC");
  const setTrashed = db.prepare("UPDATE content SET trashed_at = ? WHERE id = ? AND user_id = ? AND trashed_at IS NULL");
  const clearTrashed = db.prepare("UPDATE content SET trashed_at = NULL WHERE id = ? AND user_id = ? AND trashed_at IS NOT NULL");
  const trashedPage = db.prepare(
    `SELECT * FROM content
     WHERE user_id = @owner AND trashed_at IS NOT NULL
       AND (@afterTrashedAt IS NULL OR trashed_at < @afterTrashedAt OR (trashed_at = @afterTrashedAt AND id < @afterId))
     ORDER BY trashed_at DESC, id DESC LIMIT @limit OFFSET @offset`,
  );
  const trashedCount = db.prepare("SELECT count(*) AS n FROM content WHERE user_id = ? AND trashed_at IS NOT NULL");
  const trashedIds = db.prepare("SELECT id FROM content WHERE user_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC, id DESC");
  const expired = db.prepare(
    `SELECT user_id AS userId, id, trashed_at AS trashedAt FROM content
     WHERE trashed_at IS NOT NULL AND trashed_at <= @cutoff
       AND (@afterTrashedAt IS NULL OR trashed_at > @afterTrashedAt OR (trashed_at = @afterTrashedAt AND id > @afterId))
     ORDER BY trashed_at, id LIMIT @limit`,
  );
  const earliestAfter = db.prepare("SELECT min(trashed_at) AS at FROM content WHERE trashed_at IS NOT NULL AND trashed_at > ?");
  const byIdentity = db.prepare(
    `SELECT * FROM content
     WHERE user_id = ? AND source_kind = ? AND platform_content_id = ? AND coalesce(platform_part_id, '') = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO content (
       id, user_id, source_kind, source_url, platform_content_id, platform_part_id, platform_collection_id,
       channel_id, channel_title, title, custom_title, pinned_at, cover_url, duration_ms, published_at, raw_language,
       primary_transcript_revision_id, import_batch_id, processing_status, origin_id, created_at, updated_at
     ) VALUES (
       @id, @userId, @sourceKind, @sourceUrl, @platformContentId, @platformPartId, @platformCollectionId,
       @channelId, @channelTitle, @title, @customTitle, @pinnedAt, @coverUrl, @durationMs, @publishedAt, @rawLanguage,
       @primaryTranscriptRevisionId, @importBatchId, @processingStatus, @originId, @createdAt, @updatedAt
     )`,
  );
  const revisionOfContent = db.prepare("SELECT 1 FROM transcript_revision WHERE id = ? AND content_id = ?");
  const setPrimary = db.prepare(
    "UPDATE content SET primary_transcript_revision_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  );
  const setStatus = db.prepare("UPDATE content SET processing_status = ?, updated_at = ? WHERE id = ? AND user_id = ?");
  const setCustomTitle = db.prepare("UPDATE content SET custom_title = ?, updated_at = ? WHERE id = ? AND user_id = ?");
  // One statement decides and writes, so a concurrent writer cannot slip in between a check
  // and the write. A stored time in the future of `now` means the system clock went back
  // since it was taken; it must not block every later answer.
  const setDescription = db.prepare(
    `UPDATE content
     SET description = @description, description_truncated = @truncated, description_checked_at = @checkedAt
     WHERE id = @id AND user_id = @owner AND trashed_at IS NULL
       AND (description_checked_at IS NULL OR description_checked_at < @checkedAt OR description_checked_at > @now)`,
  );
  const setPinned = db.prepare("UPDATE content SET pinned_at = ? WHERE id = ? AND user_id = ?");
  const remove = db.prepare("DELETE FROM content WHERE id = ? AND user_id = ?");
  const METADATA_COLUMNS = {
    title: "title",
    durationMs: "duration_ms",
    coverUrl: "cover_url",
    publishedAt: "published_at",
    rawLanguage: "raw_language",
    channelId: "channel_id",
    channelTitle: "channel_title",
  } as const;
  const setMetadata = new Map(
    Object.entries(METADATA_COLUMNS).map(([field, column]) => [
      field,
      db.prepare(`UPDATE content SET ${column} = ?, updated_at = ? WHERE id = ? AND user_id = ?`),
    ]),
  );

  return {
    get(ownerUserId, contentId) {
      const row = selectActive.get(contentId, ownerUserId) as ContentRow | undefined;
      return row === undefined ? undefined : toContent(row);
    },
    getIncludingTrashed(ownerUserId, contentId) {
      const row = selectAny.get(contentId, ownerUserId) as ContentRow | undefined;
      return row === undefined ? undefined : toContent(row);
    },
    list(ownerUserId) {
      return (list.all(ownerUserId) as ContentRow[]).map(toContent);
    },
    page(ownerUserId, query) {
      const { limit, after, offset, ...filters } = query;
      const { where, params } = whereOf(ownerUserId, filters, after);
      const rows = db
        .prepare(
          `SELECT content.* FROM content WHERE ${where}
           ORDER BY (content.pinned_at IS NULL), content.pinned_at DESC, content.created_at DESC, content.id DESC
           LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit, offset: offset ?? 0 }) as ContentRow[];
      return rows.map(toContent);
    },
    count(ownerUserId, filters) {
      const { where, params } = whereOf(ownerUserId, filters);
      const row = db.prepare(`SELECT count(*) AS n FROM content WHERE ${where}`).get(params) as { n: number };
      return row.n;
    },
    trash(ownerUserId, contentId, trashedAt) {
      if (setTrashed.run(trashedAt, contentId, ownerUserId).changes === 0) {
        throw notFound("content", contentId);
      }
    },
    restore(ownerUserId, contentId) {
      if (clearTrashed.run(contentId, ownerUserId).changes === 0) {
        throw notFound("content", contentId);
      }
    },
    listTrashed(ownerUserId, { limit, after, offset }) {
      const rows = trashedPage.all({
        owner: ownerUserId,
        afterTrashedAt: after?.trashedAt ?? null,
        afterId: after?.id ?? null,
        limit,
        offset: offset ?? 0,
      }) as ContentRow[];
      return rows.map(toContent);
    },
    countTrashed(ownerUserId) {
      return (trashedCount.get(ownerUserId) as { n: number }).n;
    },
    listTrashedIds(ownerUserId) {
      return (trashedIds.all(ownerUserId) as Array<{ id: string }>).map((row) => row.id);
    },
    listExpired(cutoff, limit, after) {
      return expired.all({ cutoff, limit, afterTrashedAt: after?.trashedAt ?? null, afterId: after?.id ?? null }) as Array<{
        userId: string;
        id: string;
        trashedAt: number;
      }>;
    },
    earliestTrashedAfter(after) {
      return (earliestAfter.get(after) as { at: number | null }).at ?? undefined;
    },
    setCustomTitle(ownerUserId, contentId, title, updatedAt) {
      if (setCustomTitle.run(nullable(title), updatedAt, contentId, ownerUserId).changes === 0) {
        throw notFound("content", contentId);
      }
    },
    setPinned(ownerUserId, contentId, pinnedAt) {
      if (setPinned.run(nullable(pinnedAt), contentId, ownerUserId).changes === 0) {
        throw notFound("content", contentId);
      }
    },
    findByPlatformIdentity(ownerUserId, source) {
      if (platformContentKey(ownerUserId, source) === null) {
        return undefined;
      }
      const row = byIdentity.get(ownerUserId, source.kind, source.platformContentId, source.platformPartId ?? "") as
        | ContentRow
        | undefined;
      return row === undefined ? undefined : toContent(row);
    },
    insert(content) {
      const { source } = content;
      insert.run({
        id: content.id,
        userId: content.userId,
        sourceKind: source.kind,
        sourceUrl: nullable(source.sourceUrl),
        platformContentId: nullable(source.platformContentId),
        platformPartId: nullable(source.platformPartId),
        platformCollectionId: nullable(source.platformCollectionId),
        channelId: nullable(source.channelId),
        channelTitle: nullable(source.channelTitle),
        title: nullable(content.title),
        customTitle: nullable(content.customTitle),
        pinnedAt: nullable(content.pinnedAt),
        coverUrl: nullable(content.coverUrl),
        durationMs: nullable(content.durationMs),
        publishedAt: nullable(content.publishedAt),
        rawLanguage: nullable(content.rawLanguage),
        primaryTranscriptRevisionId: nullable(content.primaryTranscriptRevisionId),
        importBatchId: nullable(content.importBatchId),
        processingStatus: content.processingStatus,
        originId: nullable(content.originId),
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
      });
    },
    setProcessingStatus(ownerUserId, contentId, status, updatedAt) {
      if (setStatus.run(status, updatedAt, contentId, ownerUserId).changes === 0) {
        throw notFound("content", contentId);
      }
    },
    setMetadata(ownerUserId, contentId, metadata, updatedAt) {
      if (selectAny.get(contentId, ownerUserId) === undefined) {
        throw notFound("content", contentId);
      }
      for (const [field, value] of Object.entries(metadata)) {
        if (value !== undefined) {
          setMetadata.get(field)?.run(value, updatedAt, contentId, ownerUserId);
        }
      }
    },
    setDescription(ownerUserId, contentId, value, now) {
      const truncated = value.description !== null && value.truncated ? 1 : 0;
      return (
        setDescription.run({ id: contentId, owner: ownerUserId, description: value.description, truncated, checkedAt: value.checkedAt, now }).changes > 0
      );
    },
    setPrimaryTranscript(ownerUserId, contentId, revisionId, updatedAt) {
      if (revisionId !== undefined && revisionOfContent.get(revisionId, contentId) === undefined) {
        throw notFound("transcript revision", revisionId);
      }
      if (setPrimary.run(nullable(revisionId), updatedAt, contentId, ownerUserId).changes === 0) {
        throw notFound("content", contentId);
      }
    },
    delete(ownerUserId, contentId) {
      return remove.run(contentId, ownerUserId).changes > 0;
    },
  };
}
