import { markedSegmentIds } from "../../../domain/citations.ts";
import type { HistoryArtifactRef, RevisionBlockerCategory, RevisionReference } from "../../../domain/transcript.ts";
import type { RevisionReferenceRepository } from "../../../ports/repository.ts";
import { amberError } from "../../../domain/errors.ts";
import type { SqliteConnection } from "../database.ts";

/**
 * Element `value` of an `inputs_json` array (an artifact's provenance inputs): a
 * `transcriptRevision` input names the revision as `id`, a collection item snapshot as
 * `transcriptRevisionId`; other kinds name none.
 */
const INPUT_REVISION = `CASE json_extract(input.value, '$.kind')
  WHEN 'transcriptRevision' THEN json_extract(input.value, '$.id')
  ELSE json_extract(input.value, '$.transcriptRevisionId')
END`;

/**
 * Citations arrays hold `{ transcriptRevisionId, segmentId }`; both ends are references.
 * `ref` is the column naming the referencing row (the row itself unless it is part of another).
 */
function citationTargets(table: string, alias: string, where: string, ref = `${alias}.id`): string {
  return `
    SELECT ${ref} AS ref, json_extract(citation.value, '$.transcriptRevisionId') AS target
    FROM ${table}, json_each(${alias}.citations_json) AS citation ${where}
    UNION ALL
    SELECT ${ref} AS ref, segment.revision_id AS target
    FROM ${table}, json_each(${alias}.citations_json) AS citation
    JOIN transcript_segment AS segment ON segment.id = json_extract(citation.value, '$.segmentId') ${where}`;
}

function inputTargets(table: string, alias: string, where: string, ref = `${alias}.id`): string {
  return `SELECT ${ref} AS ref, ${INPUT_REVISION} AS target FROM ${table}, json_each(${alias}.inputs_json) AS input ${where}`;
}

const SUMMARY_OF_CONTENT = "summary_revision AS summary JOIN summary_artifact AS artifact ON artifact.id = summary.artifact_id";
const PARTIAL_OF_CONTENT = `rollup_partial AS partial
  JOIN summary_revision AS owner ON owner.id = partial.summary_revision_id
  JOIN summary_artifact AS artifact ON artifact.id = owner.artifact_id`;
const PARTIAL_OF_USER_COLLECTIONS = `rollup_partial AS partial
  JOIN collection_summary_revision AS owner ON owner.id = partial.collection_summary_revision_id
  JOIN collection_summary_artifact AS artifact ON artifact.id = owner.artifact_id
  JOIN collection ON collection.id = artifact.collection_id`;
const COLLECTION_SUMMARY_OF_USER = `collection_summary_revision AS collected
  JOIN collection_summary_artifact AS artifact ON artifact.id = collected.artifact_id
  JOIN collection ON collection.id = artifact.collection_id`;
const CHAPTER_OF_CONTENT = "chapter_revision AS chapter JOIN chapter_artifact AS artifact ON artifact.id = chapter.artifact_id";
const HIGHLIGHT_OF_CONTENT = "highlight_revision AS highlight JOIN highlight_artifact AS artifact ON artifact.id = highlight.artifact_id";
const MESSAGE_OF_CONTENT = "chat_message AS message JOIN chat_thread AS thread ON thread.id = message.thread_id";
const COMPACTION_OF_CONTENT = "chat_compaction AS compaction JOIN chat_thread AS thread ON thread.id = compaction.thread_id";

const BY_CONTENT = "WHERE artifact.content_id = @content";
const BY_USER_COLLECTIONS = "WHERE collection.user_id = @user";

/**
 * Structured references: each query yields `(ref, target)` pairs, one per revision a row
 * reaches, with sentence ids resolved to their revision by key lookup. Every row is matched
 * by exact key or JSON path, never by substring.
 */
const STRUCTURED: ReadonlyArray<{ category: RevisionBlockerCategory; prefix: string; sql: string }> = [
  {
    category: "draft",
    prefix: "draft",
    sql: "SELECT id AS ref, base_revision_id AS target FROM transcript_draft WHERE content_id = @content",
  },
  {
    category: "notes",
    prefix: "note",
    sql: `
      SELECT note.id AS ref, note.transcript_revision_id AS target FROM note WHERE note.content_id = @content AND note.user_id = @user
      UNION ALL
      SELECT note.id, segment.revision_id FROM note JOIN transcript_segment AS segment ON segment.id = note.start_segment_id
      WHERE note.content_id = @content AND note.user_id = @user
      UNION ALL
      SELECT note.id, segment.revision_id FROM note JOIN transcript_segment AS segment ON segment.id = note.end_segment_id
      WHERE note.content_id = @content AND note.user_id = @user`,
  },
  {
    category: "highlights",
    prefix: "highlight",
    sql: `
      SELECT highlight.id AS ref, highlight.transcript_revision_id AS target FROM ${HIGHLIGHT_OF_CONTENT} ${BY_CONTENT}
      UNION ALL
      ${inputTargets(HIGHLIGHT_OF_CONTENT, "highlight", BY_CONTENT)}
      UNION ALL
      SELECT highlight.id, segment.revision_id FROM ${HIGHLIGHT_OF_CONTENT}, json_each(highlight.items_json) AS item
      JOIN transcript_segment AS segment ON segment.id = json_extract(item.value, '$.segmentId') ${BY_CONTENT}`,
  },
  {
    category: "chatMessages",
    prefix: "message",
    sql: `
      SELECT message.id AS ref, message.context_transcript_revision_id AS target FROM ${MESSAGE_OF_CONTENT}
      WHERE thread.content_id = @content AND message.context_transcript_revision_id IS NOT NULL
      UNION ALL
      ${citationTargets(MESSAGE_OF_CONTENT, "message", "WHERE thread.content_id = @content")}`,
  },
  {
    category: "artifacts",
    prefix: "summary",
    sql: `${inputTargets(SUMMARY_OF_CONTENT, "summary", BY_CONTENT)}
      UNION ALL
      ${citationTargets(SUMMARY_OF_CONTENT, "summary", BY_CONTENT)}`,
  },
  {
    // A summary's rolling partials are part of it: kept and deleted with their summary.
    category: "artifacts",
    prefix: "summary",
    sql: `${inputTargets(PARTIAL_OF_CONTENT, "partial", BY_CONTENT, "owner.id")}
      UNION ALL
      ${citationTargets(PARTIAL_OF_CONTENT, "partial", BY_CONTENT, "owner.id")}`,
  },
  {
    category: "artifacts",
    prefix: "partial",
    sql: `${inputTargets(PARTIAL_OF_USER_COLLECTIONS, "partial", BY_USER_COLLECTIONS)}
      UNION ALL
      ${citationTargets(PARTIAL_OF_USER_COLLECTIONS, "partial", BY_USER_COLLECTIONS)}`,
  },
  {
    category: "artifacts",
    prefix: "chapter",
    sql: `${inputTargets(CHAPTER_OF_CONTENT, "chapter", BY_CONTENT)}
      UNION ALL
      SELECT chapter.id AS ref, json_extract(chapter.origin_json, '$.transcriptRevisionId') AS target FROM ${CHAPTER_OF_CONTENT} ${BY_CONTENT}
      UNION ALL
      SELECT chapter.id, segment.revision_id FROM ${CHAPTER_OF_CONTENT}, json_each(chapter.chapters_json) AS entry
      JOIN transcript_segment AS segment ON segment.id = json_extract(entry.value, '$.startSegmentId') ${BY_CONTENT}`,
  },
  {
    category: "artifacts",
    prefix: "collection-summary",
    sql: `${inputTargets(COLLECTION_SUMMARY_OF_USER, "collected", BY_USER_COLLECTIONS)}
      UNION ALL
      SELECT collected.id AS ref, json_extract(item.value, '$.transcriptRevisionId') AS target
      FROM ${COLLECTION_SUMMARY_OF_USER}, json_each(collected.input_items_json) AS item ${BY_USER_COLLECTIONS}
      UNION ALL
      ${citationTargets(COLLECTION_SUMMARY_OF_USER, "collected", BY_USER_COLLECTIONS)}`,
  },
  {
    // Only unfinished Tasks: a finished Task's request is a record of what was done. An
    // unfinished Task of the Content itself reaches every revision of it: its stages may
    // read whatever is primary when they run, so no revision may vanish underneath them.
    category: "activeTasks",
    prefix: "task",
    sql: `
      SELECT task.id AS ref, revision.id AS target
      FROM task JOIN transcript_revision AS revision ON revision.content_id = task.content_id
      WHERE task.content_id = @content AND task.user_id = @user AND task.finished_at IS NULL
      UNION ALL
      SELECT task.id AS ref, field.value AS target
      FROM task, json_each(json_array(
        json_extract(task.request_json, '$.baseRevisionId'),
        json_extract(task.request_json, '$.initialSubtitleRevisionId'),
        json_extract(task.request_json, '$.revisionId'),
        json_extract(task.request_json, '$.translationRevisionId')
      )) AS field
      WHERE task.user_id = @user AND task.finished_at IS NULL
      UNION ALL
      SELECT task.id, json_extract(item.value, '$.transcriptRevisionId')
      FROM task, json_each(task.request_json, '$.inputItems') AS item
      WHERE task.user_id = @user AND task.finished_at IS NULL`,
  },
];

/**
 * Bodies whose `[[seg:<segmentId>]]` markers are references. Rows without any marker are
 * skipped in SQL; the markers themselves are extracted exactly in code.
 */
const MARKED: ReadonlyArray<{ category: RevisionBlockerCategory; prefix: string; sql: string }> = [
  {
    category: "chatMessages",
    prefix: "message",
    sql: `SELECT message.id AS ref, message.text AS body FROM ${MESSAGE_OF_CONTENT}
      WHERE thread.content_id = @content AND instr(message.text, '[[seg:') > 0`,
  },
  {
    category: "chatMessages",
    prefix: "compaction",
    sql: `SELECT compaction.id AS ref, compaction.body AS body FROM ${COMPACTION_OF_CONTENT}
      WHERE thread.content_id = @content AND instr(compaction.body, '[[seg:') > 0`,
  },
  {
    category: "artifacts",
    prefix: "summary",
    sql: `SELECT summary.id AS ref, summary.body AS body FROM ${SUMMARY_OF_CONTENT} ${BY_CONTENT} AND instr(summary.body, '[[seg:') > 0`,
  },
  {
    category: "artifacts",
    prefix: "summary",
    sql: `SELECT owner.id AS ref, partial.body AS body FROM ${PARTIAL_OF_CONTENT} ${BY_CONTENT} AND instr(partial.body, '[[seg:') > 0`,
  },
  {
    category: "artifacts",
    prefix: "partial",
    sql: `SELECT partial.id AS ref, partial.body AS body FROM ${PARTIAL_OF_USER_COLLECTIONS} ${BY_USER_COLLECTIONS} AND instr(partial.body, '[[seg:') > 0`,
  },
  {
    category: "artifacts",
    prefix: "collection-summary",
    sql: `SELECT collected.id AS ref, collected.body AS body FROM ${COLLECTION_SUMMARY_OF_USER} ${BY_USER_COLLECTIONS}
      AND instr(collected.body, '[[seg:') > 0`,
  },
];

/** Child revisions, by parent pointer or by sentence lineage into the parent. */
const CHILDREN_SQL = `
  SELECT child.id AS holder, child.parent_revision_id AS target FROM transcript_revision AS child
  WHERE child.content_id = @content AND child.parent_revision_id IS NOT NULL
  UNION
  SELECT child.revision_id, parent.revision_id
  FROM transcript_revision AS revision
  JOIN transcript_segment AS parent ON parent.revision_id = revision.id
  JOIN transcript_segment_source AS source ON source.parent_segment_id = parent.id
  JOIN transcript_segment AS child ON child.id = source.child_segment_id
  WHERE revision.content_id = @content`;

/**
 * Whether a summary, chapter or highlight revision is history only: not its artifact's
 * current revision and nothing built on it. A collection summary that froze a summary, or a
 * summary written over a chapter revision, keeps it from going.
 */
const HISTORY_SQL: Record<HistoryArtifactRef["kind"], string> = {
  summary: `
    SELECT summary.id AS id, summary.created_at AS createdAt, artifact.template_id AS templateId
    FROM summary_revision AS summary JOIN summary_artifact AS artifact ON artifact.id = summary.artifact_id
    WHERE summary.id = @id AND artifact.current_revision_id IS NOT summary.id
      AND NOT EXISTS (
        SELECT 1 FROM collection_summary_revision AS collected, json_each(collected.input_items_json) AS item
        WHERE json_extract(item.value, '$.summaryRevisionId') = summary.id)
      AND NOT EXISTS (
        SELECT 1 FROM collection_summary_revision AS collected, json_each(collected.inputs_json) AS input
        WHERE json_extract(input.value, '$.summaryRevisionId') = summary.id
           OR (json_extract(input.value, '$.kind') = 'summaryRevision' AND json_extract(input.value, '$.id') = summary.id))
      AND NOT EXISTS (
        SELECT 1 FROM rollup_partial AS partial, json_each(partial.inputs_json) AS input
        WHERE json_extract(input.value, '$.summaryRevisionId') = summary.id
           OR (json_extract(input.value, '$.kind') = 'summaryRevision' AND json_extract(input.value, '$.id') = summary.id))`,
  chapter: `
    SELECT chapter.id AS id, chapter.created_at AS createdAt
    FROM chapter_revision AS chapter JOIN chapter_artifact AS artifact ON artifact.id = chapter.artifact_id
    WHERE chapter.id = @id AND artifact.current_revision_id IS NOT chapter.id
      AND NOT EXISTS (SELECT 1 FROM summary_revision AS summary WHERE summary.chapter_revision_id = chapter.id)
      AND NOT EXISTS (
        SELECT 1 FROM summary_revision AS summary, json_each(summary.inputs_json) AS input
        WHERE json_extract(input.value, '$.kind') = 'chapterRevision' AND json_extract(input.value, '$.id') = chapter.id)
      AND NOT EXISTS (
        SELECT 1 FROM rollup_partial AS partial, json_each(partial.inputs_json) AS input
        WHERE json_extract(input.value, '$.kind') = 'chapterRevision' AND json_extract(input.value, '$.id') = chapter.id)`,
  highlight: `
    SELECT highlight.id AS id, highlight.created_at AS createdAt
    FROM highlight_revision AS highlight JOIN highlight_artifact AS artifact ON artifact.id = highlight.artifact_id
    WHERE highlight.id = @id AND artifact.current_revision_id IS NOT highlight.id`,
};

/** Reference prefixes whose rows are artifact revisions that may be history only. */
const HISTORY_PREFIXES: Readonly<Record<string, HistoryArtifactRef["kind"]>> = { summary: "summary", chapter: "chapter", highlight: "highlight" };

const HISTORY_TABLES: Record<HistoryArtifactRef["kind"], { table: string; artifact: string }> = {
  summary: { table: "summary_revision", artifact: "summary_artifact" },
  chapter: { table: "chapter_revision", artifact: "chapter_artifact" },
  highlight: { table: "highlight_revision", artifact: "highlight_artifact" },
};

export function sqliteRevisionReferenceRepository(db: SqliteConnection): RevisionReferenceRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const children = db.prepare(CHILDREN_SQL);
  const structured = STRUCTURED.map((query) => ({ ...query, statement: db.prepare(query.sql) }));
  const marked = MARKED.map((query) => ({ ...query, statement: db.prepare(query.sql) }));
  const segmentRevision = db.prepare("SELECT revision_id FROM transcript_segment WHERE id = ?");
  const history = Object.fromEntries(Object.entries(HISTORY_SQL).map(([kind, sql]) => [kind, db.prepare(sql)])) as Record<
    HistoryArtifactRef["kind"],
    ReturnType<SqliteConnection["prepare"]>
  >;
  const historyOf = (key: string): HistoryArtifactRef | undefined => {
    const separator = key.indexOf(":");
    const kind = HISTORY_PREFIXES[key.slice(0, separator)];
    if (kind === undefined) {
      return undefined;
    }
    const row = history[kind].get({ id: key.slice(separator + 1) }) as { id: string; createdAt: number; templateId?: string | null } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { kind, revisionId: row.id, ...(typeof row.templateId === "string" ? { templateId: row.templateId } : {}), createdAt: row.createdAt };
  };

  const ownedHistory = Object.fromEntries(
    Object.entries(HISTORY_TABLES).map(([kind, { table, artifact }]) => [
      kind,
      db.prepare(`SELECT 1 FROM ${table} AS revision JOIN ${artifact} AS artifact ON artifact.id = revision.artifact_id
        JOIN content ON content.id = artifact.content_id WHERE revision.id = ? AND content.user_id = ?`),
    ]),
  ) as Record<HistoryArtifactRef["kind"], ReturnType<SqliteConnection["prepare"]>>;
  const deleteHistory = Object.fromEntries(
    Object.entries(HISTORY_TABLES).map(([kind, { table }]) => [kind, db.prepare(`DELETE FROM ${table} WHERE id = ?`)]),
  ) as Record<HistoryArtifactRef["kind"], ReturnType<SqliteConnection["prepare"]>>;

  return {
    deleteHistoryArtifact(ownerUserId, artifact) {
      // Re-checked here so that a current revision, or one something builds on, never goes.
      if (this.historyArtifact(ownerUserId, artifact.kind, artifact.revisionId) === undefined) {
        throw amberError("internal", "not a history-only artifact revision of the owner");
      }
      // Rolling partials cascade with their summary; token usage keeps its rows (triggers clear the link).
      deleteHistory[artifact.kind].run(artifact.revisionId);
    },
    historyArtifact(ownerUserId, kind, revisionId) {
      return ownedHistory[kind].get(revisionId, ownerUserId) === undefined ? undefined : historyOf(`${kind}:${revisionId}`);
    },
    listReferences(ownerUserId, contentId) {
      if (ownedContent.get(contentId, ownerUserId) === undefined) {
        return [];
      }
      const params = { content: contentId, user: ownerUserId };
      const references: RevisionReference[] = [];
      for (const row of children.all(params) as Array<{ holder: string; target: string }>) {
        references.push({ category: "children", revisionIds: [row.target], holderRevisionId: row.holder });
      }

      // Rows are keyed by category and table so one row's structured and marked references merge.
      const grouped = new Map<string, { category: RevisionBlockerCategory; revisionIds: Set<string> }>();
      const add = (category: RevisionBlockerCategory, key: string, target: string | null | undefined): void => {
        let entry = grouped.get(key);
        if (entry === undefined) {
          entry = { category, revisionIds: new Set() };
          grouped.set(key, entry);
        }
        if (typeof target === "string" && target.length > 0) {
          entry.revisionIds.add(target);
        }
      };
      for (const query of structured) {
        for (const row of query.statement.all(params) as Array<{ ref: string; target: unknown }>) {
          add(query.category, `${query.prefix}:${row.ref}`, typeof row.target === "string" ? row.target : undefined);
        }
      }
      const resolved = new Map<string, string | undefined>();
      const revisionOf = (segmentId: string): string | undefined => {
        if (!resolved.has(segmentId)) {
          const row = segmentRevision.get(segmentId) as { revision_id: string } | undefined;
          resolved.set(segmentId, row?.revision_id);
        }
        return resolved.get(segmentId);
      };
      for (const query of marked) {
        for (const row of query.statement.all(params) as Array<{ ref: string; body: string }>) {
          for (const segmentId of markedSegmentIds(row.body)) {
            add(query.category, `${query.prefix}:${row.ref}`, revisionOf(segmentId));
          }
        }
      }
      for (const [key, entry] of grouped) {
        if (entry.revisionIds.size === 0) {
          continue;
        }
        const historyRef = historyOf(key);
        references.push(
          historyRef === undefined
            ? { category: entry.category, revisionIds: [...entry.revisionIds] }
            : { category: "history", revisionIds: [...entry.revisionIds], history: historyRef },
        );
      }
      return references;
    },
  };
}
