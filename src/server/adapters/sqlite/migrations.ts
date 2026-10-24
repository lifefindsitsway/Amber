import { appError, AmberError } from "../../domain/errors.ts";
import type { SqliteConnection } from "./database.ts";
import { migration0001 } from "./migrations/0001-m0-sentinel.ts";
import { migration0002 } from "./migrations/0002-domain-schema.ts";
import { migration0003 } from "./migrations/0003-runtime-support.ts";
import { migration0004 } from "./migrations/0004-work-unit-billing.ts";
import { migration0005 } from "./migrations/0005-transcript-draft-unique.ts";
import { migration0006 } from "./migrations/0006-user-settings.ts";
import { migration0007 } from "./migrations/0007-search-index.ts";
import { migration0008 } from "./migrations/0008-server-auth.ts";
import { migration0009 } from "./migrations/0009-cache-root.ts";
import { migration0010 } from "./migrations/0010-paragraph-start.ts";
import { migration0011 } from "./migrations/0011-content-custom-title-pinned.ts";
import { migration0012 } from "./migrations/0012-provider-profile-position.ts";
import { migration0013 } from "./migrations/0013-concurrency-settings.ts";
import { migration0014 } from "./migrations/0014-collection-updated-at.ts";
import { migration0015 } from "./migrations/0015-note.ts";
import { migration0016 } from "./migrations/0016-content-trash.ts";
import { migration0017 } from "./migrations/0017-asr-profiles.ts";
import { migration0018 } from "./migrations/0018-model-pricing.ts";
import { migration0019 } from "./migrations/0019-eye-care-themes.ts";
import { migration0020 } from "./migrations/0020-transcript-revision-archive.ts";
import { migration0021 } from "./migrations/0021-cache-quality-and-trash-identity.ts";

export interface Migration {
  /** Becomes `PRAGMA user_version` once applied; versions are consecutive from 1. */
  version: number;
  /** Matches the `NNNN-<name>.ts` file that holds it. */
  name: string;
  sql: string;
}

/** Append-only: an applied migration is never edited, later changes get a new file. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007, migration0008, migration0009, migration0010, migration0011, migration0012, migration0013, migration0014, migration0015, migration0016, migration0017, migration0018, migration0019, migration0020, migration0021];

export function latestSchemaVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.at(-1)?.version ?? 0;
}

/** Refusal to open a database written by a newer build. */
export function schemaVersionUnsupported(found: number, supported: number): AmberError {
  return new AmberError(
    appError("schema_version_unsupported"),
    `database schema version ${found} is newer than the supported ${supported}`,
  );
}

export interface MigrationOutcome {
  from: number;
  to: number;
}

/**
 * Applies pending migrations in order, each in its own transaction together with the
 * `user_version` bump, then verifies referential integrity. A database written by a
 * newer build is refused rather than opened with a schema this build does not understand.
 */
export function migrate(db: SqliteConnection, migrations: readonly Migration[] = MIGRATIONS): MigrationOutcome {
  const latest = latestSchemaVersion(migrations);
  const from = db.pragma("user_version", { simple: true }) as number;
  if (from > latest) {
    throw schemaVersionUnsupported(from, latest);
  }
  for (const migration of migrations) {
    if (migration.version <= from) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  if (latest > from) {
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`migration to version ${latest} left ${violations.length} foreign key violations`);
    }
  }
  return { from, to: Math.max(from, latest) };
}
