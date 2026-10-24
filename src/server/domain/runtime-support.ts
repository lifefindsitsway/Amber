import type { Theme } from "../../shared/dto/settings.ts";
import type { UploadRetentionPolicy } from "../../shared/enums.ts";
import type { ShortcutAction } from "../../shared/shortcuts.ts";
import type { AsrModelRef, ModelRef } from "./model-ref.ts";

/**
 * One accepted `Idempotency-Key`. Unique per `(userId, route, key)` and never expires. A
 * repeat with the same digest replays the stored response; a different digest is
 * `idempotency_conflict`. `resourceRefsJson` lists every resource the original request
 * created.
 */
export interface IdempotencyRecord {
  userId: string;
  /** Route template, e.g. `POST /api/contents/import`, never the concrete URL. */
  route: string;
  key: string;
  requestDigest: string;
  responseStatus: number;
  responseBodyJson: string;
  resourceRefsJson: string;
  createdAt: number;
}

/**
 * Instance-wide parameters: a single row, instance-level and without an owner. Values
 * fixed by environment variables are read-only.
 */
export interface InstanceSettings {
  /**
   * The only concurrency setting: Tasks processed at once across the instance, also the
   * capacity of the governor that admits managed heavy local work (probing, audio
   * extraction, cache downloads, burning).
   */
  concurrencyPipeline: number;
  maxDataGB: number;
  lowWaterFreeGB: number;
  lowWaterFreeRatio: number;
  uploadRetentionDefault: UploadRetentionPolicy;
  /** Audit time of the last "reset all credentials". */
  credentialsResetAt?: number;
  /**
   * Absolute root of the client's custom video cache; absent = the data
   * directory. Server-side only: never part of the `/instance-settings` DTO.
   */
  cacheRoot?: string;
  /** A cache move in progress, kept across restarts so it can be finished or rolled back. */
  cacheMigration?: CacheMigrationMarker;
  updatedAt: number;
}

/**
 * The persisted state of a cache move. `from` / `to` are resolved absolute
 * roots; the default root is written as the data directory's absolute path, so a later
 * start can clean up without knowing which side was the default. `copying` means the copy
 * never reached the switch and must be rolled back; `cleanup_pending` means the switch
 * committed and only the old files remain to be removed.
 */
export interface CacheMigrationMarker {
  id: string;
  from: string;
  to: string;
  phase: "copying" | "cleanup_pending";
}

/**
 * One user's preferences. The row is created lazily from the named defaults;
 * `shortcuts` holds only overrides of the default key bindings. References to a
 * template or Profile are cleared in the transaction that deletes their target.
 */
/** Browsers whose login yt-dlp `--cookies-from-browser` may read. */
export type CookieBrowser = "firefox" | "chrome" | "edge";

export interface UserSettings {
  userId: string;
  theme: Theme;
  /** BCP-47. */
  language: string;
  defaultSummaryTemplateId?: string;
  shortcuts: Partial<Record<ShortcutAction, string>>;
  chatModelRef?: ModelRef;
  defaultModelRef?: ModelRef;
  /** The ASR model the new-content, re-transcribe and waiting-configuration pickers start with; never set implicitly. */
  defaultAsrModelRef?: AsrModelRef;
  defaultOutputLanguage?: string;
  platformCookieBrowser?: CookieBrowser;
  updatedAt: number;
}

/**
 * A server-mode login session. The cookie carries a high-entropy
 * opaque id; only its hash is stored. Sliding expiry; revocation is immediate.
 */
export interface Session {
  sessionIdHash: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt?: number;
}

/**
 * An administrator's exception to the outbound network policy: one exact origin
 * `scheme://host[:port]`. Instance-level; the actor is audit only.
 */
export interface NetworkAllowlistEntry {
  origin: string;
  createdByUserId?: string;
  createdAt: number;
}

/**
 * One file a purge or a user deletion left to remove. Instance-level work, not
 * owned by any user: `userId` only records where the intent came from. `rootPath` is the
 * absolute root `storageRef` was relative to when registered; the file is only ever removed
 * through that root. `expectedSizeBytes`, when known, guards against removing a file that
 * has since replaced the original under the same name.
 */
export interface PendingFileDelete {
  id: string;
  store: "data" | "cache";
  rootPath: string;
  storageRef: string;
  expectedSizeBytes?: number;
  /** `sha256:<hex>` of the file meant, from its asset's fingerprint; absent for entries registered before digests were recorded. */
  expectedDigest?: string;
  userId?: string;
  attempts: number;
  nextAttemptAt: number;
  /** Error code of the last failed attempt; never a path. */
  lastError?: string;
  createdAt: number;
}
