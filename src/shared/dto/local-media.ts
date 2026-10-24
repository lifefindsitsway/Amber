import { z } from "zod";
import { appErrorSchema } from "../errors.ts";
import { importSettingsSchema, languageTagSchema } from "./import.ts";

/** Paths handed over by the desktop shell; long Windows paths stay well below this. */
const localPathSchema = z.string().min(1).max(4096);

/**
 * `local_file` / `relink`: the shell signs a file the user picked and the sidecar checks it.
 * `burn_output`: the sidecar signs a burn product and the shell checks it before copying
 * the file out of the data directory. `cache_save`: the same for an
 * available cache file, copied out of the cache directory. `cache_dir`: the
 * shell signs the `media` cache directory it will create; both the shell (before creating
 * and allowing it) and the sidecar (before moving the cache) check it.
 * `backup_output`: the shell signs the backup file the user chose in its save dialog; the
 * sidecar checks it before writing. `restore_archive` / `restore_originals_dir`:
 * the shell signs the archive and the originals subdirectory it picked, and checks both itself
 * before running the offline restore command.
 */
export const FILE_GRANT_PURPOSES = [
  "local_file",
  "relink",
  "burn_output",
  "cache_save",
  "cache_dir",
  "backup_output",
  "restore_archive",
  "restore_originals_dir",
] as const;
export type FileGrantPurpose = (typeof FILE_GRANT_PURPOSES)[number];

/**
 * Proof that the user picked this exact file in the shell's file dialog:
 * `sig` = HMAC-SHA256 over `purpose | path | expiresAt` under a key the WebView never
 * sees, base64url without padding.
 */
export const fileGrantSchema = z
  .object({
    path: localPathSchema,
    purpose: z.enum(FILE_GRANT_PURPOSES),
    expiresAt: z.number().int().positive(),
    sig: z.string().min(1).max(128),
  })
  .strict();
export type FileGrant = z.infer<typeof fileGrantSchema>;

/** `POST /api/contents/local-file` (local mode): the file is referenced in place, never copied. */
export const localFileRequestSchema = z
  .object({
    path: localPathSchema,
    grant: fileGrantSchema,
    settings: importSettingsSchema.default({ autoProofread: true }),
    allowDuplicate: z.boolean().default(false),
    initialSubtitle: z.object({ path: localPathSchema, grant: fileGrantSchema, language: languageTagSchema }).strict().exactOptional(),
  })
  .strict();
export type LocalFileRequest = z.infer<typeof localFileRequestSchema>;

/** `PUT /api/media/:assetId/relink` [client]: the file the user picked to replace a missing `external_local` original. */
export const relinkRequestSchema = z.object({ path: localPathSchema, grant: fileGrantSchema }).strict();
export type RelinkRequest = z.infer<typeof relinkRequestSchema>;

/** `POST /api/media/:assetId/save-grant` [client]: the sidecar's `burn_output` grant for one burn product. */
export const saveGrantDtoSchema = z.object({ grant: fileGrantSchema });
export type SaveGrantDto = z.infer<typeof saveGrantDtoSchema>;

const byteCountSchema = z.number().int().nonnegative();

/**
 * Progress of a cache move: `copying` holds the exclusive cache lease,
 * `cleanup_pending` is the best-effort removal of the old files after the switch, and
 * `failed` is kept in memory until the next attempt so the storage page can show why.
 */
export const cacheMigrationDtoSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("copying"), copiedBytes: byteCountSchema, totalBytes: byteCountSchema, fileCount: byteCountSchema }).strict(),
  z.object({ phase: z.literal("cleanup_pending") }).strict(),
  z.object({ phase: z.literal("failed"), error: appErrorSchema }).strict(),
]);
export type CacheMigrationDto = z.infer<typeof cacheMigrationDtoSchema>;

/** An interrupted cache replacement waiting for the user: keep the file now at the path, or restore the displaced copy. */
export const cacheHoldDtoSchema = z
  .object({
    assetId: z.string().min(1),
    contentId: z.string().min(1).exactOptional(),
    title: z.string().exactOptional(),
    fileName: z.string(),
    currentSizeBytes: byteCountSchema.exactOptional(),
    displacedSizeBytes: byteCountSchema.exactOptional(),
  })
  .strict();
export type CacheHoldDto = z.infer<typeof cacheHoldDtoSchema>;

/**
 * `GET /api/media/cache-location` [client]. `path` is the directory
 * shown to the user and opened by the shell, the cache directory itself: `<data dir>/media`
 * by default, otherwise the `media` directory the user chose. `usedBytes` / `fileCount` count the `available`
 * `platform_cache` rows, not the bytes on disk; `freeBytes` / `totalBytes` describe the
 * volume the directory is on. There is no size cap. `holds` lists interrupted replacements
 * the start-up recovery could not settle by itself and that wait for the user.
 */
export const cacheLocationDtoSchema = z
  .object({
    path: localPathSchema,
    isDefault: z.boolean(),
    available: z.boolean(),
    fileCount: byteCountSchema,
    usedBytes: byteCountSchema,
    freeBytes: byteCountSchema,
    totalBytes: byteCountSchema,
    holds: z.array(cacheHoldDtoSchema),
    migration: cacheMigrationDtoSchema.exactOptional(),
  })
  .strict();
export type CacheLocationDto = z.infer<typeof cacheLocationDtoSchema>;

/** `PUT /api/media/cache-location` [client]: a shell-signed `cache_dir` directory, or back to the data directory. */
export const cacheLocationPutSchema = z.union([
  z.object({ path: localPathSchema, grant: fileGrantSchema }).strict(),
  z.object({ useDefault: z.literal(true) }).strict(),
]);
export type CacheLocationPut = z.infer<typeof cacheLocationPutSchema>;
