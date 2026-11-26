//! Downloading and installing an update found by the updater plugin's `check`.
//!
//! The plugin's own download holds the whole installer in one request with no resume and no
//! stall detection, so on an unstable network a single drop loses everything downloaded so
//! far. Here the bytes are fetched with resumable requests, kept across calls for the same
//! update, verified exactly as the plugin would, and handed to the plugin's installer.

mod signature;
mod transfer;

#[cfg(test)]
mod test_server;

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, ResourceId, State, Url, Webview};
use tauri_plugin_updater::Update;

use crate::defaults::{UPDATE_DOWNLOAD_RETRY_BASE_MS, UPDATE_DOWNLOAD_RETRY_MAX, UPDATE_DOWNLOAD_STALL_MS};
use transfer::{Partial, Policy, Source};

/// Progress reported to the page. `Resumed` carries the absolute number of bytes held: sent
/// at the start when earlier bytes are continued, and with 0 when the server forces a restart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "PascalCase")]
pub enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Resumed { downloaded: u64 },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: u64 },
    #[serde(rename_all = "camelCase")]
    Retrying { attempt: u32, delay_ms: u64 },
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// Gave up after bytes had arrived in this call; the bytes are kept for the next call.
    Interrupted,
    /// Gave up without receiving a byte in this call.
    Unreachable,
    /// The server refused (4xx) or kept failing (5xx).
    Server,
    /// The file does not match its signature or announced size; nothing is kept.
    Integrity,
    /// Another download is running.
    Busy,
    Other,
}

/// The command error. `attempts` counts reconnects made in this call; `detail` is the
/// underlying error with URL queries and credentials removed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadError {
    pub kind: FailureKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub attempts: u32,
    pub detail: String,
}

impl UpdateDownloadError {
    fn new(kind: FailureKind, detail: impl Into<String>) -> Self {
        Self { kind, status: None, attempts: 0, detail: detail.into() }
    }
}

/// Identifies one announced update: held bytes only continue a download of the same file.
#[derive(Clone, Debug, PartialEq, Eq)]
struct UpdateKey {
    version: String,
    url: Url,
}

impl UpdateKey {
    fn of(update: &Update) -> Self {
        Self { version: update.version.clone(), url: update.download_url.clone() }
    }
}

#[derive(Default)]
struct Slot {
    busy: bool,
    held: Option<(UpdateKey, Partial)>,
    verified: Option<(UpdateKey, Vec<u8>)>,
}

/// Managed state: at most one download at a time, the bytes of an unfinished download, and
/// the verified installer waiting for `update_install`.
#[derive(Default)]
pub struct UpdateDownloads {
    slot: Mutex<Slot>,
}

enum Claim<'a> {
    Busy,
    /// The installer for this update is already downloaded and verified; holds its size.
    Verified(u64),
    Lease(Lease<'a>),
}

/// The right to run the download; returns unfinished bytes to the state when dropped, so they
/// survive an error return as well as a completed call.
struct Lease<'a> {
    owner: &'a UpdateDownloads,
    key: UpdateKey,
    partial: Partial,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut slot = self.owner.lock();
        slot.busy = false;
        if !self.partial.bytes.is_empty() {
            slot.held = Some((self.key.clone(), std::mem::take(&mut self.partial)));
        }
    }
}

impl UpdateDownloads {
    fn lock(&self) -> MutexGuard<'_, Slot> {
        // The slot stays consistent at every unlock, so a panic elsewhere does not poison it.
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn claim(&self, key: &UpdateKey) -> Claim<'_> {
        let mut slot = self.lock();
        if slot.busy {
            return Claim::Busy;
        }
        if let Some((verified_key, bytes)) = &slot.verified {
            if verified_key == key {
                return Claim::Verified(bytes.len() as u64);
            }
            // A different update was announced since: its installer is of no further use.
            slot.verified = None;
        }
        let partial = match slot.held.take() {
            Some((held_key, partial)) if held_key == *key => partial,
            _ => Partial::default(),
        };
        slot.busy = true;
        Claim::Lease(Lease { owner: self, key: key.clone(), partial })
    }

    fn store_verified(&self, key: UpdateKey, bytes: Vec<u8>) {
        self.lock().verified = Some((key, bytes));
    }

    fn take_verified(&self, key: &UpdateKey) -> Option<Vec<u8>> {
        let mut slot = self.lock();
        match &slot.verified {
            Some((verified_key, _)) if verified_key == key => slot.verified.take().map(|(_, bytes)| bytes),
            _ => None,
        }
    }
}

/// Downloads (or continues) the update and verifies it, keeping the result for install.
async fn run<F, V>(
    downloads: &UpdateDownloads,
    key: UpdateKey,
    source: &Source,
    policy: Policy,
    verify: V,
    emit: &mut F,
) -> Result<(), UpdateDownloadError>
where
    F: FnMut(UpdateDownloadEvent) + Send,
    V: FnOnce(&[u8]) -> Result<(), String> + Send,
{
    let mut lease = match downloads.claim(&key) {
        Claim::Busy => return Err(UpdateDownloadError::new(FailureKind::Busy, "another update download is running")),
        Claim::Verified(size) => {
            emit(UpdateDownloadEvent::Started { content_length: Some(size) });
            emit(UpdateDownloadEvent::Resumed { downloaded: size });
            emit(UpdateDownloadEvent::Finished);
            return Ok(());
        }
        Claim::Lease(lease) => lease,
    };
    let attempts = transfer::fetch(source, policy, &mut lease.partial, emit).await?;
    // Whatever the verdict, these bytes are not resumable: either they verify and move to
    // the installer slot, or they are discarded.
    let bytes = std::mem::take(&mut lease.partial.bytes);
    lease.partial.clear();
    if let Err(detail) = verify(&bytes) {
        return Err(UpdateDownloadError { kind: FailureKind::Integrity, status: None, attempts, detail });
    }
    downloads.store_verified(key, bytes);
    drop(lease);
    emit(UpdateDownloadEvent::Finished);
    Ok(())
}

fn production_policy() -> Policy {
    Policy {
        stall: Duration::from_millis(UPDATE_DOWNLOAD_STALL_MS),
        retry_max: UPDATE_DOWNLOAD_RETRY_MAX,
        retry_base: Duration::from_millis(UPDATE_DOWNLOAD_RETRY_BASE_MS),
    }
}

/// The updater plugin's `pubkey` and `requireSignedVersion` settings.
fn signing_config(webview: &Webview) -> Result<(String, bool), String> {
    let config = webview.config();
    let updater = config.plugins.0.get("updater");
    let pubkey = updater
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|value| value.as_str())
        .ok_or("updater public key is not configured")?;
    let require_signed_version = updater
        .and_then(|updater| updater.get("requireSignedVersion").or_else(|| updater.get("require-signed-version")))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    Ok((pubkey.to_string(), require_signed_version))
}

fn find_update(webview: &Webview, rid: ResourceId) -> Result<std::sync::Arc<Update>, String> {
    webview.resources_table().get::<Update>(rid).map_err(|error| format!("unknown update: {error}"))
}

/// Downloads the update `check` returned (`rid`), resuming bytes kept from an earlier call.
#[tauri::command]
pub async fn update_download(
    webview: Webview,
    downloads: State<'_, UpdateDownloads>,
    rid: ResourceId,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<(), UpdateDownloadError> {
    let update = find_update(&webview, rid).map_err(|detail| UpdateDownloadError::new(FailureKind::Other, detail))?;
    let (public_key, require_signed_version) =
        signing_config(&webview).map_err(|detail| UpdateDownloadError::new(FailureKind::Other, detail))?;
    // The plugin's `timeout` is deliberately not applied: it bounds the whole request, which a
    // large installer on a slow link exceeds; the stall watchdog bounds silence instead.
    let source = Source {
        url: update.download_url.clone(),
        headers: update.headers.clone(),
        proxy: update.proxy.clone(),
        no_proxy: update.no_proxy,
        user_agent: format!("Amber/{}", webview.package_info().version),
    };
    let release_signature = update.signature.clone();
    let version = update.version.clone();
    let verify =
        move |bytes: &[u8]| signature::verify(bytes, &release_signature, &public_key, &version, require_signed_version);
    let mut emit = |event: UpdateDownloadEvent| {
        let _ = on_event.send(event);
    };
    run(&downloads, UpdateKey::of(&update), &source, production_policy(), verify, &mut emit).await
}

/// Runs the installer verified by `update_download` for the same update. On Windows the
/// plugin starts the installer and exits the app.
#[tauri::command]
pub async fn update_install(
    webview: Webview,
    downloads: State<'_, UpdateDownloads>,
    rid: ResourceId,
) -> Result<(), String> {
    let update = find_update(&webview, rid)?;
    let key = UpdateKey::of(&update);
    let bytes = downloads.take_verified(&key).ok_or("the update has not been downloaded and verified")?;
    if let Err(error) = update.install(&bytes) {
        // Keep the installer so a retry does not download it again.
        downloads.store_verified(key, bytes);
        return Err(format!("installing the update failed: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::test_server::{Reply, TestServer};
    use super::*;
    use reqwest::header::HeaderMap;

    fn policy() -> Policy {
        Policy { stall: Duration::from_millis(150), retry_max: 1, retry_base: Duration::from_millis(5) }
    }

    fn key(version: &str, url: &Url) -> UpdateKey {
        UpdateKey { version: version.into(), url: url.clone() }
    }

    fn source(url: &Url) -> Source {
        Source { url: url.clone(), headers: HeaderMap::new(), proxy: None, no_proxy: true, user_agent: "amber-test".into() }
    }

    fn download(
        downloads: &UpdateDownloads,
        key: UpdateKey,
        source: &Source,
        verdict: Result<(), String>,
    ) -> (Result<(), UpdateDownloadError>, Vec<UpdateDownloadEvent>) {
        let mut events = Vec::new();
        let result = tauri::async_runtime::block_on(run(
            downloads,
            key,
            source,
            policy(),
            move |_| verdict,
            &mut |event| events.push(event),
        ));
        (result, events)
    }

    fn body() -> Vec<u8> {
        (0..20_000u32).map(|index| (index % 253) as u8).collect()
    }

    #[test]
    fn serializes_the_page_contract() {
        let json = |event| serde_json::to_value(event).unwrap();
        assert_eq!(
            json(UpdateDownloadEvent::Started { content_length: Some(3) }),
            serde_json::json!({ "event": "Started", "data": { "contentLength": 3 } })
        );
        assert_eq!(
            json(UpdateDownloadEvent::Retrying { attempt: 2, delay_ms: 2000 }),
            serde_json::json!({ "event": "Retrying", "data": { "attempt": 2, "delayMs": 2000 } })
        );
        assert_eq!(
            json(UpdateDownloadEvent::Progress { chunk_length: 9 }),
            serde_json::json!({ "event": "Progress", "data": { "chunkLength": 9 } })
        );
        assert_eq!(json(UpdateDownloadEvent::Finished), serde_json::json!({ "event": "Finished" }));
        let error = UpdateDownloadError { kind: FailureKind::Server, status: Some(404), attempts: 0, detail: "x".into() };
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "kind": "server", "status": 404, "attempts": 0, "detail": "x" })
        );
        let busy = UpdateDownloadError::new(FailureKind::Busy, "y");
        assert_eq!(
            serde_json::to_value(&busy).unwrap(),
            serde_json::json!({ "kind": "busy", "attempts": 0, "detail": "y" })
        );
    }

    #[test]
    fn a_second_call_continues_the_same_update_and_a_new_one_starts_over() {
        let data = body();
        let server = TestServer::start(data.clone());
        server.script([Reply::CutAfter(4000), Reply::StallBeforeHeaders]);
        let url = server.url("/file");
        let downloads = UpdateDownloads::default();

        let (first, _) = download(&downloads, key("1.0.0", &url), &source(&url), Ok(()));
        assert_eq!(first.unwrap_err().kind, FailureKind::Interrupted);

        let (second, events) = download(&downloads, key("1.0.0", &url), &source(&url), Ok(()));
        second.unwrap();
        assert_eq!(events[1], UpdateDownloadEvent::Resumed { downloaded: 4000 });
        assert_eq!(events.last(), Some(&UpdateDownloadEvent::Finished));
        assert_eq!(server.requests()[2].range.as_deref(), Some("bytes=4000-"));
        assert_eq!(downloads.take_verified(&key("1.0.0", &url)), Some(data));

        server.script([Reply::CutAfter(4000), Reply::StallBeforeHeaders]);
        let (_, _) = download(&downloads, key("1.0.0", &url), &source(&url), Ok(()));
        let (other, events) = download(&downloads, key("1.0.1", &url), &source(&url), Ok(()));
        other.unwrap();
        assert!(!events.iter().any(|event| matches!(event, UpdateDownloadEvent::Resumed { .. })));
        assert_eq!(server.requests().last().unwrap().range, None);
    }

    #[test]
    fn a_verified_installer_is_not_downloaded_again() {
        let server = TestServer::start(body());
        let url = server.url("/file");
        let downloads = UpdateDownloads::default();
        download(&downloads, key("1.0.0", &url), &source(&url), Ok(())).0.unwrap();
        let (again, events) = download(&downloads, key("1.0.0", &url), &source(&url), Ok(()));
        again.unwrap();
        assert_eq!(server.requests().len(), 1);
        let size = body().len() as u64;
        assert_eq!(
            events,
            [
                UpdateDownloadEvent::Started { content_length: Some(size) },
                UpdateDownloadEvent::Resumed { downloaded: size },
                UpdateDownloadEvent::Finished
            ]
        );
        assert!(downloads.take_verified(&key("1.0.1", &url)).is_none());
        assert!(downloads.take_verified(&key("1.0.0", &url)).is_some());
    }

    #[test]
    fn a_failed_verification_discards_everything() {
        let server = TestServer::start(body());
        let url = server.url("/file");
        let downloads = UpdateDownloads::default();
        let (result, events) = download(&downloads, key("1.0.0", &url), &source(&url), Err("bad signature".into()));
        let error = result.unwrap_err();
        assert_eq!((error.kind, error.detail.as_str()), (FailureKind::Integrity, "bad signature"));
        assert!(!events.contains(&UpdateDownloadEvent::Finished));
        assert!(downloads.take_verified(&key("1.0.0", &url)).is_none());

        let (retry, events) = download(&downloads, key("1.0.0", &url), &source(&url), Ok(()));
        retry.unwrap();
        assert!(!events.iter().any(|event| matches!(event, UpdateDownloadEvent::Resumed { .. })));
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn a_concurrent_call_is_busy() {
        let url = Url::parse("http://127.0.0.1:9/file").unwrap();
        let downloads = UpdateDownloads::default();
        let Claim::Lease(lease) = downloads.claim(&key("1.0.0", &url)) else { panic!("first claim must lease") };
        let (result, events) = download(&downloads, key("1.0.0", &url), &source(&url), Ok(()));
        assert_eq!(result.unwrap_err().kind, FailureKind::Busy);
        assert!(events.is_empty());
        drop(lease);
        assert!(matches!(downloads.claim(&key("1.0.0", &url)), Claim::Lease(_)));
    }
}
