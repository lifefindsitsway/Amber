//! The resumable HTTP transfer behind the update download: one GET per attempt, continuing
//! held bytes with `Range` + `If-Range`, a stall watchdog, and a bounded reconnect loop.
//!
//! Generic over the URL and headers (no updater types) so tests can drive it against a local
//! server with millisecond timings.

use std::time::Duration;

use reqwest::header::{
    ACCEPT, CONTENT_LENGTH, CONTENT_RANGE, ETAG, HeaderMap, HeaderValue, IF_RANGE, LAST_MODIFIED, RANGE,
};
use reqwest::{StatusCode, Url};

use super::{FailureKind, UpdateDownloadError, UpdateDownloadEvent};

/// Where to fetch from and how to reach it.
pub struct Source {
    /// The announced URL. Every attempt starts here, so a redirect to a short-lived signed URL
    /// is followed afresh instead of reusing one that may have expired.
    pub url: Url,
    pub headers: HeaderMap,
    pub proxy: Option<Url>,
    pub no_proxy: bool,
    pub user_agent: String,
}

/// Timing and retry limits; production uses the named defaults, tests use milliseconds.
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    /// How long a connect, the response head or the next body chunk may take before the
    /// connection is abandoned and resumed.
    pub stall: Duration,
    /// Consecutive attempts that received no byte before giving up.
    pub retry_max: u32,
    /// Delay before the first reconnect of a run of fruitless attempts; doubles per attempt.
    pub retry_base: Duration,
}

/// Bytes received so far plus what is needed to ask for the rest of the same file.
#[derive(Default)]
pub struct Partial {
    pub bytes: Vec<u8>,
    total: Option<u64>,
    /// Strong ETag, else Last-Modified, of the response the bytes came from.
    validator: Option<HeaderValue>,
}

impl Partial {
    pub fn len(&self) -> u64 {
        self.bytes.len() as u64
    }

    /// Where to resume and the validator to send with it. Resuming needs the total (to check
    /// the `Content-Range` answer) and a validator (so `If-Range` makes a changed file come
    /// back whole instead of splicing two files together).
    fn resume_point(&self) -> Option<(u64, HeaderValue)> {
        match (&self.validator, self.total) {
            (Some(validator), Some(_)) if !self.bytes.is_empty() => Some((self.len(), validator.clone())),
            _ => None,
        }
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

/// How one attempt ended when it did not complete.
enum AttemptError {
    /// Worth reconnecting: connection-level failures, stalls, 5xx and mismatched ranges.
    Transient { status: Option<u16>, detail: String },
    /// Reconnecting cannot help.
    Fatal { kind: FailureKind, status: Option<u16>, detail: String },
}

/// Downloads into `partial` until it holds the whole file, reconnecting on transient failures.
/// Returns the number of reconnects made.
pub async fn fetch<F>(source: &Source, policy: Policy, partial: &mut Partial, emit: &mut F) -> Result<u32, UpdateDownloadError>
where
    F: FnMut(UpdateDownloadEvent) + Send,
{
    let mut announced: Option<Option<u64>> = None;
    if partial.resume_point().is_none() {
        partial.clear();
    } else {
        announce(&mut announced, partial.total, emit);
        emit(UpdateDownloadEvent::Resumed { downloaded: partial.len() });
    }

    let mut reconnects = 0u32;
    let mut fruitless = 0u32;
    let mut received_any = false;
    loop {
        let mut progressed = false;
        let failure = match attempt(source, policy, partial, &mut announced, &mut progressed, emit).await {
            Ok(()) => return Ok(reconnects),
            Err(failure) => failure,
        };
        let (status, detail) = match failure {
            AttemptError::Fatal { kind, status, detail } => {
                return Err(UpdateDownloadError { kind, status, attempts: reconnects, detail });
            }
            AttemptError::Transient { status, detail } => (status, detail),
        };
        if progressed {
            received_any = true;
            fruitless = 0;
        } else {
            fruitless += 1;
        }
        if fruitless >= policy.retry_max {
            let kind = if status.is_some_and(|code| code >= 500) {
                FailureKind::Server
            } else if received_any {
                FailureKind::Interrupted
            } else {
                FailureKind::Unreachable
            };
            return Err(UpdateDownloadError { kind, status, attempts: reconnects, detail });
        }
        reconnects += 1;
        let delay = backoff(policy.retry_base, fruitless);
        emit(UpdateDownloadEvent::Retrying {
            attempt: reconnects,
            delay_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
        });
        tokio::time::sleep(delay).await;
    }
}

/// `base × 2^(n−1)` for the n-th consecutive fruitless attempt; an attempt that made progress
/// starts the doubling over.
fn backoff(base: Duration, fruitless: u32) -> Duration {
    let exponent = fruitless.max(1) - 1;
    base.saturating_mul(1u32.checked_shl(exponent).unwrap_or(u32::MAX))
}

/// Sends `Started` the first time the total is known in this call, and again only if a
/// restart brought a different file size, so the progress bar never shows a stale total.
fn announce<F: FnMut(UpdateDownloadEvent)>(announced: &mut Option<Option<u64>>, total: Option<u64>, emit: &mut F) {
    if *announced != Some(total) {
        *announced = Some(total);
        emit(UpdateDownloadEvent::Started { content_length: total });
    }
}

async fn attempt<F>(
    source: &Source,
    policy: Policy,
    partial: &mut Partial,
    announced: &mut Option<Option<u64>>,
    progressed: &mut bool,
    emit: &mut F,
) -> Result<(), AttemptError>
where
    F: FnMut(UpdateDownloadEvent) + Send,
{
    let client = build_client(source, policy)?;
    let resume = partial.resume_point();
    if resume.is_none() && !partial.bytes.is_empty() {
        partial.clear();
        emit(UpdateDownloadEvent::Resumed { downloaded: 0 });
    }

    let mut headers = source.headers.clone();
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
    }
    if let Some((offset, validator)) = &resume {
        let range = HeaderValue::from_str(&offset_range(*offset)).expect("a byte range is a valid header value");
        headers.insert(RANGE, range);
        headers.insert(IF_RANGE, validator.clone());
    }

    let request = client.get(source.url.clone()).headers(headers).send();
    let mut response = match tokio::time::timeout(policy.stall, request).await {
        Err(_) => return Err(stalled(policy)),
        Ok(Err(error)) => return Err(classify(&error, source)),
        Ok(Ok(response)) => response,
    };

    let status = response.status();
    match status {
        StatusCode::PARTIAL_CONTENT => {
            let continues = resume.as_ref().is_some_and(|(offset, _)| {
                let range = response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok());
                range.and_then(parse_content_range).is_some_and(|range| {
                    range.start == *offset && range.total == partial.total && range.total == Some(range.end + 1)
                })
            });
            if !continues {
                return Err(AttemptError::Transient {
                    status: Some(status.as_u16()),
                    detail: "partial content does not continue the bytes already held".into(),
                });
            }
        }
        StatusCode::OK => {
            // Either the first response, or the server ignored the range or the file changed
            // (If-Range did not match): the body is the whole file, so start over with it.
            if !partial.bytes.is_empty() {
                partial.clear();
                emit(UpdateDownloadEvent::Resumed { downloaded: 0 });
            }
            partial.total = content_length(response.headers());
            partial.validator = validator(response.headers());
            if let Some(total) = partial.total.and_then(|total| usize::try_from(total).ok()) {
                // Best effort: avoids repeated reallocation of a large installer.
                let _ = partial.bytes.try_reserve_exact(total);
            }
            announce(announced, partial.total, emit);
        }
        status if status.is_client_error() => {
            return Err(AttemptError::Fatal {
                kind: FailureKind::Server,
                status: Some(status.as_u16()),
                detail: format!("server answered {status}"),
            });
        }
        status if status.is_server_error() => {
            return Err(AttemptError::Transient {
                status: Some(status.as_u16()),
                detail: format!("server answered {status}"),
            });
        }
        status => {
            return Err(AttemptError::Fatal {
                kind: FailureKind::Other,
                status: Some(status.as_u16()),
                detail: format!("unexpected response {status}"),
            });
        }
    }

    loop {
        let chunk = match tokio::time::timeout(policy.stall, response.chunk()).await {
            Err(_) => return Err(stalled(policy)),
            Ok(Err(error)) => return Err(classify(&error, source)),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => chunk,
        };
        if chunk.is_empty() {
            continue;
        }
        if partial.total.is_some_and(|total| partial.len() + chunk.len() as u64 > total) {
            partial.clear();
            return Err(AttemptError::Fatal {
                kind: FailureKind::Integrity,
                status: None,
                detail: "server sent more bytes than announced".into(),
            });
        }
        partial.bytes.extend_from_slice(&chunk);
        *progressed = true;
        emit(UpdateDownloadEvent::Progress { chunk_length: chunk.len() as u64 });
    }

    if partial.total.is_some_and(|total| partial.len() < total) {
        return Err(AttemptError::Transient { status: None, detail: "connection closed before the download completed".into() });
    }
    Ok(())
}

/// A fresh client per attempt, so a proxy change in the system settings applies on the next
/// reconnect, with the same proxy handling as the updater plugin's own download.
fn build_client(source: &Source, policy: Policy) -> Result<reqwest::Client, AttemptError> {
    ensure_crypto_provider();
    let mut builder = reqwest::Client::builder().user_agent(source.user_agent.as_str()).connect_timeout(policy.stall);
    if source.no_proxy {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &source.proxy {
        // The error text would echo the proxy address.
        let proxy = reqwest::Proxy::all(proxy.as_str()).map_err(|_| AttemptError::Fatal {
            kind: FailureKind::Other,
            status: None,
            detail: "invalid proxy configuration".into(),
        })?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| AttemptError::Fatal {
        kind: FailureKind::Other,
        status: None,
        detail: describe(&error, source),
    })
}

/// reqwest is built without a bundled TLS provider and panics if none is installed. The
/// updater plugin installs ring during its update check; installing here too keeps this
/// independent of call order. Losing the install race to another thread is harmless.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn stalled(policy: Policy) -> AttemptError {
    AttemptError::Transient { status: None, detail: format!("no data received for {} ms", policy.stall.as_millis()) }
}

/// Client-side configuration problems cannot be fixed by reconnecting; everything else
/// (connect, TLS, reset, truncated body) is the network.
fn classify(error: &reqwest::Error, source: &Source) -> AttemptError {
    let detail = describe(error, source);
    if error.is_builder() || error.is_redirect() {
        AttemptError::Fatal { kind: FailureKind::Other, status: None, detail }
    } else {
        AttemptError::Transient { status: None, detail }
    }
}

/// The error with its causes, since reqwest's own text ("error sending request") hides the
/// reason, and with credentials removed from any URL in it.
fn describe(error: &(dyn std::error::Error + 'static), source: &Source) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(inner) = cause {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        cause = inner.source();
    }
    let mut text = redact_urls(&text);
    if let Some(host) = source.proxy.as_ref().and_then(|proxy| proxy.host_str()) {
        text = text.replace(host, "<proxy>");
    }
    text
}

/// Drops the query, fragment and user info of every http(s) URL in `text`: download URLs
/// redirect to signed URLs whose query carries an access token.
pub fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = find_url(rest) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find(|c: char| c.is_whitespace() || matches!(c, ')' | '(' | '"' | '\'' | '<' | '>' | '[' | ']')).unwrap_or(tail.len());
        let url = &tail[..end];
        let url = &url[..url.find(['?', '#']).unwrap_or(url.len())];
        let scheme_end = url.find("://").map_or(0, |index| index + 3);
        let authority_end = url[scheme_end..].find('/').map_or(url.len(), |index| scheme_end + index);
        let host_start = url[scheme_end..authority_end].rfind('@').map_or(scheme_end, |index| scheme_end + index + 1);
        out.push_str(&url[..scheme_end]);
        out.push_str(&url[host_start..]);
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn find_url(text: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    [lower.find("http://"), lower.find("https://")].into_iter().flatten().min()
}

fn offset_range(offset: u64) -> String {
    format!("bytes={offset}-")
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(CONTENT_LENGTH)?.to_str().ok()?.trim().parse().ok()
}

/// A strong ETag, else Last-Modified. A weak ETag cannot be used in If-Range (servers must
/// then ignore the range), so it is skipped in favour of the date.
fn validator(headers: &HeaderMap) -> Option<HeaderValue> {
    let strong_etag = headers.get(ETAG).filter(|etag| !etag.as_bytes().starts_with(b"W/"));
    strong_etag.or_else(|| headers.get(LAST_MODIFIED)).cloned()
}

#[derive(Debug, PartialEq, Eq)]
pub struct ContentRange {
    pub start: u64,
    pub end: u64,
    pub total: Option<u64>,
}

/// Parses `bytes START-END/TOTAL` (TOTAL may be `*`).
pub fn parse_content_range(value: &str) -> Option<ContentRange> {
    let spec = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = spec.split_once('/')?;
    let (start, end) = range.trim().split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    let total = match total.trim() {
        "*" => None,
        total => Some(total.parse::<u64>().ok()?),
    };
    if end < start || total.is_some_and(|total| end >= total) {
        return None;
    }
    Some(ContentRange { start, end, total })
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{Reply, TestServer};
    use super::*;

    const LONG_STALL: Duration = Duration::from_millis(150);

    fn policy(retry_max: u32) -> Policy {
        Policy { stall: LONG_STALL, retry_max, retry_base: Duration::from_millis(5) }
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|index| (index * 7 + index / 251) as u8).collect()
    }

    fn source(url: Url) -> Source {
        Source { url, headers: HeaderMap::new(), proxy: None, no_proxy: true, user_agent: "amber-test".into() }
    }

    fn run(source: &Source, policy: Policy, partial: &mut Partial) -> (Result<u32, UpdateDownloadError>, Vec<UpdateDownloadEvent>) {
        let mut events = Vec::new();
        let result = tauri::async_runtime::block_on(fetch(source, policy, partial, &mut |event| events.push(event)));
        (result, events)
    }

    fn progress_total(events: &[UpdateDownloadEvent]) -> u64 {
        events
            .iter()
            .map(|event| match event {
                UpdateDownloadEvent::Progress { chunk_length } => *chunk_length,
                _ => 0,
            })
            .sum()
    }

    fn retries(events: &[UpdateDownloadEvent]) -> Vec<(u32, u64)> {
        events
            .iter()
            .filter_map(|event| match event {
                UpdateDownloadEvent::Retrying { attempt, delay_ms } => Some((*attempt, *delay_ms)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn resumes_through_redirects_after_two_disconnects() {
        let data = body(64 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::CutAfter(1000), Reply::CutAfter(5000)]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/redirect?sig=placeholder")), policy(3), &mut partial);
        assert_eq!(result.unwrap(), 2);
        assert_eq!(partial.bytes, data);
        assert_eq!(events.first(), Some(&UpdateDownloadEvent::Started { content_length: Some(data.len() as u64) }));
        assert_eq!(progress_total(&events), data.len() as u64);
        assert_eq!(retries(&events), vec![(1, 5), (2, 5)]);
        let files: Vec<_> = server.requests().into_iter().filter(|request| request.path == "/file").collect();
        let paths: Vec<_> = server.requests().into_iter().map(|request| request.path).collect();
        assert_eq!(paths, ["/redirect", "/file", "/redirect", "/file", "/redirect", "/file"]);
        assert_eq!(files[0].range, None);
        assert_eq!(files[1].range.as_deref(), Some("bytes=1000-"));
        assert_eq!(files[1].if_range.as_deref(), Some("\"v1\""));
        assert_eq!(files[2].range.as_deref(), Some("bytes=6000-"));
    }

    #[test]
    fn a_stalled_body_is_dropped_and_resumed() {
        let data = body(32 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::StallAfter(2000)]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/file")), policy(3), &mut partial);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(partial.bytes, data);
        assert_eq!(server.requests()[1].range.as_deref(), Some("bytes=2000-"));
        assert!(!events.contains(&UpdateDownloadEvent::Resumed { downloaded: 0 }));
    }

    #[test]
    fn a_stall_before_the_response_head_reconnects() {
        let data = body(8 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::StallBeforeHeaders]);
        let mut partial = Partial::default();
        let (result, _) = run(&source(server.url("/file")), policy(3), &mut partial);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(partial.bytes, data);
        assert_eq!(server.requests()[1].range, None);
    }

    #[test]
    fn a_full_answer_to_a_range_request_restarts_from_zero() {
        let data = body(16 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::CutAfter(1000), Reply::IgnoreRange]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/file")), policy(3), &mut partial);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(partial.bytes, data);
        assert!(events.contains(&UpdateDownloadEvent::Resumed { downloaded: 0 }));
        assert_eq!(progress_total(&events), data.len() as u64 + 1000);
        let starts = events.iter().filter(|event| matches!(event, UpdateDownloadEvent::Started { .. })).count();
        assert_eq!(starts, 1);
    }

    #[test]
    fn a_changed_file_comes_back_whole_and_replaces_held_bytes() {
        let old = body(16 * 1024);
        let new: Vec<u8> = body(20 * 1024).into_iter().map(|byte| byte ^ 0x5a).collect();
        let server = TestServer::start(old);
        server.script([Reply::CutAfter(1000), Reply::Replace(new.clone(), "v2")]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/file")), policy(3), &mut partial);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(partial.bytes, new);
        assert!(events.contains(&UpdateDownloadEvent::Resumed { downloaded: 0 }));
        assert!(events.contains(&UpdateDownloadEvent::Started { content_length: Some(new.len() as u64) }));
        assert_eq!(server.requests()[1].if_range.as_deref(), Some("\"v1\""));
    }

    #[test]
    fn a_mismatched_range_is_retried_with_the_same_offset() {
        let data = body(16 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::CutAfter(1000), Reply::WrongRange]);
        let mut partial = Partial::default();
        let (result, _) = run(&source(server.url("/file")), policy(3), &mut partial);
        assert_eq!(result.unwrap(), 2);
        assert_eq!(partial.bytes, data);
        let ranges: Vec<_> = server.requests().into_iter().map(|request| request.range).collect();
        assert_eq!(ranges, [None, Some("bytes=1000-".into()), Some("bytes=1000-".into())]);
    }

    #[test]
    fn a_client_error_fails_without_retrying() {
        let server = TestServer::start(body(1024));
        server.script([Reply::Status(404)]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/file")), policy(3), &mut partial);
        let error = result.unwrap_err();
        assert_eq!((error.kind, error.status, error.attempts), (FailureKind::Server, Some(404), 0));
        assert_eq!(server.requests().len(), 1);
        assert!(retries(&events).is_empty());
    }

    #[test]
    fn server_errors_back_off_and_give_up_after_the_limit() {
        let server = TestServer::start(body(1024));
        server.script([Reply::Status(503), Reply::Status(503), Reply::Status(503)]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/file")), policy(3), &mut partial);
        let error = result.unwrap_err();
        assert_eq!((error.kind, error.status, error.attempts), (FailureKind::Server, Some(503), 2));
        assert_eq!(server.requests().len(), 3);
        assert_eq!(retries(&events), vec![(1, 5), (2, 10)]);
    }

    #[test]
    fn progress_resets_the_fruitless_attempt_counter() {
        let data = body(16 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::Status(503), Reply::CutAfter(1000), Reply::Status(503), Reply::Serve]);
        let mut partial = Partial::default();
        let (result, events) = run(&source(server.url("/file")), policy(2), &mut partial);
        assert_eq!(result.unwrap(), 3);
        assert_eq!(partial.bytes, data);
        assert_eq!(retries(&events), vec![(1, 5), (2, 5), (3, 5)]);
    }

    #[test]
    fn giving_up_after_bytes_arrived_is_an_interruption() {
        let data = body(16 * 1024);
        let server = TestServer::start(data);
        server.script([Reply::CutAfter(1000), Reply::StallBeforeHeaders, Reply::StallBeforeHeaders]);
        let mut partial = Partial::default();
        let (result, _) = run(&source(server.url("/file")), policy(2), &mut partial);
        let error = result.unwrap_err();
        assert_eq!((error.kind, error.status, error.attempts), (FailureKind::Interrupted, None, 2));
        assert_eq!(partial.len(), 1000);
    }

    #[test]
    fn an_unreachable_host_gives_up_as_unreachable() {
        let url = TestServer::closed_url("/file");
        let mut partial = Partial::default();
        let (result, events) = run(&source(url), policy(3), &mut partial);
        let error = result.unwrap_err();
        assert_eq!((error.kind, error.status, error.attempts), (FailureKind::Unreachable, None, 2));
        assert_eq!(retries(&events), vec![(1, 5), (2, 10)]);
    }

    #[test]
    fn failure_details_keep_the_url_but_not_its_query() {
        let server = TestServer::start(body(1024));
        server.script([Reply::Hangup, Reply::Hangup]);
        let mut partial = Partial::default();
        let (result, _) = run(&source(server.url("/file?sig=placeholder&exp=1")), policy(2), &mut partial);
        let error = result.unwrap_err();
        assert_eq!((error.kind, error.attempts), (FailureKind::Unreachable, 1));
        assert!(error.detail.contains("127.0.0.1"), "{}", error.detail);
        assert!(!error.detail.contains("sig="), "{}", error.detail);
        assert!(!error.detail.contains("exp="), "{}", error.detail);
    }

    #[test]
    fn held_bytes_continue_in_a_later_call() {
        let data = body(16 * 1024);
        let server = TestServer::start(data.clone());
        server.script([Reply::CutAfter(3000), Reply::StallBeforeHeaders]);
        let mut partial = Partial::default();
        let (first, _) = run(&source(server.url("/file")), policy(1), &mut partial);
        assert_eq!(first.unwrap_err().kind, FailureKind::Interrupted);
        assert_eq!(partial.len(), 3000);

        let (second, events) = run(&source(server.url("/file")), policy(1), &mut partial);
        assert_eq!(second.unwrap(), 0);
        assert_eq!(partial.bytes, data);
        assert_eq!(
            events[..2],
            [
                UpdateDownloadEvent::Started { content_length: Some(data.len() as u64) },
                UpdateDownloadEvent::Resumed { downloaded: 3000 }
            ]
        );
        assert_eq!(server.requests()[2].range.as_deref(), Some("bytes=3000-"));
    }

    #[test]
    fn parses_content_ranges() {
        assert_eq!(parse_content_range("bytes 10-99/100"), Some(ContentRange { start: 10, end: 99, total: Some(100) }));
        assert_eq!(parse_content_range("bytes 0-0/*"), Some(ContentRange { start: 0, end: 0, total: None }));
        assert_eq!(parse_content_range("bytes 10-100/100"), None);
        assert_eq!(parse_content_range("bytes 20-10/100"), None);
        assert_eq!(parse_content_range("bytes */100"), None);
        assert_eq!(parse_content_range("items 0-1/2"), None);
    }

    #[test]
    fn redacts_queries_and_credentials_from_urls() {
        assert_eq!(
            redact_urls("error sending request for url (https://cdn.example/a/b.exe?sig=x&se=1#f): reset"),
            "error sending request for url (https://cdn.example/a/b.exe): reset"
        );
        assert_eq!(redact_urls("via HTTP://user:pass@proxy.example:8080/x?y"), "via HTTP://proxy.example:8080/x");
        assert_eq!(redact_urls("plain text? yes"), "plain text? yes");
    }

    #[test]
    fn backoff_doubles_per_fruitless_attempt() {
        let base = Duration::from_millis(1000);
        assert_eq!(backoff(base, 0), base);
        assert_eq!(backoff(base, 1), base);
        assert_eq!(backoff(base, 3), base * 4);
        assert!(backoff(base, 64) >= base);
    }

    #[test]
    fn prefers_a_strong_etag_as_validator() {
        let mut headers = HeaderMap::new();
        headers.insert(LAST_MODIFIED, HeaderValue::from_static("Wed, 01 Jan 2025 00:00:00 GMT"));
        headers.insert(ETAG, HeaderValue::from_static("W/\"weak\""));
        assert_eq!(validator(&headers), Some(HeaderValue::from_static("Wed, 01 Jan 2025 00:00:00 GMT")));
        headers.insert(ETAG, HeaderValue::from_static("\"strong\""));
        assert_eq!(validator(&headers), Some(HeaderValue::from_static("\"strong\"")));
    }
}
