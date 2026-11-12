import type { SpeakerConfirmationRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";

export function sqliteSpeakerConfirmationRepository(db: SqliteConnection): SpeakerConfirmationRepository {
  const confirmedAt = db.prepare(
    `SELECT c.confirmed_at FROM transcript_revision_speaker_confirmation c
     WHERE c.revision_id = ? AND c.user_id = ?`,
  );
  const ownsRevision = db.prepare(
    `SELECT 1 FROM transcript_revision r JOIN content c ON c.id = r.content_id
     WHERE r.id = ? AND r.content_id = ? AND c.user_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO transcript_revision_speaker_confirmation (revision_id, content_id, user_id, confirmed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (revision_id) DO UPDATE SET confirmed_at = excluded.confirmed_at`,
  );
  const remove = db.prepare("DELETE FROM transcript_revision_speaker_confirmation WHERE revision_id = ? AND user_id = ?");

  return {
    confirmedAt(ownerUserId, revisionId) {
      const row = confirmedAt.get(revisionId, ownerUserId) as { confirmed_at: number } | undefined;
      return row?.confirmed_at;
    },
    confirmedAmong(ownerUserId, revisionIds) {
      const found = new Map<string, number>();
      for (const revisionId of new Set(revisionIds)) {
        const row = confirmedAt.get(revisionId, ownerUserId) as { confirmed_at: number } | undefined;
        if (row !== undefined) found.set(revisionId, row.confirmed_at);
      }
      return found;
    },
    set(ownerUserId, contentId, revisionId, at) {
      if (ownsRevision.get(revisionId, contentId, ownerUserId) === undefined) {
        throw new Error("revision is not the owner's");
      }
      if (at === undefined) remove.run(revisionId, ownerUserId);
      else upsert.run(revisionId, contentId, ownerUserId, at);
    },
  };
}
