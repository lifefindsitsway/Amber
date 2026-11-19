//! Local file grants: the shell signs files the user picked in
//! its own dialogs (`local_file`, `relink`, the backup file to write `backup_output`, the
//! backup to restore `restore_archive`, the content pack to write `pack_output` or to read
//! `pack_input`), the cache directory it will create for the user (`cache_dir`), the directory
//! a restore puts originals in (`restore_originals_dir`) and the directory a content pack
//! import puts its originals under (`pack_originals_dir`), and
//! checks the grants the sidecar signs for burn products (`burn_output`) and cached platform
//! media (`cache_save`).
//! Both sides share `AMBER_FILE_GRANT_KEY`, which the WebView never sees, so the WebView can
//! pass grants along but cannot mint or alter one.

use std::path::{Path, PathBuf};

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::encoding::{base64url, base64url_decode};
use crate::defaults::FILE_GRANT_TTL_MS;

pub const PURPOSE_LOCAL_FILE: &str = "local_file";
pub const PURPOSE_RELINK: &str = "relink";
pub const PURPOSE_BURN_OUTPUT: &str = "burn_output";
pub const PURPOSE_CACHE_DIR: &str = "cache_dir";
pub const PURPOSE_CACHE_SAVE: &str = "cache_save";
pub const PURPOSE_BACKUP_OUTPUT: &str = "backup_output";
pub const PURPOSE_RESTORE_ARCHIVE: &str = "restore_archive";
pub const PURPOSE_RESTORE_ORIGINALS_DIR: &str = "restore_originals_dir";
pub const PURPOSE_PACK_OUTPUT: &str = "pack_output";
pub const PURPOSE_PACK_INPUT: &str = "pack_input";
pub const PURPOSE_PACK_ORIGINALS_DIR: &str = "pack_originals_dir";

/// Wire shape shared with the TypeScript `fileGrantSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileGrant {
    pub path: String,
    pub purpose: String,
    pub expires_at: u64,
    pub sig: String,
}

fn mac(key: &[u8], purpose: &str, path: &str, expires_at: u64) -> Hmac<Sha256> {
    // HMAC accepts keys of any length, so this cannot fail.
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes keys of any length");
    mac.update(format!("{purpose}|{path}|{expires_at}").as_bytes());
    mac
}

pub fn sign(key: &[u8], purpose: &str, path: &str, expires_at: u64) -> FileGrant {
    let sig = base64url(&mac(key, purpose, path, expires_at).finalize().into_bytes());
    FileGrant { path: path.to_owned(), purpose: purpose.to_owned(), expires_at, sig }
}

/// A grant for `path` that expires `FILE_GRANT_TTL_MS` from `now_ms`.
pub fn issue(key: &[u8], purpose: &str, path: &str, now_ms: u64) -> FileGrant {
    sign(key, purpose, path, now_ms.saturating_add(FILE_GRANT_TTL_MS))
}

/// Accepts a grant only for `purpose`, while it is valid, and with an untampered signature.
/// Grants that would live longer than any signer issues are forged or from a skewed clock.
pub fn verify(key: &[u8], grant: &FileGrant, purpose: &str, now_ms: u64) -> Result<(), &'static str> {
    if grant.purpose != purpose {
        return Err("file grant has the wrong purpose");
    }
    if grant.expires_at <= now_ms {
        return Err("file grant has expired");
    }
    if grant.expires_at - now_ms > FILE_GRANT_TTL_MS {
        return Err("file grant expires too far in the future");
    }
    let sig = base64url_decode(&grant.sig).ok_or("file grant signature is malformed")?;
    // `verify_slice` compares in constant time.
    mac(key, &grant.purpose, &grant.path, grant.expires_at)
        .verify_slice(&sig)
        .map_err(|_| "file grant signature does not match")
}

/// Canonicalizes `path` and requires it to be a regular file strictly inside the
/// canonicalized `root`. Canonicalizing both sides resolves `..`, symlinks and junctions, so
/// a path that only looks like it is under `root` is rejected.
pub fn resolve_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| format!("data directory is not accessible: {error}"))?;
    let resolved = path.canonicalize().map_err(|error| format!("file is not accessible: {error}"))?;
    if resolved == root || !resolved.starts_with(&root) {
        return Err("file is outside the data directory's assets".to_owned());
    }
    if !resolved.metadata().map_err(|error| format!("file is not accessible: {error}"))?.is_file() {
        return Err("path is not a regular file".to_owned());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const KEY_BASE64URL: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    fn key() -> Vec<u8> {
        let key: Vec<u8> = (0u8..32).collect();
        assert_eq!(base64url(&key), KEY_BASE64URL);
        key
    }

    /// Known-answer vectors shared with the sidecar's TypeScript implementation.
    #[test]
    fn reproduces_the_shared_vectors() {
        let key = key();
        let vectors = [
            (PURPOSE_LOCAL_FILE, r"C:\Users\测试 用户\Videos\lecture 1.mp4", 1_767_225_600_000, "VYYCA1fnKrVJwZYiup-qcp7W-3Z1rHpOURT3ynl14To"),
            (
                PURPOSE_BURN_OUTPUT,
                r"C:\Users\测试 用户\AppData\Roaming\Amber\assets\u1\c1\a1",
                1_767_225_900_000,
                "SKmzcEZo2nOZDrKclgOluQG9ci2UOaD2GViMRoq5VfE",
            ),
            (PURPOSE_RELINK, "/home/amber/视频/第 2 讲.mkv", 1_767_225_600_123, "WxvKTAj1FJujtvxozGJ2ZR8J6RTNw33y5lPdPAgb-js"),
            (PURPOSE_CACHE_DIR, r"D:\Amber Cache", 1_767_226_200_000, "DozJ0x_XB54SCE358IOqi8PHZxtMcRT5xmIZZjLLiOM"),
            (
                PURPOSE_CACHE_SAVE,
                r"C:\Users\测试 用户\AppData\Roaming\Amber\media\第 1 讲 (2).mp4",
                1_767_226_500_000,
                "pVNVlwJu7bPMB5W5GafJ4Q5kTVcjaLhy4pwBPlUpLqI",
            ),
        ];
        for (purpose, path, expires_at, sig) in vectors {
            let grant = sign(&key, purpose, path, expires_at);
            assert_eq!(grant.sig, sig, "{purpose}");
            assert_eq!(verify(&key, &grant, purpose, expires_at - 1), Ok(()));
        }
    }

    /// The wire names of the content pack purposes, as the sidecar's verifier expects them.
    #[test]
    fn names_the_content_pack_purposes() {
        assert_eq!(PURPOSE_PACK_OUTPUT, "pack_output");
        assert_eq!(PURPOSE_PACK_INPUT, "pack_input");
        assert_eq!(PURPOSE_PACK_ORIGINALS_DIR, "pack_originals_dir");
        let key = key();
        let grant = issue(&key, PURPOSE_PACK_INPUT, r"D:\资料\第 1 讲.amberpack", 1_000);
        assert_eq!(verify(&key, &grant, PURPOSE_PACK_INPUT, 1_000), Ok(()));
        assert!(verify(&key, &grant, PURPOSE_PACK_OUTPUT, 1_000).is_err());
        assert!(verify(&key, &grant, PURPOSE_RESTORE_ARCHIVE, 1_000).is_err());
    }

    #[test]
    fn issues_grants_valid_for_the_ttl() {
        let key = key();
        let grant = issue(&key, PURPOSE_RELINK, "/a", 1_000);
        assert_eq!(grant.expires_at, 1_000 + FILE_GRANT_TTL_MS);
        assert_eq!(verify(&key, &grant, PURPOSE_RELINK, 1_000), Ok(()));
    }

    #[test]
    fn serializes_with_the_wire_field_names() {
        let grant = sign(&key(), PURPOSE_LOCAL_FILE, "/a", 5);
        let json = serde_json::to_value(&grant).unwrap();
        assert_eq!(json["expiresAt"], 5);
        assert_eq!(json["purpose"], "local_file");
        let parsed: FileGrant = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, grant);
    }

    #[test]
    fn rejects_tampered_grants() {
        let key = key();
        let now = 1_767_225_600_000;
        let grant = issue(&key, PURPOSE_BURN_OUTPUT, r"C:\data\assets\a1", now);

        let mut other_path = grant.clone();
        other_path.path = r"C:\Windows\System32\config\SAM".to_owned();
        assert!(verify(&key, &other_path, PURPOSE_BURN_OUTPUT, now).is_err());

        let mut other_purpose = grant.clone();
        other_purpose.purpose = PURPOSE_LOCAL_FILE.to_owned();
        assert!(verify(&key, &other_purpose, PURPOSE_LOCAL_FILE, now).is_err());
        assert!(verify(&key, &grant, PURPOSE_LOCAL_FILE, now).is_err());

        let mut other_expiry = grant.clone();
        other_expiry.expires_at -= 1;
        assert!(verify(&key, &other_expiry, PURPOSE_BURN_OUTPUT, now).is_err());

        let mut other_sig = grant.clone();
        other_sig.sig.replace_range(0..1, if other_sig.sig.starts_with('A') { "B" } else { "A" });
        assert!(verify(&key, &other_sig, PURPOSE_BURN_OUTPUT, now).is_err());

        let mut malformed = grant.clone();
        malformed.sig = "not base64!".to_owned();
        assert!(verify(&key, &malformed, PURPOSE_BURN_OUTPUT, now).is_err());

        let wrong_key = [7u8; 32];
        assert!(verify(&wrong_key, &grant, PURPOSE_BURN_OUTPUT, now).is_err());
    }

    #[test]
    fn rejects_expired_and_far_future_grants() {
        let key = key();
        let now = 1_767_225_600_000;
        let grant = issue(&key, PURPOSE_BURN_OUTPUT, "/a", now);
        assert!(verify(&key, &grant, PURPOSE_BURN_OUTPUT, grant.expires_at).is_err());
        assert!(verify(&key, &grant, PURPOSE_BURN_OUTPUT, grant.expires_at + 1).is_err());
        let future = sign(&key, PURPOSE_BURN_OUTPUT, "/a", now + FILE_GRANT_TTL_MS + 1);
        assert!(verify(&key, &future, PURPOSE_BURN_OUTPUT, now).is_err());
        let at_limit = sign(&key, PURPOSE_BURN_OUTPUT, "/a", now + FILE_GRANT_TTL_MS);
        assert_eq!(verify(&key, &at_limit, PURPOSE_BURN_OUTPUT, now), Ok(()));
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let mut bytes = [0u8; 8];
            crate::sidecar::fill_random(&mut bytes).unwrap();
            let dir = std::env::temp_dir().join(format!("amber-{name}-{}", base64url(&bytes)));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_files_inside_the_assets_directory() {
        let temp = TempDir::new("grant-inside");
        let assets = temp.0.join("data").join("assets");
        fs::create_dir_all(assets.join("u1").join("c1")).unwrap();
        let file = assets.join("u1").join("c1").join("a1");
        fs::write(&file, b"mp4").unwrap();

        let resolved = resolve_inside(&assets, &file).unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());
        // A detour through `..` that lands back inside is still inside.
        let detour = assets.join("u1").join("..").join("u1").join("c1").join("a1");
        assert!(resolve_inside(&assets, &detour).is_ok());
    }

    #[test]
    fn rejects_paths_outside_the_assets_directory() {
        let temp = TempDir::new("grant-outside");
        let data = temp.0.join("data");
        let assets = data.join("assets");
        let sibling = data.join("assets-other");
        fs::create_dir_all(&assets).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(data.join("database.sqlite"), b"db").unwrap();
        fs::write(sibling.join("a1"), b"x").unwrap();

        // `..` escape from inside the assets directory.
        assert!(resolve_inside(&assets, &assets.join("..").join("database.sqlite")).is_err());
        // A sibling whose name merely starts with "assets".
        assert!(resolve_inside(&assets, &sibling.join("a1")).is_err());
        // The root itself and directories are not files to copy.
        assert!(resolve_inside(&assets, &assets).is_err());
        fs::create_dir_all(assets.join("u1")).unwrap();
        assert!(resolve_inside(&assets, &assets.join("u1")).is_err());
        // Missing files cannot be canonicalized.
        assert!(resolve_inside(&assets, &assets.join("missing")).is_err());
        // Another root entirely.
        let elsewhere = TempDir::new("grant-elsewhere");
        fs::write(elsewhere.0.join("a1"), b"x").unwrap();
        assert!(resolve_inside(&assets, &elsewhere.0.join("a1")).is_err());
        #[cfg(windows)]
        {
            let other_drive = if assets.to_string_lossy().starts_with('C') { r"D:\a1" } else { r"C:\a1" };
            assert!(resolve_inside(&assets, Path::new(other_drive)).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        let temp = TempDir::new("grant-symlink");
        let assets = temp.0.join("assets");
        fs::create_dir_all(&assets).unwrap();
        fs::write(temp.0.join("secret"), b"x").unwrap();
        std::os::unix::fs::symlink(temp.0.join("secret"), assets.join("link")).unwrap();
        assert!(resolve_inside(&assets, &assets.join("link")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_symlink_escapes() {
        let temp = TempDir::new("grant-symlink");
        let assets = temp.0.join("assets");
        fs::create_dir_all(&assets).unwrap();
        fs::create_dir_all(temp.0.join("outside")).unwrap();
        fs::write(temp.0.join("outside").join("secret"), b"x").unwrap();
        // A directory junction needs no privilege, unlike a symlink.
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(assets.join("junction"))
            .arg(temp.0.join("outside"))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(resolve_inside(&assets, &assets.join("junction").join("secret")).is_err());
    }
}
