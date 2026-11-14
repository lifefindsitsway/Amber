//! File dialog commands. The WebView never names a local path the
//! sidecar will trust: paths come from dialogs the shell itself opens and leave signed, the
//! only files the shell copies out are ones the sidecar signed (burn products in the data
//! directory, cached media in a cache directory), and the media cache directory is one the
//! shell itself creates and allows for playback only when the grant it issued for exactly
//! that directory is presented back. Opening a folder in the system file manager is likewise
//! limited to directories Amber manages or already allows.

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::encoding::base64url;
use crate::file_grant::{
    self, FileGrant, PURPOSE_BURN_OUTPUT, PURPOSE_CACHE_DIR, PURPOSE_CACHE_SAVE, PURPOSE_LOCAL_FILE, PURPOSE_RELINK,
};
use crate::identity::{CACHE_DIR_NAME, CACHE_EXTENSIONS, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC};
use crate::marker::has_marker;
use crate::sidecar::{Supervisor, fill_random};

/// Containers and audio formats the sidecar can probe; it sniffs the content anyway.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "flv", "wmv", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp", "mp3", "m4a", "aac",
    "wav", "flac", "ogg", "oga", "opus", "wma",
];
/// Timed subtitle files a new Content can carry, the Amber subtitle package included. Plain
/// text cannot be imported with new media, so it is not offered.
const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "vtt", "ass", "ambersub"];
/// ISO BMFF major brands of the MP4 files an export writes; other ISO BMFF files (M4A,
/// QuickTime, AVIF, HEIC) share the `ftyp` box but are not exports.
const MP4_BRANDS: &[[u8; 4]] = &[*b"isom", *b"iso2", *b"mp41", *b"mp42"];
/// The EBML header's element ID, which every Matroska or WebM file starts with.
const EBML_MAGIC: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];
/// The EBML `DocType` element ID (marker bit kept, as IDs are compared).
const EBML_DOC_TYPE_ID: u64 = 0x4282;
const MATROSKA_DOC_TYPE: &[u8] = b"matroska";
/// How much of a file's head is read to recognize its container; an `ftyp` box or an EBML
/// header is a few dozen bytes.
const CONTAINER_HEAD_BYTES: u64 = 4096;
/// The default file name's stem when nothing usable is left of the suggested one.
const FALLBACK_STEM: &str = "amber";
/// Keeps the suggested name well inside Windows' 255-character component limit.
const MAX_SUGGESTED_NAME_CHARS: usize = 200;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickKind {
    Media,
    Subtitle,
}

#[derive(Serialize)]
pub struct PickedFile {
    pub(crate) path: String,
    pub(crate) grant: FileGrant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    saved_path: String,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// Filter labels are the extensions themselves, so the shell carries no UI copy of its own.
pub(crate) fn with_filter<R: Runtime>(dialog: FileDialogBuilder<R>, extensions: &[&str]) -> FileDialogBuilder<R> {
    let label = extensions.iter().map(|extension| format!("*.{extension}")).collect::<Vec<_>>().join(" ");
    dialog.add_filter(label, extensions)
}

/// Dialogs are modal to the main window when it exists.
pub(crate) fn file_dialog<R: Runtime>(app: &AppHandle<R>) -> FileDialogBuilder<R> {
    let dialog = app.dialog().file();
    match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    }
}

/// The exact string the sidecar will stat: an absolute path without the `\\?\` verbatim
/// prefix, which the file dialog does not produce but which would defeat path equality.
pub(crate) fn path_string(path: PathBuf) -> Result<String, String> {
    let text = path.into_os_string().into_string().map_err(|_| "the selected path is not valid Unicode".to_owned())?;
    let text = match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => text,
    };
    if !Path::new(&text).is_absolute() {
        return Err("the selected path is not absolute".to_owned());
    }
    Ok(text)
}

/// Runs a blocking dialog off the async runtime's worker threads.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| format!("dialog task failed: {error}"))?
}

fn pick_and_sign(app: &AppHandle, extensions: &[&str], purpose: &str, playable: bool) -> Result<Option<PickedFile>, String> {
    let Some(picked) = with_filter(file_dialog(app), extensions).blocking_pick_file() else {
        return Ok(None);
    };
    let path = path_string(picked.into_path().map_err(|error| format!("unusable selection: {error}"))?)?;
    if playable {
        // Persisted by the persisted-scope plugin, so playback keeps working after a restart.
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| format!("could not allow the file for playback: {error}"))?;
    }
    let supervisor = app.state::<Supervisor>();
    let grant = file_grant::issue(supervisor.file_grant_key(), purpose, &path, now_ms());
    Ok(Some(PickedFile { path, grant }))
}

/// Open dialog for one media or subtitle file; `None` when the user cancels. Media files
/// join the asset protocol scope for `<video>`; subtitle files are only read by the sidecar.
#[tauri::command]
pub async fn pick_local_file(app: AppHandle, kind: PickKind) -> Result<Option<PickedFile>, String> {
    blocking(move || match kind {
        PickKind::Media => pick_and_sign(&app, MEDIA_EXTENSIONS, PURPOSE_LOCAL_FILE, true),
        PickKind::Subtitle => pick_and_sign(&app, SUBTITLE_EXTENSIONS, PURPOSE_LOCAL_FILE, false),
    })
    .await
}

/// Open dialog for the file that replaces a missing local original.
#[tauri::command]
pub async fn pick_relink_file(app: AppHandle) -> Result<Option<PickedFile>, String> {
    blocking(move || pick_and_sign(&app, MEDIA_EXTENSIONS, PURPOSE_RELINK, true)).await
}

/// Whether Windows reads `base` (a name up to its first dot) as a device such as `CON` or
/// `COM1`; superscript digits count too, as they do for Windows.
fn is_device_name(base: &str) -> bool {
    let upper = base.trim_end().to_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let mut chars = upper.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "COM" || prefix == "LPT") && matches!(rest.as_slice(), ['1'..='9' | '¹' | '²' | '³'])
}

/// A name Windows would open as a device (`NUL.mp4` is `NUL`) gets `_` before its first dot.
fn unreserve(name: &str) -> String {
    let (base, rest) = name.split_at(name.find('.').unwrap_or(name.len()));
    if is_device_name(base) {
        format!("{base}_{rest}")
    } else {
        name.to_owned()
    }
}

/// A default file name from untrusted text: no path separators, reserved or control
/// characters, no trailing dots or spaces (Windows strips them), no device name, and the
/// given extension.
pub(crate) fn sanitize_file_name(suggested: &str, extension: &str) -> String {
    const RESERVED: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let cleaned: String = suggested
        .chars()
        .filter(|c| !c.is_control() && !RESERVED.contains(c))
        .take(MAX_SUGGESTED_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    let suffix = format!(".{extension}");
    let name = if trimmed.is_empty() {
        format!("{FALLBACK_STEM}{suffix}")
    } else if trimmed.to_lowercase().ends_with(&suffix.to_lowercase()) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}{suffix}")
    };
    unreserve(&name)
}

/// A temporary file name beside the target, so the final rename stays on one volume.
fn temporary_beside(target: &Path) -> Result<PathBuf, String> {
    let directory = target.parent().ok_or("the chosen location has no directory")?;
    let mut suffix = [0u8; 6];
    fill_random(&mut suffix)?;
    Ok(directory.join(format!(".amber-save-{}.partial", base64url(&suffix))))
}

/// Copies through a temporary file in the destination directory and renames it over the
/// target, so the chosen file is either complete or untouched. The save dialog already
/// asked before replacing an existing file.
fn copy_atomically(source: &Path, target: &Path) -> Result<(), String> {
    let temporary = temporary_beside(target)?;
    let result = fs::copy(source, &temporary)
        .map_err(|error| format!("copy failed: {error}"))
        .and_then(|_| fs::rename(&temporary, target).map_err(|error| format!("replace failed: {error}")));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// [`copy_atomically`] from an open handle, starting at its first byte: what is copied is
/// the very file whose head was inspected, even if the path was swapped in between.
fn copy_open_file_atomically(source: &mut File, target: &Path) -> Result<(), String> {
    let temporary = temporary_beside(target)?;
    let result = write_copy(source, &temporary)
        .map_err(|error| format!("copy failed: {error}"))
        .and_then(|()| fs::rename(&temporary, target).map_err(|error| format!("replace failed: {error}")));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_copy(source: &mut File, temporary: &Path) -> io::Result<()> {
    source.seek(SeekFrom::Start(0))?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(temporary)?;
    io::copy(source, &mut output)?;
    output.sync_all()
}

/// The containers a subtitled video export produces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VideoContainer {
    Mp4,
    Mkv,
}

impl VideoContainer {
    fn extension(self) -> &'static str {
        match self {
            VideoContainer::Mp4 => "mp4",
            VideoContainer::Mkv => "mkv",
        }
    }
}

/// The first bytes of an open file, from its current position (the start, when just opened).
fn read_head(file: &mut File) -> io::Result<Vec<u8>> {
    let mut head = Vec::new();
    (&mut *file).take(CONTAINER_HEAD_BYTES).read_to_end(&mut head)?;
    Ok(head)
}

/// The major brand of an ISO BMFF file: its first box is `ftyp`, at least as long as the
/// size, type, major brand and minor version it must hold.
fn ftyp_major_brand(head: &[u8]) -> Option<[u8; 4]> {
    let size = u32::from_be_bytes(head.get(0..4)?.try_into().ok()?);
    if head.get(4..8)? != b"ftyp".as_slice() || size < 16 {
        return None;
    }
    head.get(8..12)?.try_into().ok()
}

/// An EBML variable-length integer at `pos`: its length is one plus the leading zero bits of
/// its first byte, at most `max_len`. Element IDs keep the length marker bit, sizes drop it.
/// `None` when it is malformed or runs past the data.
fn read_vint(data: &[u8], pos: usize, max_len: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *data.get(pos)?;
    if first == 0 {
        return None;
    }
    let len = usize::try_from(first.leading_zeros()).ok()? + 1;
    if len > max_len {
        return None;
    }
    let bytes = data.get(pos..pos.checked_add(len)?)?;
    let mut value = if keep_marker { u64::from(first) } else { u64::from(first) & (0xFF_u64 >> len) };
    for byte in &bytes[1..] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, len))
}

/// The `DocType` of an EBML file, read from the header element it starts with. The header
/// must fit in `head` and every child must lie inside the header.
fn ebml_doc_type(head: &[u8]) -> Option<&[u8]> {
    if !head.starts_with(&EBML_MAGIC) {
        return None;
    }
    let (header_size, size_len) = read_vint(head, EBML_MAGIC.len(), 8, false)?;
    let start = EBML_MAGIC.len() + size_len;
    let header = head.get(start..start.checked_add(usize::try_from(header_size).ok()?)?)?;
    let mut pos = 0;
    while pos < header.len() {
        let (id, id_len) = read_vint(header, pos, 4, true)?;
        let (size, size_len) = read_vint(header, pos + id_len, 8, false)?;
        let data_start = pos + id_len + size_len;
        let data_end = data_start.checked_add(usize::try_from(size).ok()?)?;
        let data = header.get(data_start..data_end)?;
        if id == EBML_DOC_TYPE_ID {
            // EBML strings may be padded with trailing zero bytes.
            let used = data.iter().rposition(|byte| *byte != 0).map_or(0, |last| last + 1);
            return Some(&data[..used]);
        }
        pos = data_end;
    }
    None
}

/// Recognizes the container of a burn product from its first bytes: an MP4 by its `ftyp`
/// major brand, an MKV by its EBML `DocType`. Anything else (WebM, M4A, QuickTime, still
/// images, an empty or truncated file) is refused rather than saved under a wrong name.
fn detect_container(head: &[u8]) -> Result<VideoContainer, String> {
    if let Some(brand) = ftyp_major_brand(head) {
        return if MP4_BRANDS.contains(&brand) {
            Ok(VideoContainer::Mp4)
        } else {
            Err("the file is an ISO media file of an unsupported brand".to_owned())
        };
    }
    if head.starts_with(&EBML_MAGIC) {
        return match ebml_doc_type(head) {
            Some(doc_type) if doc_type == MATROSKA_DOC_TYPE => Ok(VideoContainer::Mkv),
            _ => Err("the file is not a Matroska video".to_owned()),
        };
    }
    Err("the file is neither an MP4 nor an MKV video".to_owned())
}

/// Whether a path's extension names the container, in any letter case.
fn has_container_extension(path: &Path, container: VideoContainer) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(container.extension()))
}

/// The path to save to: the chosen one when its extension names the container, otherwise
/// the chosen name with the container's extension appended. The save dialog only confirmed
/// replacing the name the user chose, so an appended name that already exists is refused.
fn save_target(chosen: PathBuf, container: VideoContainer) -> Result<PathBuf, String> {
    if has_container_extension(&chosen, container) {
        return Ok(chosen);
    }
    let mut name = chosen.file_name().ok_or("the chosen location has no file name")?.to_os_string();
    name.push(".");
    name.push(container.extension());
    let target = chosen.with_file_name(name);
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(target),
        Ok(_) => Err(format!("a file named with the .{} extension already exists there", container.extension())),
        Err(error) => Err(format!("the chosen location is not accessible: {error}")),
    }
}

/// Save dialog for a burn product. The grant must be the sidecar's `burn_output` grant and
/// its path must resolve inside `<data dir>/assets`; the WebView cannot pick the source. The
/// container is recognized from the opened file itself and decides the dialog's filter and
/// the saved extension; the same handle is then copied, so no other file can slip in.
#[tauri::command]
pub async fn save_burn_output(app: AppHandle, grant: FileGrant, suggested_name: String) -> Result<Option<SavedFile>, String> {
    blocking(move || {
        let supervisor = app.state::<Supervisor>();
        file_grant::verify(supervisor.file_grant_key(), &grant, PURPOSE_BURN_OUTPUT, now_ms())?;
        let source = file_grant::resolve_inside(&supervisor.data_dir().join("assets"), Path::new(&grant.path))?;
        let mut file = File::open(&source).map_err(|error| format!("file is not accessible: {error}"))?;
        let head = read_head(&mut file).map_err(|error| format!("file is not readable: {error}"))?;
        let container = detect_container(&head)?;
        let extension = container.extension();
        let dialog = with_filter(file_dialog(&app), &[extension]).set_file_name(sanitize_file_name(&suggested_name, extension));
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let chosen = chosen.into_path().map_err(|error| format!("unusable location: {error}"))?;
        let target = save_target(chosen, container)?;
        copy_open_file_atomically(&mut file, &target)?;
        Ok(Some(SavedFile { saved_path: path_string(target)? }))
    })
    .await
}

/// Whether a path string (canonicalized and stripped of the verbatim prefix) sits on a local
/// volume. On Windows that is a drive letter followed by `:\`, which rules out UNC shares and
/// device namespaces (both begin with `\\`); elsewhere any absolute path qualifies.
pub(crate) fn is_local_volume(path: &str) -> bool {
    if cfg!(windows) {
        let mut chars = path.chars();
        matches!((chars.next(), chars.next(), chars.next()), (Some(drive), Some(':'), Some('\\')) if drive.is_ascii_alphabetic())
    } else {
        Path::new(path).is_absolute()
    }
}

/// The directory a picked folder maps to: the folder itself when it already is an Amber cache
/// directory (re-selecting a previous location, recognized by its marker), otherwise its
/// `media` child.
fn cache_dir_target(picked: &Path) -> PathBuf {
    if has_marker(picked, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC) {
        picked.to_path_buf()
    } else {
        picked.join(CACHE_DIR_NAME)
    }
}

/// A refused cache location as `cache_dir:<reason>: <detail>`. The reason is one of the
/// sidecar's `invalid_request.cache_dir` reasons, so the WebView can show the
/// same localized message whichever side refused.
fn cache_dir_error(reason: &str, detail: impl std::fmt::Display) -> String {
    format!("cache_dir:{reason}: {detail}")
}

/// Whether `path` is `root` or lies inside it, compared without case on Windows.
fn is_same_or_inside(root: &Path, path: &Path) -> bool {
    if cfg!(windows) {
        let root = root.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        let root = root.trim_end_matches('\\');
        path == root || path.starts_with(&format!("{root}\\"))
    } else {
        path.starts_with(root)
    }
}

/// Whether a cache target shares space with the data directory: the data directory itself,
/// inside it, or holding it. The default cache directory (`<data dir>/media`) is the one
/// exception; picking the data directory maps to it and simply means "back to the default".
/// The sidecar refuses the same; checking here first keeps the shell from creating the
/// directory before that refusal.
fn overlaps_data_dir(target: &Path, data_dir: &Path, default_cache_dir: &Path) -> bool {
    let is_default = is_same_or_inside(default_cache_dir, target) && is_same_or_inside(target, default_cache_dir);
    !is_default && (is_same_or_inside(data_dir, target) || is_same_or_inside(target, data_dir))
}

/// The directory a `cache_dir` grant may name: on a local volume and called `media`.
/// Checked again when the grant comes back, so a valid signature alone never allows a
/// directory the shell would not have signed.
fn cache_dir_path(path: &str) -> Result<&Path, String> {
    if !is_local_volume(path) {
        return Err(cache_dir_error("not_local", "the cache directory must be on a local volume"));
    }
    let path = Path::new(path);
    if !path.file_name().is_some_and(|name| name == CACHE_DIR_NAME) {
        return Err(cache_dir_error("invalid_path", format!("the cache directory must be named {CACHE_DIR_NAME}")));
    }
    Ok(path)
}

/// A cache target may be missing, empty, or hold nothing but a valid cache marker (a
/// previous location of Amber's own). Anything else (a file, a link, other entries) would
/// mix cache files with data Amber does not own.
fn ensure_empty_dir(target: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(cache_dir_error("not_accessible", format!("the cache directory is not accessible: {error}"))),
    };
    if !metadata.is_dir() {
        return Err(cache_dir_error("not_directory", "the cache location exists but is not a directory"));
    }
    let not_readable = |error: io::Error| cache_dir_error("not_accessible", format!("the cache directory is not readable: {error}"));
    let entries = fs::read_dir(target).map_err(not_readable)?;
    for entry in entries {
        let entry = entry.map_err(not_readable)?;
        if entry.file_name() == CACHE_ROOT_MARKER && has_marker(target, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC) {
            continue;
        }
        return Err(cache_dir_error("not_empty", "the cache directory is not empty"));
    }
    Ok(())
}

/// Only directories may be opened, and only the default cache directory (`<data dir>/media`)
/// or one the asset protocol scope already allows, i.e. a cache directory the user chose.
fn folder_is_openable(canonical: &Path, default_cache_dir: &Path, is_allowed: impl Fn(&Path) -> bool) -> bool {
    canonical.is_dir() && (canonical == default_cache_dir || is_allowed(canonical))
}

/// The extension of a cache file the shell may copy out: one of the cache containers.
fn cache_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    CACHE_EXTENSIONS.iter().copied().find(|candidate| *candidate == extension)
}

/// Whether a canonicalized cache file may be copied out: a regular file on a local volume,
/// directly inside a `media` cache directory that is either the default one (canonicalized
/// `<data dir>/media`, `None` when it does not exist) or one the asset scope allows.
fn cache_source_allowed(source: &Path, default_cache_dir: Option<&Path>, is_allowed: impl Fn(&Path) -> bool) -> bool {
    let Ok(text) = path_string(source.to_path_buf()) else {
        return false;
    };
    if !is_local_volume(&text) || !source.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    let Some(parent) = source.parent() else {
        return false;
    };
    parent.file_name().is_some_and(|name| name == CACHE_DIR_NAME) && (default_cache_dir == Some(parent) || is_allowed(parent))
}

/// Folder dialog for a new media cache location; `None` when the user cancels. The grant
/// names the `media` directory that will be created, which must not exist yet or must be
/// empty. Nothing is created or allowed here: the sidecar validates the location first,
/// then the WebView presents the grant to `allow_cache_dir`.
#[tauri::command]
pub async fn pick_cache_dir(app: AppHandle) -> Result<Option<PickedFile>, String> {
    blocking(move || {
        let Some(picked) = file_dialog(&app).blocking_pick_folder() else {
            return Ok(None);
        };
        let picked = picked.into_path().map_err(|error| cache_dir_error("not_found", format!("unusable selection: {error}")))?;
        // Canonicalizing resolves junctions and `..`, so the grant names the directory that
        // will really hold the cache rather than an alias of it.
        let picked = picked.canonicalize().map_err(|error| cache_dir_error("not_found", format!("unusable selection: {error}")))?;
        let picked = path_string(picked).map_err(|error| cache_dir_error("invalid_path", error))?;
        if !is_local_volume(&picked) {
            return Err(cache_dir_error("not_local", "the cache directory must be on a local volume"));
        }
        let target = cache_dir_target(Path::new(&picked));
        let supervisor = app.state::<Supervisor>();
        let data_dir = supervisor.data_dir();
        let data_dir = data_dir
            .canonicalize()
            .ok()
            .and_then(|canonical| path_string(canonical).ok())
            .map_or_else(|| data_dir.to_path_buf(), PathBuf::from);
        if overlaps_data_dir(&target, &data_dir, &data_dir.join(CACHE_DIR_NAME)) {
            return Err(cache_dir_error("overlaps_data_dir", "the cache directory must not share space with the data directory"));
        }
        ensure_empty_dir(&target)?;
        let path = path_string(target).map_err(|error| cache_dir_error("invalid_path", error))?;
        let grant = file_grant::issue(supervisor.file_grant_key(), PURPOSE_CACHE_DIR, &path, now_ms());
        Ok(Some(PickedFile { path, grant }))
    })
    .await
}

/// Creates the cache directory a `cache_dir` grant names and lets `<video>` play from it.
/// The grant is the shell's own, so the WebView can only hand back a location it picked.
#[tauri::command]
pub async fn allow_cache_dir(app: AppHandle, grant: FileGrant) -> Result<(), String> {
    blocking(move || {
        let supervisor = app.state::<Supervisor>();
        file_grant::verify(supervisor.file_grant_key(), &grant, PURPOSE_CACHE_DIR, now_ms())?;
        let path = cache_dir_path(&grant.path)?;
        fs::create_dir_all(path).map_err(|error| cache_dir_error("not_writable", format!("could not create the cache directory: {error}")))?;
        // A directory that already existed must still be empty; nothing is ever removed here.
        ensure_empty_dir(path)?;
        // Persisted by the persisted-scope plugin, so playback from the new root keeps
        // working after a restart.
        app.asset_protocol_scope()
            .allow_directory(path, true)
            .map_err(|error| format!("could not allow the cache directory for playback: {error}"))?;
        Ok(())
    })
    .await
}

/// Save dialog for a cached platform media file ("save cache as"). The grant must be
/// the sidecar's `cache_save` grant and its path must resolve to a file directly inside a
/// cache directory; the WebView cannot pick the source. The cache file itself stays.
#[tauri::command]
pub async fn save_cached_media(app: AppHandle, grant: FileGrant, suggested_name: String) -> Result<Option<SavedFile>, String> {
    blocking(move || {
        let supervisor = app.state::<Supervisor>();
        file_grant::verify(supervisor.file_grant_key(), &grant, PURPOSE_CACHE_SAVE, now_ms())?;
        // Canonicalizing resolves `..`, symlinks and junctions on both sides of the check.
        let source = Path::new(&grant.path).canonicalize().map_err(|error| format!("file is not accessible: {error}"))?;
        let default_cache_dir = supervisor.data_dir().join(CACHE_DIR_NAME).canonicalize().ok();
        let scope = app.asset_protocol_scope();
        if !cache_source_allowed(&source, default_cache_dir.as_deref(), |candidate| scope.is_allowed(candidate)) {
            return Err("file is not in a cache directory".to_owned());
        }
        let extension = cache_extension(&source).ok_or("file is not a cache file")?;
        let dialog = with_filter(file_dialog(&app), &[extension]).set_file_name(sanitize_file_name(&suggested_name, extension));
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let target = chosen.into_path().map_err(|error| format!("unusable location: {error}"))?;
        copy_atomically(&source, &target)?;
        Ok(Some(SavedFile { saved_path: path_string(target)? }))
    })
    .await
}

/// Shows a directory in the system file manager. The opener's Rust API applies no scope of
/// its own (the capability only constrains the JS API), so the check here is the whole
/// security boundary between the WebView and the system shell.
#[tauri::command]
pub async fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    blocking(move || {
        let canonical = Path::new(&path).canonicalize().map_err(|error| format!("folder is not accessible: {error}"))?;
        let default_cache_dir = app.state::<Supervisor>().data_dir().join(CACHE_DIR_NAME);
        // The default cache directory may not exist yet on a fresh install; creating this one
        // directory of the sidecar's own layout lets the user open it before anything is cached.
        fs::create_dir_all(&default_cache_dir).map_err(|error| format!("data directory is not accessible: {error}"))?;
        let default_cache_dir =
            default_cache_dir.canonicalize().map_err(|error| format!("data directory is not accessible: {error}"))?;
        let scope = app.asset_protocol_scope();
        if !folder_is_openable(&canonical, &default_cache_dir, |candidate| scope.is_allowed(candidate)) {
            return Err("folder is not one Amber manages".to_owned());
        }
        app.opener()
            .open_path(path_string(canonical)?, None::<&str>)
            .map_err(|error| format!("could not open the folder: {error}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::marker::marker_text;

    fn scratch_dir(name: &str) -> PathBuf {
        let mut bytes = [0u8; 8];
        fill_random(&mut bytes).unwrap();
        let dir = std::env::temp_dir().join(format!("amber-{name}-{}", base64url(&bytes)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_cache_marker(dir: &Path) {
        fs::write(dir.join(CACHE_ROOT_MARKER), marker_text(CACHE_ROOT_MARKER_MAGIC)).unwrap();
    }

    #[test]
    fn sanitizes_suggested_names() {
        assert_eq!(sanitize_file_name("第 1 讲 双语.mp4", "mp4"), "第 1 讲 双语.mp4");
        assert_eq!(sanitize_file_name("lecture", "mp4"), "lecture.mp4");
        assert_eq!(sanitize_file_name("Lecture.MP4", "mp4"), "Lecture.MP4");
        assert_eq!(sanitize_file_name(r"..\..\Windows\evil.mp4", "mp4"), "....Windowsevil.mp4");
        assert_eq!(sanitize_file_name("a/b:c*d?e\"f<g>h|i\u{0}\n.mp4", "mp4"), "abcdefghi.mp4");
        assert_eq!(sanitize_file_name("name. . ", "mp4"), "name.mp4");
        assert_eq!(sanitize_file_name("", "mp4"), "amber.mp4");
        assert_eq!(sanitize_file_name(" ../ ", "mp4"), "amber.mp4");
        assert_eq!(sanitize_file_name("\u{1}\u{2}", "mp4"), "amber.mp4");
        assert_eq!(sanitize_file_name(&"长".repeat(500), "mp4").chars().count(), MAX_SUGGESTED_NAME_CHARS + 4);
    }

    #[test]
    fn keeps_the_source_extension() {
        assert_eq!(sanitize_file_name("讲座 #1.mp3", "mp3"), "讲座 #1.mp3");
        assert_eq!(sanitize_file_name("讲座 #1.mp4", "mp3"), "讲座 #1.mp4.mp3");
        assert_eq!(sanitize_file_name("talk", "webm"), "talk.webm");
        assert_eq!(sanitize_file_name("talk.WEBM", "webm"), "talk.WEBM");
        assert_eq!(sanitize_file_name("", "mp3"), "amber.mp3");
    }

    #[test]
    fn renames_windows_device_names() {
        assert_eq!(sanitize_file_name("CON", "mp4"), "CON_.mp4");
        assert_eq!(sanitize_file_name("nul.mp3", "mp3"), "nul_.mp3");
        assert_eq!(sanitize_file_name("Aux.tar", "mp4"), "Aux_.tar.mp4");
        assert_eq!(sanitize_file_name("com1", "mp4"), "com1_.mp4");
        assert_eq!(sanitize_file_name("LPT9.webm", "webm"), "LPT9_.webm");
        assert_eq!(sanitize_file_name("COM\u{b9}", "mp4"), "COM\u{b9}_.mp4");
        assert_eq!(sanitize_file_name("prn .mp4", "mp4"), "prn _.mp4");
        // Look-alikes stay as they are.
        assert_eq!(sanitize_file_name("CONSOLE", "mp4"), "CONSOLE.mp4");
        assert_eq!(sanitize_file_name("COM0", "mp4"), "COM0.mp4");
        assert_eq!(sanitize_file_name("COM10", "mp4"), "COM10.mp4");
        assert_eq!(sanitize_file_name("my CON", "mp4"), "my CON.mp4");
    }

    #[test]
    fn strips_the_verbatim_prefix() {
        #[cfg(windows)]
        {
            assert_eq!(path_string(PathBuf::from(r"\\?\C:\Videos\a.mp4")).unwrap(), r"C:\Videos\a.mp4");
            assert_eq!(path_string(PathBuf::from(r"C:\Videos\a.mp4")).unwrap(), r"C:\Videos\a.mp4");
            assert_eq!(path_string(PathBuf::from(r"\\?\UNC\server\share\a.mp4")).unwrap(), r"\\?\UNC\server\share\a.mp4");
        }
        #[cfg(not(windows))]
        assert_eq!(path_string(PathBuf::from("/videos/a.mp4")).unwrap(), "/videos/a.mp4");
        assert!(path_string(PathBuf::from("relative.mp4")).is_err());
    }

    #[test]
    fn copies_through_a_temporary_file() {
        let dir = scratch_dir("save");
        let source = dir.join("source.mp4");
        let target = dir.join("目标 文件.mp4");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old content").unwrap();
        copy_atomically(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".partial")).collect();
        assert!(leftovers.is_empty());
        assert!(copy_atomically(&dir.join("missing.mp4"), &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"new");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The head ffmpeg writes for `-f mp4`: an `ftyp` box with major brand `isom`.
    const MP4_HEAD: &[u8] = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41\x00\x00\x00\x08free";

    /// An EBML header as ffmpeg writes it for `-f matroska`, with an 8-byte header size.
    fn ebml_head(doc_type: &[u8]) -> Vec<u8> {
        let mut children: Vec<u8> = Vec::new();
        for (id, value) in [([0x42_u8, 0x86_u8], 1_u8), ([0x42, 0xF7], 1), ([0x42, 0xF2], 4), ([0x42, 0xF3], 8)] {
            children.extend_from_slice(&id);
            children.extend_from_slice(&[0x81, value]);
        }
        children.extend_from_slice(&[0x42, 0x82, 0x80 | u8::try_from(doc_type.len()).unwrap()]);
        children.extend_from_slice(doc_type);
        children.extend_from_slice(&[0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02]);
        let mut head = EBML_MAGIC.to_vec();
        head.push(0x01);
        head.extend_from_slice(&u64::try_from(children.len()).unwrap().to_be_bytes()[1..]);
        head.extend_from_slice(&children);
        // The Segment element that follows the header.
        head.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        head
    }

    fn ftyp(brand: &[u8; 4]) -> Vec<u8> {
        let mut head = b"\x00\x00\x00\x18ftyp".to_vec();
        head.extend_from_slice(brand);
        head.extend_from_slice(b"\x00\x00\x00\x00");
        head.extend_from_slice(brand);
        head.extend_from_slice(b"isom");
        head
    }

    #[test]
    fn recognizes_export_containers() {
        assert_eq!(detect_container(MP4_HEAD), Ok(VideoContainer::Mp4));
        for brand in [b"isom", b"iso2", b"mp41", b"mp42"] {
            assert_eq!(detect_container(&ftyp(brand)), Ok(VideoContainer::Mp4));
        }
        assert_eq!(detect_container(&ebml_head(b"matroska")), Ok(VideoContainer::Mkv));
        // A DocType padded with zero bytes, and a one-byte header size, still read the same.
        let mut padded = EBML_MAGIC.to_vec();
        padded.extend_from_slice(&[0x80 | 13, 0x42, 0x82, 0x8A]);
        padded.extend_from_slice(b"matroska\x00\x00");
        assert_eq!(detect_container(&padded), Ok(VideoContainer::Mkv));
    }

    #[test]
    fn refuses_other_files() {
        // ISO BMFF files that are not exports: a forged `ftyp`, M4A, QuickTime, AVIF, HEIC.
        for brand in [b"abcd", b"M4A ", b"qt  ", b"avif", b"heic"] {
            assert!(detect_container(&ftyp(brand)).is_err());
        }
        // A `ftyp` box too short to hold its brand, or not the first box.
        assert!(detect_container(b"\x00\x00\x00\x0cftypisom").is_err());
        assert!(detect_container(b"\x00\x00\x00\x08freeftypisom\x00\x00\x00\x00").is_err());
        // WebM shares the EBML header but is not Matroska.
        assert!(detect_container(&ebml_head(b"webm")).is_err());
        assert!(detect_container(&ebml_head(b"matroskax")).is_err());
        // Empty and truncated files.
        assert!(detect_container(b"").is_err());
        assert!(detect_container(b"\x00\x00\x00").is_err());
        assert!(detect_container(b"\x00\x00\x00\x20ftyp").is_err());
        assert!(detect_container(&EBML_MAGIC[..3]).is_err());
        assert!(detect_container(&EBML_MAGIC).is_err());
        let whole = ebml_head(b"matroska");
        assert!(detect_container(&whole[..30]).is_err());
        // An EBML header without a DocType, or with a malformed size.
        assert!(detect_container(&[0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01]).is_err());
        assert!(detect_container(&[0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x42]).is_err());
        // Other formats.
        assert!(detect_container(b"RIFF\x24\x00\x00\x00AVI LIST").is_err());
        assert!(detect_container(b"ID3\x04\x00\x00\x00\x00\x00\x00").is_err());
    }

    #[test]
    fn reads_and_copies_the_same_handle() {
        let dir = scratch_dir("burn-save");
        let source = dir.join("asset");
        let mut content = ebml_head(b"matroska");
        content.extend(std::iter::repeat_n(7u8, 10_000));
        fs::write(&source, &content).unwrap();
        let mut file = File::open(&source).unwrap();
        let head = read_head(&mut file).unwrap();
        assert_eq!(head.len(), usize::try_from(CONTAINER_HEAD_BYTES).unwrap());
        assert_eq!(detect_container(&head), Ok(VideoContainer::Mkv));
        let target = dir.join("第 1 讲.mkv");
        fs::write(&target, b"old content").unwrap();
        copy_open_file_atomically(&mut file, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), content);
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".partial")).collect();
        assert!(leftovers.is_empty());
        // An empty file reads as an empty head and is refused.
        let empty = dir.join("empty");
        fs::write(&empty, b"").unwrap();
        assert!(detect_container(&read_head(&mut File::open(&empty).unwrap()).unwrap()).is_err());
        drop(file);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrects_the_saved_extension() {
        let dir = scratch_dir("burn-extension");
        // A matching extension, in any case, is kept; the dialog already confirmed replacing it.
        let chosen = dir.join("lecture.MKV");
        fs::write(&chosen, b"x").unwrap();
        assert_eq!(save_target(chosen.clone(), VideoContainer::Mkv), Ok(chosen));
        assert_eq!(save_target(dir.join("lecture.mp4"), VideoContainer::Mp4), Ok(dir.join("lecture.mp4")));
        // A missing or different extension gets the right one appended.
        assert_eq!(save_target(dir.join("lecture"), VideoContainer::Mp4), Ok(dir.join("lecture.mp4")));
        assert_eq!(save_target(dir.join("lecture.mp4"), VideoContainer::Mkv), Ok(dir.join("lecture.mp4.mkv")));
        assert_eq!(save_target(dir.join("第 1.5 讲"), VideoContainer::Mkv), Ok(dir.join("第 1.5 讲.mkv")));
        // An appended name the dialog never showed is not allowed to replace an existing file.
        fs::write(dir.join("taken.mkv"), b"keep").unwrap();
        assert!(save_target(dir.join("taken"), VideoContainer::Mkv).is_err());
        assert_eq!(fs::read(dir.join("taken.mkv")).unwrap(), b"keep");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn accepts_only_local_volumes() {
        #[cfg(windows)]
        {
            assert!(is_local_volume(r"C:\x"));
            assert!(is_local_volume(r"d:\media"));
            assert!(is_local_volume(r"C:\"));
            assert!(!is_local_volume(r"\\server\share"));
            assert!(!is_local_volume(r"\\?\UNC\server\share"));
            assert!(!is_local_volume(r"\\?\C:\x"));
            assert!(!is_local_volume(r"\\.\PhysicalDrive0"));
            assert!(!is_local_volume("C:x"));
            assert!(!is_local_volume("C:/x"));
            assert!(!is_local_volume(r"1:\x"));
        }
        #[cfg(not(windows))]
        {
            assert!(is_local_volume("/mnt/data"));
            assert!(!is_local_volume(r"\\server\share"));
        }
        assert!(!is_local_volume("relative"));
        assert!(!is_local_volume(""));
    }

    #[test]
    fn names_the_cache_directory() {
        let dir = scratch_dir("cache-name");
        // An unmarked folder gets a `media` child, even one already called `media`.
        assert_eq!(cache_dir_target(&dir), dir.join(CACHE_DIR_NAME));
        let unmarked = dir.join(CACHE_DIR_NAME);
        fs::create_dir(&unmarked).unwrap();
        assert_eq!(cache_dir_target(&unmarked), unmarked.join(CACHE_DIR_NAME));
        // A previous location of Amber's is recognized by its marker and reused.
        write_cache_marker(&unmarked);
        assert_eq!(cache_dir_target(&unmarked), unmarked);
        // A data directory marker or a foreign marker does not count.
        let other = dir.join("other");
        fs::create_dir(&other).unwrap();
        fs::write(other.join(CACHE_ROOT_MARKER), marker_text("amber-data-root-v1")).unwrap();
        assert_eq!(cache_dir_target(&other), other.join(CACHE_DIR_NAME));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn requires_the_media_name() {
        #[cfg(windows)]
        {
            assert_eq!(cache_dir_path(r"D:\Videos\media").unwrap(), Path::new(r"D:\Videos\media"));
            assert!(cache_dir_path(r"D:\Videos").is_err());
            assert!(cache_dir_path(r"D:\Amber Cache").is_err());
            assert!(cache_dir_path(r"D:\media\inner").is_err());
            assert!(cache_dir_path(r"\\server\share\media").is_err());
        }
        #[cfg(not(windows))]
        {
            assert_eq!(cache_dir_path("/videos/media").unwrap(), Path::new("/videos/media"));
            assert!(cache_dir_path("/videos").is_err());
        }
        assert!(cache_dir_path("media").is_err());
    }

    #[test]
    fn requires_a_missing_or_empty_target() {
        let dir = scratch_dir("cache-target");
        assert_eq!(ensure_empty_dir(&dir.join("missing")), Ok(()));
        let empty = dir.join(CACHE_DIR_NAME);
        fs::create_dir(&empty).unwrap();
        assert_eq!(ensure_empty_dir(&empty), Ok(()));
        // Only Amber's own marker is allowed to be there already.
        write_cache_marker(&empty);
        assert_eq!(ensure_empty_dir(&empty), Ok(()));
        fs::write(empty.join("leftover"), b"x").unwrap();
        assert!(ensure_empty_dir(&empty).is_err());
        fs::remove_file(empty.join("leftover")).unwrap();
        fs::write(empty.join(CACHE_ROOT_MARKER), b"not a marker").unwrap();
        assert!(ensure_empty_dir(&empty).is_err());
        let file = dir.join("file");
        fs::write(&file, b"x").unwrap();
        assert!(ensure_empty_dir(&file).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refusals_carry_the_cache_dir_reason() {
        let dir = scratch_dir("cache-reason");
        let target = dir.join(CACHE_DIR_NAME);
        fs::create_dir(&target).unwrap();
        fs::write(target.join("leftover"), b"x").unwrap();
        assert!(ensure_empty_dir(&target).unwrap_err().starts_with("cache_dir:not_empty: "));
        let file = dir.join("file");
        fs::write(&file, b"x").unwrap();
        assert!(ensure_empty_dir(&file).unwrap_err().starts_with("cache_dir:not_directory: "));
        fs::remove_dir_all(&dir).unwrap();
        #[cfg(windows)]
        {
            assert!(cache_dir_path(r"D:\Videos").unwrap_err().starts_with("cache_dir:invalid_path: "));
            assert!(cache_dir_path(r"\\server\share\media").unwrap_err().starts_with("cache_dir:not_local: "));
        }
        #[cfg(not(windows))]
        assert!(cache_dir_path("/videos").unwrap_err().starts_with("cache_dir:invalid_path: "));
        assert!(cache_dir_path("media").unwrap_err().starts_with("cache_dir:not_local: "));
    }

    #[test]
    fn refuses_cache_targets_that_share_the_data_directory() {
        #[cfg(windows)]
        let (data, unrelated) = (PathBuf::from(r"C:\Users\u\AppData\Roaming\Amber"), PathBuf::from(r"D:\Videos\media"));
        #[cfg(not(windows))]
        let (data, unrelated) = (PathBuf::from("/home/u/.local/share/Amber"), PathBuf::from("/videos/media"));
        let default = data.join(CACHE_DIR_NAME);
        // Inside the data directory, the data directory itself, or an ancestor of it.
        assert!(overlaps_data_dir(&data.join("cache").join(CACHE_DIR_NAME), &data, &default));
        assert!(overlaps_data_dir(&data, &data, &default));
        assert!(overlaps_data_dir(data.parent().unwrap(), &data, &default));
        // The default cache directory is allowed: picking the data directory means "back to the default".
        assert!(!overlaps_data_dir(&default, &data, &default));
        assert!(!overlaps_data_dir(&unrelated, &data, &default));
        // A sibling whose name merely starts with the data directory's name is unrelated.
        let sibling = data.with_file_name("Amber-cache").join(CACHE_DIR_NAME);
        assert!(!overlaps_data_dir(&sibling, &data, &default));
        #[cfg(windows)]
        assert!(overlaps_data_dir(&PathBuf::from(r"c:\users\U\appdata\roaming\amber\x\media"), &data, &default));
    }

    #[test]
    fn opens_only_managed_or_allowed_directories() {
        let dir = scratch_dir("open-folder");
        let media = dir.join(CACHE_DIR_NAME);
        let allowed = dir.join("allowed");
        let other = dir.join("other");
        let file = dir.join("file");
        for directory in [&media, &allowed, &other] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(&file, b"x").unwrap();
        let is_allowed = |candidate: &Path| candidate == allowed.as_path();
        assert!(folder_is_openable(&media, &media, is_allowed));
        assert!(folder_is_openable(&allowed, &media, is_allowed));
        assert!(!folder_is_openable(&other, &media, is_allowed));
        assert!(!folder_is_openable(&file, &media, |_| true));
        assert!(!folder_is_openable(&dir.join("missing"), &media, |_| true));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recognizes_cache_extensions() {
        assert_eq!(cache_extension(Path::new("a.mp4")), Some("mp4"));
        assert_eq!(cache_extension(Path::new("第 1 讲.WEBM")), Some("webm"));
        assert_eq!(cache_extension(Path::new("a.b.mp3")), Some("mp3"));
        assert_eq!(cache_extension(Path::new("a.mkv")), None);
        assert_eq!(cache_extension(Path::new("mp4")), None);
    }

    #[test]
    fn saves_only_files_directly_inside_a_cache_directory() {
        let dir = scratch_dir("cache-save");
        let default_media = dir.join("data").join(CACHE_DIR_NAME);
        let custom_media = dir.join("custom").join(CACHE_DIR_NAME);
        let elsewhere = dir.join("elsewhere");
        for directory in [&default_media, &custom_media, &elsewhere, &default_media.join("nested")] {
            fs::create_dir_all(directory).unwrap();
        }
        let files = [
            default_media.join("第 1 讲.mp4"),
            custom_media.join("talk.mp3"),
            elsewhere.join("secret.mp4"),
            default_media.join("nested").join("deep.mp4"),
        ];
        for file in &files {
            fs::write(file, b"x").unwrap();
        }
        let canonical = |path: &Path| path.canonicalize().unwrap();
        let default_dir = canonical(&default_media);
        let custom_dir = canonical(&custom_media);
        let allowed = |candidate: &Path| candidate == custom_dir.as_path();
        assert!(cache_source_allowed(&canonical(&files[0]), Some(&default_dir), allowed));
        assert!(cache_source_allowed(&canonical(&files[1]), Some(&default_dir), allowed));
        // A file elsewhere, even in an allowed directory not called `media`, or one level deeper.
        assert!(!cache_source_allowed(&canonical(&files[2]), Some(&default_dir), |_| true));
        assert!(!cache_source_allowed(&canonical(&files[3]), Some(&default_dir), |_| true));
        // The custom directory only counts while the scope allows it.
        assert!(!cache_source_allowed(&canonical(&files[1]), Some(&default_dir), |_| false));
        // Without a default cache directory only allowed ones remain.
        assert!(!cache_source_allowed(&canonical(&files[0]), None, |_| false));
        // A directory is not a file to copy.
        assert!(!cache_source_allowed(&default_dir, Some(&default_dir), |_| true));
        fs::remove_dir_all(&dir).unwrap();
    }
}
