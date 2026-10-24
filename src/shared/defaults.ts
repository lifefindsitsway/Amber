/**
 * Named defaults: the thresholds, counts, capacities, timeouts, budgets and default keys
 * Amber is tuned by. This file is their only definition: code elsewhere imports the name
 * and never restates the number, so changing a value means changing it here and nowhere
 * else.
 */

/** Last cue end / media duration below this marks platform subtitles `invalid`. */
export const SUBTITLE_COVERAGE_MIN = 0.9;
/** Last cue end / media duration above this means subtitles do not match the media. */
export const SUBTITLE_COVERAGE_MAX = 1.05;
/** Maximum share of music-only or empty cues before subtitles are `invalid`. */
export const MUSIC_LINE_RATIO_MAX = 0.5;

/** Sentences per proofreading chunk; one chunk is one WorkUnit. */
export const PROOFREAD_CHUNK_SENTENCES = 150;
/** Read-only context sentences before and after each proofreading chunk. */
export const PROOFREAD_CONTEXT_SENTENCES = 10;
/** Proofreading ranges one chunk may split into, the chunk itself included. */
export const PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT = 31;
/** Proofreading ranges a whole stage run may add by splitting, chunks not counted. */
export const PROOFREAD_SPLIT_MAX_EXTRA_UNITS = 64;

/** Upper bound on key terms passed to ASR. */
export const ASR_KEYTERMS_MAX = 1000;
/** Lower bound of the HTTP timeout for whole-file ASR submission, in minutes. */
export const ASR_HTTP_TIMEOUT_MIN = 30;
/** First wait before asking an asynchronous ASR job for its state, in milliseconds. */
export const ASR_POLL_INTERVAL_MS = 5000;
/** Longest wait between two state queries of one ASR job, in milliseconds. */
export const ASR_POLL_INTERVAL_MAX_MS = 30000;
/** Safety bound on waiting for one asynchronous ASR job, in hours. */
export const ASR_JOB_MAX_WAIT_HOURS = 24;
/** Upper bound on an ASR job's result file read into memory, in megabytes. */
export const ASR_RESULT_MAX_MB = 64;
/** Length of the generated sound an ASR model test transcribes, in milliseconds. */
export const ASR_TEST_AUDIO_MS = 2000;
/** How long an ASR model test waits for its result, in milliseconds; below common proxy timeouts. */
export const ASR_TEST_TIMEOUT_MS = 45000;
/** Wait between state queries of an ASR model test's job, in milliseconds. */
export const ASR_TEST_POLL_INTERVAL_MS = 2000;

/** Invalid citation ratio above which one citation repair is attempted. */
export const CITATION_INVALID_RATIO_MAX = 0.05;
/** Default AI highlight score threshold (0–100). */
export const HIGHLIGHT_THRESHOLD_DEFAULT = 80;
/** Lectures per group in collection rollup. */
export const COLLECTION_PARTIAL_SIZE = 5;

/** Lines per translation batch; one batch is one WorkUnit. */
export const TRANSLATE_BATCH_LINES = 40;

/** Tolerance for "nearest startMs" when jumping to the same sentence across revisions. */
export const SEEK_MATCH_TOLERANCE_MS = 3000;

/** Recent turns kept verbatim by the chat context policy. */
export const CHAT_RECENT_TURNS = 6;
/** Share of the context window that "full text" chat mode may occupy. */
export const CONTEXT_SAFETY_RATIO = 0.7;

/** Queries up to this many characters use the short-query fallback. */
export const SEARCH_SHORT_QUERY_MAX_CHARS = 2;
/** Result cap for the short-query fallback. */
export const SEARCH_SHORT_QUERY_LIMIT = 200;

/** Total size cap of the data directory excluding the media cache directory, in GB. */
export const MAX_DATA_GB = 30;
/** New tasks pause when free space drops below this, in GB. */
export const LOW_WATER_FREE_GB = 10;
/** New tasks pause when the free-space ratio drops below this; 0 leaves only the absolute floor. */
export const LOW_WATER_FREE_RATIO = 0;
/** Per-file upload cap, in GB. */
export const MAX_UPLOAD_GB = 10;
/** Default retention policy for `managed_upload` assets. */
export const UPLOAD_RETENTION_DEFAULT = "keep";
/** Maximum items imported at once from a collection or playlist. */
export const IMPORT_BATCH_MAX = 50;

/** Tasks processed at once, shared by every task kind; also the capacity of the managed heavy-job governor. */
export const CONCURRENCY_PIPELINE = 2;
/** Highest settable `CONCURRENCY_PIPELINE`. */
export const CONCURRENCY_PIPELINE_MAX = 5;

/** Initial window of an LLM lane (one per profile × model): requests it lets in flight before any feedback. */
export const LLM_WINDOW_INITIAL = 3;
/** Rate-limit / overload cooldown base without `retry-after`: limit round n waits `BASE × 3^(n−1)`. */
export const LLM_COOLDOWN_BASE_MS = 5000;
/** Cap of a locally computed cooldown; never applied to the upstream's `retry-after`. */
export const LLM_COOLDOWN_MAX_MS = 120000;
/** Highest random extension of a locally computed cooldown, as a share of it. */
export const LLM_COOLDOWN_JITTER = 0.5;

/** Automatic retries for `safe` and `policy` failures. */
export const RETRY_MAX = 3;
/** Backoff base: attempt n waits `RETRY_BASE_MS × 2^(n−1)`. */
export const RETRY_BASE_MS = 2000;

/** Login attempts per minute, keyed by IP and username. */
export const LOGIN_RATE_PER_MIN = 5;
/** Sliding session lifetime, in days. */
export const SESSION_SLIDING_DAYS = 30;
/** Minimum password length. */
export const PASSWORD_MIN_LEN = 12;
/** Lifetime of the one-time server setup token, in minutes. */
export const SETUP_TOKEN_TTL_MIN = 30;

/** Maximum entries in one TerminologySet. */
export const TERMINOLOGY_MAX_ENTRIES = 1000;
/** Maximum characters of a single term. */
export const TERMINOLOGY_TERM_MAX_CHARS = 50;
/** Maximum characters of a custom summary template prompt. */
export const PROMPT_CUSTOM_MAX_CHARS = 8000;

/** Time to wait for the sidecar READY line. */
export const SIDECAR_READY_TIMEOUT_MS = 15000;
/** Automatic sidecar restarts after crashes. */
export const SIDECAR_RESTART_MAX = 3;
/** Grace period after asking the sidecar to exit before its process tree is killed. */
export const SIDECAR_SHUTDOWN_GRACE_MS = 5000;

/** Items shown for the expanded current collection in the sidebar. */
export const SIDEBAR_COLLECTION_ITEMS = 10;
/** Items shown under "recent" in the sidebar. */
export const SIDEBAR_RECENT_ITEMS = 10;
/** Rows per page of a list page until the user picks another size. */
export const LIST_PAGE_SIZE_DEFAULT = 10;
/** Finished Tasks the task panel's history loads per page. */
export const TASK_HISTORY_PAGE_SIZE = 20;

/** Below this width the right pane collapses into a drawer, in px. */
export const BREAKPOINT_DRAWER_PX = 1100;
/** Below this width the layout switches to single-pane tabs, in px. */
export const BREAKPOINT_SINGLE_PX = 768;

/** Default "new summary" shortcut; page takeover verified in Firefox and WebView2. */
export const SHORTCUT_NEW_SUMMARY_DEFAULT = "Ctrl+Shift+O";
/** Default Omnibox shortcut. */
export const SHORTCUT_OMNIBOX_DEFAULT = "Ctrl+K";

/** SQLite lock wait in ms; equal to the better-sqlite3 default, declared explicitly. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
/** Interval of SSE comment-line heartbeats so reverse proxies do not drop idle streams. */
export const SSE_HEARTBEAT_MS = 15000;
/** Default and maximum `limit` for paginated lists and segment pages. */
export const API_PAGE_SIZE_DEFAULT = 100;
export const API_PAGE_SIZE_MAX = 1000;
/** Most ids one `GET /contents?ids=` may name: the three content-side search groups at their limit. */
export const CONTENT_LIST_IDS_MAX = 60;
/** Default listening port in server mode. */
export const SERVER_PORT_DEFAULT = 3000;

/** Coverage within `[SUBTITLE_COVERAGE_MIN, MIN + MARGIN)` is `suspicious` rather than `valid`. */
export const SUBTITLE_SUSPICIOUS_MARGIN = 0.05;
/** Largest gap allowed between adjacent platform cues before the track is `suspicious`. */
export const SUBTITLE_GAP_MAX_MS = 120000;

/** Character budget of the rolling `carry` summary. */
export const ROLLUP_CARRY_BUDGET_CHARS = 1500;
/** Character budget of a chat compaction body. */
export const CHAT_COMPACTION_BUDGET_CHARS = 1500;
/** FTS hits taken in retrieval mode, and neighbouring segments attached to each hit. */
export const CHAT_RETRIEVAL_HITS_MAX = 20;
export const CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS = 2;
/** Conservative token estimate: characters per token for non-CJK text, tokens per CJK character. */
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
export const TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR = 1.5;

/** Login backoff after the rate limit: `Retry-After = BASE × 2^(n−1)`, capped. */
export const LOGIN_BACKOFF_BASE_MS = 2000;
export const LOGIN_BACKOFF_MAX_MS = 300000;
/** argon2id parameters (OWASP minimum recommendation: 19 MiB, 2 iterations, parallelism 1). */
export const ARGON2_MEMORY_KIB = 19456;
export const ARGON2_ITERATIONS = 2;
export const ARGON2_PARALLELISM = 1;

/** `H` in the yt-dlp format expression used when caching platform video. */
export const CACHE_MEDIA_MAX_HEIGHT = 1080;
/** Longest stem (without extension) of a cached media file name, in code points. */
export const CACHE_FILE_NAME_MAX_CHARS = 100;
/** Bitrate of audio caches transcoded to MP3, in kbit/s. */
export const CACHE_AUDIO_MP3_KBPS = 128;
/** Polling interval of the QR login status endpoint. */
export const QR_POLL_INTERVAL_MS = 2000;
/** How often the storage page re-reads a cache move in progress. */
export const CACHE_MIGRATION_REFRESH_MS = 1000;

/** Timeout of ffprobe / magic-number probing. */
export const MEDIA_PROBE_TIMEOUT_MS = 60000;
/** Leading bytes read for MIME sniffing. */
export const MEDIA_SNIFF_BYTES = 8192;
/** Upper bound of subtitle and cookie text imports, in bytes (20 MiB). */
export const SUBTITLE_IMPORT_MAX_BYTES = 20971520;
/** Maximum length of `MediaAsset.displayName`. */
export const DISPLAY_NAME_MAX_CHARS = 255;

/** Timeout of the synchronous platform metadata fetch done by import / inspect. */
export const PLATFORM_METADATA_TIMEOUT_MS = 30000;
/** yt-dlp `--socket-timeout`, in seconds. */
export const YTDLP_SOCKET_TIMEOUT_S = 30;
/** Maximum hops when expanding a platform short link. */
export const SHORTLINK_MAX_HOPS = 3;

/**
 * Longest wait from handing the encoded request to outbound HTTP until the model first
 * produces something (non-empty answer text or reasoning), response headers included.
 * Heartbeats, empty deltas and metadata events do not count; a non-streaming request
 * counts once the whole answer has arrived. On expiry the request is aborted and
 * classified by the send boundary.
 */
export const LLM_FIRST_OUTPUT_TIMEOUT_MS = 300000;
/**
 * Once the model produces, the longest upstream wait between two outputs before the call
 * counts as `outcome_unknown`. Heartbeats do not reset it; time spent by the consumer on
 * delivered text is not counted.
 */
export const LLM_STREAM_IDLE_TIMEOUT_MS = 60000;
/** Timeout of one "test connection" request. */
export const LLM_PROBE_TIMEOUT_MS = 20000;
/** `max_tokens` of "test connection" requests. */
export const LLM_PROBE_MAX_OUTPUT_TOKENS = 256;
/** `maxOutputTokens` default for protocols that require it when no capability declares one. */
export const LLM_MAX_OUTPUT_TOKENS_DEFAULT = 8192;

/** Audio-assisted proofreading falls back to text for a chunk whose audio exceeds this, in MB. */
export const PROOFREAD_AUDIO_MAX_MB = 12;
/** Candidate sentences offered per invalid alias during citation repair. */
export const CITATION_REPAIR_CANDIDATES = 20;
/** Search results per group. */
export const SEARCH_GROUP_LIMIT = 20;
/** Floor of recent chat turns carried when compaction still overflows the budget. */
export const CHAT_RECENT_TURNS_MIN = 2;
/** Fallback for revisions without paragraph marks: a pause between sentences that starts a new reading paragraph. */
export const PARAGRAPH_GAP_MS = 2000;
/**
 * Fallback for revisions without paragraph marks: a readability soft cap, not a
 * semantic boundary. Past it the paragraph ends at the next sentence end; at twice the cap it
 * ends before the next sentence. A segment is never split.
 */
export const PARAGRAPH_MAX_CHARS = 200;

/** Default shortcut of the shortcut help sheet. */
export const SHORTCUT_HELP_DEFAULT = "Ctrl+/";
/** Default theme. */
export const THEME_DEFAULT = "light";
/** Default UI and output language. */
export const UI_LANGUAGE_DEFAULT = "zh-CN";
/** Default browser for the client's `--cookies-from-browser`. */
export const PLATFORM_COOKIE_BROWSER_DEFAULT = "firefox";
/** Skip step of the local player, in seconds. */
export const PLAYER_SKIP_SECONDS = 10;
/** Volume step of the local player's Up / Down keys; volume runs from 0 to 1. */
export const PLAYER_VOLUME_STEP = 0.1;
/** Idle time after which the local player hides its controls while playing. */
export const PLAYER_CONTROLS_IDLE_MS = 3000;
/** SSE reconnect backoff: base and cap. */
export const SSE_RECONNECT_BASE_MS = 1000;
export const SSE_RECONNECT_MAX_MS = 30000;

/** Throttle of `Session.lastSeenAt` writes, in minutes. */
export const SESSION_TOUCH_INTERVAL_MIN = 5;
/** Upper bound on waiting for a user's Tasks and chat answers to stop before the account is deleted. */
export const USER_DELETE_DRAIN_TIMEOUT_MS = 10000;
/** Length cap of one note's comment, in characters. */
export const NOTE_COMMENT_MAX_CHARS = 2000;
/** Most sentences one note may span. */
export const NOTE_SPAN_MAX_SEGMENTS = 20;
/** Most notes one Content may hold. */
export const NOTES_PER_CONTENT_MAX = 500;
/** Days a Content stays in the trash; after that it is purged and can no longer be restored. */
export const TRASH_RETENTION_DAYS = 30;
/** Retry backoff of pending file deletions and deferred trash purges: base and cap. */
export const TRASH_RETRY_BASE_MS = 60000;
export const TRASH_RETRY_MAX_MS = 21600000;
/** Expired trash entries purged per sweep batch. */
export const TRASH_SWEEP_BATCH = 200;
/** Maximum redirect hops followed by the outbound HTTP client. */
export const OUTBOUND_MAX_REDIRECTS = 5;
/** Default lifetime of a QR login attempt when the platform gives no expiry. */
export const QR_ATTEMPT_TTL_MS = 180000;
/** Seek accuracy tolerance of the local player. */
export const PLAYER_SEEK_TOLERANCE_MS = 500;
/** Space a video cache download reserves on the cache volume, as a multiple of its estimated size (separate streams plus the merge). */
export const CACHE_DOWNLOAD_PEAK_FACTOR = 2;
/** Per-volume reservation of a cache download whose size or duration is unknown, in GB. */
export const CACHE_UNKNOWN_SIZE_RESERVE_GB = 2;
/** How often a running cache download re-reads the free space of both volumes. */
export const CACHE_DISK_CHECK_INTERVAL_MS = 5000;
/** Lifetime of a local file grant issued by the desktop shell. */
export const FILE_GRANT_TTL_MS = 300000;
/**
 * Subtitle appearance defaults. Lengths are 1080p picture pixels, the unit
 * of ASS at `PlayResY: 1080`; colours are `#RRGGBB`.
 */
export const SUBTITLE_ORIGINAL_FONT_SIZE = 48;
export const SUBTITLE_TRANSLATION_FONT_SIZE = 44;
export const SUBTITLE_ORIGINAL_COLOR = "#FFFFFF";
export const SUBTITLE_TRANSLATION_COLOR = "#FFFF00";
export const SUBTITLE_OUTLINE_COLOR = "#000000";
export const SUBTITLE_OUTLINE_WIDTH = 2;
export const SUBTITLE_BACKGROUND_COLOR = "#000000";
export const SUBTITLE_BACKGROUND_OPACITY_PCT = 50;
export const SUBTITLE_BACKGROUND_PADDING = 12;
/** Default subtitle anchor, in basis points of the picture width / height; the anchor is the block's bottom edge. */
export const SUBTITLE_PLACEMENT_X_BP = 5000;
export const SUBTITLE_PLACEMENT_Y_BP = 9200;
/** Bounds of the subtitle style fields. */
export const SUBTITLE_FONT_SIZE_MIN = 16;
export const SUBTITLE_FONT_SIZE_MAX = 120;
export const SUBTITLE_OUTLINE_WIDTH_MAX = 8;
export const SUBTITLE_BACKGROUND_PADDING_MAX = 40;
/** Widest a subtitle block may be, as a share of the picture width (ASS `MarginL/R` follow from it). */
export const SUBTITLE_WRAP_RATIO = 0.8;
/** CSS `font-size` per ASS `Fontsize` with the bundled font: libass sizes a font by ascender + descender. */
export const SUBTITLE_ASS_EM_RATIO = 0.6906;
/** A dragged block whose top / bottom edge lies within this many basis points of the picture edge anchors there. */
export const SUBTITLE_EDGE_ZONE_BP = 3333;
/** Arrow-key steps of the subtitle editor, in basis points: plain and with Shift. */
export const SUBTITLE_NUDGE_BP = 10;
export const SUBTITLE_NUDGE_FAST_BP = 100;
/** AAC bitrate for audio tracks a hard-subtitle export must re-encode, in kbit/s. */
export const SUBTITLE_VIDEO_AUDIO_KBPS = 192;
/** Size cap when the web client reads the bundled subtitle font. */
export const SUBTITLE_FONT_MAX_BYTES = 33554432;
/** How long a "saved to …" notice stays before it dismisses itself. */
export const SAVE_NOTICE_DISMISS_MS = 30000;
/** Timeout of one update check against the release feed. */
export const UPDATE_CHECK_TIMEOUT_MS = 15000;
/** How long the maintenance state entered before an update install lasts unless released first. */
export const UPDATE_INSTALL_MAINTENANCE_TTL_MS = 600000;
/** Poll interval of a running backup export's progress. */
export const BACKUP_PROGRESS_POLL_MS = 1000;
/** Size cap of one UI preference value carried in a backup. */
export const BACKUP_UI_PREFERENCE_MAX_BYTES = 4096;
/** Size cap of all UI preferences carried in a backup together (1 MiB). */
export const BACKUP_UI_PREFERENCES_MAX_BYTES = 1048576;
/** Size cap of a backup's `header.json` (32 MiB). */
export const BACKUP_HEADER_MAX_BYTES = 33554432;
/** Size cap of a backup's `manifest.json` (32 MiB). */
export const BACKUP_MANIFEST_MAX_BYTES = 33554432;
