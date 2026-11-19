import type { Migration } from "../migrations.ts";

/**
 * Transfer identity of what a content pack carries between devices. Every record a pack
 * import creates gets a fresh local id and keeps the id it had on the device it came from in
 * `origin_id`; the transfer identity of a record is `origin_id ?? id`, so carrying it on again
 * keeps the first identity. A speaker's identity is the pair (Content identity, speaker id),
 * because older libraries reuse the same speaker ids across Contents.
 *
 * `content_origin_map` / `collection_origin_map` remember that the user chose to merge a
 * carried Content or collection into a local one whose identity differs. Each row names its
 * owner and the composite foreign key keeps the target in the same user's library; a row goes
 * with its target. One identity may map to several local records (the user imported it twice
 * on purpose), and then the user picks the target every time.
 *
 * `transcript_revision` keeps its immutability trigger: `origin_id` is written on insert only.
 */
export const migration0034: Migration = {
  version: 34,
  name: "transfer-origins",
  sql: `
    ALTER TABLE content ADD COLUMN origin_id TEXT;
    ALTER TABLE transcript_revision ADD COLUMN origin_id TEXT;
    ALTER TABLE note ADD COLUMN origin_id TEXT;
    ALTER TABLE content_figure ADD COLUMN origin_id TEXT;
    ALTER TABLE collection ADD COLUMN origin_id TEXT;
    ALTER TABLE content_speaker ADD COLUMN origin_content_id TEXT;
    ALTER TABLE content_speaker ADD COLUMN origin_speaker_id TEXT CHECK ((origin_content_id IS NULL) = (origin_speaker_id IS NULL));
    CREATE INDEX content_origin ON content (user_id, origin_id) WHERE origin_id IS NOT NULL;
    CREATE INDEX collection_origin ON collection (user_id, origin_id) WHERE origin_id IS NOT NULL;

    CREATE TABLE content_origin_map (
      user_id TEXT NOT NULL,
      origin_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, origin_id, content_id),
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX content_origin_map_content ON content_origin_map (content_id);

    CREATE TABLE collection_origin_map (
      user_id TEXT NOT NULL,
      origin_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, origin_id, collection_id),
      FOREIGN KEY (collection_id, user_id) REFERENCES collection (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX collection_origin_map_collection ON collection_origin_map (collection_id);
  `,
};
