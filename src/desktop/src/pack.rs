//! Content pack file dialogs. The shell only opens the dialogs and signs the paths they
//! return: the pack file to write, the pack file to read, and the not yet existing
//! subdirectory an import puts carried original files in, which it also admits for playback.
//! Writing, reading and checking the pack, and creating that subdirectory, are the sidecar's
//! work; it checks each grant before it touches the path.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::backup::{allow_originals_for_playback, is_local_stamp, originals_dir, target_with_extension};
use crate::file_grant::{self, PURPOSE_PACK_INPUT, PURPOSE_PACK_ORIGINALS_DIR, PURPOSE_PACK_OUTPUT};
use crate::files::{PickedFile, blocking, file_dialog, now_ms, path_string, sanitize_file_name, with_filter};
use crate::identity::{CONTENT_PACK_FILE_EXTENSION, IMPORTED_ORIGINALS_DIR_PREFIX};
use crate::sidecar::Supervisor;

/// Save dialog for a content pack; the sidecar writes the file the grant names.
#[tauri::command]
pub async fn pick_pack_destination(app: AppHandle, suggested_name: String) -> Result<Option<PickedFile>, String> {
    blocking(move || {
        let dialog = with_filter(file_dialog(&app), &[CONTENT_PACK_FILE_EXTENSION]).set_file_name(sanitize_file_name(&suggested_name, CONTENT_PACK_FILE_EXTENSION));
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = target_with_extension(chosen.into_path().map_err(|error| format!("unusable location: {error}"))?, CONTENT_PACK_FILE_EXTENSION)?;
        let supervisor = app.state::<Supervisor>();
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_PACK_OUTPUT, &path, now_ms());
        Ok(Some(PickedFile { path, grant }))
    })
    .await
}

/// A regular file, canonicalized; the grant names the file the sidecar will really open.
fn pack_source_path(path: &Path) -> Result<String, String> {
    let canonical = path.canonicalize().map_err(|error| format!("the content pack is not accessible: {error}"))?;
    if !canonical.metadata().map_err(|error| format!("the content pack is not accessible: {error}"))?.is_file() {
        return Err("the content pack is not a regular file".to_owned());
    }
    path_string(canonical)
}

/// Open dialog for a content pack to import; the sidecar reads the file the grant names and
/// checks everything in it.
#[tauri::command]
pub async fn pick_pack_source(app: AppHandle) -> Result<Option<PickedFile>, String> {
    blocking(move || {
        let Some(picked) = with_filter(file_dialog(&app), &[CONTENT_PACK_FILE_EXTENSION]).blocking_pick_file() else {
            return Ok(None);
        };
        let path = pack_source_path(&picked.into_path().map_err(|error| format!("unusable selection: {error}"))?)?;
        let supervisor = app.state::<Supervisor>();
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_PACK_INPUT, &path, now_ms());
        Ok(Some(PickedFile { path, grant }))
    })
    .await
}

/// Folder dialog for the originals a content pack import carries: the grant names
/// `<chosen>/Amber-Imported-<local_stamp>`, a subdirectory that must not exist yet and that the
/// import creates. Only that subdirectory, never the chosen folder, is admitted for playback,
/// now, because the import outlives the grant. `local_stamp` is the user's local time as
/// `yyyyMMdd-HHmmss`, formatted by the WebView, which knows the time zone.
#[tauri::command]
pub async fn pick_pack_originals_dir(app: AppHandle, local_stamp: String) -> Result<Option<PickedFile>, String> {
    if !is_local_stamp(&local_stamp) {
        return Err("the time stamp must be yyyyMMdd-HHmmss".to_owned());
    }
    blocking(move || {
        let Some(picked) = file_dialog(&app).blocking_pick_folder() else {
            return Ok(None);
        };
        let picked = picked.into_path().map_err(|error| format!("unusable selection: {error}"))?;
        let picked = path_string(picked.canonicalize().map_err(|error| format!("unusable selection: {error}"))?)?;
        let target = Path::new(&picked).join(format!("{IMPORTED_ORIGINALS_DIR_PREFIX}{local_stamp}"));
        let path = path_string(target)?;
        let supervisor = app.state::<Supervisor>();
        originals_dir(&path, supervisor.data_dir(), IMPORTED_ORIGINALS_DIR_PREFIX)?;
        allow_originals_for_playback(&app, &path)?;
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_PACK_ORIGINALS_DIR, &path, now_ms());
        Ok(Some(PickedFile { path, grant }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("amber-pack-test-{name}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn names_the_destination_with_the_pack_extension() {
        let temp = TempDir::new("destination");
        let chosen = target_with_extension(temp.0.join("讲义"), CONTENT_PACK_FILE_EXTENSION).unwrap();
        assert_eq!(chosen, path_string(temp.0.join("讲义.amberpack")).unwrap());
        let kept = target_with_extension(temp.0.join("a.AmberPack"), CONTENT_PACK_FILE_EXTENSION).unwrap();
        assert_eq!(kept, path_string(temp.0.join("a.AmberPack")).unwrap());
        // The dialog confirmed replacing `b`, not the `b.amberpack` the extension leads to.
        fs::write(temp.0.join("b.amberpack"), b"x").unwrap();
        assert!(target_with_extension(temp.0.join("b"), CONTENT_PACK_FILE_EXTENSION).is_err());
    }

    #[test]
    fn signs_only_regular_pack_files() {
        let temp = TempDir::new("source");
        let file = temp.0.join("a.amberpack");
        fs::write(&file, b"x").unwrap();
        assert_eq!(pack_source_path(&file).unwrap(), path_string(file.canonicalize().unwrap()).unwrap());
        assert!(pack_source_path(&temp.0).is_err());
        assert!(pack_source_path(&temp.0.join("missing.amberpack")).is_err());
    }

    #[test]
    fn refuses_originals_directories_it_would_not_sign() {
        let temp = TempDir::new("originals");
        let data = temp.0.join("data");
        let picked = temp.0.join("picked");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&picked).unwrap();
        let ok = path_string(picked.join(format!("{IMPORTED_ORIGINALS_DIR_PREFIX}20261118-090000"))).unwrap();
        if crate::files::is_local_volume(&ok) {
            assert!(originals_dir(&ok, &data, IMPORTED_ORIGINALS_DIR_PREFIX).is_ok());
            // A restore's name does not pass as an import's, nor the chosen folder itself.
            let restored = path_string(picked.join("Amber-Restored-20261118-090000")).unwrap();
            assert!(originals_dir(&restored, &data, IMPORTED_ORIGINALS_DIR_PREFIX).is_err());
            assert!(originals_dir(&path_string(picked.clone()).unwrap(), &data, IMPORTED_ORIGINALS_DIR_PREFIX).is_err());
            let inside = path_string(data.join(format!("{IMPORTED_ORIGINALS_DIR_PREFIX}x"))).unwrap();
            assert!(originals_dir(&inside, &data, IMPORTED_ORIGINALS_DIR_PREFIX).is_err());
            fs::create_dir(picked.join(format!("{IMPORTED_ORIGINALS_DIR_PREFIX}exists"))).unwrap();
            let existing = path_string(picked.join(format!("{IMPORTED_ORIGINALS_DIR_PREFIX}exists"))).unwrap();
            assert!(originals_dir(&existing, &data, IMPORTED_ORIGINALS_DIR_PREFIX).is_err());
        }
    }
}
