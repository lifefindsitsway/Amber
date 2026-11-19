//! Backup and restore commands. The shell only opens the dialogs, signs
//! and re-checks the paths they return, runs the offline restore command with the sidecar
//! held, and keeps a restore and an update install from overlapping; reading, verifying and
//! writing the library is the restore command's work.

use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::encoding::base64url;
use crate::file_grant::{self, FileGrant, PURPOSE_BACKUP_OUTPUT, PURPOSE_RESTORE_ARCHIVE, PURPOSE_RESTORE_ORIGINALS_DIR};
use crate::files::{PickedFile, blocking, file_dialog, is_local_volume, now_ms, path_string, sanitize_file_name, with_filter};
use crate::identity::{BACKUP_FILE_EXTENSION, RESTORE_PROGRESS_PREFIX, RESTORED_ORIGINALS_DIR_PREFIX};
use crate::sidecar::{Supervisor, fill_random};

/// Progress of a running restore, one `RestoreProgress` per event.
pub const EVENT_RESTORE_PROGRESS: &str = "amber://restore-progress";

/// Long native operations that must not overlap: an offline restore stops the backend, an
/// update install replaces the application.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NativeOp {
    Restore,
    UpdateInstall,
}

/// The one native operation under way, if any.
#[derive(Default)]
pub struct NativeOps(Mutex<Option<NativeOp>>);

impl NativeOps {
    /// Registers `op`; an update install may be registered again by a retried install.
    pub fn begin(&self, op: NativeOp) -> Result<(), String> {
        let mut current = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match *current {
            None => {
                *current = Some(op);
                Ok(())
            }
            Some(NativeOp::UpdateInstall) if op == NativeOp::UpdateInstall => Ok(()),
            Some(NativeOp::Restore) => Err("a restore is under way".to_owned()),
            Some(NativeOp::UpdateInstall) => Err("an update is being installed".to_owned()),
        }
    }

    /// Clears `op` if it is the registered one.
    pub fn end(&self, op: NativeOp) {
        let mut current = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if *current == Some(op) {
            *current = None;
        }
    }

    #[cfg(test)]
    fn current(&self) -> Option<NativeOp> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Clears the restore registration however the command ends.
struct RestoreRegistration<'a>(&'a NativeOps);

impl Drop for RestoreRegistration<'_> {
    fn drop(&mut self) {
        self.0.end(NativeOp::Restore);
    }
}

#[derive(Serialize)]
pub struct InspectedBackup {
    archive: PickedFile,
    report: Value,
}

/// Whether `stamp` is `yyyyMMdd-HHmmss`: the user's local time, formatted by the WebView,
/// which knows the time zone. Only digits pass, so the stamp cannot shape the path otherwise.
pub(crate) fn is_local_stamp(stamp: &str) -> bool {
    let bytes = stamp.as_bytes();
    bytes.len() == 15
        && bytes.iter().enumerate().all(|(index, byte)| if index == 8 { *byte == b'-' } else { byte.is_ascii_digit() })
}

/// Whether `path` is `root` or lies inside it, compared without case on Windows.
fn is_inside(root: &Path, path: &Path) -> bool {
    if cfg!(windows) {
        let root = root.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        path == root || path.starts_with(&format!("{}\\", root.trim_end_matches('\\')))
    } else {
        path.starts_with(root)
    }
}

fn not_found(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("the location already exists".to_owned()),
        Err(error) => Err(format!("the location is not accessible: {error}")),
    }
}

/// The file a save dialog's choice names: the chosen name with `extension` (the backup or the
/// content pack extension). The dialog confirmed replacing the name the user chose; an
/// appended name that already exists is refused. The directory is canonicalized so the grant
/// names where the file will really be.
pub(crate) fn target_with_extension(chosen: PathBuf, extension: &str) -> Result<String, String> {
    let has_extension = chosen.extension().and_then(|chosen_extension| chosen_extension.to_str()).is_some_and(|chosen_extension| chosen_extension.eq_ignore_ascii_case(extension));
    let name = chosen.file_name().ok_or("the chosen location has no file name")?.to_os_string();
    let parent = chosen.parent().ok_or("the chosen location has no directory")?;
    let parent = parent.canonicalize().map_err(|error| format!("the chosen directory is not accessible: {error}"))?;
    let target = if has_extension {
        parent.join(name)
    } else {
        let mut name = name;
        name.push(".");
        name.push(extension);
        let target = parent.join(name);
        not_found(&target)?;
        target
    };
    path_string(target)
}

/// Save dialog for a backup; the sidecar writes the file the grant names.
#[tauri::command]
pub async fn pick_backup_destination(app: AppHandle, suggested_name: String) -> Result<Option<PickedFile>, String> {
    blocking(move || {
        let dialog = with_filter(file_dialog(&app), &[BACKUP_FILE_EXTENSION]).set_file_name(sanitize_file_name(&suggested_name, BACKUP_FILE_EXTENSION));
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = target_with_extension(chosen.into_path().map_err(|error| format!("unusable location: {error}"))?, BACKUP_FILE_EXTENSION)?;
        let supervisor = app.state::<Supervisor>();
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_BACKUP_OUTPUT, &path, now_ms());
        Ok(Some(PickedFile { path, grant }))
    })
    .await
}

/// A report file of the restore command, unique per run, in the data directory's `tmp`.
fn report_path(supervisor: &Supervisor) -> Result<PathBuf, String> {
    let dir = supervisor.data_dir().join("tmp");
    fs::create_dir_all(&dir).map_err(|error| format!("could not prepare the report directory: {error}"))?;
    let mut suffix = [0u8; 9];
    fill_random(&mut suffix)?;
    Ok(dir.join(format!("restore-report-{}.json", base64url(&suffix))))
}

/// Runs one restore subcommand and returns its report as the command wrote it.
fn run_with_report(supervisor: &Supervisor, mut args: Vec<OsString>, on_line: impl FnMut(&str)) -> Result<Value, String> {
    let report = report_path(supervisor)?;
    args.push("--report".into());
    args.push(report.clone().into_os_string());
    supervisor.run_restore_command(&args, on_line)?;
    let text = fs::read_to_string(&report).map_err(|error| format!("the restore command left no report: {error}"));
    let _ = fs::remove_file(&report);
    serde_json::from_str(&text?).map_err(|error| format!("the restore command's report is unreadable: {error}"))
}

/// A regular file, canonicalized; the grant and the restore command get the same string.
fn archive_path(path: &Path) -> Result<String, String> {
    let canonical = path.canonicalize().map_err(|error| format!("the backup is not accessible: {error}"))?;
    if !canonical.metadata().map_err(|error| format!("the backup is not accessible: {error}"))?.is_file() {
        return Err("the backup is not a regular file".to_owned());
    }
    path_string(canonical)
}

/// Open dialog for a backup to restore: signs it and reads its header with the restore
/// command. The header is unverified until the restore itself checks the whole archive.
#[tauri::command]
pub async fn inspect_backup(app: AppHandle) -> Result<Option<InspectedBackup>, String> {
    blocking(move || {
        let Some(picked) = with_filter(file_dialog(&app), &[BACKUP_FILE_EXTENSION]).blocking_pick_file() else {
            return Ok(None);
        };
        let path = archive_path(&picked.into_path().map_err(|error| format!("unusable selection: {error}"))?)?;
        let supervisor = app.state::<Supervisor>();
        let report = run_with_report(&supervisor, vec!["inspect".into(), "--archive".into(), path.clone().into()], |_| {})?;
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_RESTORE_ARCHIVE, &path, now_ms());
        Ok(Some(InspectedBackup { archive: PickedFile { path, grant }, report }))
    })
    .await
}

/// The originals directory a grant may name: a not yet existing child named `<prefix>…`
/// (`Amber-Restored-…` for a restore, `Amber-Imported-…` for a content pack import) of an
/// existing local directory reached without links, outside the data directory. Checked when
/// signing and, for a restore, again when the grant comes back.
pub(crate) fn originals_dir(path: &str, data_dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    if !is_local_volume(path) {
        return Err("the originals directory must be on a local volume".to_owned());
    }
    let target = PathBuf::from(path);
    if !target.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(prefix)) {
        return Err("not an originals directory of this kind".to_owned());
    }
    let parent = target.parent().ok_or("the originals directory has no parent")?;
    let canonical = path_string(parent.canonicalize().map_err(|error| format!("the chosen directory is not accessible: {error}"))?)?;
    if Path::new(&canonical) != parent {
        return Err("the chosen directory is reached through a link".to_owned());
    }
    let data_dir = path_string(data_dir.canonicalize().map_err(|error| format!("data directory is not accessible: {error}"))?)?;
    if is_inside(Path::new(&data_dir), &target) {
        return Err("the originals directory must lie outside the data directory".to_owned());
    }
    not_found(&target)?;
    Ok(target)
}

/// Folder dialog for the restored originals: the grant names a new subdirectory of the chosen
/// folder, `Amber-Restored-<local_stamp>`, that the restore will create.
#[tauri::command]
pub async fn pick_restore_originals_dir(app: AppHandle, local_stamp: String) -> Result<Option<PickedFile>, String> {
    if !is_local_stamp(&local_stamp) {
        return Err("the time stamp must be yyyyMMdd-HHmmss".to_owned());
    }
    blocking(move || {
        let Some(picked) = file_dialog(&app).blocking_pick_folder() else {
            return Ok(None);
        };
        let picked = picked.into_path().map_err(|error| format!("unusable selection: {error}"))?;
        let picked = path_string(picked.canonicalize().map_err(|error| format!("unusable selection: {error}"))?)?;
        let target = Path::new(&picked).join(format!("{RESTORED_ORIGINALS_DIR_PREFIX}{local_stamp}"));
        let path = path_string(target)?;
        let supervisor = app.state::<Supervisor>();
        originals_dir(&path, supervisor.data_dir(), RESTORED_ORIGINALS_DIR_PREFIX)?;
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_RESTORE_ORIGINALS_DIR, &path, now_ms());
        Ok(Some(PickedFile { path, grant }))
    })
    .await
}

/// Lets `<video>` play from an originals directory and everything below it. Persisted by the
/// persisted-scope plugin, so the originals stay playable after a restart.
pub(crate) fn allow_originals_for_playback(app: &AppHandle, dir: &str) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|error| format!("could not allow the originals for playback: {error}"))
}

/// Restores a backup: checks both grants, stops the sidecar, runs the offline restore,
/// admits the restored originals to the asset scope and lets the sidecar start again. The
/// report is returned as the restore command wrote it.
#[tauri::command]
pub async fn restore_backup(app: AppHandle, archive_grant: FileGrant, originals_grant: Option<FileGrant>) -> Result<Value, String> {
    blocking(move || {
        let supervisor = app.state::<Supervisor>();
        let key = supervisor.file_grant_key();
        file_grant::verify(key, &archive_grant, PURPOSE_RESTORE_ARCHIVE, now_ms())?;
        let archive = archive_path(Path::new(&archive_grant.path))?;
        if archive != archive_grant.path {
            return Err("the backup moved since it was chosen".to_owned());
        }
        let originals = match &originals_grant {
            Some(grant) => {
                file_grant::verify(key, grant, PURPOSE_RESTORE_ORIGINALS_DIR, now_ms())?;
                Some(originals_dir(&grant.path, supervisor.data_dir(), RESTORED_ORIGINALS_DIR_PREFIX)?)
            }
            None => None,
        };
        let ops = app.state::<NativeOps>();
        ops.begin(NativeOp::Restore)?;
        let _registration = RestoreRegistration(&ops);
        let hold = supervisor.hold()?;
        let mut args: Vec<OsString> = vec!["apply".into(), "--archive".into(), archive.into(), "--data-dir".into(), supervisor.data_dir().as_os_str().to_owned()];
        if let Some(dir) = &originals {
            args.push("--originals-dir".into());
            args.push(dir.clone().into_os_string());
        }
        let emitter = app.clone();
        let report = run_with_report(&supervisor, args, move |line| {
            if let Some(progress) = line.strip_prefix(RESTORE_PROGRESS_PREFIX).and_then(|json| serde_json::from_str::<Value>(json).ok()) {
                let _ = emitter.emit(EVENT_RESTORE_PROGRESS, progress);
            }
        });
        if let Ok(report) = &report
            && report.get("ok") == Some(&Value::Bool(true))
            && let Some(dir) = report.get("originalsDir").and_then(Value::as_str)
        {
            if let Err(error) = allow_originals_for_playback(&app, dir) {
                drop(hold);
                return Err(error);
            }
        }
        drop(hold);
        report
    })
    .await
}

/// Registers an update install; refused while a restore runs.
#[tauri::command]
pub fn begin_update_install(ops: State<'_, NativeOps>) -> Result<(), String> {
    ops.begin(NativeOp::UpdateInstall)
}

/// Clears the registration after a failed or abandoned install.
#[tauri::command]
pub fn end_update_install(ops: State<'_, NativeOps>) {
    ops.end(NativeOp::UpdateInstall);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_and_update_install_exclude_each_other() {
        let ops = NativeOps::default();
        ops.begin(NativeOp::UpdateInstall).unwrap();
        ops.begin(NativeOp::UpdateInstall).unwrap();
        assert!(ops.begin(NativeOp::Restore).is_err());
        ops.end(NativeOp::Restore);
        assert_eq!(ops.current(), Some(NativeOp::UpdateInstall));
        ops.end(NativeOp::UpdateInstall);
        ops.begin(NativeOp::Restore).unwrap();
        assert!(ops.begin(NativeOp::UpdateInstall).is_err());
        assert!(ops.begin(NativeOp::Restore).is_err());
        {
            let _registration = RestoreRegistration(&ops);
        }
        assert_eq!(ops.current(), None);
    }

    #[test]
    fn accepts_only_plain_local_stamps() {
        assert!(is_local_stamp("20261019-083000"));
        for bad in ["2026101-083000", "20261019083000", "20261019-08300a", "20261019-083000 ", "../../x-083000", "２０２６１０１９-083000", ""] {
            assert!(!is_local_stamp(bad), "{bad}");
        }
    }

    #[test]
    fn compares_containment_by_components() {
        if cfg!(windows) {
            assert!(is_inside(Path::new(r"C:\Data\Amber"), Path::new(r"c:\data\amber\x")));
            assert!(!is_inside(Path::new(r"C:\Data\Amber"), Path::new(r"C:\Data\AmberX\y")));
        } else {
            assert!(is_inside(Path::new("/data/amber"), Path::new("/data/amber/x")));
            assert!(!is_inside(Path::new("/data/amber"), Path::new("/data/amberx/y")));
        }
    }

    #[test]
    fn refuses_originals_directories_it_would_not_sign() {
        let base = std::env::temp_dir().join(format!("amber-backup-test-{}", std::process::id()));
        let data = base.join("data");
        let picked = base.join("picked");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&picked).unwrap();
        let picked = picked.canonicalize().unwrap();
        let data = data.canonicalize().unwrap();
        let ok = path_string(picked.join("Amber-Restored-20261019-000000")).unwrap();
        if is_local_volume(&ok) {
            assert!(originals_dir(&ok, &data, RESTORED_ORIGINALS_DIR_PREFIX).is_ok());
            assert!(originals_dir(&path_string(picked.join("Other")).unwrap(), &data, RESTORED_ORIGINALS_DIR_PREFIX).is_err());
            assert!(originals_dir(&path_string(data.join("Amber-Restored-x")).unwrap(), &data, RESTORED_ORIGINALS_DIR_PREFIX).is_err());
            fs::create_dir(picked.join("Amber-Restored-exists")).unwrap();
            assert!(originals_dir(&path_string(picked.join("Amber-Restored-exists")).unwrap(), &data, RESTORED_ORIGINALS_DIR_PREFIX).is_err());
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
