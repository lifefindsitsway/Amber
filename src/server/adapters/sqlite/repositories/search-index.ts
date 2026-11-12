import { questionTrigrams } from "../../../domain/search-query.ts";
import type { SearchIndexHit, SearchIndexQuery, SearchIndexRepository } from "../../../ports/repository.ts";
import type { SqliteConnection, SqliteStatement } from "../database.ts";

/** Citation markers carry ids, not words; they are left out of the indexed text. */
const MARKERS = /\[\[(?:seg|unresolved):[^\]]*\]\]/g;

const COLUMNS = "text, kind, user_id, content_id, collection_id, revision_id, segment_id, start_ms";

/** A whole term as one FTS5 string: inner quotes doubled, so input never becomes query syntax. */
function ftsString(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** A `LIKE` pattern matching `term` literally anywhere; `\` is the escape character. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

interface HitRow {
  kind: SearchIndexHit["kind"];
  content_id: string | null;
  collection_id: string | null;
  revision_id: string | null;
  segment_id: string | null;
  start_ms: number | null;
  text: string;
  artifact_id: string | null;
  template_id: string | null;
  speaker_id: string | null;
  speaker_ordinal: number | null;
  speaker_name: string | null;
  speaker_color_index: number | null;
  speakers_confirmed: number | null;
}

function toHit(row: HitRow): SearchIndexHit {
  switch (row.kind) {
    case "segment":
      return {
        kind: "segment",
        contentId: row.content_id as string,
        transcriptRevisionId: row.revision_id as string,
        segmentId: row.segment_id as string,
        startMs: row.start_ms as number,
        text: row.text,
        ...(row.speaker_id === null
          ? {}
          : {
              speaker: {
                id: row.speaker_id,
                ordinal: row.speaker_ordinal as number,
                ...(row.speaker_name === null ? {} : { name: row.speaker_name }),
                colorIndex: row.speaker_color_index as number,
                confirmed: row.speakers_confirmed === 1,
              },
            }),
      };
    case "summary":
      return {
        kind: "summary",
        contentId: row.content_id as string,
        artifactId: row.artifact_id as string,
        templateId: row.template_id as string,
        summaryRevisionId: row.revision_id as string,
        text: row.text,
      };
    case "collection":
      return { kind: "collection", collectionId: row.collection_id as string, text: row.text };
    default:
      return { kind: row.kind, contentId: row.content_id as string, text: row.text };
  }
}

/** Kinds in the order a `like` scan reports them, so short lists still show titles first. */
const LIKE_ORDER = ["title", "collection", "reference", "summary", "segment"] as const;

/**
 * The FTS5 projection, derived from the business tables with
 * `INSERT … SELECT`; summary bodies pass through JavaScript to drop citation markers.
 * Rows are located by their UNINDEXED columns, so re-deriving one Content scans the table:
 * acceptable at personal-library scale, revisited if libraries grow large.
 */
export function sqliteSearchIndexRepository(db: SqliteConnection): SearchIndexRepository {
  // `@all = 1` lifts the owner / id filter for a full rebuild; a trashed Content is never projected.
  const contentFilter = "(@all = 1 OR (c.user_id = @owner AND c.id = @contentId)) AND c.trashed_at IS NULL";
  const insertTitles = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT coalesce(c.custom_title, c.title), 'title', c.user_id, c.id, NULL, NULL, NULL, NULL FROM content c
     WHERE ${contentFilter} AND coalesce(c.custom_title, c.title) IS NOT NULL AND coalesce(c.custom_title, c.title) <> ''`,
  );
  const insertSegments = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT s.text, 'segment', c.user_id, c.id, NULL, s.revision_id, s.id, s.start_ms
     FROM content c JOIN transcript_segment s ON s.revision_id = c.primary_transcript_revision_id
     WHERE ${contentFilter} ORDER BY c.id, s.ordinal`,
  );
  const insertReferences = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT r.text, 'reference', c.user_id, c.id, NULL, r.id, NULL, NULL
     FROM content c JOIN reference_text r ON r.content_id = c.id
     WHERE ${contentFilter} ORDER BY c.id, r.created_at, r.id`,
  );
  const currentSummaries = db.prepare(
    `SELECT r.id AS revision_id, r.body, c.user_id, c.id AS content_id
     FROM content c JOIN summary_artifact a ON a.content_id = c.id JOIN summary_revision r ON r.id = a.current_revision_id
     WHERE ${contentFilter} ORDER BY c.id, a.template_id`,
  );
  const insertRow = db.prepare(
    `INSERT INTO search_index (${COLUMNS}) VALUES (@text, @kind, @userId, @contentId, @collectionId, @revisionId, NULL, NULL)`,
  );
  const insertCollections = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT trim(k.name || ' ' || coalesce(k.description, '')), 'collection', k.user_id, NULL, k.id, NULL, NULL, NULL
     FROM collection k WHERE (@all = 1 OR (k.user_id = @owner AND k.id = @collectionId))`,
  );
  const deleteContent = db.prepare("DELETE FROM search_index WHERE user_id = ? AND content_id = ?");
  const deleteCollection = db.prepare("DELETE FROM search_index WHERE user_id = ? AND kind = 'collection' AND collection_id = ?");
  const deleteAll = db.prepare("DELETE FROM search_index");
  const anyRow = db.prepare("SELECT 1 FROM search_index LIMIT 1");
  const anySource = db.prepare("SELECT 1 FROM content WHERE trashed_at IS NULL UNION ALL SELECT 1 FROM collection LIMIT 1");
  const matchSegments = db.prepare(
    `SELECT segment_id FROM search_index
     WHERE search_index MATCH @match AND user_id = @owner AND kind = 'segment' AND revision_id = @revisionId
     ORDER BY bm25(search_index) LIMIT @limit`,
  );
  // The same ranking within the sentences of some speakers: filtered here, before the
  // limit, so a speaker's hits are not crowded out by everyone else's.
  const matchSpeakerSegments = db.prepare(
    `SELECT segment_id FROM search_index
     WHERE search_index MATCH @match AND user_id = @owner AND kind = 'segment' AND revision_id = @revisionId
       AND segment_id IN (SELECT s.id FROM transcript_segment s
         WHERE s.revision_id = @revisionId AND s.speaker_id IN (SELECT value FROM json_each(@speakers)))
     ORDER BY bm25(search_index) LIMIT @limit`,
  );

  const projectContent = (params: { all: number; owner: string | null; contentId: string | null }): void => {
    insertTitles.run(params);
    insertSegments.run(params);
    insertReferences.run(params);
    const summaries = currentSummaries.all(params) as Array<{ revision_id: string; body: string; user_id: string; content_id: string }>;
    for (const summary of summaries) {
      insertRow.run({
        text: summary.body.replace(MARKERS, " "),
        kind: "summary",
        userId: summary.user_id,
        contentId: summary.content_id,
        collectionId: null,
        revisionId: summary.revision_id,
      });
    }
  };

  // Prepared per shape: the number of terms varies with the query.
  const statements = new Map<string, SqliteStatement>();
  const statement = (sql: string): SqliteStatement => {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };

  // A sentence's speaker is joined as it is now, never indexed: a rename or a review shows at once.
  const SELECT_HIT = `SELECT si.kind, si.content_id, si.collection_id, si.revision_id, si.segment_id, si.start_ms, si.text,
      a.id AS artifact_id, a.template_id,
      sp.id AS speaker_id, sp.ordinal AS speaker_ordinal, sp.name AS speaker_name, sp.color_index AS speaker_color_index,
      CASE WHEN sc.revision_id IS NULL THEN 0 ELSE 1 END AS speakers_confirmed
    FROM search_index si
    LEFT JOIN summary_revision sr ON si.kind = 'summary' AND sr.id = si.revision_id
    LEFT JOIN summary_artifact a ON a.id = sr.artifact_id
    LEFT JOIN transcript_segment ts ON si.kind = 'segment' AND ts.id = si.segment_id
    LEFT JOIN content_speaker sp ON sp.content_id = si.content_id AND sp.id = ts.speaker_id
    LEFT JOIN transcript_revision_speaker_confirmation sc ON si.kind = 'segment' AND sc.revision_id = si.revision_id`;
  const speakerNameFilter = (terms: number): string => Array.from({ length: terms }, () => " AND sp.name LIKE ? ESCAPE '\\'").join("");

  /** Scope condition and its parameters; content scopes never return collection rows. */
  const scopeOf = (query: SearchIndexQuery): { sql: string; params: unknown[]; kinds: readonly string[] } => {
    switch (query.scope.kind) {
      case "global":
        return { sql: "", params: [], kinds: LIKE_ORDER };
      case "library":
        return { sql: "", params: [], kinds: LIKE_ORDER.filter((kind) => kind !== "collection") };
      case "collection":
        return {
          sql: " AND si.content_id IN (SELECT content_id FROM collection_item WHERE collection_id = ?)",
          params: [query.scope.collectionId],
          kinds: LIKE_ORDER.filter((kind) => kind !== "collection"),
        };
    }
  };

  return {
    syncContent(ownerUserId, contentId) {
      deleteContent.run(ownerUserId, contentId);
      projectContent({ all: 0, owner: ownerUserId, contentId });
    },
    removeContent(ownerUserId, contentId) {
      deleteContent.run(ownerUserId, contentId);
    },
    syncCollection(ownerUserId, collectionId) {
      deleteCollection.run(ownerUserId, collectionId);
      insertCollections.run({ all: 0, owner: ownerUserId, collectionId });
    },
    removeCollection(ownerUserId, collectionId) {
      deleteCollection.run(ownerUserId, collectionId);
    },
    query(ownerUserId, query) {
      if (query.terms.length === 0) {
        return [];
      }
      const scope = scopeOf(query);
      if (query.mode === "fts") {
        const match = query.terms.map(ftsString).join(" ");
        const hits: SearchIndexHit[] = [];
        for (const kind of scope.kinds) {
          const rows = statement(
            `${SELECT_HIT} WHERE search_index MATCH ? AND si.user_id = ? AND si.kind = ?${scope.sql}
             ORDER BY bm25(search_index), si.rowid LIMIT ?`,
          ).all(match, ownerUserId, kind, ...scope.params, query.groupLimit) as HitRow[];
          hits.push(...rows.map(toHit));
        }
        return hits;
      }
      const likes = query.terms.map(() => " AND si.text LIKE ? ESCAPE '\\'").join("");
      const kinds = scope.kinds.map(() => "?").join(", ");
      const order = scope.kinds.map((kind, index) => `WHEN '${kind}' THEN ${index}`).join(" ");
      const rows = statement(
        `${SELECT_HIT} WHERE si.user_id = ? AND si.kind IN (${kinds})${likes}${scope.sql}
         ORDER BY CASE si.kind ${order} END, si.rowid LIMIT ?`,
      ).all(ownerUserId, ...scope.kinds, ...query.terms.map(likePattern), ...scope.params, query.likeLimit) as HitRow[];
      const perKind = new Map<string, number>();
      const hits: SearchIndexHit[] = [];
      for (const row of rows) {
        const seen = perKind.get(row.kind) ?? 0;
        if (seen < query.groupLimit) {
          perKind.set(row.kind, seen + 1);
          hits.push(toHit(row));
        }
      }
      return hits;
    },
    matchSegments(ownerUserId, transcriptRevisionId, question, limit, options) {
      const grams = questionTrigrams(question);
      const speakerIds = options?.speakerIds;
      if (grams.length === 0 || limit <= 0 || speakerIds?.length === 0) {
        return [];
      }
      const params = { match: grams.map(ftsString).join(" OR "), owner: ownerUserId, revisionId: transcriptRevisionId, limit };
      const rows = (
        speakerIds === undefined ? matchSegments.all(params) : matchSpeakerSegments.all({ ...params, speakers: JSON.stringify(speakerIds) })
      ) as Array<{
        segment_id: string;
      }>;
      return rows.map((row) => row.segment_id);
    },
    matchSpeakers(ownerUserId, terms, limit) {
      if (terms.length === 0 || limit <= 0) {
        return [];
      }
      const rows = statement(
        `SELECT * FROM (
           SELECT sp.content_id, sp.id, sp.ordinal, sp.name, sp.color_index,
             (SELECT count(*) FROM transcript_segment s WHERE s.revision_id = c.primary_transcript_revision_id AND s.speaker_id = sp.id) AS sentences
           FROM content_speaker sp JOIN content c ON c.id = sp.content_id AND c.user_id = sp.user_id
           WHERE sp.user_id = ? AND c.trashed_at IS NULL AND c.primary_transcript_revision_id IS NOT NULL AND sp.name IS NOT NULL${speakerNameFilter(terms.length)}
         ) WHERE sentences > 0
         ORDER BY sentences DESC, content_id, ordinal LIMIT ?`,
      ).all(ownerUserId, ...terms.map(likePattern), limit) as Array<{
        content_id: string;
        id: string;
        ordinal: number;
        name: string;
        color_index: number;
        sentences: number;
      }>;
      return rows.map((row) => ({
        contentId: row.content_id,
        speakerId: row.id,
        ordinal: row.ordinal,
        name: row.name,
        colorIndex: row.color_index,
        sentences: row.sentences,
      }));
    },
    rebuild() {
      deleteAll.run();
      projectContent({ all: 1, owner: null, contentId: null });
      insertCollections.run({ all: 1, owner: null, collectionId: null });
    },
    healthy() {
      try {
        db.prepare("INSERT INTO search_index (search_index) VALUES ('integrity-check')").run();
      } catch {
        return false;
      }
      return !(anyRow.get() === undefined && anySource.get() !== undefined);
    },
  };
}
