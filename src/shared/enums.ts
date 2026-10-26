/**
 * Closed value sets shared by server and web. The arrays are the single source;
 * types are derived from them so runtime validation and static types cannot drift.
 * These are the canonical names of the domain model: code, DTOs and stored rows use these
 * members and never introduce synonyms.
 */

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const RUN_MODES = ["local", "server"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * Supported platforms, the single enumeration shared by server and web.
 * Application and pipeline code must not branch on these literals; platform-specific
 * behavior lives in `adapters/platform/<name>/` behind `PlatformSourceAdapter`.
 */
export const PLATFORMS = ["bilibili", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CONTENT_SOURCE_KINDS = [...PLATFORMS, "local"] as const;
export type ContentSourceKind = (typeof CONTENT_SOURCE_KINDS)[number];

/** Result of the last credential check; `unknown` until checked or when the check was inconclusive. */
export const PLATFORM_ACCOUNT_STATUSES = ["valid", "expired", "unknown"] as const;
export type PlatformAccountStatus = (typeof PLATFORM_ACCOUNT_STATUSES)[number];

/** Where a QR login attempt stands. */
export const PLATFORM_QR_STATUSES = ["pending", "scanned", "confirmed", "expired"] as const;
export type PlatformQrStatus = (typeof PLATFORM_QR_STATUSES)[number];

export const MEDIA_ASSET_KINDS = [
  "external_local",
  "managed_upload",
  "platform_cache",
  "extracted_audio",
  "temporary",
] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

export const TRANSCRIPT_KINDS = ["platform", "imported", "asr", "manual", "corrected", "translated"] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

export const TIMING_FIDELITIES = ["exact_words", "inherited_segment", "segment_only"] as const;
export type TimingFidelity = (typeof TIMING_FIDELITIES)[number];

export const STAGE_IDS = [
  "source",
  "media",
  "subtitle",
  "asr",
  "proofread",
  "chapter",
  "summary",
  "highlight",
  "translate",
  "collection_summary",
  "burn",
  "cache_media",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_STATUSES = [
  "pending",
  "waiting_configuration",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const WORK_UNIT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "waiting_user_action",
  "interrupted",
  "cancelled",
] as const;
export type WorkUnitStatus = (typeof WORK_UNIT_STATUSES)[number];

/** Skip conditions: evaluated when the stage is reached; false means `skipped`. */
export const STAGE_CONDITION_IDS = [
  "needs_asr",
  "auto_proofread_enabled",
  "no_platform_chapters",
  "is_local_file",
  "client_only",
] as const;
export type StageConditionId = (typeof STAGE_CONDITION_IDS)[number];

/** ASR providers with an adapter; adding one means a new adapter plus a member here. */
export const ASR_PROVIDERS = ["elevenlabs", "dashscope"] as const;
export type AsrProviderId = (typeof ASR_PROVIDERS)[number];

/** Run requirements: unmet means `waiting_configuration`; declared in the graph, never persisted on a StageRun. */
export const STAGE_REQUIREMENT_IDS = ["llm_configured", "asr_configured"] as const;
export type StageRequirementId = (typeof STAGE_REQUIREMENT_IDS)[number];

export const TASK_KINDS = [
  "process_content",
  "regenerate_summary",
  "reproofread",
  "retranscribe",
  "regenerate_chapters",
  "recompute_highlights",
  "translate",
  "summarize_collection",
  "burn",
  "cache_media",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * Rebuildable projection of StageRun / WorkUnit state, shared by `Task.statusProjection`
 * and `Content.processingStatus`. Never a source of truth.
 */
export const PROCESSING_STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/** Retention choices for `managed_upload` offered as the instance default. */
export const UPLOAD_RETENTION_POLICIES = ["keep", "discard_after_audio"] as const;
export type UploadRetentionPolicy = (typeof UPLOAD_RETENTION_POLICIES)[number];

export const TOKEN_USAGE_FEATURES = [
  "summary",
  "proofread",
  "chapter",
  "highlight",
  "chat",
  "chat_compaction",
  "chat_search_plan",
  "translate",
  "collection_summary",
  "citation_repair",
  "test_connection",
] as const;
export type TokenUsageFeature = (typeof TOKEN_USAGE_FEATURES)[number];

/** What an ASR call was for: a Task's transcription or a model's "test connection". */
export const ASR_USAGE_FEATURES = ["transcribe", "test_connection"] as const;
export type AsrUsageFeature = (typeof ASR_USAGE_FEATURES)[number];

export const CHAT_MESSAGE_STATUSES = ["streaming", "complete", "interrupted", "failed"] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

/** Web search of one chat message: none, when the model judges it useful, or this time for sure. */
export const WEB_SEARCH_MODES = ["off", "auto", "force"] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];
/** The remembered setting; `force` applies to one message only and is never stored. */
export const CHAT_WEB_SEARCH_SETTINGS = ["off", "auto"] as const;
export type ChatWebSearchSetting = (typeof CHAT_WEB_SEARCH_SETTINGS)[number];
/** Outcome of one answer's web search. */
export const WEB_SEARCH_STATUSES = ["searched", "partial", "failed", "skipped", "dropped"] as const;
export type WebSearchStatus = (typeof WEB_SEARCH_STATUSES)[number];
/** Why a search was `skipped` or `dropped`. */
export const WEB_SEARCH_REASONS = ["unconfigured", "not_needed", "planner_failed", "budget"] as const;
export type WebSearchReason = (typeof WEB_SEARCH_REASONS)[number];
/** Search services; adding one = an adapter + a member here. */
export const WEB_SEARCH_SERVICES = ["tavily"] as const;
export type WebSearchService = (typeof WEB_SEARCH_SERVICES)[number];

export const TRI_STATES = ["supported", "unsupported", "unknown"] as const;
export type Tri = (typeof TRI_STATES)[number];

export const LLM_PROTOCOLS = ["openai_compatible", "anthropic_messages"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

export const FRESHNESS_VALUES = ["fresh", "stale"] as const;
export type Freshness = (typeof FRESHNESS_VALUES)[number];

/** What a DTO says about a stored credential; `unavailable` = ciphertext exists but the master key cannot decrypt it. */
export const CREDENTIAL_STATUSES = ["missing", "configured", "unavailable"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** Height tiers a `cache_media` Task may ask for; the default is `CACHE_MEDIA_MAX_HEIGHT`. */
export const CACHE_MEDIA_QUALITIES = [360, 480, 720, 1080] as const;
export type CacheMediaQuality = (typeof CACHE_MEDIA_QUALITIES)[number];

/** What a `burn` Task writes into the picture: the original, its translation, or both. */
export const BURN_MODES = ["original", "translation", "bilingual"] as const;
export type BurnMode = (typeof BURN_MODES)[number];

/** How a subtitled video is exported: burned into the picture, or muxed as subtitle tracks. */
export const SUBTITLE_DELIVERIES = ["hard", "soft"] as const;
export type SubtitleDelivery = (typeof SUBTITLE_DELIVERIES)[number];

/** Containers a subtitled video export may produce; a hard-subtitle export is always MP4. */
export const SUBTITLE_VIDEO_CONTAINERS = ["mp4", "mkv"] as const;
export type SubtitleVideoContainer = (typeof SUBTITLE_VIDEO_CONTAINERS)[number];

/** Which edge of the subtitle block its stored y coordinate is. */
export const SUBTITLE_ANCHORS = ["top", "center", "bottom"] as const;
export type SubtitleAnchor = (typeof SUBTITLE_ANCHORS)[number];

/** Line order of a bilingual subtitle. */
export const SUBTITLE_BILINGUAL_ORDERS = ["original_first", "translation_first"] as const;
export type SubtitleBilingualOrder = (typeof SUBTITLE_BILINGUAL_ORDERS)[number];

/** Which lines of a bilingual subtitle the background box covers: one block around both, or one line only. */
export const SUBTITLE_BACKGROUND_SCOPES = ["both", "original", "translation"] as const;
export type SubtitleBackgroundScope = (typeof SUBTITLE_BACKGROUND_SCOPES)[number];

/** How a note marks its text: a coloured underline or a coloured background (UI "高亮"). */
export const NOTE_MARKS = ["underline", "background"] as const;
export type NoteMark = (typeof NOTE_MARKS)[number];

/** The palette a note may use. */
export const NOTE_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/** What the local player does when it reaches the end. */
export const PLAYER_END_BEHAVIORS = ["pause", "loop_one", "loop_list"] as const;
export type PlayerEndBehavior = (typeof PLAYER_END_BEHAVIORS)[number];
