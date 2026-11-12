import type { Migration } from "../migrations.ts";

/**
 * Speaker context: what the user has confirmed about speakers, and which speakers an AI
 * result was produced with.
 *
 * `transcript_revision_speaker_confirmation` records that the user has reviewed who said
 * each sentence of a transcript revision; no row means not reviewed. Revisions and their
 * sentences are immutable, so, like the archive mark, the flag lives beside the revision in
 * its own table and confirming or withdrawing it inserts or deletes one row. The composite
 * keys keep the mark on a revision of the same Content and under that Content's owner, and
 * the cascades drop it with the revision, the Content or the user.
 *
 * `content_speaker.name_confirmed_at` is when the user confirmed a speaker's name; NULL means
 * the name (if any) has not been confirmed.
 *
 * `speaker_context_json` on summaries, rolling-summary partials, chapters, highlights and
 * chat messages records the speaker context an AI result or chat answer was generated with,
 * kept on the immutable row itself because it belongs to how that row was produced.
 *
 * `chat_message.context_used_json` records the material an answer was finally planned with
 * (its mode, whether it took a selection of someone's speech, whether the default summary
 * was left out), written once planning is done, so a reload shows what the answer used.
 *
 * `chat_compaction.speaker_bases_json` records what the absorbed answers that read speakers
 * were based on (revision, speaker snapshot, cited sentences). A compaction is immutable
 * apart from `through_message_id`; the trigger names its immutable columns, so it is
 * recreated to cover the new column too while keeping that one exception.
 *
 * Every new column is nullable and no existing row is rewritten: earlier rows read as absent.
 */
export const migration0029: Migration = {
  version: 29,
  name: "speaker-context",
  sql: `
    CREATE TABLE transcript_revision_speaker_confirmation (
      revision_id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      confirmed_at INTEGER NOT NULL,
      FOREIGN KEY (revision_id, content_id) REFERENCES transcript_revision (id, content_id) ON DELETE CASCADE,
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX transcript_revision_speaker_confirmation_content ON transcript_revision_speaker_confirmation (content_id, user_id);

    ALTER TABLE content_speaker ADD COLUMN name_confirmed_at INTEGER;

    ALTER TABLE summary_revision ADD COLUMN speaker_context_json TEXT CHECK (speaker_context_json IS NULL OR json_valid(speaker_context_json));
    ALTER TABLE rollup_partial ADD COLUMN speaker_context_json TEXT CHECK (speaker_context_json IS NULL OR json_valid(speaker_context_json));
    ALTER TABLE chapter_revision ADD COLUMN speaker_context_json TEXT CHECK (speaker_context_json IS NULL OR json_valid(speaker_context_json));
    ALTER TABLE highlight_revision ADD COLUMN speaker_context_json TEXT CHECK (speaker_context_json IS NULL OR json_valid(speaker_context_json));
    ALTER TABLE chat_message ADD COLUMN speaker_context_json TEXT CHECK (speaker_context_json IS NULL OR json_valid(speaker_context_json));
    ALTER TABLE chat_message ADD COLUMN context_used_json TEXT CHECK (context_used_json IS NULL OR json_valid(context_used_json));

    ALTER TABLE chat_compaction ADD COLUMN speaker_bases_json TEXT CHECK (speaker_bases_json IS NULL OR json_valid(speaker_bases_json));
    DROP TRIGGER chat_compaction_immutable;
    CREATE TRIGGER chat_compaction_immutable
    BEFORE UPDATE OF id, thread_id, body, model_ref_json, prompt_ref_json, prompt_snapshot, created_at, speaker_bases_json ON chat_compaction
    BEGIN
      SELECT RAISE(ABORT, 'chat_compaction is immutable');
    END;
  `,
};
