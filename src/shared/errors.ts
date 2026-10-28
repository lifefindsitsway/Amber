import { z } from "zod";

/**
 * What the system may do after a failure. Not a boolean "retryable".
 * Invariant: `outcome_unknown` means a paid request was sent but its result never arrived,
 * so it is never re-sent without user confirmation.
 */
export const RETRY_DISPOSITIONS = ["safe", "policy", "outcome_unknown", "never"] as const;
export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const ERROR_ACTIONS = [
  "retry_stage",
  "configure_llm",
  "configure_asr",
  "configure_web_search",
  "login_platform",
  "confirm_resend",
  "none",
] as const;
export type ErrorAction = (typeof ERROR_ACTIONS)[number];

/**
 * The error catalogue: every class an `AppError` may carry. `ERROR_CLASS_DEFAULTS` gives each
 * its default retry disposition and action; refined codes live in the registry below.
 */
export const ERROR_CLASSES = [
  "source_unsupported_url",
  "source_unreachable",
  "source_html_error_page",
  "platform_blocked",
  "auth_required",
  "paid_content",
  "browser_cookies_unavailable",
  "media_no_audio",
  "media_too_long",
  "media_too_large",
  "media_unsupported_type",
  "media_missing",
  "media_changed",
  "subtitle_none",
  "subtitle_incomplete",
  "asr_unconfigured",
  "asr_quota",
  "asr_timeout",
  "asr_failed",
  "llm_unconfigured",
  "llm_capability",
  "web_search_failed",
  "llm_rate_limited",
  "llm_outcome_unknown",
  "llm_failed",
  "output_mismatch",
  "citation_degraded",
  "network_blocked_by_policy",
  "disk_low",
  "idempotency_conflict",
  "schema_version_unsupported",
  "backup_invalid",
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "rate_limited",
  "storage_quota_exceeded",
  "internal",
  "cancelled",
  "interrupted",
  "unknown",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export interface ErrorClassDefaults {
  /** `null` for internal states that are not surfaced as retryable failures: they have no default disposition. */
  retryDisposition: RetryDisposition | null;
  action?: ErrorAction;
}

export const ERROR_CLASS_DEFAULTS: Readonly<Record<ErrorClass, ErrorClassDefaults>> = {
  source_unsupported_url: { retryDisposition: "never" },
  source_unreachable: { retryDisposition: "safe" },
  source_html_error_page: { retryDisposition: "policy" },
  platform_blocked: { retryDisposition: "never", action: "login_platform" },
  auth_required: { retryDisposition: "never" },
  paid_content: { retryDisposition: "never" },
  browser_cookies_unavailable: { retryDisposition: "never", action: "login_platform" },
  media_no_audio: { retryDisposition: "never" },
  media_too_long: { retryDisposition: "never" },
  media_too_large: { retryDisposition: "never" },
  media_unsupported_type: { retryDisposition: "never" },
  media_missing: { retryDisposition: "never" },
  media_changed: { retryDisposition: "never" },
  subtitle_none: { retryDisposition: null },
  subtitle_incomplete: { retryDisposition: null },
  asr_unconfigured: { retryDisposition: "never", action: "configure_asr" },
  asr_quota: { retryDisposition: "never" },
  asr_timeout: { retryDisposition: "outcome_unknown", action: "confirm_resend" },
  asr_failed: { retryDisposition: "policy" },
  llm_unconfigured: { retryDisposition: "never", action: "configure_llm" },
  llm_capability: { retryDisposition: "never" },
  // Recorded on the answer and shown beside it; only `.unconfigured` refuses a request.
  web_search_failed: { retryDisposition: "never" },
  llm_rate_limited: { retryDisposition: "policy" },
  llm_outcome_unknown: { retryDisposition: "outcome_unknown" },
  llm_failed: { retryDisposition: "policy" },
  output_mismatch: { retryDisposition: "policy" },
  citation_degraded: { retryDisposition: null },
  network_blocked_by_policy: { retryDisposition: "never" },
  disk_low: { retryDisposition: "never" },
  idempotency_conflict: { retryDisposition: "never" },
  schema_version_unsupported: { retryDisposition: "never" },
  backup_invalid: { retryDisposition: "never" },
  unauthenticated: { retryDisposition: "never" },
  forbidden: { retryDisposition: "never" },
  not_found: { retryDisposition: "never" },
  invalid_request: { retryDisposition: "never" },
  conflict: { retryDisposition: "never" },
  rate_limited: { retryDisposition: "never" },
  storage_quota_exceeded: { retryDisposition: "never" },
  internal: { retryDisposition: "never" },
  cancelled: { retryDisposition: null },
  // Interrupted work is re-queued by crash recovery rather than retried by disposition.
  interrupted: { retryDisposition: null },
  unknown: { retryDisposition: "never" },
};

/**
 * What a refined code may override or carry: the class default disposition / action
 * (a bad API key must not be retried like a generic upstream failure) and the keys its
 * `details` may use. Keys not listed here are rejected by the schema.
 */
export interface RefinedErrorCodeSpec {
  retryDisposition?: RetryDisposition;
  action?: ErrorAction;
  detailsKeys?: readonly string[];
}

/**
 * Refined codes `<class>.<detail>`. This registry is the only place a
 * refined code may be introduced; everything else uses the bare class as its code.
 */
export const REFINED_ERROR_CODE_REGISTRY = {
  // The master key is absent or cannot decrypt the stored envelope.
  "internal.secret_unavailable": {},
  // ffprobe / ffmpeg / yt-dlp could not be started or timed out.
  "internal.tool_failed": {},
  // Another unfinished Task on the same target touches an overlapping stage set.
  "conflict.mutation_lane": {},
  // The instance setting is fixed by its environment variable and read-only.
  "conflict.setting_env_overridden": {},
  // A file with the same fingerprint already belongs to another Content; `trashed` when that Content is in the trash.
  "conflict.duplicate_file": { detailsKeys: ["duplicateOfContentId", "trashed"] },
  // The primary transcript changed since the draft was opened.
  "conflict.primary_changed": { detailsKeys: ["currentPrimaryRevisionId"] },
  "conflict.last_admin": {},
  "conflict.username_taken": {},
  // Deleting a user while its Tasks still shut down.
  "conflict.tasks_still_running": {},
  // Deleting a Content, or one of its media files, while one of its Tasks is unfinished.
  "conflict.tasks_unfinished": {},
  // The video cache is being moved to another directory.
  "conflict.cache_migrating": {},
  // The previous cache move still has old files to remove.
  "conflict.cache_cleanup_pending": {},
  "conflict.cache_name_taken": { detailsKeys: ["fileName", "holderContentId", "holderTitle", "actualHeight"] },
  "conflict.cache_name_pending": {},
  // A cache download that does not fit the free space above the low-water mark of one volume.
  "disk_low.cache_volume": { detailsKeys: ["volume", "needBytes", "freeBytes", "lowWaterBytes"] },
  "conflict.cache_file_busy": {},
  "conflict.cache_file_foreign": {},
  "conflict.cache_recovery_pending": {},
  "conflict.revision_is_primary": {},
  "conflict.summary_revision_in_use": { detailsKeys: ["reason"] },
  "conflict.revision_referenced": { detailsKeys: ["children", "draft", "notes", "highlights", "chatMessages", "artifacts", "activeTasks", "history"] },
  // The custom cache directory is not reachable: drive unplugged or directory removed.
  "conflict.cache_unavailable": {},
  // Purging a Content while one of its chat answers is still streaming.
  "conflict.chat_inflight": {},
  // A retry may only replace the effective answer of a thread's last turn.
  "conflict.chat_retry_not_last": {},
  // The quoted sentence of the retried question can no longer be read.
  "conflict.chat_quote_unavailable": {},
  // An idempotent replay whose answer the user has since deleted; nothing is sent again.
  "not_found.chat_answer_deleted": {},
  // Restoring a Content whose trash retention has run out.
  "conflict.trash_expired": {},
  // Another backup export is running, or the cache gate is held by one.
  "conflict.backup_in_progress": {},
  // A restore target that is not a fresh installation; `nonEmpty` names what it already holds.
  "conflict.library_not_empty": { detailsKeys: ["nonEmpty"] },
  // The sidecar is in maintenance before an update install and refuses changes.
  "conflict.maintenance": {},
  // The start-up sweep and recovery have not finished yet.
  "conflict.starting_up": {},
  // Failures before the last request chunk reached the socket are safe to retry.
  "llm_failed.unreachable": { retryDisposition: "safe" },
  "llm_failed.auth": { retryDisposition: "never", action: "configure_llm" },
  "llm_failed.quota": { retryDisposition: "never" },
  // The upstream is temporarily overloaded; the wait comes from the model lane's cooldown.
  "llm_failed.overloaded": { retryDisposition: "policy", detailsKeys: ["retryAfterMs"] },
  // A limit answer that does not tell a rate limit from an exhausted quota: not guessed.
  "llm_failed.limit_ambiguous": { retryDisposition: "never" },
  "llm_failed.invalid_request": { retryDisposition: "never" },
  "llm_failed.model_not_found": { retryDisposition: "never" },
  // A safety refusal: the same request to the same model is usually refused again.
  "llm_failed.refused": { retryDisposition: "never" },
  // A rate limit that says when to try again: the upstream's `retry-after`, or the lane's remaining cooldown.
  "llm_rate_limited.retry_after": { detailsKeys: ["retryAfterMs"] },
  "llm_capability.context_length": {},
  // The model has no effective context window, so no input bound can be planned.
  "llm_capability.context_window_unknown": { detailsKeys: ["providerProfileId", "modelId"] },
  // A chat retry whose original model is no longer configured; the client asks before using another.
  "llm_unconfigured.model_missing": { detailsKeys: ["providerProfileId", "modelId"] },
  "web_search_failed.unconfigured": { action: "configure_web_search" },
  "web_search_failed.auth": { action: "configure_web_search" },
  "web_search_failed.quota": {},
  "web_search_failed.rate_limited": { retryDisposition: "policy", detailsKeys: ["retryAfterMs"] },
  "web_search_failed.unreachable": { retryDisposition: "safe" },
  "web_search_failed.invalid_query": {},
  // `reason`: too_large, bad_response or server_error.
  "web_search_failed.unavailable": { retryDisposition: "policy", detailsKeys: ["reason"] },
  // A proofread answer whose lines do not match its sentences one to one; the details count
  // and name what went wrong but never carry text.
  "output_mismatch.proofread_lines": {
    detailsKeys: [
      "expectedCount",
      "nonBlankLineCount",
      "validUniqueAliasCount",
      "missingAliases",
      "duplicateAliases",
      "outOfRangeAliases",
      "invalidLineCount",
      "stopReason",
      "truncatedTail",
    ],
  },
  // Splitting a mismatched proofread range would pass a split budget; the same
  // model would hit it again, so it is not retried.
  "output_mismatch.proofread_split_limit": {
    retryDisposition: "never",
    detailsKeys: [
      "rootIndex",
      "firstAlias",
      "lastAlias",
      "depth",
      "rootUnitsUsed",
      "stageExtraUnitsUsed",
      "rootUnitLimit",
      "stageExtraUnitLimit",
      "missingAliases",
    ],
  },
  "asr_failed.unreachable": { retryDisposition: "safe" },
  "asr_failed.auth": { retryDisposition: "never", action: "configure_asr" },
  // A valid key that lacks a permission the call needs (restricted keys).
  "asr_failed.permission": { retryDisposition: "never", action: "configure_asr" },
  "asr_failed.invalid_audio": { retryDisposition: "never" },
  // The provider throttled the request; `retryAfterMs` is its own wait when it named one.
  "asr_failed.rate_limited": { retryDisposition: "policy", detailsKeys: ["retryAfterMs"] },
  // An asynchronous job ended in failure on the provider's side; re-running submits anew.
  "asr_failed.job_failed": { retryDisposition: "never" },
  // The provider no longer knows the job (expired, cancelled or never kept).
  "asr_failed.job_expired": { retryDisposition: "never" },
  // The configured model does not exist, or is not offered in the profile's region.
  "asr_failed.model_unavailable": { retryDisposition: "never", action: "configure_asr" },
  // The account's free quota for the model is used up and it is set to stop there.
  "asr_quota.free_tier_exhausted": { retryDisposition: "never" },
  // Answered with HTTP 416 instead of the 400 of its class.
  "invalid_request.range_not_satisfiable": {},
  "invalid_request.subtitle_encoding": {},
  "invalid_request.subtitle_format": {},
  // A multi-part submission that did not choose parts.
  "invalid_request.multipart_choice_required": { detailsKeys: ["parts"] },
  "invalid_request.batch_too_large": { detailsKeys: ["itemCount", "limit"] },
  "invalid_request.collection_summary_missing": { detailsKeys: ["missingContentIds"] },
  "invalid_request.cookie_format": {},
  "invalid_request.allowlist_entry": {},
  "invalid_request.schema": { detailsKeys: ["path"] },
  "invalid_request.cache_request_outdated": {},
  "invalid_request.cache_probe_failed": {},
  "invalid_request.revision_kind_protected": {},
  // A soft-subtitle MP4 export whose source has streams outside the MP4 policy.
  "invalid_request.container_unsupported": { detailsKeys: ["streams"] },
  // A note anchor outside its revision, out of order, or splitting a surrogate pair.
  "invalid_request.note_anchor": {},
  "invalid_request.note_span": { detailsKeys: ["limit"] },
  "invalid_request.note_limit": { detailsKeys: ["limit"] },
  // A custom system prompt that lacks a placeholder or protocol fragment of its builtin text,
  // adds an unknown placeholder, or is empty or too long; `missing` / `unknown` list them as written.
  "invalid_request.prompt_protocol": { detailsKeys: ["missing", "unknown"] },
  // A media cache location the sidecar or the shell refuses; `reason` is a CacheDirReason.
  "invalid_request.cache_dir": { detailsKeys: ["reason"] },
  "unauthenticated.csrf": {},
  "unauthenticated.setup_token": {},
  "unauthenticated.bad_credentials": {},
  // The local file grant is missing, forged or expired.
  "unauthenticated.file_grant": {},
  "forbidden.account_suspended": {},
  "forbidden.must_change_password": {},
  "network_blocked_by_policy.private_address": {},
  "network_blocked_by_policy.redirect": {},
  "network_blocked_by_policy.dns_rebinding": {},
} as const satisfies Readonly<Record<string, RefinedErrorCodeSpec>>;
export type RefinedErrorCode = keyof typeof REFINED_ERROR_CODE_REGISTRY;
export const REFINED_ERROR_CODES = Object.keys(REFINED_ERROR_CODE_REGISTRY) as readonly RefinedErrorCode[];

/**
 * Why a media cache location was refused (`invalid_request.cache_dir`). The shell
 * reports the same reasons as `cache_dir:<reason>: <detail>` strings from its folder commands.
 */
export const CACHE_DIR_REASONS = [
  "overlaps_data_dir",
  "overlaps_current",
  "not_local",
  "not_found",
  "not_directory",
  "not_accessible",
  "not_empty",
  "not_writable",
  "invalid_path",
] as const;
export type CacheDirReason = (typeof CACHE_DIR_REASONS)[number];

export function isCacheDirReason(value: unknown): value is CacheDirReason {
  return typeof value === "string" && (CACHE_DIR_REASONS as readonly string[]).includes(value);
}

export function isRefinedErrorCode(code: string): code is RefinedErrorCode {
  return Object.hasOwn(REFINED_ERROR_CODE_REGISTRY, code);
}

/** The keys `details` may carry for a code; a bare class or an unregistered code allows none. */
export function allowedDetailsKeys(code: string): readonly string[] {
  return isRefinedErrorCode(code) ? (REFINED_ERROR_CODE_REGISTRY[code] as RefinedErrorCodeSpec).detailsKeys ?? [] : [];
}

/** Classes whose default disposition is "—" are status codes for `StageRun.resultJson.reasons[]`, never errors. */
export function isErrorClassUsableAsError(errorClass: ErrorClass): boolean {
  return ERROR_CLASS_DEFAULTS[errorClass].retryDisposition !== null;
}

/**
 * The only error shape in the system: errors are structured values. API responses, Task state,
 * UI and logs all carry this structure; the UI never parses error strings.
 * `userMessage` text comes from i18n resources, never from hard-coded literals.
 * `code` defaults to the class and may be refined as `<class>.<detail>`.
 */
const detailsValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const appErrorSchema = z
  .object({
    class: z.enum(ERROR_CLASSES),
    code: z.string().min(1),
    retryDisposition: z.enum(RETRY_DISPOSITIONS),
    userMessage: z.string(),
    upstreamMessage: z.string().exactOptional(),
    action: z.enum(ERROR_ACTIONS).exactOptional(),
    details: z.record(z.string(), detailsValueSchema).exactOptional(),
  })
  .refine((error) => isErrorClassUsableAsError(error.class), {
    message: "status-only error classes cannot be raised as AppError",
    path: ["class"],
  })
  .refine(
    (error) => {
      if (error.details === undefined) {
        return true;
      }
      const allowed = allowedDetailsKeys(error.code);
      return Object.keys(error.details).every((key) => allowed.includes(key));
    },
    { message: "details may only carry the keys registered for the refined code", path: ["details"] },
  ) satisfies z.ZodType<AppError>;

export type AppErrorDetails = Record<string, string | number | boolean | string[]>;

export interface AppError {
  class: ErrorClass;
  code: string;
  retryDisposition: RetryDisposition;
  userMessage: string;
  /** Upstream text after redaction; never contains credentials. */
  upstreamMessage?: string;
  action?: ErrorAction;
  /** Structured ids, counts and lists under keys registered for the refined code; never paths, secrets or upstream text. */
  details?: AppErrorDetails;
}

/** Error response body for every `/api` failure. */
export const errorResponseSchema = z.object({ error: appErrorSchema });
