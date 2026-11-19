import type { RestoreApplyReport, RestoreInspectReport } from "../../shared/dto/backup.ts";
import type { FileGrant } from "../../shared/dto/local-media.ts";

/**
 * The desktop shell's commands and events, the only place the web app talks to
 * Tauri besides locating the sidecar. Every function is safe to import in a browser: the
 * Tauri modules load lazily and `isDesktop()` is false there.
 */

/** A file the user picked in the shell's dialog, with the shell's signed grant for it. */
export interface PickedFile {
  path: string;
  grant: FileGrant;
}

/** Fired after the shell restarted a crashed sidecar and its new endpoint is ready. */
export const EVENT_SIDECAR_RESTARTED = "amber://sidecar-restarted";
/** Fired once the shell gave up restarting the sidecar; the payload is a diagnostic message. */
export const EVENT_SIDECAR_FAILED = "sidecar://failed";
export const EVENT_SIDECAR_READY = "sidecar://ready";
/** Progress of a running restore, a `RestoreProgress` per line of the restore command. */
export const EVENT_RESTORE_PROGRESS = "amber://restore-progress";

export async function isDesktop(): Promise<boolean> {
  const { isTauri } = await import("@tauri-apps/api/core");
  return isTauri();
}

/** Marks the document as the desktop window's, for styles that differ from a browser tab. */
export async function markDesktopShell(root: HTMLElement = document.documentElement): Promise<void> {
  if (await isDesktop()) root.dataset.shell = "desktop";
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(command, args);
}

/** System open dialog for one media or subtitle file; `null` when the user cancels. A picked media file joins the asset scope. */
export function pickLocalFile(kind: "media" | "subtitle"): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_local_file", { kind });
}

/** Open dialog for the file that replaces a missing local original; `null` when cancelled. */
export function pickRelinkFile(): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_relink_file");
}

/**
 * Save dialog for a burn product; the shell checks the sidecar's `burn_output` grant and
 * copies the file. `null` when the user cancels.
 */
export function saveBurnOutput(grant: FileGrant, suggestedName: string): Promise<{ savedPath: string } | null> {
  return invoke<{ savedPath: string } | null>("save_burn_output", { grant, suggestedName });
}

/**
 * Save dialog for a platform cache: the shell checks the sidecar's
 * `cache_save` grant and copies the file; the cache itself stays where it is. `null` when
 * the user cancels.
 */
export function saveCachedMedia(grant: FileGrant, suggestedName: string): Promise<{ savedPath: string } | null> {
  return invoke<{ savedPath: string } | null>("save_cached_media", { grant, suggestedName });
}

/**
 * Folder dialog for a new cache location: the shell signs the `media` directory it will
 * use inside the chosen folder (`purpose = cache_dir`). `null` when the user
 * cancels.
 */
export function pickCacheDir(): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_cache_dir");
}

/**
 * Creates the signed `media` directory and admits it to the asset scope. Called only after
 * the user chose the folder, so a cancelled dialog leaves no directory behind.
 */
export function allowCacheDir(grant: FileGrant): Promise<void> {
  return invoke<void>("allow_cache_dir", { grant });
}

/** Shows a directory in the system file manager. */
export function openFolder(path: string): Promise<void> {
  return invoke<void>("open_folder", { path });
}

/**
 * Opens the isolated bilibili login window and resolves with the Netscape cookies once the
 * user has logged in, or `null` when the window was closed first. The text is handed
 * straight to `PUT /api/platform-accounts/bilibili/cookies` and kept nowhere else.
 */
export function openBilibiliLogin(): Promise<{ cookies: string } | null> {
  return invoke<{ cookies: string } | null>("open_bilibili_login");
}

/**
 * Removes the bilibili cookies the shell gave the main WebView for the player iframe,
 * once the bilibili account is removed, all credentials are reset or a
 * fresh login could not be stored. Callers ignore a failure; the shell logs it.
 */
export function clearBilibiliPlayerSession(): Promise<void> {
  return invoke<void>("clear_bilibili_player_session");
}

/** After a successful credential reset: a new master key in Credential Manager and a sidecar restart. */
export function rotateMasterKey(): Promise<void> {
  return invoke<void>("rotate_master_key");
}

/**
 * Save dialog for a backup (`.amberbackup`): the shell signs the chosen file for
 * `backup_output` and the sidecar writes it. `null` when the user cancels.
 */
export function pickBackupDestination(suggestedName: string): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_backup_destination", { suggestedName });
}

/**
 * Open dialog for a backup to restore: the shell signs it for `restore_archive` and reads its
 * header with the restore command, unverified until the restore itself.
 * `null` when the user cancels.
 */
export function inspectBackup(): Promise<{ archive: PickedFile; report: RestoreInspectReport } | null> {
  return invoke<{ archive: PickedFile; report: RestoreInspectReport } | null>("inspect_backup");
}

/**
 * Folder dialog for the restored originals: the shell signs `<chosen>/Amber-Restored-<localStamp>`,
 * a subdirectory that must not exist yet and that the restore creates (`restore_originals_dir`).
 * `localStamp` is the user's local time as `yyyyMMdd-HHmmss` (`localTimeStamp`); the shell
 * refuses anything else. `null` when the user cancels.
 */
export function pickRestoreOriginalsDir(localStamp: string): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_restore_originals_dir", { localStamp });
}

/** `yyyyMMdd-HHmmss` in local time, the stamp a restore's originals directory is named with. */
export function localTimeStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Stops the sidecar, runs the offline restore and restarts the sidecar; progress arrives as
 * `EVENT_RESTORE_PROGRESS`, the restart as `EVENT_SIDECAR_RESTARTED`. Rejects with a message
 * when the shell refuses to start (an update install is under way, a grant does not verify).
 */
export function restoreBackup(archiveGrant: FileGrant, originalsGrant: FileGrant | null): Promise<RestoreApplyReport> {
  return invoke<RestoreApplyReport>("restore_backup", { archiveGrant, originalsGrant });
}

/** Registers the update install with the shell, which then refuses a restore; rejects while a restore runs. */
export function beginUpdateInstall(): Promise<void> {
  return invoke<void>("begin_update_install");
}

/** Clears the registration after a failed or abandoned install. */
export function endUpdateInstall(): Promise<void> {
  return invoke<void>("end_update_install");
}

/**
 * Save dialog for a content pack (`.amberpack`): the shell signs the chosen file for
 * `pack_output` and the sidecar writes the pack there. `null` when the user cancels.
 */
export function pickPackDestination(suggestedName: string): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_pack_destination", { suggestedName });
}

/**
 * Open dialog for a content pack to import: the shell signs the chosen file for `pack_input`
 * and the sidecar reads and checks it. `null` when the user cancels.
 */
export function pickPackSource(): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_pack_source");
}

/**
 * Folder dialog for the originals a content pack import carries: the shell signs
 * `<chosen>/Amber-Imported-<localStamp>` for `pack_originals_dir`, a subdirectory that must not
 * exist yet and that the import creates, and admits it for playback. `localStamp` is the
 * user's local time as `yyyyMMdd-HHmmss` (`localTimeStamp`); the shell refuses anything else.
 * `null` when the user cancels.
 */
export function pickPackOriginalsDir(localStamp: string): Promise<PickedFile | null> {
  return invoke<PickedFile | null>("pick_pack_originals_dir", { localStamp });
}

/** The asset-protocol URL of a local file for `<video src>`. */
export async function localFileUrl(path: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

/** Subscribes to a shell event; resolves with the unsubscribe function. */
export async function onShellEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (message) => handler(message.payload));
}
