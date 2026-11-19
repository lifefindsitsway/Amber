/**
 * Names of the client backup that the desktop shell needs too, kept free of
 * imports so the tooling can generate them into the shell's Rust source.
 */

/** File extension of a backup, without the dot. */
export const BACKUP_FILE_EXTENSION = "amberbackup";

/** Prefix of the subdirectory a restore creates for the originals: `Amber-Restored-<yyyyMMdd-HHmmss>`. */
export const RESTORED_ORIGINALS_DIR_PREFIX = "Amber-Restored-";

/** Line prefix of the restore command's progress output on stdout; JSON follows it. */
export const RESTORE_PROGRESS_PREFIX = "PROGRESS ";

/** File extension of a content pack, without the dot. */
export const CONTENT_PACK_FILE_EXTENSION = "amberpack";

/**
 * Prefix of the subdirectory a content pack import puts the carried original files in:
 * `Amber-Imported-<yyyyMMdd-HHmmss>`. The shell names it when the user picks the parent
 * directory, so it can admit exactly that directory for playback.
 */
export const IMPORTED_ORIGINALS_DIR_PREFIX = "Amber-Imported-";
