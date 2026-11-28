//! Sidecar lifecycle: spawn `node server.js` with an explicit environment,
//! wait for its READY line, restart it after crashes up to `SIDECAR_RESTART_MAX` times,
//! and shut it down without leaving orphans.
//!
//! A requested restart (after the master key was rotated) stops the running
//! sidecar the same way shutdown does, but the supervise loop then starts the next one
//! without charging the crash-restart budget.
//!
//! A hold (an offline restore) stops the running sidecar the same way and
//! keeps the supervise loop parked, without charging the budget, until the hold is released;
//! the next sidecar then starts and the WebView is told it restarted.
//!
//! Shutdown closes the sidecar's stdin, which the server treats as the request to exit
//! (Windows has no POSIX signals), then kills the whole process tree once
//! `SIDECAR_SHUTDOWN_GRACE_MS` has passed. It runs from `ShutdownGuard::drop`: Tauri
//! clears the app resource table on normal exit, on restart and right before the updater
//! starts an installer, so every exit path goes through the same code.
//!
//! On Windows the sidecar follows the user's system proxy: it gets the current proxy
//! message in `AMBER_SYSTEM_PROXY` when spawned and later changes as lines on stdin. Stdin
//! belongs to a writer thread of that process, so the supervisor never writes to the pipe.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Resource};

use crate::data_dir;
use crate::defaults::{SIDECAR_READY_TIMEOUT_MS, SIDECAR_RESTART_MAX, SIDECAR_SHUTDOWN_GRACE_MS};
use crate::encoding::base64url;
use crate::identity::LEGACY_APP_IDENTIFIER;
use crate::master_key;
use crate::system_proxy::{self, ProxyFeed, StdinWriter};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);
const TOKEN_BYTES: usize = 32;
const FILE_GRANT_KEY_BYTES: usize = 32;

/// Variables passed through from the shell's own environment; nothing else is inherited.
/// `APPDATA` / `LOCALAPPDATA` locate browser profiles for yt-dlp `--cookies-from-browser`.
const PASSTHROUGH_ENV: [&str; 6] = ["SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"];

/// Emitted after every successful handshake.
pub const EVENT_READY: &str = "sidecar://ready";
/// Emitted once the restart budget is spent; the payload is a diagnostic message.
pub const EVENT_FAILED: &str = "sidecar://failed";
/// Emitted after every successful handshake but the first: the endpoint and token changed,
/// so the WebView fetches them again, reconnects SSE and reloads its snapshot.
pub const EVENT_RESTARTED: &str = "amber://sidecar-restarted";

struct Paths {
    node: PathBuf,
    resource_dir: PathBuf,
    server_dir: PathBuf,
    bin_dir: PathBuf,
    data_dir: PathBuf,
    log_dir: PathBuf,
}

struct Endpoint {
    url: String,
    token: String,
}

struct Running {
    child: Child,
    /// Dropping it closes the sidecar's stdin, the request to exit.
    stdin: Option<StdinWriter>,
    pid: u32,
    endpoint: Option<Endpoint>,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    /// Crash restarts charged against `SIDECAR_RESTART_MAX`.
    restarts: u32,
    /// Successful handshakes in this shell's lifetime.
    handshakes: u64,
    stopping: bool,
    /// Set by `request_restart`; the supervise loop stops the sidecar and starts a new one.
    restart_requested: bool,
    /// Whether a supervise loop is alive; it ends on shutdown or after the budget is spent.
    supervising: bool,
    /// Set while a `HoldGuard` lives: no sidecar may run.
    held: bool,
    /// Set while the supervise loop waits for a hold to end, with no sidecar running.
    parked: bool,
    failure: Option<String>,
}

struct Inner {
    app: AppHandle,
    paths: Paths,
    state: Mutex<State>,
    /// Wakes a supervise loop parked by a hold, when the hold ends or shutdown begins.
    unparked: Condvar,
    /// Held while a sidecar is being stopped, so shutdown waits for a restart's stop that is
    /// already under way instead of exiting with the child half-stopped.
    stop_lock: Mutex<()>,
    /// HMAC key of local file grants: generated once per shell
    /// lifetime so it survives sidecar restarts, handed only to the sidecar's environment
    /// and the shell's own grant checks, never logged, never part of diagnostics and never
    /// sent to the WebView.
    file_grant_key: [u8; FILE_GRANT_KEY_BYTES],
    /// The master key from the Credential Manager, `None` when it could not be read
    /// (credentials then report as unavailable). Same handling as the file grant key; only
    /// the sidecar receives it.
    secret_key: Mutex<Option<String>>,
    /// The system proxy the sidecar follows; `None` where the shell does not read one.
    proxy: Option<Arc<ProxyFeed>>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn log(&self, message: &str) {
        append_log(&self.paths.log_dir.join("shell.log"), message);
    }
}

/// Managed state for the handshake commands.
pub struct Supervisor(Arc<Inner>);

/// Lives only in the app resource table; dropping it stops the sidecar.
pub struct ShutdownGuard(Arc<Inner>);

impl Resource for ShutdownGuard {}

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        shutdown(&self.0);
    }
}

/// The bundled Node sits next to the app executable: Tauri strips the target-triple suffix
/// from `externalBin` entries, both when building (`tauri dev`) and in the NSIS installer.
pub fn node_sidecar_path() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("executable has no parent directory"))?;
    Ok(dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
}

/// Once no credential of the legacy identifier is left, its WebView2 state directory under
/// `%LOCALAPPDATA%` has no further use; the bilibili login inside it cannot be migrated.
/// Off the start path; a failure is logged and the next start tries again.
fn remove_legacy_state_dir(inner: &Arc<Inner>) {
    let dir = match inner.app.path().local_data_dir() {
        Ok(local) => local.join(LEGACY_APP_IDENTIFIER),
        Err(error) => {
            inner.log(&format!("legacy WebView2 directory not located: {error}"));
            return;
        }
    };
    let inner = Arc::clone(inner);
    thread::spawn(move || match data_dir::remove_legacy_state_dir(&dir) {
        Ok(true) => inner.log(&format!("legacy WebView2 directory removed: {}", dir.display())),
        Ok(false) => {}
        Err(reason) => inner.log(&format!("legacy WebView2 directory kept ({}): {reason}", dir.display())),
    });
}

impl Supervisor {
    pub fn start(app: &AppHandle, proxy: Option<Arc<ProxyFeed>>) -> Result<Self, Box<dyn std::error::Error>> {
        let resource_dir = app.path().resource_dir()?;
        let paths = Paths {
            node: node_sidecar_path()?,
            server_dir: resource_dir.join("server"),
            bin_dir: resource_dir.join("bin"),
            resource_dir,
            data_dir: app.path().app_data_dir()?,
            log_dir: app.path().app_log_dir()?,
        };
        // Before anything is written there: the log directory lives inside the data directory.
        if let Err(refusal) = data_dir::claim(&paths.data_dir) {
            data_dir::refuse_and_exit(app, &paths.data_dir, &refusal);
        }
        fs::create_dir_all(&paths.data_dir)?;
        fs::create_dir_all(&paths.log_dir)?;
        let mut file_grant_key = [0u8; FILE_GRANT_KEY_BYTES];
        fill_random(&mut file_grant_key)?;
        let inner = Arc::new(Inner {
            app: app.clone(),
            paths,
            state: Mutex::new(State { supervising: true, ..State::default() }),
            unparked: Condvar::new(),
            stop_lock: Mutex::new(()),
            file_grant_key,
            secret_key: Mutex::new(None),
            proxy,
        });
        inner.log(&format!(
            "paths node={} resources={} data={}",
            inner.paths.node.display(),
            inner.paths.resource_dir.display(),
            inner.paths.data_dir.display()
        ));
        match master_key::load_or_create() {
            Ok(loaded) => {
                for note in &loaded.notes {
                    inner.log(note);
                }
                if loaded.legacy_gone {
                    remove_legacy_state_dir(&inner);
                }
                *inner.secret_key.lock().unwrap_or_else(PoisonError::into_inner) = Some(loaded.key);
            }
            Err(reason) => inner.log(&format!("master key unavailable, starting the sidecar without it: {reason}")),
        }
        let supervised = Arc::clone(&inner);
        thread::spawn(move || supervise(&supervised));
        Ok(Self(inner))
    }

    /// The raw file grant key for the shell's own signing and checks.
    pub fn file_grant_key(&self) -> &[u8] {
        &self.0.file_grant_key
    }

    /// The app data directory the sidecar was given as `AMBER_DATA_DIR`.
    pub fn data_dir(&self) -> &Path {
        &self.0.paths.data_dir
    }

    /// Stores a fresh master key and restarts the sidecar with it. When the store refuses
    /// the key nothing changes and the running sidecar keeps its old key.
    pub fn rotate_master_key(&self) -> Result<(), String> {
        let key = master_key::rotate().inspect_err(|reason| self.0.log(&format!("master key rotation failed: {reason}")))?;
        *self.0.secret_key.lock().unwrap_or_else(PoisonError::into_inner) = Some(key);
        self.0.log("master key rotated; restarting the sidecar");
        request_restart(&self.0);
        Ok(())
    }

    /// Stops the sidecar and keeps it stopped until the returned guard is dropped; the next
    /// sidecar then starts with a fresh restart budget. Fails during shutdown, when another
    /// hold is active, or when the sidecar does not stop in time.
    pub fn hold(&self) -> Result<HoldGuard, String> {
        {
            let mut state = self.0.lock();
            if state.stopping {
                return Err("the application is shutting down".to_owned());
            }
            if state.held {
                return Err("the backend is already stopped for another operation".to_owned());
            }
            state.held = true;
            if state.supervising {
                state.restart_requested = true;
            }
        }
        let guard = HoldGuard(Arc::clone(&self.0));
        // Stopping takes at most the grace period plus the kill; the handshake of a sidecar
        // that was just starting may come first.
        let deadline = Instant::now() + Duration::from_millis(SIDECAR_SHUTDOWN_GRACE_MS + SIDECAR_READY_TIMEOUT_MS);
        loop {
            {
                let state = self.0.lock();
                if state.running.is_none() && (state.parked || !state.supervising) {
                    break;
                }
            }
            if Instant::now() >= deadline {
                return Err("the backend did not stop in time".to_owned());
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.0.log("sidecar held");
        Ok(guard)
    }

    /// Runs `node server.js restore <args>` from the bundled server with `AMBER_MODE=local`,
    /// `AMBER_DATA_DIR` and the system variables the sidecar also gets, nothing else: no
    /// master key, token, file grant key or tool directory. Each stdout line goes to `on_line`; stderr goes to the sidecar log. Returns once
    /// the command has exited; its outcome is in the report file it was given.
    pub fn run_restore_command(&self, args: &[std::ffi::OsString], mut on_line: impl FnMut(&str)) -> Result<(), String> {
        let paths = &self.0.paths;
        let mut command = Command::new(&paths.node);
        command
            .arg("server.js")
            .arg("restore")
            .args(args)
            .current_dir(&paths.server_dir)
            .env_clear()
            .env("AMBER_MODE", "local")
            .env("AMBER_DATA_DIR", &paths.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in PASSTHROUGH_ENV {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| format!("spawn {}: {error}", paths.node.display()))?;
        let stdout = child.stdout.take().ok_or("restore stdout missing")?;
        let stderr = child.stderr.take().ok_or("restore stderr missing")?;
        forward_lines(stderr, paths.log_dir.join("sidecar.log"));
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            on_line(&line);
        }
        let status = child.wait().map_err(|error| format!("restore command wait failed: {error}"))?;
        self.0.log(&format!("restore command exited: {status}"));
        Ok(())
    }

    pub fn shutdown_guard(&self) -> ShutdownGuard {
        ShutdownGuard(Arc::clone(&self.0))
    }

    /// `{ endpoint, token }` while a handshaken sidecar is running. The token only travels
    /// to the main WebView through this command and stays in its memory.
    pub fn endpoint(&self) -> Option<BTreeMap<&'static str, String>> {
        let state = self.0.lock();
        let endpoint = state.running.as_ref()?.endpoint.as_ref()?;
        Some(BTreeMap::from([("endpoint", endpoint.url.clone()), ("token", endpoint.token.clone())]))
    }

    pub fn diagnostics(&self) -> BTreeMap<&'static str, String> {
        let state = self.0.lock();
        let paths = &self.0.paths;
        BTreeMap::from([
            ("sidecarPid", state.running.as_ref().map_or_else(String::new, |running| running.pid.to_string())),
            ("restarts", state.restarts.to_string()),
            ("failure", state.failure.clone().unwrap_or_default()),
            ("nodePath", paths.node.display().to_string()),
            ("resourceDir", paths.resource_dir.display().to_string()),
            ("dataDir", paths.data_dir.display().to_string()),
            ("logDir", paths.log_dir.display().to_string()),
        ])
    }
}

/// Keeps the sidecar stopped while it lives (see `Supervisor::hold`).
pub struct HoldGuard(Arc<Inner>);

impl Drop for HoldGuard {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.held = false;
        self.0.unparked.notify_all();
        if state.stopping || state.supervising {
            return;
        }
        // The loop had given up before the hold: the restored library deserves a fresh try.
        state.supervising = true;
        state.restarts = 0;
        state.failure = None;
        drop(state);
        self.0.log("sidecar released");
        let supervised = Arc::clone(&self.0);
        thread::spawn(move || supervise(&supervised));
    }
}

/// Makes the supervise loop stop the running sidecar and start a new one. A loop that has
/// already given up is started again with a fresh budget: the new key deserves a new try.
fn request_restart(inner: &Arc<Inner>) {
    let mut state = inner.lock();
    if state.stopping {
        return;
    }
    if state.supervising {
        state.restart_requested = true;
        return;
    }
    state.supervising = true;
    state.restart_requested = false;
    state.restarts = 0;
    state.failure = None;
    drop(state);
    let supervised = Arc::clone(inner);
    thread::spawn(move || supervise(&supervised));
}

/// Starts the sidecar and restarts it after every crash or failed handshake until the
/// restart budget is spent or shutdown begins. Requested restarts are not charged.
fn supervise(inner: &Arc<Inner>) {
    loop {
        {
            let mut state = inner.lock();
            while state.held && !state.stopping {
                state.parked = true;
                state = inner.unparked.wait(state).unwrap_or_else(PoisonError::into_inner);
            }
            state.parked = false;
            if state.stopping {
                state.supervising = false;
                return;
            }
        }
        match spawn_and_handshake(inner) {
            Ok(pid) => {
                let handshakes = {
                    let mut state = inner.lock();
                    state.handshakes += 1;
                    state.handshakes
                };
                inner.log(&format!("sidecar ready pid={pid}"));
                let _ = inner.app.emit(EVENT_READY, ());
                if handshakes > 1 {
                    let _ = inner.app.emit(EVENT_RESTARTED, ());
                }
                wait_for_exit(inner);
            }
            Err(error) => inner.log(&format!("sidecar start failed: {error}")),
        }
        let restarts = {
            let mut state = inner.lock();
            if state.stopping {
                state.supervising = false;
                return;
            }
            if state.restart_requested {
                state.restart_requested = false;
                drop(state);
                inner.log("restarting sidecar on request");
                continue;
            }
            state.restarts += 1;
            if state.restarts > SIDECAR_RESTART_MAX {
                // Decided under the same lock as the restart request check, so a request
                // either lands before this and is honoured, or finds the loop gone and
                // starts a new one.
                let message = format!("sidecar stopped after {SIDECAR_RESTART_MAX} restarts");
                state.failure = Some(message.clone());
                state.supervising = false;
                drop(state);
                inner.log(&message);
                let _ = inner.app.emit(EVENT_FAILED, message);
                return;
            }
            state.restarts
        };
        inner.log(&format!("restarting sidecar ({restarts}/{SIDECAR_RESTART_MAX})"));
    }
}

fn spawn_and_handshake(inner: &Arc<Inner>) -> Result<u32, String> {
    let paths = &inner.paths;
    let token = random_token()?;
    let mut command = Command::new(&paths.node);
    command
        .arg("server.js")
        .current_dir(&paths.server_dir)
        .env_clear()
        .env("AMBER_MODE", "local")
        .env("AMBER_SIDECAR_TOKEN", &token)
        .env("AMBER_FILE_GRANT_KEY", base64url(&inner.file_grant_key))
        .env("AMBER_DATA_DIR", &paths.data_dir)
        .env("AMBER_BIN_DIR", &paths.bin_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Without a key the sidecar opens the library and reports credentials as unavailable
    // rather than the shell inventing a key over an unreadable one.
    if let Some(key) = inner.secret_key.lock().unwrap_or_else(PoisonError::into_inner).as_deref() {
        command.env("AMBER_SECRET_KEY", key);
    }
    for name in PASSTHROUGH_ENV {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // Taken before the spawn; a change after this snapshot reaches the new sidecar over
    // stdin once its writer is attached below.
    let proxy_snapshot = inner.proxy.as_ref().and_then(|feed| feed.snapshot());
    if let Some((_, message)) = &proxy_snapshot {
        command.env(system_proxy::ENV_VAR, message);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| format!("spawn {}: {error}", paths.node.display()))?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr missing")?;
    let stdin = child.stdin.take().map(StdinWriter::spawn);
    if let (Some(feed), Some(writer), Some((seq, _))) = (&inner.proxy, &stdin, &proxy_snapshot) {
        feed.attach(writer.slot(), *seq);
    }
    inner.lock().running = Some(Running { child, stdin, pid, endpoint: None });

    let sidecar_log = paths.log_dir.join("sidecar.log");
    forward_lines(stderr, sidecar_log.clone());
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut ready_tx = Some(ready_tx);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match parse_ready(&line) {
                Some(ready) if ready_tx.is_some() => {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(ready);
                    }
                }
                _ => append_log(&sidecar_log, &format!("stdout: {line}")),
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_millis(SIDECAR_READY_TIMEOUT_MS)) {
        Ok((port, reported_pid)) => {
            let mut state = inner.lock();
            let running = state.running.as_mut().ok_or("sidecar stopped during handshake")?;
            if reported_pid != pid {
                inner.log(&format!("READY pid {reported_pid} differs from spawned pid {pid}"));
            }
            running.endpoint = Some(Endpoint { url: format!("http://127.0.0.1:{port}"), token });
            Ok(pid)
        }
        Err(error) => {
            let reason = match error {
                RecvTimeoutError::Timeout => format!("no READY within {SIDECAR_READY_TIMEOUT_MS} ms"),
                RecvTimeoutError::Disconnected => "sidecar exited before READY".to_string(),
            };
            if let Some(mut running) = inner.lock().running.take() {
                kill_tree(running.pid);
                let _ = running.child.wait();
            }
            Err(reason)
        }
    }
}

/// Returns once the running sidecar has exited on its own, when shutdown has taken it, or
/// after stopping it for a requested restart.
fn wait_for_exit(inner: &Arc<Inner>) {
    loop {
        let mut state = inner.lock();
        if state.restart_requested && !state.stopping {
            drop(state);
            // Taken under the stop lock so that a shutdown starting now waits for this stop.
            let _stopping = inner.stop_lock.lock().unwrap_or_else(PoisonError::into_inner);
            let running = inner.lock().running.take();
            if let Some(running) = running {
                stop(inner, running);
            }
            return;
        }
        let Some(running) = state.running.as_mut() else {
            return;
        };
        match running.child.try_wait() {
            Ok(Some(status)) => {
                state.running = None;
                drop(state);
                inner.log(&format!("sidecar exited unexpectedly: {status}"));
                return;
            }
            Ok(None) => {}
            Err(error) => {
                drop(state);
                inner.log(&format!("sidecar wait failed: {error}"));
                return;
            }
        }
        drop(state);
        thread::sleep(EXIT_POLL_INTERVAL);
    }
}

fn shutdown(inner: &Inner) {
    let running = {
        let mut state = inner.lock();
        state.stopping = true;
        inner.unparked.notify_all();
        state.running.take()
    };
    // When a requested restart is stopping the sidecar right now, this waits until it is gone.
    let _stopping = inner.stop_lock.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(running) = running {
        stop(inner, running);
    }
}

/// Asks the sidecar to exit by closing its stdin (Windows has no POSIX signals) and kills
/// its process tree once `SIDECAR_SHUTDOWN_GRACE_MS` has passed. Callers hold `stop_lock`.
/// Stdin is closed by its writer thread; one stuck writing to a sidecar that does not read
/// gets out when the kill breaks the pipe.
fn stop(inner: &Inner, mut running: Running) {
    drop(running.stdin.take());
    let deadline = Instant::now() + Duration::from_millis(SIDECAR_SHUTDOWN_GRACE_MS);
    loop {
        if let Ok(Some(status)) = running.child.try_wait() {
            inner.log(&format!("sidecar pid={} exited after stdin closed: {status}", running.pid));
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    kill_tree(running.pid);
    let _ = running.child.wait();
    inner.log(&format!(
        "sidecar pid={} did not exit within {SIDECAR_SHUTDOWN_GRACE_MS} ms; process tree killed",
        running.pid
    ));
}

/// `taskkill /T` walks the process tree. Addressed by absolute path so neither PATH nor
/// the working directory decides which executable runs.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system_root = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
        let _ = Command::new(system_root.join("System32").join("taskkill.exe"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("/bin/kill").args(["-KILL", &pid.to_string()]).status();
    }
}

/// Parses `READY {"port":N,"pid":P}`, the single line the server prints when listening.
pub fn parse_ready(line: &str) -> Option<(u16, u32)> {
    let body = line.strip_prefix("READY ")?.trim();
    let body = body.strip_prefix('{')?.strip_suffix('}')?;
    let (mut port, mut pid) = (None, None);
    for field in body.split(',') {
        let (key, value) = field.split_once(':')?;
        match key.trim() {
            "\"port\"" => port = value.trim().parse().ok(),
            "\"pid\"" => pid = value.trim().parse().ok(),
            _ => {}
        }
    }
    Some((port?, pid?))
}

fn forward_lines(stream: impl Read + Send + 'static, log: PathBuf) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            append_log(&log, &line);
        }
    });
}

fn append_log(path: &Path, message: &str) {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{millis} {message}");
    }
}

/// 256-bit token from the operating system's CSPRNG, hex-encoded.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    fill_random(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(windows)]
pub fn fill_random(buffer: &mut [u8]) -> Result<(), String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(algorithm: *mut core::ffi::c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let length = u32::try_from(buffer.len()).map_err(|_| "token buffer too large".to_string())?;
    // SAFETY: the buffer pointer and length describe a live, writable slice, and a null
    // algorithm handle is valid together with BCRYPT_USE_SYSTEM_PREFERRED_RNG.
    let status =
        unsafe { BCryptGenRandom(core::ptr::null_mut(), buffer.as_mut_ptr(), length, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("BCryptGenRandom failed: {status:#x}"))
    }
}

#[cfg(not(windows))]
pub fn fill_random(buffer: &mut [u8]) -> Result<(), String> {
    fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(buffer))
        .map_err(|error| format!("read /dev/urandom: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ready_line() {
        assert_eq!(parse_ready(r#"READY {"port":51234,"pid":4321}"#), Some((51234, 4321)));
        assert_eq!(parse_ready(r#"READY {"pid":7,"port":80}"#), Some((80, 7)));
    }

    #[test]
    fn rejects_other_lines() {
        assert_eq!(parse_ready("listening"), None);
        assert_eq!(parse_ready(r#"READY {"port":"x","pid":1}"#), None);
        assert_eq!(parse_ready(r#"READY {"port":1}"#), None);
    }

    #[test]
    fn random_bytes_vary() {
        let (mut first, mut second) = ([0u8; FILE_GRANT_KEY_BYTES], [0u8; FILE_GRANT_KEY_BYTES]);
        fill_random(&mut first).unwrap();
        fill_random(&mut second).unwrap();
        assert_ne!(first, second);
        assert_eq!(base64url(&first).len(), 43);
    }

    #[test]
    fn token_is_256_bit_hex_and_varies() {
        let first = random_token().unwrap();
        assert_eq!(first.len(), TOKEN_BYTES * 2);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, random_token().unwrap());
    }
}
