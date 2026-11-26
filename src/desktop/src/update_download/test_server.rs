//! A scriptable HTTP/1.1 file server on loopback for the download tests: honours `Range` and
//! `If-Range` like a release-asset host, and injects one fault per request from a script.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use reqwest::Url;

const LAST_MODIFIED: &str = "Wed, 01 Jan 2025 00:00:00 GMT";
/// Upper bound on how long a stalling connection waits for the client to hang up, so a test
/// that fails to time out cannot leave a thread blocked forever.
const STALL_LIMIT: Duration = Duration::from_secs(10);

/// What the server does with one request to `/file`; unscripted requests get `Serve`.
pub enum Reply {
    Serve,
    /// Sends the head and only this many body bytes, then closes.
    CutAfter(usize),
    /// Sends the head and this many body bytes, then goes silent until the client hangs up.
    StallAfter(usize),
    /// Reads the request and never answers.
    StallBeforeHeaders,
    /// Closes the connection without answering.
    Hangup,
    /// Answers 200 with the whole file whatever the request asked for.
    IgnoreRange,
    /// Answers 206 with a range that does not start where the client asked.
    WrongRange,
    /// Replaces the file (new content and ETag), then serves normally.
    Replace(Vec<u8>, &'static str),
    Status(u16),
}

#[derive(Clone, Debug)]
pub struct Request {
    pub path: String,
    pub range: Option<String>,
    pub if_range: Option<String>,
}

struct State {
    file: Mutex<(Vec<u8>, String)>,
    script: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<Request>>,
}

pub struct TestServer {
    port: u16,
    state: Arc<State>,
}

impl TestServer {
    pub fn start(body: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(State {
            file: Mutex::new((body, "\"v1\"".into())),
            script: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
        });
        let shared = state.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = shared.clone();
                thread::spawn(move || {
                    let _ = handle(stream, &state);
                });
            }
        });
        Self { port, state }
    }

    /// A loopback URL nothing listens on.
    pub fn closed_url(path: &str) -> Url {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        Url::parse(&format!("http://127.0.0.1:{port}{path}")).unwrap()
    }

    pub fn script(&self, replies: impl IntoIterator<Item = Reply>) {
        self.state.script.lock().unwrap().extend(replies);
    }

    pub fn url(&self, path_and_query: &str) -> Url {
        Url::parse(&format!("http://127.0.0.1:{}{path_and_query}", self.port)).unwrap()
    }

    pub fn requests(&self) -> Vec<Request> {
        self.state.requests.lock().unwrap().clone()
    }
}

fn handle(stream: TcpStream, state: &State) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();
    let (mut range, mut if_range) = (None, None);
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = Some(value.trim().to_string());
            match name.trim().to_ascii_lowercase().as_str() {
                "range" => range = value,
                "if-range" => if_range = value,
                _ => {}
            }
        }
    }
    state.requests.lock().unwrap().push(Request { path: path.clone(), range: range.clone(), if_range: if_range.clone() });
    let mut stream = stream;

    if path == "/redirect" {
        let head = "HTTP/1.1 302 Found\r\nLocation: /file?signed=placeholder\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        return stream.write_all(head.as_bytes());
    }

    let reply = state.script.lock().unwrap().pop_front().unwrap_or(Reply::Serve);
    if let Reply::Replace(body, etag) = &reply {
        *state.file.lock().unwrap() = (body.clone(), (*etag).to_string());
    }
    let (body, etag) = state.file.lock().unwrap().clone();
    match reply {
        Reply::Status(code) => {
            let head = format!("HTTP/1.1 {code} Scripted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return stream.write_all(head.as_bytes());
        }
        Reply::StallBeforeHeaders => return wait_for_hangup(stream),
        Reply::Hangup => return stream.shutdown(Shutdown::Both),
        _ => {}
    }

    let validator_matches = if_range.as_deref().is_none_or(|value| value == etag || value == LAST_MODIFIED);
    let start = range
        .as_deref()
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.strip_suffix('-'))
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|start| *start < body.len() && validator_matches && !matches!(reply, Reply::IgnoreRange));
    let total = body.len();
    let (status, offset, content_range) = match start {
        Some(start) if matches!(reply, Reply::WrongRange) => {
            let shifted = start + 1;
            ("206 Partial Content", shifted, Some(format!("bytes {shifted}-{}/{total}", total - 1)))
        }
        Some(start) => ("206 Partial Content", start, Some(format!("bytes {start}-{}/{total}", total - 1))),
        None => ("200 OK", 0, None),
    };
    let rest = &body[offset..];
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: {etag}\r\nLast-Modified: {LAST_MODIFIED}\r\nAccept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n",
        rest.len()
    );
    if let Some(content_range) = content_range {
        head.push_str(&format!("Content-Range: {content_range}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;

    match reply {
        Reply::CutAfter(count) => {
            stream.write_all(&rest[..count.min(rest.len())])?;
            stream.flush()?;
            stream.shutdown(Shutdown::Both)
        }
        Reply::StallAfter(count) => {
            stream.write_all(&rest[..count.min(rest.len())])?;
            stream.flush()?;
            wait_for_hangup(stream)
        }
        _ => {
            stream.write_all(rest)?;
            stream.flush()
        }
    }
}

/// Holds the connection open without sending anything until the client closes it.
fn wait_for_hangup(mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(STALL_LIMIT))?;
    let mut sink = [0u8; 256];
    while stream.read(&mut sink)? > 0 {}
    Ok(())
}
