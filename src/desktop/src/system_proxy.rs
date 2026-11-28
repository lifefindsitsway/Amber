//! The current user's Windows system proxy, read by the shell and handed to the sidecar.
//!
//! Only Windows builds read anything: `WinHttpGetIEProxyConfigForCurrentUser` is called once
//! at start and then every `SYSTEM_PROXY_POLL_MS`. Each read is reduced to a small
//! configuration the sidecar understands (off / manual / unsupported / error) and, when it
//! differs from the last one sent, wrapped in a message with a strictly increasing `seq`.
//! The sidecar receives the current message in `AMBER_SYSTEM_PROXY` when it is spawned and
//! every later change as one JSON line on its stdin.
//!
//! The shell does not route anything itself: reading, reducing and passing on is all it does.
//! Which request goes direct, through the proxy or is refused is decided in the sidecar.
//!
//! Stdin of a sidecar is owned by one writer thread per process. The poll thread only
//! replaces the pending line in that writer's slot and never blocks on the pipe, so a sidecar
//! that stops reading stdin cannot stall polling or the supervisor; the writer always sends
//! the newest line and drops the ones it never got to.

// Only Windows builds poll; elsewhere the reading side is exercised by the tests alone.
#![cfg_attr(not(windows), allow(dead_code))]

use std::io::Write;
use std::net::Ipv6Addr;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;

use serde::Serialize;

use crate::defaults::{SYSTEM_PROXY_BYPASS_MAX_ENTRIES, SYSTEM_PROXY_MESSAGE_MAX_BYTES};

/// Environment variable carrying the message current when the sidecar is spawned; its
/// presence puts the sidecar in system proxy mode.
pub const ENV_VAR: &str = "AMBER_SYSTEM_PROXY";
const MESSAGE_VERSION: u8 = 1;
const MESSAGE_TYPE: &str = "system_proxy";
/// Upper bound on the UTF-16 units read from one returned string. The values come from the
/// user's registry and are tiny in practice; the bound only keeps a missing terminator from
/// turning into an unbounded read.
const MAX_WIDE_UNITS: usize = 1 << 16;
/// DNS names are at most 253 characters.
const MAX_HOST_LEN: usize = 253;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyState {
    Off,
    Manual,
    Unsupported,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyReason {
    Pac,
    Socks,
    Unparsable,
    ReadFailed,
}

/// The reduced configuration as the sidecar receives it. `http` / `https` are `host:port`
/// without credentials; a protocol without an entry goes direct.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub state: ProxyState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ProxyReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub https: Option<String>,
    pub bypass: Vec<String>,
    /// A PAC script is set next to the manual proxy and is ignored.
    #[serde(skip_serializing_if = "is_false")]
    pub pac_ignored: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ProxyConfig {
    fn off() -> Self {
        Self { state: ProxyState::Off, reason: None, http: None, https: None, bypass: Vec::new(), pac_ignored: false }
    }

    fn unsupported(reason: ProxyReason, bypass: Vec<String>) -> Self {
        Self { state: ProxyState::Unsupported, reason: Some(reason), bypass, ..Self::off() }
    }
}

#[derive(Serialize)]
struct Message<'a> {
    v: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    seq: u64,
    config: &'a ProxyConfig,
}

/// The message as one JSON object without the trailing newline.
pub fn message_json(seq: u64, config: &ProxyConfig) -> String {
    serde_json::to_string(&Message { v: MESSAGE_VERSION, kind: MESSAGE_TYPE, seq, config })
        .unwrap_or_else(|_| unreachable!("the message holds only strings, numbers and booleans"))
}

/// A string returned by the system: text, or units that are not valid UTF-16 or have no
/// terminator within `MAX_WIDE_UNITS`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WideText {
    Text(String),
    Invalid,
}

/// One successful read, with the strings already copied out and released.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct RawSettings {
    /// "Automatically detect settings" (WPAD); on by default in Windows and not supported.
    pub auto_detect: bool,
    pub auto_config_url: Option<WideText>,
    pub proxy: Option<WideText>,
    pub bypass: Option<WideText>,
}

/// Why a read produced no settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// The call failed with this system error code.
    Failed(u32),
}

/// What one read gave: settings, the documented "no proxy settings can be found" outcome
/// (nothing configured, the same as no proxy), or a failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    Settings(RawSettings),
    NoSettings,
    Failed(ReadError),
}

fn wide_text(text: Option<&WideText>) -> Option<Result<&str, ()>> {
    match text? {
        WideText::Text(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then_some(Ok(trimmed))
        }
        WideText::Invalid => Some(Err(())),
    }
}

/// Reduces one successful read.
pub fn normalize(raw: &RawSettings) -> ProxyConfig {
    let pac = wide_text(raw.auto_config_url.as_ref()).is_some();
    let bypass = match wide_text(raw.bypass.as_ref()) {
        None => Ok(Vec::new()),
        Some(Ok(text)) => Ok(parse_bypass(text)),
        Some(Err(())) => Err(()),
    };
    // Exceptions still apply under a refused configuration, so they travel with it; an
    // exception list that cannot be decoded makes the whole configuration unparsable.
    let Ok(bypass) = bypass else {
        return ProxyConfig::unsupported(ProxyReason::Unparsable, Vec::new());
    };
    let config = match wide_text(raw.proxy.as_ref()) {
        Some(Ok(text)) => match parse_proxy_server(text) {
            ProxyServer::Unparsable => ProxyConfig::unsupported(ProxyReason::Unparsable, bypass),
            ProxyServer::SocksOnly => ProxyConfig::unsupported(ProxyReason::Socks, bypass),
            ProxyServer::Manual { http, https } => {
                ProxyConfig { state: ProxyState::Manual, reason: None, http, https, bypass, pac_ignored: pac }
            }
        },
        Some(Err(())) => ProxyConfig::unsupported(ProxyReason::Unparsable, bypass),
        None if pac => ProxyConfig::unsupported(ProxyReason::Pac, bypass),
        // Only automatic detection, or nothing at all: automatic discovery is not supported.
        None => ProxyConfig::off(),
    };
    fit_message_budget(config)
}

/// The configuration sent after a failed read: the last successfully read one is kept and
/// marked, so requests keep their route. Without one the sidecar must not let anything out,
/// so the result is unsupported, as is a failure after an unsupported configuration (the
/// state cannot carry both reasons, and either way requests are refused).
fn after_read_failure(last_good: Option<&ProxyConfig>) -> ProxyConfig {
    match last_good {
        None => ProxyConfig::unsupported(ProxyReason::ReadFailed, Vec::new()),
        Some(last) if last.state == ProxyState::Unsupported => {
            ProxyConfig { reason: Some(ProxyReason::ReadFailed), ..last.clone() }
        }
        Some(last) => ProxyConfig { state: ProxyState::Error, reason: Some(ProxyReason::ReadFailed), ..last.clone() },
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProxyServer {
    Manual { http: Option<String>, https: Option<String> },
    SocksOnly,
    Unparsable,
}

/// `ProxyServer` is either one address used for every protocol (`host:port`, optionally
/// prefixed with `http://`) or per-protocol entries (`http=…;https=…;socks=…`), separated by
/// semicolons or whitespace. Anything else, a mix of both forms, a repeated protocol or an
/// unknown one is unparsable: the sidecar then refuses instead of guessing.
fn parse_proxy_server(text: &str) -> ProxyServer {
    let tokens: Vec<&str> = text.split(|c: char| c == ';' || c.is_whitespace()).filter(|token| !token.is_empty()).collect();
    if tokens.iter().all(|token| !token.contains('=')) {
        return match tokens.as_slice() {
            [single] => match proxy_address(single) {
                Some(address) => ProxyServer::Manual { http: Some(address.clone()), https: Some(address) },
                None => ProxyServer::Unparsable,
            },
            _ => ProxyServer::Unparsable,
        };
    }
    let (mut http, mut https, mut socks) = (None, None, false);
    let (mut seen_http, mut seen_https, mut seen_socks) = (false, false, false);
    for token in tokens {
        let Some((scheme, value)) = token.split_once('=') else {
            return ProxyServer::Unparsable;
        };
        let (seen, target) = match scheme.to_ascii_lowercase().as_str() {
            "http" => (&mut seen_http, Some(&mut http)),
            "https" => (&mut seen_https, Some(&mut https)),
            "socks" => (&mut seen_socks, None),
            // Protocols Amber never requests; Windows writes them when the user fills them in.
            "ftp" | "gopher" => continue,
            _ => return ProxyServer::Unparsable,
        };
        if *seen {
            return ProxyServer::Unparsable;
        }
        *seen = true;
        if value.is_empty() {
            continue;
        }
        match target {
            Some(slot) => match proxy_address(value) {
                Some(address) => *slot = Some(address),
                None => return ProxyServer::Unparsable,
            },
            None => socks = true,
        }
    }
    if http.is_some() || https.is_some() {
        ProxyServer::Manual { http, https }
    } else if socks {
        ProxyServer::SocksOnly
    } else {
        ProxyServer::Unparsable
    }
}

/// `host:port` of an http proxy, the host lowercased and an IPv6 host kept in brackets.
/// Credentials, paths, a scheme other than `http://`, a missing or invalid port and
/// non-ASCII host names are refused.
fn proxy_address(value: &str) -> Option<String> {
    let rest = match value.find("://") {
        Some(index) if value[..index].eq_ignore_ascii_case("http") => &value[index + 3..],
        Some(_) => return None,
        None => value,
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains(['@', '/', '\\', '?', '#']) {
        return None;
    }
    let (host, port) = if let Some(bracketed) = rest.strip_prefix('[') {
        let (address, tail) = bracketed.split_once(']')?;
        let address: Ipv6Addr = address.parse().ok()?;
        (format!("[{address}]"), tail.strip_prefix(':')?)
    } else {
        let (host, port) = rest.rsplit_once(':')?;
        let valid = !host.is_empty()
            && host.len() <= MAX_HOST_LEN
            && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
        if !valid {
            return None;
        }
        (host.to_ascii_lowercase(), port)
    };
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok().filter(|port| *port != 0)?;
    Some(format!("{host}:{port}"))
}

/// Entries split on `;` and trimmed, empty ones dropped, at most
/// `SYSTEM_PROXY_BYPASS_MAX_ENTRIES`; matching them is the sidecar's job.
fn parse_bypass(text: &str) -> Vec<String> {
    text.split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .take(SYSTEM_PROXY_BYPASS_MAX_ENTRIES)
        .map(str::to_owned)
        .collect()
}

/// Drops trailing bypass entries until the line, with its newline and the longest possible
/// `seq`, fits in `SYSTEM_PROXY_MESSAGE_MAX_BYTES`; the sidecar discards longer lines.
fn fit_message_budget(mut config: ProxyConfig) -> ProxyConfig {
    let entries = std::mem::take(&mut config.bypass);
    // The empty list is already in the base length as `[]`; every entry adds its encoded
    // length and, after the first, a comma.
    let mut total = message_json(u64::MAX, &config).len() + 1;
    let mut keep = 0;
    for (index, entry) in entries.iter().enumerate() {
        let added = serde_json::to_string(entry).map_or(usize::MAX, |encoded| encoded.len()) + usize::from(index > 0);
        if total.saturating_add(added) > SYSTEM_PROXY_MESSAGE_MAX_BYTES {
            break;
        }
        total += added;
        keep += 1;
    }
    config.bypass = entries;
    config.bypass.truncate(keep);
    config
}

/// Turns reads into messages: a new `seq` only when the reduced configuration changed.
#[derive(Default)]
pub struct Tracker {
    seq: u64,
    sent: Option<ProxyConfig>,
    last_good: Option<ProxyConfig>,
}

impl Tracker {
    /// The new `(seq, message)` when this read changes what the sidecar should know.
    pub fn observe(&mut self, outcome: &ReadOutcome) -> Option<(u64, String)> {
        let config = match outcome {
            ReadOutcome::Settings(raw) => {
                let config = normalize(raw);
                self.last_good = Some(config.clone());
                config
            }
            ReadOutcome::NoSettings => {
                self.last_good = Some(ProxyConfig::off());
                ProxyConfig::off()
            }
            ReadOutcome::Failed(_) => after_read_failure(self.last_good.as_ref()),
        };
        if self.sent.as_ref() == Some(&config) {
            return None;
        }
        self.seq += 1;
        let message = message_json(self.seq, &config);
        self.sent = Some(config);
        Some((self.seq, message))
    }
}

/// The pointers one call to the system hands back; every non-null one must be freed.
#[derive(Debug)]
pub struct RawPointers {
    pub auto_detect: bool,
    pub auto_config_url: *mut u16,
    pub proxy: *mut u16,
    pub bypass: *mut u16,
}

impl Default for RawPointers {
    fn default() -> Self {
        Self {
            auto_detect: false,
            auto_config_url: std::ptr::null_mut(),
            proxy: std::ptr::null_mut(),
            bypass: std::ptr::null_mut(),
        }
    }
}

/// The two system calls involved, behind a trait so tests can count the releases.
pub trait ProxyApi {
    /// Fills `out`; any pointer it sets is released by the caller, also on failure.
    fn query(&self, out: &mut RawPointers) -> Result<(), QueryError>;
    /// Releases one string `query` returned.
    ///
    /// # Safety
    /// `ptr` is non-null, came from `query` on this API and is released only once.
    unsafe fn free(&self, ptr: *mut u16);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryError {
    NoSettings,
    Failed(u32),
}

/// Releases one returned string when dropped, on every path out of `read_with`.
struct ReturnedString<'a, A: ProxyApi + ?Sized> {
    api: &'a A,
    ptr: *mut u16,
}

impl<A: ProxyApi + ?Sized> ReturnedString<'_, A> {
    fn text(&self) -> Option<WideText> {
        if self.ptr.is_null() {
            return None;
        }
        let mut units = Vec::new();
        for offset in 0..MAX_WIDE_UNITS {
            // SAFETY: the pointer is a NUL-terminated string from the system that stays
            // allocated until this guard drops; reading stops at the terminator.
            let unit = unsafe { *self.ptr.add(offset) };
            if unit == 0 {
                return Some(String::from_utf16(&units).map_or(WideText::Invalid, WideText::Text));
            }
            units.push(unit);
        }
        Some(WideText::Invalid)
    }
}

impl<A: ProxyApi + ?Sized> Drop for ReturnedString<'_, A> {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            // SAFETY: non-null, returned by `query` on this API, owned only by this guard.
            unsafe { self.api.free(self.ptr) };
        }
    }
}

/// One read through `api`, with every returned string released before returning.
pub fn read_with<A: ProxyApi + ?Sized>(api: &A) -> ReadOutcome {
    let mut out = RawPointers::default();
    let result = api.query(&mut out);
    let auto_config_url = ReturnedString { api, ptr: out.auto_config_url };
    let proxy = ReturnedString { api, ptr: out.proxy };
    let bypass = ReturnedString { api, ptr: out.bypass };
    match result {
        Err(QueryError::NoSettings) => ReadOutcome::NoSettings,
        Err(QueryError::Failed(code)) => ReadOutcome::Failed(ReadError::Failed(code)),
        Ok(()) => ReadOutcome::Settings(RawSettings {
            auto_detect: out.auto_detect,
            auto_config_url: auto_config_url.text(),
            proxy: proxy.text(),
            bypass: bypass.text(),
        }),
    }
}

#[cfg(windows)]
mod winhttp {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, GetLastError, GlobalFree};
    use windows_sys::Win32::Networking::WinHttp::{WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WinHttpGetIEProxyConfigForCurrentUser};

    use super::{ProxyApi, QueryError, RawPointers};

    pub struct WinHttp;

    impl ProxyApi for WinHttp {
        fn query(&self, out: &mut RawPointers) -> Result<(), QueryError> {
            let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
            // SAFETY: a zeroed, writable structure of the documented layout.
            let ok = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } != 0;
            // Read before anything else can overwrite the thread's last error.
            // SAFETY: no preconditions.
            let error = if ok { 0 } else { unsafe { GetLastError() } };
            *out = RawPointers {
                auto_detect: config.fAutoDetect != 0,
                auto_config_url: config.lpszAutoConfigUrl,
                proxy: config.lpszProxy,
                bypass: config.lpszProxyBypass,
            };
            match (ok, error) {
                (true, _) => Ok(()),
                (false, ERROR_FILE_NOT_FOUND) => Err(QueryError::NoSettings),
                (false, code) => Err(QueryError::Failed(code)),
            }
        }

        unsafe fn free(&self, ptr: *mut u16) {
            // SAFETY: the caller guarantees a string the call above returned, freed once;
            // the documentation says to release them with GlobalFree.
            unsafe { GlobalFree(ptr.cast()) };
        }
    }
}

/// The one-slot mailbox between the poll thread and a sidecar's stdin writer.
pub struct WriterSlot {
    state: Mutex<SlotState>,
    wake: Condvar,
}

#[derive(Default)]
struct SlotState {
    pending: Option<String>,
    closing: bool,
}

impl WriterSlot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Replaces the pending line and wakes the writer; never waits for the pipe.
    pub fn submit(&self, line: String) {
        let mut state = self.lock();
        if state.closing {
            return;
        }
        state.pending = Some(line);
        self.wake.notify_one();
    }

    fn close(&self) {
        let mut state = self.lock();
        state.closing = true;
        state.pending = None;
        self.wake.notify_one();
    }
}

/// The sidecar's stdin, owned by its writer thread. Dropping it asks the thread to close
/// stdin, which the sidecar takes as the request to exit. A thread stuck writing to a
/// sidecar that does not read gets out when the process is killed and the pipe breaks.
pub struct StdinWriter {
    slot: Arc<WriterSlot>,
}

impl StdinWriter {
    pub fn spawn<W: Write + Send + 'static>(sink: W) -> Self {
        let slot = Arc::new(WriterSlot { state: Mutex::new(SlotState::default()), wake: Condvar::new() });
        let owned = Arc::clone(&slot);
        thread::spawn(move || write_loop(&owned, sink));
        Self { slot }
    }

    pub fn slot(&self) -> &Arc<WriterSlot> {
        &self.slot
    }
}

impl Drop for StdinWriter {
    fn drop(&mut self) {
        self.slot.close();
    }
}

/// Sends the newest pending line until the slot closes or a write fails (the sidecar is
/// gone); returning drops `sink`, which closes stdin.
fn write_loop<W: Write>(slot: &WriterSlot, mut sink: W) {
    loop {
        let line = {
            let mut state = slot.lock();
            loop {
                if state.closing {
                    return;
                }
                if let Some(line) = state.pending.take() {
                    break line;
                }
                state = slot.wake.wait(state).unwrap_or_else(PoisonError::into_inner);
            }
        };
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        if sink.write_all(&bytes).and_then(|()| sink.flush()).is_err() {
            slot.close();
            return;
        }
    }
}

/// The latest message and the writer of the running sidecar, under a lock of their own so
/// that polling never touches the supervisor's state.
pub struct ProxyFeed {
    state: Mutex<FeedState>,
}

#[derive(Default)]
struct FeedState {
    tracker: Tracker,
    latest: Option<(u64, String)>,
    writer: Weak<WriterSlot>,
}

impl Default for ProxyFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl ProxyFeed {
    pub fn new() -> Self {
        Self { state: Mutex::new(FeedState::default()) }
    }

    fn lock(&self) -> MutexGuard<'_, FeedState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Applies one read; a change goes to the attached writer. Returns whether it changed.
    pub fn observe(&self, outcome: &ReadOutcome) -> bool {
        let mut state = self.lock();
        let Some(message) = state.tracker.observe(outcome) else {
            return false;
        };
        if let Some(writer) = state.writer.upgrade() {
            writer.submit(message.1.clone());
        }
        state.latest = Some(message);
        true
    }

    /// The current `(seq, message)` for the environment of a sidecar about to be spawned.
    pub fn snapshot(&self) -> Option<(u64, String)> {
        self.lock().latest.clone()
    }

    /// Makes `writer` the one changes go to. `sent_seq` is the `seq` its sidecar got in the
    /// environment; a change that landed between that snapshot and now is sent at once.
    pub fn attach(&self, writer: &Arc<WriterSlot>, sent_seq: u64) {
        let mut state = self.lock();
        state.writer = Arc::downgrade(writer);
        if let Some((seq, message)) = &state.latest
            && *seq > sent_seq
        {
            writer.submit(message.clone());
        }
    }
}

/// Reads the system proxy once and keeps polling it every `SYSTEM_PROXY_POLL_MS` on a
/// thread of its own. Only Windows builds read it; elsewhere there is nothing to follow and
/// the sidecar reads the standard proxy variables like any standalone Node.
#[cfg(windows)]
pub fn start() -> Option<Arc<ProxyFeed>> {
    use crate::defaults::SYSTEM_PROXY_POLL_MS;
    let feed = Arc::new(ProxyFeed::new());
    feed.observe(&read_with(&winhttp::WinHttp));
    let polled = Arc::clone(&feed);
    thread::spawn(move || {
        loop {
            thread::sleep(std::time::Duration::from_millis(SYSTEM_PROXY_POLL_MS));
            polled.observe(&read_with(&winhttp::WinHttp));
        }
    });
    Some(feed)
}

#[cfg(not(windows))]
pub fn start() -> Option<Arc<ProxyFeed>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::io;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};

    fn text(value: &str) -> Option<WideText> {
        Some(WideText::Text(value.to_owned()))
    }

    fn manual(proxy: &str, bypass: Option<&str>) -> RawSettings {
        RawSettings { auto_detect: true, auto_config_url: None, proxy: text(proxy), bypass: bypass.and_then(text) }
    }

    fn config_json(config: &ProxyConfig) -> Value {
        serde_json::to_value(config).unwrap()
    }

    #[test]
    fn single_address_serves_both_protocols() {
        for proxy in ["127.0.0.1:7890", "http://127.0.0.1:7890", "HTTP://127.0.0.1:7890/", " 127.0.0.1:7890 "] {
            let config = normalize(&manual(proxy, None));
            assert_eq!(
                config_json(&config),
                json!({ "state": "manual", "http": "127.0.0.1:7890", "https": "127.0.0.1:7890", "bypass": [] }),
                "{proxy}"
            );
        }
        let config = normalize(&manual("Proxy.Example.COM:8080", None));
        assert_eq!(config.http.as_deref(), Some("proxy.example.com:8080"));
        let config = normalize(&manual("[::1]:7890", None));
        assert_eq!(config.https.as_deref(), Some("[::1]:7890"));
    }

    #[test]
    fn per_protocol_entries_leave_a_missing_protocol_direct() {
        let both = normalize(&manual("http=127.0.0.1:8080;https=127.0.0.1:8443", None));
        assert_eq!(
            config_json(&both),
            json!({ "state": "manual", "http": "127.0.0.1:8080", "https": "127.0.0.1:8443", "bypass": [] })
        );
        let http_only = normalize(&manual("http=proxy.example.com:8080", None));
        assert_eq!(config_json(&http_only), json!({ "state": "manual", "http": "proxy.example.com:8080", "bypass": [] }));
        let https_only = normalize(&manual("https=http://127.0.0.1:7890 ftp=127.0.0.1:21", None));
        assert_eq!(config_json(&https_only), json!({ "state": "manual", "https": "127.0.0.1:7890", "bypass": [] }));
        let with_socks = normalize(&manual("HTTP=127.0.0.1:7890;socks=127.0.0.1:7891", None));
        assert_eq!(config_json(&with_socks), json!({ "state": "manual", "http": "127.0.0.1:7890", "bypass": [] }));
    }

    #[test]
    fn socks_only_is_unsupported() {
        let config = normalize(&manual("socks=127.0.0.1:7891", Some("localhost")));
        assert_eq!(config_json(&config), json!({ "state": "unsupported", "reason": "socks", "bypass": ["localhost"] }));
        let config = normalize(&manual("http=;socks=127.0.0.1:7891", None));
        assert_eq!(config.reason, Some(ProxyReason::Socks));
    }

    #[test]
    fn anything_else_is_unparsable() {
        for proxy in [
            "user:pass@127.0.0.1:7890",
            "http://user@127.0.0.1:7890",
            "https://127.0.0.1:7890",
            "socks5://127.0.0.1:7891",
            "127.0.0.1",
            "127.0.0.1:",
            "127.0.0.1:0",
            "127.0.0.1:65536",
            "127.0.0.1:+80",
            "127.0.0.1:7890/path",
            "::1:7890",
            "[::1]",
            "[zz]:7890",
            "a.example:1 b.example:2",
            "127.0.0.1:7890;https=127.0.0.1:7890",
            "http=127.0.0.1:1;http=127.0.0.1:2",
            "https=https://127.0.0.1:7890",
            "foo=127.0.0.1:7890",
            "http=",
            "ftp=127.0.0.1:21",
            "b\u{fc}cher.example:80",
        ] {
            let config = normalize(&manual(proxy, Some("localhost")));
            assert_eq!(
                config_json(&config),
                json!({ "state": "unsupported", "reason": "unparsable", "bypass": ["localhost"] }),
                "{proxy}"
            );
        }
        let invalid = RawSettings { proxy: Some(WideText::Invalid), ..RawSettings::default() };
        assert_eq!(normalize(&invalid).reason, Some(ProxyReason::Unparsable));
        let invalid_bypass = RawSettings { bypass: Some(WideText::Invalid), ..manual("127.0.0.1:7890", None) };
        assert_eq!(
            config_json(&normalize(&invalid_bypass)),
            json!({ "state": "unsupported", "reason": "unparsable", "bypass": [] })
        );
    }

    #[test]
    fn pac_next_to_manual_is_ignored_and_pac_alone_is_unsupported() {
        let both = RawSettings { auto_config_url: text("http://wpad.example/proxy.pac"), ..manual("127.0.0.1:7890", None) };
        assert_eq!(
            config_json(&normalize(&both)),
            json!({ "state": "manual", "http": "127.0.0.1:7890", "https": "127.0.0.1:7890", "bypass": [], "pacIgnored": true })
        );
        let pac_only =
            RawSettings { auto_detect: true, auto_config_url: text("http://wpad.example/proxy.pac"), ..RawSettings::default() };
        assert_eq!(config_json(&normalize(&pac_only)), json!({ "state": "unsupported", "reason": "pac", "bypass": [] }));
        let blank_pac = RawSettings { auto_config_url: text("  "), ..RawSettings::default() };
        assert_eq!(normalize(&blank_pac).state, ProxyState::Off);
    }

    #[test]
    fn automatic_detection_alone_is_off() {
        let detect = RawSettings { auto_detect: true, ..RawSettings::default() };
        assert_eq!(config_json(&normalize(&detect)), json!({ "state": "off", "bypass": [] }));
        let blank = RawSettings { proxy: text(""), bypass: text("localhost"), ..RawSettings::default() };
        assert_eq!(config_json(&normalize(&blank)), json!({ "state": "off", "bypass": [] }));
    }

    #[test]
    fn bypass_is_split_trimmed_and_capped() {
        let config = normalize(&manual("127.0.0.1:7890", Some(" localhost ; 127.* ;;192.168.*;<local>; ")));
        assert_eq!(config.bypass, ["localhost", "127.*", "192.168.*", "<local>"]);
        let many: Vec<String> = (0..SYSTEM_PROXY_BYPASS_MAX_ENTRIES + 10).map(|index| format!("h{index}.example")).collect();
        let config = normalize(&manual("127.0.0.1:7890", Some(&many.join(";"))));
        assert_eq!(config.bypass.len(), SYSTEM_PROXY_BYPASS_MAX_ENTRIES);
        assert_eq!(config.bypass, many[..SYSTEM_PROXY_BYPASS_MAX_ENTRIES]);
    }

    #[test]
    fn long_bypass_entries_keep_the_message_within_the_limit() {
        let long: Vec<String> =
            (0..SYSTEM_PROXY_BYPASS_MAX_ENTRIES).map(|index| format!("{index:04}.{}.example", "a".repeat(60))).collect();
        let config = normalize(&manual("http=127.0.0.1:7890;https=127.0.0.1:7890", Some(&long.join(";"))));
        let line = message_json(u64::MAX, &config);
        assert!(line.len() < SYSTEM_PROXY_MESSAGE_MAX_BYTES, "{}", line.len());
        assert!(config.bypass.len() < SYSTEM_PROXY_BYPASS_MAX_ENTRIES);
        assert_eq!(config.bypass, long[..config.bypass.len()]);
        // One more entry would not have fitted.
        let mut longer = config.clone();
        longer.bypass.push(long[config.bypass.len()].clone());
        assert!(message_json(u64::MAX, &longer).len() + 1 > SYSTEM_PROXY_MESSAGE_MAX_BYTES);
        // Short entries all fit, so the count cap is what applies to them.
        let short: Vec<String> = (0..SYSTEM_PROXY_BYPASS_MAX_ENTRIES).map(|index| format!("h{index}.example")).collect();
        let config = normalize(&manual("127.0.0.1:7890", Some(&short.join(";"))));
        assert_eq!(config.bypass.len(), SYSTEM_PROXY_BYPASS_MAX_ENTRIES);
        assert!(message_json(u64::MAX, &config).len() < SYSTEM_PROXY_MESSAGE_MAX_BYTES);
    }

    #[test]
    fn read_failure_keeps_the_last_good_configuration() {
        let mut tracker = Tracker::default();
        let good = ReadOutcome::Settings(manual("127.0.0.1:7890", Some("localhost")));
        let failed = ReadOutcome::Failed(ReadError::Failed(5));
        let (seq, _) = tracker.observe(&good).unwrap();
        assert_eq!(seq, 1);
        let (seq, message) = tracker.observe(&failed).unwrap();
        assert_eq!(seq, 2);
        assert_eq!(
            serde_json::from_str::<Value>(&message).unwrap()["config"],
            json!({ "state": "error", "reason": "read_failed", "http": "127.0.0.1:7890", "https": "127.0.0.1:7890", "bypass": ["localhost"] })
        );
        assert_eq!(tracker.observe(&failed), None);
        let (seq, message) = tracker.observe(&good).unwrap();
        assert_eq!(seq, 3);
        assert_eq!(serde_json::from_str::<Value>(&message).unwrap()["config"]["state"], "manual");

        let mut off_then_failed = Tracker::default();
        off_then_failed.observe(&ReadOutcome::NoSettings).unwrap();
        let (_, message) = off_then_failed.observe(&failed).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&message).unwrap()["config"],
            json!({ "state": "error", "reason": "read_failed", "bypass": [] })
        );

        let mut pac_then_failed = Tracker::default();
        pac_then_failed
            .observe(&ReadOutcome::Settings(RawSettings { auto_config_url: text("http://wpad.example/p.pac"), ..RawSettings::default() }))
            .unwrap();
        let (_, message) = pac_then_failed.observe(&failed).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&message).unwrap()["config"],
            json!({ "state": "unsupported", "reason": "read_failed", "bypass": [] })
        );
    }

    #[test]
    fn read_failure_at_start_lets_nothing_out() {
        let mut tracker = Tracker::default();
        let (seq, message) = tracker.observe(&ReadOutcome::Failed(ReadError::Failed(8))).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&message).unwrap(),
            json!({ "v": 1, "type": "system_proxy", "seq": 1, "config": { "state": "unsupported", "reason": "read_failed", "bypass": [] } })
        );
        assert_eq!(seq, 1);
    }

    #[test]
    fn only_changes_get_a_new_seq() {
        let mut tracker = Tracker::default();
        let first = ReadOutcome::Settings(manual("127.0.0.1:7890", None));
        assert_eq!(tracker.observe(&first).map(|(seq, _)| seq), Some(1));
        assert_eq!(tracker.observe(&first), None);
        // A different spelling of the same proxy is the same configuration.
        assert_eq!(tracker.observe(&ReadOutcome::Settings(manual("http://127.0.0.1:7890", None))), None);
        let off = ReadOutcome::Settings(RawSettings { auto_detect: true, ..RawSettings::default() });
        assert_eq!(tracker.observe(&off).map(|(seq, _)| seq), Some(2));
        assert_eq!(tracker.observe(&ReadOutcome::NoSettings), None);
        assert_eq!(tracker.observe(&first).map(|(seq, _)| seq), Some(3));
    }

    /// The messages the sidecar's schema accepts, field for field.
    #[test]
    fn messages_match_the_shared_fixture() {
        let cases: [(u64, ProxyConfig, Value); 9] = [
            (
                1,
                normalize(&manual("127.0.0.1:7890", Some("localhost;127.*;192.168.*;<local>"))),
                json!({ "state": "manual", "http": "127.0.0.1:7890", "https": "127.0.0.1:7890", "bypass": ["localhost", "127.*", "192.168.*", "<local>"] }),
            ),
            (
                2,
                normalize(&manual("http=proxy.example.com:8080", None)),
                json!({ "state": "manual", "http": "proxy.example.com:8080", "bypass": [] }),
            ),
            (
                3,
                normalize(&RawSettings { auto_config_url: text("http://wpad.example/p.pac"), ..manual("127.0.0.1:7890", None) }),
                json!({ "state": "manual", "http": "127.0.0.1:7890", "https": "127.0.0.1:7890", "bypass": [], "pacIgnored": true }),
            ),
            (4, normalize(&RawSettings { auto_detect: true, ..RawSettings::default() }), json!({ "state": "off", "bypass": [] })),
            (
                5,
                normalize(&RawSettings { auto_config_url: text("http://wpad.example/p.pac"), ..RawSettings::default() }),
                json!({ "state": "unsupported", "reason": "pac", "bypass": [] }),
            ),
            (
                6,
                normalize(&manual("socks=127.0.0.1:7891", None)),
                json!({ "state": "unsupported", "reason": "socks", "bypass": [] }),
            ),
            (
                7,
                normalize(&manual("user:pass@127.0.0.1:7890", None)),
                json!({ "state": "unsupported", "reason": "unparsable", "bypass": [] }),
            ),
            (
                8,
                after_read_failure(Some(&normalize(&manual("127.0.0.1:7890", Some("localhost"))))),
                json!({ "state": "error", "reason": "read_failed", "http": "127.0.0.1:7890", "https": "127.0.0.1:7890", "bypass": ["localhost"] }),
            ),
            (1, after_read_failure(None), json!({ "state": "unsupported", "reason": "read_failed", "bypass": [] })),
        ];
        for (seq, config, expected) in cases {
            let line = message_json(seq, &config);
            assert!(!line.contains('\n'));
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({ "v": 1, "type": "system_proxy", "seq": seq, "config": expected })
            );
        }
    }

    /// Hands out NUL-terminated buffers and records every release.
    struct FakeApi {
        result: Result<(), QueryError>,
        strings: [Option<Vec<u16>>; 3],
        handed: RefCell<Vec<*mut u16>>,
        freed: RefCell<HashMap<usize, usize>>,
    }

    impl FakeApi {
        fn new(result: Result<(), QueryError>, strings: [Option<Vec<u16>>; 3]) -> Self {
            Self { result, strings, handed: RefCell::new(Vec::new()), freed: RefCell::new(HashMap::new()) }
        }

        fn assert_each_freed_once(&self) {
            let handed = self.handed.borrow();
            let freed = self.freed.borrow();
            assert_eq!(freed.len(), handed.len());
            for ptr in handed.iter() {
                assert_eq!(freed.get(&(*ptr as usize)), Some(&1));
            }
        }
    }

    impl Drop for FakeApi {
        fn drop(&mut self) {
            for ptr in self.handed.borrow_mut().drain(..) {
                // SAFETY: allocated by `query` below from a boxed slice whose length is
                // recovered by scanning to the terminator it was given.
                unsafe {
                    let mut len = 0;
                    while *ptr.add(len) != 0 {
                        len += 1;
                    }
                    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len + 1)));
                }
            }
        }
    }

    impl ProxyApi for FakeApi {
        fn query(&self, out: &mut RawPointers) -> Result<(), QueryError> {
            let allocate = |units: &Option<Vec<u16>>| match units {
                None => std::ptr::null_mut(),
                Some(units) => {
                    let mut owned = units.clone();
                    owned.push(0);
                    let ptr = Box::into_raw(owned.into_boxed_slice()).cast::<u16>();
                    self.handed.borrow_mut().push(ptr);
                    ptr
                }
            };
            out.auto_detect = true;
            out.auto_config_url = allocate(&self.strings[0]);
            out.proxy = allocate(&self.strings[1]);
            out.bypass = allocate(&self.strings[2]);
            self.result
        }

        unsafe fn free(&self, ptr: *mut u16) {
            *self.freed.borrow_mut().entry(ptr as usize).or_insert(0) += 1;
        }
    }

    fn wide(value: &str) -> Option<Vec<u16>> {
        Some(value.encode_utf16().collect())
    }

    #[test]
    fn every_returned_string_is_freed_once() {
        let api = FakeApi::new(Ok(()), [wide("http://wpad.example/p.pac"), wide("127.0.0.1:7890"), wide("localhost")]);
        let ReadOutcome::Settings(raw) = read_with(&api) else { panic!("expected settings") };
        assert_eq!(raw.proxy, text("127.0.0.1:7890"));
        assert!(normalize(&raw).pac_ignored);
        assert_eq!(api.handed.borrow().len(), 3);
        api.assert_each_freed_once();

        // Undecodable text: reduced to unparsable, still released.
        let api = FakeApi::new(Ok(()), [None, Some(vec![0xD800, 0x41]), None]);
        let ReadOutcome::Settings(raw) = read_with(&api) else { panic!("expected settings") };
        assert_eq!(normalize(&raw).reason, Some(ProxyReason::Unparsable));
        assert_eq!(api.handed.borrow().len(), 1);
        api.assert_each_freed_once();

        // A failing call that still handed strings back: released on the early return.
        let api = FakeApi::new(Err(QueryError::Failed(5)), [None, wide("127.0.0.1:7890"), wide("localhost")]);
        assert_eq!(read_with(&api), ReadOutcome::Failed(ReadError::Failed(5)));
        assert_eq!(api.handed.borrow().len(), 2);
        api.assert_each_freed_once();

        let api = FakeApi::new(Err(QueryError::NoSettings), [None, None, None]);
        assert_eq!(read_with(&api), ReadOutcome::NoSettings);
        assert!(api.freed.borrow().is_empty());

        let api = FakeApi::new(Ok(()), [None, None, None]);
        let ReadOutcome::Settings(raw) = read_with(&api) else { panic!("expected settings") };
        assert_eq!(normalize(&raw).state, ProxyState::Off);
        assert!(api.freed.borrow().is_empty());
    }

    /// A sink whose first write blocks until released, then records what it receives.
    struct GatedSink {
        gate: Arc<(Mutex<Option<io::Result<()>>>, Condvar)>,
        entered: mpsc::Sender<()>,
        written: Arc<Mutex<Vec<u8>>>,
        dropped: Arc<AtomicBool>,
        writes: Arc<AtomicUsize>,
    }

    impl Write for GatedSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.writes.fetch_add(1, Ordering::SeqCst) == 0 {
                let _ = self.entered.send(());
                let (lock, wake) = &*self.gate;
                let mut verdict = lock.lock().unwrap();
                while verdict.is_none() {
                    verdict = wake.wait(verdict).unwrap();
                }
                if let Some(Err(error)) = verdict.take() {
                    return Err(error);
                }
            }
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for GatedSink {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct Gated {
        writer: StdinWriter,
        gate: Arc<(Mutex<Option<io::Result<()>>>, Condvar)>,
        entered: mpsc::Receiver<()>,
        written: Arc<Mutex<Vec<u8>>>,
        dropped: Arc<AtomicBool>,
    }

    fn gated() -> Gated {
        let gate = Arc::new((Mutex::new(None), Condvar::new()));
        let (entered_tx, entered) = mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let dropped = Arc::new(AtomicBool::new(false));
        let sink = GatedSink {
            gate: Arc::clone(&gate),
            entered: entered_tx,
            written: Arc::clone(&written),
            dropped: Arc::clone(&dropped),
            writes: Arc::new(AtomicUsize::new(0)),
        };
        Gated { writer: StdinWriter::spawn(sink), gate, entered, written, dropped }
    }

    fn release(gate: &(Mutex<Option<io::Result<()>>>, Condvar), verdict: io::Result<()>) {
        *gate.0.lock().unwrap() = Some(verdict);
        gate.1.notify_all();
    }

    fn wait_until(condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn a_sidecar_that_does_not_read_never_blocks_submit_or_close() {
        let gated = gated();
        gated.writer.slot().submit("first".to_owned());
        gated.entered.recv_timeout(Duration::from_secs(5)).unwrap();
        // The writer is stuck in the pipe now; submitting and closing still return at once.
        let started = Instant::now();
        for index in 0..100 {
            gated.writer.slot().submit(format!("line {index}"));
        }
        let slot = Arc::clone(gated.writer.slot());
        drop(gated.writer);
        slot.submit("after close".to_owned());
        assert!(started.elapsed() < Duration::from_millis(200), "{:?}", started.elapsed());
        assert!(!gated.dropped.load(Ordering::SeqCst));
        // Killing the process breaks the pipe: the write fails and the thread ends.
        release(&gated.gate, Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        assert!(wait_until(|| gated.dropped.load(Ordering::SeqCst)));
        assert!(gated.written.lock().unwrap().is_empty());
    }

    #[test]
    fn the_writer_sends_only_the_newest_line() {
        let gated = gated();
        let slot = Arc::clone(gated.writer.slot());
        slot.submit("a".to_owned());
        gated.entered.recv_timeout(Duration::from_secs(5)).unwrap();
        slot.submit("b".to_owned());
        slot.submit("c".to_owned());
        release(&gated.gate, Ok(()));
        assert!(wait_until(|| gated.written.lock().unwrap().as_slice() == b"a\nc\n"));
        thread::sleep(Duration::from_millis(50));
        assert_eq!(gated.written.lock().unwrap().as_slice(), b"a\nc\n");
        drop(gated.writer);
        assert!(wait_until(|| gated.dropped.load(Ordering::SeqCst)));
    }

    #[test]
    fn closing_drops_stdin_without_sending_what_is_pending() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let dropped = Arc::new(AtomicBool::new(false));
        struct Recording(Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>);
        impl Write for Recording {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Drop for Recording {
            fn drop(&mut self) {
                self.1.store(true, Ordering::SeqCst);
            }
        }
        let writer = StdinWriter::spawn(Recording(Arc::clone(&written), Arc::clone(&dropped)));
        writer.slot().submit("one".to_owned());
        assert!(wait_until(|| written.lock().unwrap().as_slice() == b"one\n"));
        drop(writer);
        assert!(wait_until(|| dropped.load(Ordering::SeqCst)));
        assert_eq!(written.lock().unwrap().as_slice(), b"one\n");
    }

    #[test]
    fn the_feed_pushes_changes_only_and_catches_up_on_attach() {
        let feed = ProxyFeed::new();
        let manual_read = ReadOutcome::Settings(manual("127.0.0.1:7890", None));
        assert!(feed.observe(&manual_read));
        let (seq, line) = feed.snapshot().unwrap();
        assert_eq!(seq, 1);
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["config"]["state"], "manual");

        // A sidecar spawned with seq 1; a change lands before its writer is attached.
        let off = ReadOutcome::Settings(RawSettings::default());
        assert!(feed.observe(&off));
        let written = Arc::new(Mutex::new(Vec::new()));
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let writer = StdinWriter::spawn(Shared(Arc::clone(&written)));
        feed.attach(writer.slot(), seq);
        let lines = || -> Vec<Value> {
            String::from_utf8(written.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        };
        assert!(wait_until(|| lines().len() == 1));
        assert_eq!(lines()[0]["seq"], 2);
        assert_eq!(lines()[0]["config"]["state"], "off");

        for _ in 0..5 {
            assert!(!feed.observe(&off));
        }
        assert!(feed.observe(&manual_read));
        assert!(wait_until(|| lines().len() == 2));
        thread::sleep(Duration::from_millis(50));
        assert_eq!(lines().len(), 2);
        assert_eq!(lines()[1]["seq"], 3);

        // Attaching a writer that already has the latest sends nothing.
        let quiet = Arc::new(Mutex::new(Vec::new()));
        let second = StdinWriter::spawn(Shared(Arc::clone(&quiet)));
        feed.attach(second.slot(), 3);
        thread::sleep(Duration::from_millis(50));
        assert!(quiet.lock().unwrap().is_empty());
        drop(writer);
    }
}
