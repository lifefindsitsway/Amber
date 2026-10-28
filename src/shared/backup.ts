import { z } from "zod";
import { isValidCacheFileName } from "./cache-file-name.ts";
import { BACKUP_UI_PREFERENCE_MAX_BYTES, BACKUP_UI_PREFERENCES_MAX_BYTES } from "./defaults.ts";
import { NOTE_COLORS, PLAYER_END_BEHAVIORS } from "./enums.ts";
import { trackPrefSchema } from "./subtitle-prefs.ts";
import { subtitleAppearanceSchema, subtitlePlacementSchema } from "./subtitle-style.ts";

/**
 * The client backup format `amber-backup-v1`: an uncompressed tar whose first
 * entry is `header.json`, then `database.sqlite`, the originals, the cache files, and last
 * `manifest.json`. The header fixes what the archive contains before any file is copied;
 * the manifest only adds the hashes of what was actually written.
 */

export { BACKUP_FILE_EXTENSION, RESTORED_ORIGINALS_DIR_PREFIX } from "./backup-names.ts";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_HEADER_ENTRY = "header.json";
export const BACKUP_DATABASE_ENTRY = "database.sqlite";
export const BACKUP_MANIFEST_ENTRY = "manifest.json";
/** Archive directory of `external_local` originals: `originals/<assetId>[.<ext>]`. */
export const BACKUP_ORIGINALS_DIR = "originals";
/** Archive directory of `platform_cache` files: `media/<cache file name>`, the name they keep on restore. */
export const BACKUP_CACHE_DIR = "media";

/** Asset ids become archive path components, so only a conservative alphabet is accepted. */
const ASSET_ID = /^[0-9A-Za-z_-]{1,64}$/u;
/** The extension an original keeps in the archive, taken from its file name when it is plain. */
const ORIGINAL_EXTENSION = /^[a-z0-9]{1,16}$/u;
const ORIGINAL_PATH = /^originals\/([0-9A-Za-z_-]{1,64})(?:\.[a-z0-9]{1,16})?$/u;

/** The archive path of an original: chosen by asset id only, so the user's file name never shapes a path. */
export function originalArchivePath(assetId: string, fileName: string): string {
  if (!ASSET_ID.test(assetId)) {
    throw new Error("asset id is not a safe archive path component");
  }
  const dot = fileName.lastIndexOf(".");
  const extension = dot <= 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  return ORIGINAL_EXTENSION.test(extension) ? `${BACKUP_ORIGINALS_DIR}/${assetId}.${extension}` : `${BACKUP_ORIGINALS_DIR}/${assetId}`;
}

/** The archive path of a cache file. */
export function cacheArchivePath(cacheFileName: string): string {
  if (!isValidCacheFileName(cacheFileName)) {
    throw new Error("not a valid cache file name");
  }
  return `${BACKUP_CACHE_DIR}/${cacheFileName}`;
}

/** Whether `path` is an archive path an original may have. */
export function isOriginalArchivePath(path: string): boolean {
  return ORIGINAL_PATH.test(path);
}

/** Whether `path` is an archive path a cache file may have. */
export function isCacheArchivePath(path: string): boolean {
  return path.startsWith(`${BACKUP_CACHE_DIR}/`) && isValidCacheFileName(path.slice(BACKUP_CACHE_DIR.length + 1));
}

const countSchema = z.number().int().nonnegative();
const assetIdSchema = z.string().regex(ASSET_ID);
/** `MediaAsset.fingerprint` as stored: `sha256:<hex>`. */
export const mediaFingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const backupHeaderSchema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    mode: z.literal("local"),
    amberVersion: z.string().min(1).max(64),
    schemaVersion: z.number().int().positive(),
    createdAt: z.number().int().positive(),
    encryption: z.literal("none"),
    includes: z.object({ originals: z.boolean(), cache: z.boolean() }).strict(),
    /** Originals the user excluded explicitly (unreadable at estimate time); they restore as `missing`. */
    excludedOriginals: z.array(assetIdSchema),
    counts: z
      .object({ contents: countSchema, collections: countSchema, notes: countSchema, originals: countSchema, cache: countSchema })
      .strict(),
    sizes: z.object({ database: countSchema, originals: countSchema, cache: countSchema }).strict(),
    originals: z.array(
      z
        .object({
          assetId: assetIdSchema,
          archivePath: z.string().refine(isOriginalArchivePath),
          /** The file name the original had; a restore derives its new name from it. */
          originalName: z.string().min(1).max(1024),
          sizeBytes: countSchema,
          fingerprint: mediaFingerprintSchema.nullable(),
        })
        .strict(),
    ),
    cache: z.array(z.object({ assetId: assetIdSchema, archivePath: z.string().refine(isCacheArchivePath) }).strict()),
    /** Whitelisted local UI preferences, raw local-storage strings by key. */
    uiPreferences: z.record(z.string(), z.string()),
  })
  .strict();
export type BackupHeader = z.infer<typeof backupHeaderSchema>;

export const backupManifestSchema = z
  .object({
    headerSha256: sha256HexSchema,
    files: z.array(z.object({ path: z.string().min(1), sizeBytes: countSchema, sha256: sha256HexSchema }).strict()),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;

// UI preferences a backup may carry: subtitle appearance / placement / track,
// player and note colours. Each key pattern names the parser its value must pass.

const USER_ID = "[0-9A-Za-z_-]{1,64}";
const CONTENT_ID = "[0-9A-HJKMNP-TV-Z]{26}";

function jsonOf(schema: z.ZodType): (value: string) => boolean {
  return (value) => {
    try {
      return schema.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  };
}

const oneOf =
  (values: readonly string[]) =>
  (value: string): boolean =>
    values.includes(value);

const PREFERENCE_RULES: ReadonlyArray<{ key: RegExp; valid: (value: string) => boolean }> = [
  { key: new RegExp(`^amber\\.subtitle\\.appearance\\.${USER_ID}$`, "u"), valid: jsonOf(subtitleAppearanceSchema) },
  { key: new RegExp(`^amber\\.subtitle\\.placement\\.${USER_ID}(?:\\.${CONTENT_ID})?$`, "u"), valid: jsonOf(subtitlePlacementSchema) },
  { key: new RegExp(`^amber\\.subtitle\\.track\\.${USER_ID}\\.${CONTENT_ID}$`, "u"), valid: jsonOf(trackPrefSchema) },
  { key: /^amber\.player\.volume$/u, valid: (value) => /^\d+(?:\.\d+)?$/u.test(value) && Number(value) <= 1 },
  { key: /^amber\.player\.(?:muted|autoplay)$/u, valid: oneOf(["0", "1"]) },
  { key: /^amber\.player\.endBehavior$/u, valid: oneOf(PLAYER_END_BEHAVIORS) },
  { key: /^amber\.notes\.color\.(?:underline|background)$/u, valid: oneOf(NOTE_COLORS) },
];

/** Whether a local-storage key is one a backup may carry. */
export function isBackupPreferenceKey(key: string): boolean {
  return PREFERENCE_RULES.some((rule) => rule.key.test(key));
}

export const PREFERENCE_DROP_REASONS = ["not_allowed", "invalid_value", "too_large", "total_too_large"] as const;
export type PreferenceDropReason = (typeof PREFERENCE_DROP_REASONS)[number];

export const droppedPreferenceSchema = z.object({ key: z.string(), reason: z.enum(PREFERENCE_DROP_REASONS) }).strict();
export type DroppedPreference = z.infer<typeof droppedPreferenceSchema>;

/**
 * Splits UI preferences into the ones a backup keeps and the ones it drops, with the reason
 * for each drop; nothing is dropped silently. Keys are taken in sorted order so the total
 * cap drops the same keys on every run. Sizes are UTF-8 bytes of key plus value.
 */
export function filterUiPreferences(input: Readonly<Record<string, string>>): {
  accepted: Record<string, string>;
  dropped: DroppedPreference[];
} {
  const encoder = new TextEncoder();
  const accepted: Record<string, string> = {};
  const dropped: DroppedPreference[] = [];
  let total = 0;
  for (const key of Object.keys(input).sort()) {
    const value = input[key] as string;
    const rule = PREFERENCE_RULES.find((candidate) => candidate.key.test(key));
    if (rule === undefined) {
      dropped.push({ key, reason: "not_allowed" });
      continue;
    }
    const size = encoder.encode(value).length;
    if (size > BACKUP_UI_PREFERENCE_MAX_BYTES) {
      dropped.push({ key, reason: "too_large" });
      continue;
    }
    if (!rule.valid(value)) {
      dropped.push({ key, reason: "invalid_value" });
      continue;
    }
    const entrySize = encoder.encode(key).length + size;
    if (total + entrySize > BACKUP_UI_PREFERENCES_MAX_BYTES) {
      dropped.push({ key, reason: "total_too_large" });
      continue;
    }
    total += entrySize;
    accepted[key] = value;
  }
  return { accepted, dropped };
}

/**
 * What a fresh-install check found: each category names a table with rows,
 * or `cache_root` for a relocated cache directory. A restore target must have none.
 */
export const LIBRARY_CATEGORIES = [
  "content",
  "collection",
  "import_batch",
  "task",
  "media_asset",
  "transcript_revision",
  "transcript_draft",
  "note",
  "chat_thread",
  "provider_profile",
  "asr_provider_profile",
  "other_model_profile",
  "platform_account",
  "secret",
  "terminology_set",
  "summary_template",
  "prompt_override_version",
  "token_usage",
  "asr_usage",
  "network_allowlist",
  "pending_file_delete",
  "cache_root",
] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

/** Settings a restore replaces wholesale, listed in its confirmation. */
export const REPLACEABLE_SETTINGS = ["appearance", "language", "shortcuts", "model_refs", "task_concurrency", "disk"] as const;
export type ReplaceableSetting = (typeof REPLACEABLE_SETTINGS)[number];
