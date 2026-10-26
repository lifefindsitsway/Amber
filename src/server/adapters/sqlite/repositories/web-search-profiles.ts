import type { WebSearchService } from "../../../../shared/enums.ts";
import type { WebSearchProfile } from "../../../domain/web-search.ts";
import type { WebSearchProfileRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { nullable, withoutNulls } from "./rows.ts";

interface WebSearchProfileRow {
  user_id: string;
  service: WebSearchService;
  credential_ref: string | null;
  created_at: number;
  updated_at: number;
}

export function sqliteWebSearchProfileRepository(db: SqliteConnection): WebSearchProfileRepository {
  const select = db.prepare("SELECT * FROM web_search_profile WHERE user_id = ?");
  const upsert = db.prepare(
    `INSERT INTO web_search_profile (user_id, service, credential_ref, created_at, updated_at)
     VALUES (@userId, @service, @credentialRef, @createdAt, @updatedAt)
     ON CONFLICT (user_id) DO UPDATE SET service = excluded.service, credential_ref = excluded.credential_ref, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare("DELETE FROM web_search_profile WHERE user_id = ?");
  const clearCredentials = db.prepare("UPDATE web_search_profile SET credential_ref = NULL WHERE credential_ref IS NOT NULL");

  return {
    get(ownerUserId) {
      const row = select.get(ownerUserId) as WebSearchProfileRow | undefined;
      return row === undefined
        ? undefined
        : withoutNulls<WebSearchProfile>({ userId: row.user_id, service: row.service, credentialRef: row.credential_ref, createdAt: row.created_at, updatedAt: row.updated_at });
    },
    put(profile) {
      upsert.run({ userId: profile.userId, service: profile.service, credentialRef: nullable(profile.credentialRef), createdAt: profile.createdAt, updatedAt: profile.updatedAt });
    },
    delete(ownerUserId) {
      return remove.run(ownerUserId).changes > 0;
    },
    clearCredentials() {
      clearCredentials.run();
    },
  };
}
