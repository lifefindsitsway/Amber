import { amberError } from "../../../domain/errors.ts";
import {
  checkTranscriptInvariants,
  type TranscriptDraft,
  type TranscriptGeneration,
  type TranscriptRevision,
  type TranscriptSegment,
  type TranscriptWord,
} from "../../../domain/transcript.ts";
import type { SegmentId } from "../../../../shared/ids.ts";
import type { TranscriptRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface RevisionRow {
  id: string;
  content_id: string;
  kind: TranscriptRevision["kind"];
  parent_revision_id: string | null;
  language: string;
  timing_fidelity: TranscriptRevision["timingFidelity"];
  generation_json: string;
  segment_count: number;
  created_at: number;
}

interface SegmentRow {
  id: string;
  revision_id: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  text: string;
  words_json: string | null;
  speaker_id: string | null;
  paragraph_start: number | null;
}

interface SourceRow {
  child_segment_id: string;
  parent_segment_id: string;
}

interface DraftRow {
  id: string;
  content_id: string;
  base_revision_id: string;
  segments_json: string;
  updated_at: number;
}

function toSegment(row: SegmentRow, sources: readonly SegmentId[]): TranscriptSegment {
  return withoutNulls<TranscriptSegment>({
    id: row.id as SegmentId,
    revisionId: row.revision_id,
    ordinal: row.ordinal,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    words: parseJsonOrNull<TranscriptWord[]>(row.words_json),
    speakerId: row.speaker_id,
    paragraphStart: row.paragraph_start === null ? null : row.paragraph_start === 1,
    sourceSegmentIds: [...sources],
  });
}

function toDraft(row: DraftRow): TranscriptDraft {
  return {
    id: row.id,
    contentId: row.content_id,
    baseRevisionId: row.base_revision_id,
    segments: parseJson<TranscriptDraft["segments"]>(row.segments_json),
    updatedAt: row.updated_at,
  };
}

function toRevision(row: RevisionRow): TranscriptRevision {
  return withoutNulls<TranscriptRevision>({
    id: row.id,
    contentId: row.content_id,
    kind: row.kind,
    parentRevisionId: row.parent_revision_id,
    language: row.language,
    timingFidelity: row.timing_fidelity,
    generation: parseJson<TranscriptGeneration>(row.generation_json),
    segmentCount: row.segment_count,
    createdAt: row.created_at,
  });
}

export function sqliteTranscriptRepository(db: SqliteConnection): TranscriptRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const ownedRevision = db.prepare(
    `SELECT revision.* FROM transcript_revision AS revision
     JOIN content ON content.id = revision.content_id
     WHERE revision.id = ? AND content.user_id = ?`,
  );
  const revisionsOfContent = db.prepare(
    `SELECT revision.* FROM transcript_revision AS revision
     JOIN content ON content.id = revision.content_id
     WHERE revision.content_id = ? AND content.user_id = ?
     ORDER BY revision.created_at, revision.id`,
  );
  const segmentsOfRevision = db.prepare("SELECT * FROM transcript_segment WHERE revision_id = ? ORDER BY ordinal");
  const segmentPage = db.prepare(
    "SELECT * FROM transcript_segment WHERE revision_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?",
  );
  const sourcesOfRevision = db.prepare(
    `SELECT source.child_segment_id, source.parent_segment_id FROM transcript_segment_source AS source
     JOIN transcript_segment AS child ON child.id = source.child_segment_id
     WHERE child.revision_id = ?
     ORDER BY source.child_segment_id, source.position`,
  );
  const sourcesOfPage = db.prepare(
    `SELECT source.child_segment_id, source.parent_segment_id FROM transcript_segment_source AS source
     JOIN transcript_segment AS child ON child.id = source.child_segment_id
     WHERE child.revision_id = ? AND child.ordinal > ? AND child.ordinal <= ?
     ORDER BY source.child_segment_id, source.position`,
  );
  const ownedSegment = db.prepare(
    `SELECT segment.* FROM transcript_segment AS segment
     JOIN transcript_revision AS revision ON revision.id = segment.revision_id
     JOIN content ON content.id = revision.content_id
     WHERE segment.id = ? AND content.user_id = ?`,
  );
  const sourcesOfSegment = db.prepare(
    "SELECT parent_segment_id FROM transcript_segment_source WHERE child_segment_id = ? ORDER BY position",
  );
  const draftOfContent = db.prepare(
    `SELECT draft.* FROM transcript_draft AS draft
     JOIN content ON content.id = draft.content_id
     WHERE draft.content_id = ? AND content.user_id = ?`,
  );
  const upsertDraft = db.prepare(
    `INSERT INTO transcript_draft (id, content_id, base_revision_id, segments_json, updated_at)
     VALUES (@id, @contentId, @baseRevisionId, @segmentsJson, @updatedAt)
     ON CONFLICT (content_id) DO UPDATE SET
       id = excluded.id,
       base_revision_id = excluded.base_revision_id,
       segments_json = excluded.segments_json,
       updated_at = excluded.updated_at`,
  );
  const deleteDraft = db.prepare(
    "DELETE FROM transcript_draft WHERE content_id = ? AND content_id IN (SELECT id FROM content WHERE user_id = ?)",
  );
  const segmentOfRevision = db.prepare("SELECT 1 FROM transcript_segment WHERE id = ? AND revision_id = ?");
  const insertRevision = db.prepare(
    `INSERT INTO transcript_revision (
       id, content_id, kind, parent_revision_id, language, timing_fidelity, generation_json, segment_count, created_at
     ) VALUES (
       @id, @contentId, @kind, @parentRevisionId, @language, @timingFidelity, @generationJson, @segmentCount, @createdAt
     )`,
  );
  const insertSegment = db.prepare(
    `INSERT INTO transcript_segment (id, revision_id, ordinal, start_ms, end_ms, text, words_json, speaker_id, paragraph_start)
     VALUES (@id, @revisionId, @ordinal, @startMs, @endMs, @text, @wordsJson, @speakerId, @paragraphStart)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO transcript_segment_source (child_segment_id, parent_segment_id, position)
     VALUES (?, ?, ?)`,
  );
  const deleteRevision = db.prepare(
    `DELETE FROM transcript_revision
     WHERE id = ? AND content_id IN (SELECT id FROM content WHERE user_id = ?)`,
  );
  const archivedOfContent = db.prepare(
    `SELECT archive.revision_id, archive.archived_at FROM transcript_revision_archive AS archive
     JOIN content ON content.id = archive.content_id
     WHERE archive.content_id = ? AND content.user_id = ?
     ORDER BY archive.archived_at, archive.revision_id`,
  );
  const insertArchive = db.prepare(
    `INSERT INTO transcript_revision_archive (revision_id, content_id, archived_at) VALUES (?, ?, ?)
     ON CONFLICT (revision_id) DO NOTHING`,
  );
  const deleteArchive = db.prepare("DELETE FROM transcript_revision_archive WHERE revision_id = ?");

  return {
    insertRevision(ownerUserId, revision, segments) {
      if (ownedContent.get(revision.contentId, ownerUserId) === undefined) {
        throw notFound("content", revision.contentId);
      }
      const violations = checkTranscriptInvariants(revision, segments);
      const parentId = revision.parentRevisionId;
      for (const segment of segments) {
        const foreign = segment.sourceSegmentIds.some(
          (source) => parentId === undefined || segmentOfRevision.get(source, parentId) === undefined,
        );
        if (foreign) {
          violations.push({ segmentId: segment.id, rule: "source_count_mismatch" });
        }
      }
      if (violations.length > 0) {
        const rules = [...new Set(violations.map((violation) => violation.rule))].join(", ");
        throw amberError("internal", `transcript revision ${revision.id} violates ${rules}`);
      }
      insertRevision.run({
        id: revision.id,
        contentId: revision.contentId,
        kind: revision.kind,
        parentRevisionId: nullable(revision.parentRevisionId),
        language: revision.language,
        timingFidelity: revision.timingFidelity,
        generationJson: JSON.stringify(revision.generation),
        segmentCount: revision.segmentCount,
        createdAt: revision.createdAt,
      });
      for (const segment of segments) {
        insertSegment.run({
          id: segment.id,
          revisionId: segment.revisionId,
          ordinal: segment.ordinal,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          wordsJson: jsonOrNull(segment.words),
          speakerId: nullable(segment.speakerId),
          paragraphStart: segment.paragraphStart === undefined ? null : segment.paragraphStart ? 1 : 0,
        });
        segment.sourceSegmentIds.forEach((source, position) => insertSource.run(segment.id, source, position));
      }
    },
    getRevision(ownerUserId, revisionId) {
      const row = ownedRevision.get(revisionId, ownerUserId) as RevisionRow | undefined;
      return row === undefined ? undefined : toRevision(row);
    },
    listRevisions(ownerUserId, contentId) {
      return (revisionsOfContent.all(contentId, ownerUserId) as RevisionRow[]).map(toRevision);
    },
    listSegments(ownerUserId, revisionId, page) {
      if (ownedRevision.get(revisionId, ownerUserId) === undefined) {
        return [];
      }
      let rows: SegmentRow[];
      let sourceRows: SourceRow[];
      if (page === undefined) {
        rows = segmentsOfRevision.all(revisionId) as SegmentRow[];
        sourceRows = sourcesOfRevision.all(revisionId) as SourceRow[];
      } else {
        const after = page.afterOrdinal ?? -1;
        rows = segmentPage.all(revisionId, after, page.limit) as SegmentRow[];
        const last = rows.at(-1);
        sourceRows = last === undefined ? [] : (sourcesOfPage.all(revisionId, after, last.ordinal) as SourceRow[]);
      }
      const sources = new Map<string, SegmentId[]>();
      for (const row of sourceRows) {
        const list = sources.get(row.child_segment_id) ?? [];
        list.push(row.parent_segment_id as SegmentId);
        sources.set(row.child_segment_id, list);
      }
      return rows.map((row) => toSegment(row, sources.get(row.id) ?? []));
    },
    getSegment(ownerUserId, segmentId) {
      const row = ownedSegment.get(segmentId, ownerUserId) as SegmentRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const sources = (sourcesOfSegment.all(segmentId) as Array<{ parent_segment_id: string }>).map(
        (source) => source.parent_segment_id as SegmentId,
      );
      return toSegment(row, sources);
    },
    getDraft(ownerUserId, contentId) {
      const row = draftOfContent.get(contentId, ownerUserId) as DraftRow | undefined;
      return row === undefined ? undefined : toDraft(row);
    },
    putDraft(ownerUserId, draft) {
      if (ownedContent.get(draft.contentId, ownerUserId) === undefined) {
        throw notFound("content", draft.contentId);
      }
      const base = ownedRevision.get(draft.baseRevisionId, ownerUserId) as RevisionRow | undefined;
      if (base === undefined || base.content_id !== draft.contentId) {
        throw notFound("transcript revision", draft.baseRevisionId);
      }
      upsertDraft.run({
        id: draft.id,
        contentId: draft.contentId,
        baseRevisionId: draft.baseRevisionId,
        segmentsJson: JSON.stringify(draft.segments),
        updatedAt: draft.updatedAt,
      });
    },
    deleteDraft(ownerUserId, contentId) {
      return deleteDraft.run(contentId, ownerUserId).changes > 0;
    },
    deleteRevision(ownerUserId, revisionId) {
      return deleteRevision.run(revisionId, ownerUserId).changes > 0;
    },
    listArchived(ownerUserId, contentId) {
      return (archivedOfContent.all(contentId, ownerUserId) as Array<{ revision_id: string; archived_at: number }>).map((row) => ({
        revisionId: row.revision_id,
        archivedAt: row.archived_at,
      }));
    },
    setArchived(ownerUserId, revisionId, archivedAt) {
      const revision = ownedRevision.get(revisionId, ownerUserId) as RevisionRow | undefined;
      if (revision === undefined) {
        throw notFound("transcript revision", revisionId);
      }
      if (archivedAt === undefined) {
        deleteArchive.run(revisionId);
      } else {
        insertArchive.run(revisionId, revision.content_id, archivedAt);
      }
    },
  };
}
