import type { ContentFigure } from "../../../domain/figure.ts";
import type { FigurePatch, FigureRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { withoutNulls } from "./rows.ts";

interface FigureRow {
  id: string;
  content_id: string;
  user_id: string;
  source: ContentFigure["source"];
  captured_at_ms: number | null;
  display_ms: number;
  anchor_revision_id: string | null;
  anchor_segment_id: string | null;
  anchor_side: "before" | "after" | null;
  sort_key: number;
  width_ratio: number;
  caption: string | null;
  image_width: number;
  image_height: number;
  image_bytes: number;
  image_sha256: string;
  version: number;
  deleted_at: number | null;
  origin_id: string | null;
  created_at: number;
  updated_at: number;
}

function toFigure(row: FigureRow): ContentFigure {
  return withoutNulls<ContentFigure>({
    id: row.id,
    contentId: row.content_id,
    userId: row.user_id,
    source: row.source,
    capturedAtMs: row.captured_at_ms,
    displayMs: row.display_ms,
    anchor:
      row.anchor_revision_id === null || row.anchor_segment_id === null || row.anchor_side === null
        ? null
        : { revisionId: row.anchor_revision_id, segmentId: row.anchor_segment_id, side: row.anchor_side },
    sortKey: row.sort_key,
    widthRatio: row.width_ratio,
    caption: row.caption,
    image: { width: row.image_width, height: row.image_height, bytes: row.image_bytes, sha256: row.image_sha256 },
    version: row.version,
    deletedAt: row.deleted_at,
    originId: row.origin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function sqliteFigureRepository(db: SqliteConnection): FigureRepository {
  const select = db.prepare("SELECT * FROM content_figure WHERE id = ? AND user_id = ?");
  const byContent = db.prepare("SELECT * FROM content_figure WHERE content_id = ? AND user_id = ? ORDER BY display_ms, sort_key, created_at, id");
  const count = db.prepare("SELECT count(*) AS n FROM content_figure WHERE content_id = ? AND user_id = ?");
  const insert = db.prepare(
    `INSERT INTO content_figure (
       id, content_id, user_id, source, captured_at_ms, display_ms, anchor_revision_id, anchor_segment_id, anchor_side,
       sort_key, width_ratio, caption, image_width, image_height, image_bytes, image_sha256, version, deleted_at,
       origin_id, created_at, updated_at
     ) VALUES (
       @id, @contentId, @userId, @source, @capturedAtMs, @displayMs, @anchorRevisionId, @anchorSegmentId, @anchorSide,
       @sortKey, @widthRatio, @caption, @imageWidth, @imageHeight, @imageBytes, @imageSha256, @version, @deletedAt,
       @originId, @createdAt, @updatedAt
     )`,
  );
  const insertImage = db.prepare("INSERT INTO content_figure_image (figure_id, bytes) VALUES (?, ?)");
  const image = db.prepare(
    `SELECT image.bytes FROM content_figure_image AS image
     JOIN content_figure AS figure ON figure.id = image.figure_id
     WHERE image.figure_id = ? AND figure.user_id = ?`,
  );
  const write = db.prepare(
    `UPDATE content_figure SET
       caption = @caption, width_ratio = @widthRatio, display_ms = @displayMs,
       anchor_revision_id = @anchorRevisionId, anchor_segment_id = @anchorSegmentId, anchor_side = @anchorSide,
       sort_key = @sortKey, deleted_at = @deletedAt, version = version + 1, updated_at = @updatedAt
     WHERE id = @id AND user_id = @owner`,
  );
  const due = db.prepare("SELECT id, user_id, content_id FROM content_figure WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at, id LIMIT ?");
  const remove = db.prepare("DELETE FROM content_figure WHERE id = ?");

  const get = (owner: string, id: string): ContentFigure | undefined => {
    const row = select.get(id, owner) as FigureRow | undefined;
    return row === undefined ? undefined : toFigure(row);
  };

  const store = (owner: string, figure: ContentFigure, now: number): ContentFigure => {
    write.run({
      id: figure.id,
      owner,
      caption: figure.caption ?? null,
      widthRatio: figure.widthRatio,
      displayMs: figure.displayMs,
      anchorRevisionId: figure.anchor?.revisionId ?? null,
      anchorSegmentId: figure.anchor?.segmentId ?? null,
      anchorSide: figure.anchor?.side ?? null,
      sortKey: figure.sortKey,
      deletedAt: figure.deletedAt ?? null,
      updatedAt: now,
    });
    const stored = get(owner, figure.id);
    if (stored === undefined) {
      throw new Error("figure vanished during its update");
    }
    return stored;
  };

  return {
    get,
    listByContent(owner, contentId) {
      return (byContent.all(contentId, owner) as FigureRow[]).map(toFigure);
    },
    countByContent(owner, contentId) {
      return (count.get(contentId, owner) as { n: number }).n;
    },
    insert(figure, bytes) {
      insert.run({
        id: figure.id,
        contentId: figure.contentId,
        userId: figure.userId,
        source: figure.source,
        capturedAtMs: figure.capturedAtMs ?? null,
        displayMs: figure.displayMs,
        anchorRevisionId: figure.anchor?.revisionId ?? null,
        anchorSegmentId: figure.anchor?.segmentId ?? null,
        anchorSide: figure.anchor?.side ?? null,
        sortKey: figure.sortKey,
        widthRatio: figure.widthRatio,
        caption: figure.caption ?? null,
        imageWidth: figure.image.width,
        imageHeight: figure.image.height,
        imageBytes: figure.image.bytes,
        imageSha256: figure.image.sha256,
        version: figure.version,
        deletedAt: figure.deletedAt ?? null,
        originId: figure.originId ?? null,
        createdAt: figure.createdAt,
        updatedAt: figure.updatedAt,
      });
      insertImage.run(figure.id, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
    update(owner, id, expectedVersion, patch: FigurePatch, now) {
      const current = get(owner, id);
      if (current === undefined) {
        return undefined;
      }
      if (current.version !== expectedVersion) {
        return { conflict: "version_mismatch", currentVersion: current.version };
      }
      const next: ContentFigure = { ...current };
      if (patch.caption !== undefined) {
        if (patch.caption === null) delete next.caption;
        else next.caption = patch.caption;
      }
      if (patch.widthRatio !== undefined) next.widthRatio = patch.widthRatio;
      if (patch.displayMs !== undefined) next.displayMs = patch.displayMs;
      if (patch.anchor !== undefined) {
        if (patch.anchor === null) delete next.anchor;
        else next.anchor = patch.anchor;
      }
      if (patch.sortKey !== undefined) next.sortKey = patch.sortKey;
      return store(owner, next, now);
    },
    setDeleted(owner, id, deletedAt, now) {
      const current = get(owner, id);
      if (current === undefined) {
        return undefined;
      }
      if (current.deletedAt === deletedAt || (deletedAt !== undefined && current.deletedAt !== undefined)) {
        return current;
      }
      const next: ContentFigure = { ...current };
      if (deletedAt === undefined) delete next.deletedAt;
      else next.deletedAt = deletedAt;
      return store(owner, next, now);
    },
    getImage(owner, id) {
      const row = image.get(id, owner) as { bytes: Buffer } | undefined;
      return row === undefined ? undefined : new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
    },
    purgeDeleted(before, limit) {
      const rows = due.all(before, limit) as Array<{ id: string; user_id: string; content_id: string }>;
      for (const row of rows) {
        remove.run(row.id);
      }
      return rows.map((row) => ({ userId: row.user_id, contentId: row.content_id, figureId: row.id }));
    },
  };
}
