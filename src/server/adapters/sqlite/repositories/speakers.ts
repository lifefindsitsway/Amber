import { SPEAKER_AVATAR_MIMES, type SpeakerAvatarMime } from "../../../../shared/dto/speaker.ts";
import { defaultSpeakerColorIndex } from "../../../../shared/speakers.ts";
import type { ContentSpeaker, SpeakerAvatar } from "../../../domain/speaker.ts";
import type { SpeakerRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";

interface SpeakerRow {
  content_id: string;
  id: string;
  user_id: string;
  ordinal: number;
  name: string | null;
  name_confirmed_at: number | null;
  color_index: number;
  avatar_mime: string | null;
  avatar_version: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = "content_id, id, user_id, ordinal, name, name_confirmed_at, color_index, avatar_mime, avatar_version, created_at, updated_at";

/** A photo type outside the known ones (a restored backup bypasses the API) reads as no photo. */
function mimeOf(value: string | null): SpeakerAvatarMime | undefined {
  return SPEAKER_AVATAR_MIMES.find((mime) => mime === value);
}

function toSpeaker(row: SpeakerRow): ContentSpeaker {
  const mime = mimeOf(row.avatar_mime);
  return {
    contentId: row.content_id,
    id: row.id,
    userId: row.user_id,
    ordinal: row.ordinal,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.name_confirmed_at === null ? {} : { nameConfirmedAt: row.name_confirmed_at }),
    colorIndex: row.color_index,
    ...(mime === undefined ? {} : { avatar: { mime, version: row.avatar_version } }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A revision `r` of content `c` that is a comparison transcription and not the primary. A
 * comparison the user made the primary is read like any other revision, so its speakers show.
 */
const COMPARISON_REVISION = "(r.kind = 'asr' AND IFNULL(json_extract(r.generation_json, '$.purpose'), '') = 'comparison' AND r.id IS NOT c.primary_transcript_revision_id)";

/**
 * Speaker `cs` of content `c` is named only by comparison transcriptions: by a sentence of at
 * least one, by no sentence of any other revision (archived ones included) and by no draft.
 * The single definition both the list's flag and the suggestions' exclusion use.
 */
const COMPARISON_ONLY = `(
  EXISTS (SELECT 1 FROM transcript_revision r JOIN transcript_segment s ON s.revision_id = r.id
          WHERE r.content_id = cs.content_id AND ${COMPARISON_REVISION} AND s.speaker_id = cs.id)
  AND NOT EXISTS (SELECT 1 FROM transcript_revision r JOIN transcript_segment s ON s.revision_id = r.id
          WHERE r.content_id = cs.content_id AND NOT ${COMPARISON_REVISION} AND s.speaker_id = cs.id)
  AND NOT EXISTS (SELECT 1 FROM transcript_draft d JOIN json_each(d.segments_json) AS item
          WHERE d.content_id = cs.content_id AND json_type(item.value, '$.speakerId') = 'text' AND json_extract(item.value, '$.speakerId') = cs.id)
)`;

/** `%` and `_` are LIKE wildcards; a query matches them literally. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

export function sqliteSpeakerRepository(db: SqliteConnection): SpeakerRepository {
  const list = db.prepare(`SELECT ${COLUMNS} FROM content_speaker WHERE user_id = ? AND content_id = ? ORDER BY ordinal`);
  const get = db.prepare(`SELECT ${COLUMNS} FROM content_speaker WHERE user_id = ? AND content_id = ? AND id = ?`);
  const ownsContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const maxOrdinal = db.prepare("SELECT COALESCE(MAX(ordinal), 0) AS max FROM content_speaker WHERE content_id = ?");
  const insert = db.prepare(
    `INSERT INTO content_speaker (content_id, id, user_id, ordinal, name, name_confirmed_at, color_index, created_at, updated_at)
     VALUES (@contentId, @id, @userId, @ordinal, @name, @nameConfirmedAt, @colorIndex, @now, @now)`,
  );
  const updateName = db.prepare("UPDATE content_speaker SET name = @name, updated_at = @now WHERE user_id = @owner AND content_id = @contentId AND id = @id");
  const updateNameConfirmed = db.prepare(
    "UPDATE content_speaker SET name_confirmed_at = @confirmedAt, updated_at = @now WHERE user_id = @owner AND content_id = @contentId AND id = @id",
  );
  const updateColor = db.prepare("UPDATE content_speaker SET color_index = @colorIndex, updated_at = @now WHERE user_id = @owner AND content_id = @contentId AND id = @id");
  const setAvatar = db.prepare(
    `UPDATE content_speaker SET avatar_mime = @mime, avatar = @bytes, avatar_version = avatar_version + 1, updated_at = @now
     WHERE user_id = @owner AND content_id = @contentId AND id = @id`,
  );
  const clearAvatar = db.prepare(
    "UPDATE content_speaker SET avatar_mime = NULL, avatar = NULL, updated_at = @now WHERE user_id = @owner AND content_id = @contentId AND id = @id",
  );
  const avatar = db.prepare("SELECT avatar_mime, avatar, avatar_version FROM content_speaker WHERE user_id = ? AND content_id = ? AND id = ? AND avatar IS NOT NULL");
  const count = db.prepare("SELECT COUNT(*) AS count FROM content_speaker WHERE user_id = ? AND content_id = ?");
  const used = db.prepare(
    `SELECT DISTINCT s.speaker_id AS id
     FROM transcript_segment s
     JOIN transcript_revision r ON r.id = s.revision_id
     JOIN content c ON c.id = r.content_id
     WHERE c.id = @contentId AND c.user_id = @owner AND s.speaker_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM transcript_revision_archive a WHERE a.revision_id = r.id)
     UNION
     SELECT DISTINCT json_extract(item.value, '$.speakerId') AS id
     FROM transcript_draft d
     JOIN content c ON c.id = d.content_id
     JOIN json_each(d.segments_json) AS item
     WHERE d.content_id = @contentId AND c.user_id = @owner AND d.target_language IS NULL
       AND json_type(item.value, '$.speakerId') = 'text'`,
  );
  const suggestions = db.prepare(
    `SELECT ${COLUMNS.split(", ")
      .map((column) => `cs.${column}`)
      .join(", ")}, COALESCE(c.custom_title, c.title) AS content_title
     FROM content_speaker cs
     JOIN content c ON c.id = cs.content_id
     WHERE cs.user_id = @owner AND cs.name IS NOT NULL AND c.trashed_at IS NULL
       AND (@exclude IS NULL OR cs.content_id <> @exclude)
       AND (@pattern IS NULL OR cs.name LIKE @pattern ESCAPE '\\')
       AND NOT ${COMPARISON_ONLY}
     ORDER BY cs.updated_at DESC, cs.content_id, cs.id
     LIMIT @limit`,
  );
  const hasComparison = db.prepare(
    `SELECT 1 FROM transcript_revision r JOIN content c ON c.id = r.content_id
     WHERE r.content_id = ? AND c.user_id = ? AND ${COMPARISON_REVISION} LIMIT 1`,
  );
  const comparisonOnly = db.prepare(
    `SELECT cs.id FROM content_speaker cs JOIN content c ON c.id = cs.content_id AND c.user_id = cs.user_id
     WHERE cs.user_id = ? AND cs.content_id = ? AND ${COMPARISON_ONLY}`,
  );
  const referenced = db.prepare(
    `SELECT s.speaker_id AS id
     FROM transcript_revision r
     JOIN content c ON c.id = r.content_id
     JOIN transcript_segment s ON s.revision_id = r.id
     WHERE r.content_id = @contentId AND c.user_id = @owner AND s.speaker_id IN (SELECT value FROM json_each(@ids))
     UNION
     SELECT json_extract(item.value, '$.speakerId') AS id
     FROM transcript_draft d
     JOIN content c ON c.id = d.content_id
     JOIN json_each(d.segments_json) AS item
     WHERE d.content_id = @contentId AND c.user_id = @owner AND json_type(item.value, '$.speakerId') = 'text'
       AND json_extract(item.value, '$.speakerId') IN (SELECT value FROM json_each(@ids))`,
  );
  const remove = db.prepare("DELETE FROM content_speaker WHERE user_id = ? AND content_id = ? AND id IN (SELECT value FROM json_each(?))");

  const getSpeaker = (owner: string, contentId: string, speakerId: string): ContentSpeaker | undefined => {
    const row = get.get(owner, contentId, speakerId) as SpeakerRow | undefined;
    return row === undefined ? undefined : toSpeaker(row);
  };

  return {
    list(ownerUserId, contentId) {
      return (list.all(ownerUserId, contentId) as SpeakerRow[]).map(toSpeaker);
    },
    get: getSpeaker,
    insert(ownerUserId, contentId, speakers, now) {
      if (ownsContent.get(contentId, ownerUserId) === undefined) {
        throw new Error("content is not the owner's");
      }
      let ordinal = (maxOrdinal.get(contentId) as { max: number }).max;
      return speakers.map((speaker) => {
        ordinal += 1;
        insert.run({
          contentId,
          id: speaker.id,
          userId: ownerUserId,
          ordinal,
          name: speaker.name ?? null,
          nameConfirmedAt: speaker.nameConfirmedAt ?? null,
          colorIndex: speaker.colorIndex ?? defaultSpeakerColorIndex(ordinal),
          now,
        });
        return getSpeaker(ownerUserId, contentId, speaker.id) as ContentSpeaker;
      });
    },
    update(ownerUserId, contentId, speakerId, patch, now) {
      if (getSpeaker(ownerUserId, contentId, speakerId) === undefined) {
        return undefined;
      }
      const key = { owner: ownerUserId, contentId, id: speakerId, now };
      if (patch.name !== undefined) updateName.run({ ...key, name: patch.name });
      if (patch.nameConfirmedAt !== undefined) updateNameConfirmed.run({ ...key, confirmedAt: patch.nameConfirmedAt });
      if (patch.colorIndex !== undefined) updateColor.run({ ...key, colorIndex: patch.colorIndex });
      if (patch.avatar === null) clearAvatar.run(key);
      else if (patch.avatar !== undefined) setAvatar.run({ ...key, mime: patch.avatar.mime, bytes: Buffer.from(patch.avatar.bytes) });
      return getSpeaker(ownerUserId, contentId, speakerId);
    },
    getAvatar(ownerUserId, contentId, speakerId) {
      const row = avatar.get(ownerUserId, contentId, speakerId) as { avatar_mime: string; avatar: Buffer; avatar_version: number } | undefined;
      const mime = row === undefined ? undefined : mimeOf(row.avatar_mime);
      if (row === undefined || mime === undefined) return undefined;
      const stored: SpeakerAvatar & { version: number } = { mime, bytes: new Uint8Array(row.avatar), version: row.avatar_version };
      return stored;
    },
    count(ownerUserId, contentId) {
      return (count.get(ownerUserId, contentId) as { count: number }).count;
    },
    usedIds(ownerUserId, contentId) {
      return new Set((used.all({ owner: ownerUserId, contentId }) as Array<{ id: string }>).map((row) => row.id));
    },
    comparisonOnlyIds(ownerUserId, contentId) {
      // Most Contents have no comparison transcription; they skip the per-speaker checks.
      if (hasComparison.get(contentId, ownerUserId) === undefined) return new Set();
      return new Set((comparisonOnly.all(ownerUserId, contentId) as Array<{ id: string }>).map((row) => row.id));
    },
    referencedAmong(ownerUserId, contentId, speakerIds) {
      if (speakerIds.length === 0) return new Set();
      return new Set((referenced.all({ owner: ownerUserId, contentId, ids: JSON.stringify(speakerIds) }) as Array<{ id: string }>).map((row) => row.id));
    },
    delete(ownerUserId, contentId, speakerIds) {
      if (speakerIds.length === 0) return 0;
      return remove.run(ownerUserId, contentId, JSON.stringify(speakerIds)).changes;
    },
    suggestions(ownerUserId, query, excludeContentId, limit) {
      const trimmed = query.trim();
      const rows = suggestions.all({
        owner: ownerUserId,
        exclude: excludeContentId ?? null,
        pattern: trimmed === "" ? null : likePattern(trimmed),
        limit,
      }) as Array<SpeakerRow & { content_title: string | null }>;
      return rows.map((row) => ({ ...toSpeaker(row), ...(row.content_title === null ? {} : { contentTitle: row.content_title }) }));
    },
  };
}
