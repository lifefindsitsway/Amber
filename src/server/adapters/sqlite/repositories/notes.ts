import type { Note } from "../../../domain/note.ts";
import type { NoteGroup, NoteRepository, TimedNote } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface NoteRow {
  id: string;
  user_id: string;
  content_id: string;
  transcript_revision_id: string;
  start_segment_id: string;
  start_offset: number;
  end_segment_id: string;
  end_offset: number;
  quote: string;
  mark: Note["mark"];
  color: Note["color"];
  comment: string | null;
  origin_id: string | null;
  created_at: number;
  updated_at: number;
  start_ms: number;
}

function toNote(row: NoteRow): TimedNote {
  return withoutNulls<TimedNote>({
    id: row.id,
    userId: row.user_id,
    contentId: row.content_id,
    transcriptRevisionId: row.transcript_revision_id,
    startSegmentId: row.start_segment_id,
    startOffset: row.start_offset,
    endSegmentId: row.end_segment_id,
    endOffset: row.end_offset,
    quote: row.quote,
    mark: row.mark,
    color: row.color,
    comment: row.comment,
    originId: row.origin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startMs: row.start_ms,
  });
}

/** Every read joins the start sentence: its time orders the notes and is shown with each of them. */
const TIMED = `SELECT note.*, segment.start_ms FROM note
  JOIN transcript_segment AS segment ON segment.id = note.start_segment_id`;

export function sqliteNoteRepository(db: SqliteConnection): NoteRepository {
  const select = db.prepare(`${TIMED} WHERE note.id = ? AND note.user_id = ?`);
  const byContent = db.prepare(
    `${TIMED} WHERE note.content_id = ? AND note.user_id = ?
     ORDER BY segment.start_ms, note.start_offset, note.created_at, note.id`,
  );
  const countByContent = db.prepare("SELECT count(*) AS n FROM note WHERE content_id = ? AND user_id = ?");
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const insert = db.prepare(
    `INSERT INTO note (
       id, user_id, content_id, transcript_revision_id, start_segment_id, start_offset, end_segment_id, end_offset,
       quote, mark, color, comment, origin_id, created_at, updated_at
     ) VALUES (
       @id, @userId, @contentId, @transcriptRevisionId, @startSegmentId, @startOffset, @endSegmentId, @endOffset,
       @quote, @mark, @color, @comment, @originId, @createdAt, @updatedAt
     )`,
  );
  // NULL binds keep a field as it is; `setComment` tells "clear the comment" from "leave it".
  const update = db.prepare(
    `UPDATE note SET
       mark = coalesce(@mark, mark),
       color = coalesce(@color, color),
       comment = CASE WHEN @setComment = 1 THEN @comment ELSE comment END,
       updated_at = @updatedAt
     WHERE id = @id AND user_id = @owner`,
  );
  const remove = db.prepare("DELETE FROM note WHERE id = ? AND user_id = ?");
  // Parameters are always bound, `NULL` meaning "from the start", so one statement serves every page.
  const groups = db.prepare(
    `SELECT note.content_id AS contentId, count(*) AS count, max(note.created_at) AS latestAt FROM note
     JOIN content ON content.id = note.content_id AND content.user_id = note.user_id
     WHERE note.user_id = @owner AND content.trashed_at IS NULL
     GROUP BY note.content_id
     HAVING @afterLatest IS NULL OR latestAt < @afterLatest OR (latestAt = @afterLatest AND contentId < @afterContent)
     ORDER BY latestAt DESC, contentId DESC
     LIMIT @limit OFFSET @offset`,
  );
  const countGroups = db.prepare(
    `SELECT count(DISTINCT note.content_id) AS n FROM note
     JOIN content ON content.id = note.content_id AND content.user_id = note.user_id
     WHERE note.user_id = ? AND content.trashed_at IS NULL`,
  );

  return {
    get(ownerUserId, noteId) {
      const row = select.get(noteId, ownerUserId) as NoteRow | undefined;
      return row === undefined ? undefined : toNote(row);
    },
    listByContent(ownerUserId, contentId) {
      return (byContent.all(contentId, ownerUserId) as NoteRow[]).map(toNote);
    },
    countByContent(ownerUserId, contentId) {
      return (countByContent.get(contentId, ownerUserId) as { n: number }).n;
    },
    insert(note) {
      if (ownedContent.get(note.contentId, note.userId) === undefined) {
        throw notFound("content", note.contentId);
      }
      insert.run({
        id: note.id,
        userId: note.userId,
        contentId: note.contentId,
        transcriptRevisionId: note.transcriptRevisionId,
        startSegmentId: note.startSegmentId,
        startOffset: note.startOffset,
        endSegmentId: note.endSegmentId,
        endOffset: note.endOffset,
        quote: note.quote,
        mark: note.mark,
        color: note.color,
        comment: nullable(note.comment),
        originId: nullable(note.originId),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
    },
    update(ownerUserId, noteId, patch, updatedAt) {
      return (
        update.run({
          id: noteId,
          owner: ownerUserId,
          mark: nullable(patch.mark),
          color: nullable(patch.color),
          setComment: "comment" in patch ? 1 : 0,
          comment: nullable(patch.comment),
          updatedAt,
        }).changes > 0
      );
    },
    delete(ownerUserId, noteId) {
      return remove.run(noteId, ownerUserId).changes > 0;
    },
    listGroups(ownerUserId, position) {
      return groups.all({
        owner: ownerUserId,
        afterLatest: position.after?.latestAt ?? null,
        afterContent: position.after?.contentId ?? null,
        limit: position.limit,
        offset: position.offset ?? 0,
      }) as NoteGroup[];
    },
    countGroups(ownerUserId) {
      return (countGroups.get(ownerUserId) as { n: number }).n;
    },
  };
}
