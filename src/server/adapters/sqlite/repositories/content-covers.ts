import type { ContentCoverImage, ContentCoverImageInput, ContentCoverRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound } from "./rows.ts";

interface CoverRow {
  image: Buffer;
  width: number;
  height: number;
  sha256: string;
  version: number;
}

function toCover(row: CoverRow): ContentCoverImage {
  return { bytes: new Uint8Array(row.image), width: row.width, height: row.height, sha256: row.sha256, version: row.version };
}

export function sqliteContentCoverRepository(db: SqliteConnection): ContentCoverRepository {
  const SELECT = `SELECT cover.image, cover.width, cover.height, cover.sha256, content.cover_image_version AS version
                  FROM content_cover_image AS cover JOIN content ON content.id = cover.content_id AND content.user_id = cover.user_id
                  WHERE cover.content_id = ? AND cover.user_id = ?`;
  const selectActive = db.prepare(`${SELECT} AND content.trashed_at IS NULL`);
  const selectAny = db.prepare(SELECT);
  const writable = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ? AND trashed_at IS NULL");
  const exists = db.prepare("SELECT 1 FROM content_cover_image WHERE content_id = ? AND user_id = ?");
  // A plain column update: `updated_at` is left alone so a list does not reorder when a cover arrives.
  const bump = db.prepare(
    "UPDATE content SET cover_image_version = coalesce(cover_image_version, 0) + 1 WHERE id = ? AND user_id = ? AND trashed_at IS NULL",
  );
  const version = db.prepare("SELECT cover_image_version AS v FROM content WHERE id = ? AND user_id = ?");
  const upsert = db.prepare(
    `INSERT INTO content_cover_image (content_id, user_id, image, width, height, bytes, sha256, created_at, updated_at)
     VALUES (@contentId, @owner, @image, @width, @height, @bytes, @sha256, @now, @now)
     ON CONFLICT (content_id) DO UPDATE SET
       image = excluded.image, width = excluded.width, height = excluded.height,
       bytes = excluded.bytes, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
  );

  function write(ownerUserId: string, contentId: string, image: ContentCoverImageInput, now: number): number {
    if (bump.run(contentId, ownerUserId).changes === 0) {
      throw notFound("content", contentId);
    }
    upsert.run({
      contentId,
      owner: ownerUserId,
      image: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength),
      width: image.width,
      height: image.height,
      bytes: image.bytes.byteLength,
      sha256: image.sha256,
      now,
    });
    return (version.get(contentId, ownerUserId) as { v: number }).v;
  }

  function writeIfAbsent(ownerUserId: string, contentId: string, image: ContentCoverImageInput, now: number): boolean {
    if (writable.get(contentId, ownerUserId) === undefined) {
      throw notFound("content", contentId);
    }
    if (exists.get(contentId, ownerUserId) !== undefined) {
      return false;
    }
    write(ownerUserId, contentId, image, now);
    return true;
  }

  // Each write runs in its own nested transaction, which inside the caller's is a savepoint: a
  // failed write rolls the version bump back with it even when the caller catches the error and
  // keeps its own transaction going.
  return {
    get(ownerUserId, contentId) {
      const row = selectActive.get(contentId, ownerUserId) as CoverRow | undefined;
      return row === undefined ? undefined : toCover(row);
    },
    getIncludingTrashed(ownerUserId, contentId) {
      const row = selectAny.get(contentId, ownerUserId) as CoverRow | undefined;
      return row === undefined ? undefined : toCover(row);
    },
    put(ownerUserId, contentId, image, now) {
      return db.transaction(() => write(ownerUserId, contentId, image, now))();
    },
    putIfAbsent(ownerUserId, contentId, image, now) {
      return db.transaction(() => writeIfAbsent(ownerUserId, contentId, image, now))();
    },
  };
}
