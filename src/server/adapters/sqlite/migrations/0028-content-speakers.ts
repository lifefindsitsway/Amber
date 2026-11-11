import { ASR_DIARIZATION_DEFAULT, SPEAKER_PALETTE_SIZE } from "../../../../shared/defaults.ts";
import type { Migration } from "../migrations.ts";

/**
 * Speaker identities. `content_speaker` holds the speakers of each Content: the id is unique
 * within its Content only, so the key is composite, and `ordinal` (the N of 「发言人 N」) is
 * unique per Content. Sentences keep their `speaker_id` column; since segments are immutable
 * a foreign key would buy nothing, so a trigger checks on insert that a named speaker exists
 * in the revision's Content. Rows go with their Content.
 *
 * Earlier databases may already hold raw provider labels on sentences (only a build that
 * turned identification on could write them). Each Content gets one row per label, numbered
 * by first appearance (revision creation, then sentence order), and no sentence is rewritten;
 * the same label in two transcriptions of one Content becomes one identity.
 *
 * `user_settings.asr_diarization` is the "identify speakers" setting.
 */
export const migration0028: Migration = {
  version: 28,
  name: "content-speakers",
  sql: `
    CREATE TABLE content_speaker (
      content_id TEXT NOT NULL,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
      name TEXT CHECK (name IS NULL OR name <> ''),
      color_index INTEGER NOT NULL CHECK (color_index >= 0 AND color_index < ${SPEAKER_PALETTE_SIZE}),
      avatar_mime TEXT CHECK (avatar_mime IS NULL OR avatar_mime IN ('image/webp', 'image/png', 'image/jpeg')),
      avatar BLOB,
      avatar_version INTEGER NOT NULL DEFAULT 0 CHECK (avatar_version >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (content_id, id),
      UNIQUE (content_id, ordinal),
      CHECK ((avatar IS NULL) = (avatar_mime IS NULL)),
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX content_speaker_named ON content_speaker (user_id, updated_at DESC) WHERE name IS NOT NULL;

    INSERT INTO content_speaker (content_id, id, user_id, ordinal, name, color_index, created_at, updated_at)
    SELECT content_id, speaker_id, user_id, rank, NULL, (rank - 1) % ${SPEAKER_PALETTE_SIZE}, first_at, first_at
    FROM (
      SELECT content_id, speaker_id, user_id, first_at,
             ROW_NUMBER() OVER (PARTITION BY content_id ORDER BY first_at, first_ordinal, speaker_id) AS rank
      FROM (
        SELECT r.content_id, s.speaker_id, c.user_id,
               MIN(r.created_at) AS first_at,
               MIN(r.created_at * 1000000 + s.ordinal) AS first_ordinal
        FROM transcript_segment s
        JOIN transcript_revision r ON r.id = s.revision_id
        JOIN content c ON c.id = r.content_id
        WHERE s.speaker_id IS NOT NULL
        GROUP BY r.content_id, s.speaker_id
      )
    );

    CREATE TRIGGER transcript_segment_speaker_known BEFORE INSERT ON transcript_segment
    WHEN NEW.speaker_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM content_speaker cs
      JOIN transcript_revision r ON r.content_id = cs.content_id
      WHERE r.id = NEW.revision_id AND cs.id = NEW.speaker_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'transcript_segment speaker is not a speaker of its content');
    END;

    ALTER TABLE user_settings ADD COLUMN asr_diarization INTEGER NOT NULL DEFAULT ${ASR_DIARIZATION_DEFAULT ? 1 : 0} CHECK (asr_diarization IN (0, 1));
  `,
};
