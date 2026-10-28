import type { PromptOverride, PromptOverrideVersion } from "../../../domain/artifact.ts";
import { amberError } from "../../../domain/errors.ts";
import type { PromptOverrideRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { withoutNulls } from "./rows.ts";

interface OverrideRow {
  user_id: string;
  prompt_id: string;
  current_version: number | null;
  updated_at: number;
}

interface VersionRow {
  user_id: string;
  prompt_id: string;
  version: number;
  text: string;
  created_at: number;
}

function toOverride(row: OverrideRow): PromptOverride {
  return withoutNulls<PromptOverride>({
    userId: row.user_id,
    promptId: row.prompt_id,
    currentVersion: row.current_version,
    updatedAt: row.updated_at,
  });
}

function toVersion(row: VersionRow): PromptOverrideVersion {
  return { userId: row.user_id, promptId: row.prompt_id, version: row.version, text: row.text, createdAt: row.created_at };
}

/** Rows carry their owner directly; every statement is keyed by `user_id`. */
export function sqlitePromptOverrideRepository(db: SqliteConnection): PromptOverrideRepository {
  const listOverrides = db.prepare("SELECT * FROM prompt_override WHERE user_id = ? ORDER BY prompt_id");
  const getOverride = db.prepare("SELECT * FROM prompt_override WHERE user_id = ? AND prompt_id = ?");
  const getVersion = db.prepare("SELECT * FROM prompt_override_version WHERE user_id = ? AND prompt_id = ? AND version = ?");
  const listVersions = db.prepare("SELECT * FROM prompt_override_version WHERE user_id = ? AND prompt_id = ? ORDER BY version");
  const latestVersion = db.prepare("SELECT max(version) AS version FROM prompt_override_version WHERE user_id = ? AND prompt_id = ?");
  const insertOverride = db.prepare(
    "INSERT INTO prompt_override (user_id, prompt_id, current_version, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT (user_id, prompt_id) DO NOTHING",
  );
  const insertVersion = db.prepare(
    "INSERT INTO prompt_override_version (user_id, prompt_id, version, text, created_at) VALUES (@userId, @promptId, @version, @text, @createdAt)",
  );
  const setCurrent = db.prepare("UPDATE prompt_override SET current_version = ?, updated_at = ? WHERE user_id = ? AND prompt_id = ?");

  return {
    list(ownerUserId) {
      return (listOverrides.all(ownerUserId) as OverrideRow[]).map(toOverride);
    },
    get(ownerUserId, promptId) {
      const row = getOverride.get(ownerUserId, promptId) as OverrideRow | undefined;
      return row === undefined ? undefined : toOverride(row);
    },
    getVersion(ownerUserId, promptId, version) {
      const row = getVersion.get(ownerUserId, promptId, version) as VersionRow | undefined;
      return row === undefined ? undefined : toVersion(row);
    },
    listVersions(ownerUserId, promptId) {
      return (listVersions.all(ownerUserId, promptId) as VersionRow[]).map(toVersion);
    },
    addVersion(version) {
      const latest = (latestVersion.get(version.userId, version.promptId) as { version: number | null }).version ?? 0;
      if (version.version !== latest + 1) {
        throw amberError("internal", `prompt version ${version.version} does not follow ${latest}`);
      }
      // The version row must exist before `current_version` may point at it.
      insertOverride.run(version.userId, version.promptId, version.createdAt);
      insertVersion.run(version);
      setCurrent.run(version.version, version.createdAt, version.userId, version.promptId);
    },
    clearCurrent(ownerUserId, promptId, updatedAt) {
      return setCurrent.run(null, updatedAt, ownerUserId, promptId).changes > 0;
    },
  };
}
