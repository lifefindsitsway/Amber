import { describe, expect, it } from "vitest";
import * as enums from "../../src/shared/enums.ts";

/** Every closed value set shared by server and web, member by member and in order. */
const EXPECTED: Readonly<Record<string, readonly (string | number)[]>> = {
  USER_ROLES: ["admin", "user"],
  USER_STATUSES: ["active", "suspended"],
  RUN_MODES: ["local", "server"],
  PLATFORMS: ["bilibili", "youtube"],
  CONTENT_SOURCE_KINDS: ["bilibili", "youtube", "local"],
  PLATFORM_ACCOUNT_STATUSES: ["valid", "expired", "unknown"],
  PLATFORM_QR_STATUSES: ["pending", "scanned", "confirmed", "expired"],
  MEDIA_ASSET_KINDS: ["external_local", "managed_upload", "platform_cache", "extracted_audio", "temporary"],
  TRANSCRIPT_KINDS: ["platform", "imported", "asr", "manual", "corrected", "translated"],
  TIMING_FIDELITIES: ["exact_words", "inherited_segment", "segment_only"],
  STAGE_IDS: ["source", "media", "subtitle", "asr", "proofread", "chapter", "summary", "highlight", "translate", "collection_summary", "burn", "cache_media"],
  STAGE_STATUSES: ["pending", "waiting_configuration", "running", "succeeded", "failed", "skipped", "interrupted", "cancelled"],
  WORK_UNIT_STATUSES: ["pending", "running", "succeeded", "failed", "waiting_user_action", "interrupted", "cancelled"],
  STAGE_CONDITION_IDS: ["needs_asr", "auto_proofread_enabled", "no_platform_chapters", "is_local_file", "client_only"],
  ASR_PROVIDERS: ["elevenlabs", "dashscope"],
  STAGE_REQUIREMENT_IDS: ["llm_configured", "asr_configured"],
  TASK_KINDS: [
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
  ],
  PROCESSING_STATUSES: ["queued", "running", "waiting", "succeeded", "failed", "cancelled"],
  UPLOAD_RETENTION_POLICIES: ["keep", "discard_after_audio"],
  TOKEN_USAGE_FEATURES: [
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
  ],
  ASR_USAGE_FEATURES: ["transcribe", "test_connection"],
  CHAT_MESSAGE_STATUSES: ["streaming", "complete", "interrupted", "failed"],
  TRI_STATES: ["supported", "unsupported", "unknown"],
  LLM_PROTOCOLS: ["openai_compatible", "anthropic_messages"],
  FRESHNESS_VALUES: ["fresh", "stale"],
  CREDENTIAL_STATUSES: ["missing", "configured", "unavailable"],
  CACHE_MEDIA_QUALITIES: [360, 480, 720, 1080],
  BURN_MODES: ["original", "translation", "bilingual"],
  SUBTITLE_DELIVERIES: ["hard", "soft"],
  SUBTITLE_VIDEO_CONTAINERS: ["mp4", "mkv"],
  SUBTITLE_ANCHORS: ["top", "center", "bottom"],
  SUBTITLE_BILINGUAL_ORDERS: ["original_first", "translation_first"],
  SUBTITLE_BACKGROUND_SCOPES: ["both", "original", "translation"],
  NOTE_MARKS: ["underline", "background"],
  NOTE_COLORS: ["yellow", "green", "blue", "pink", "purple"],
  PLAYER_END_BEHAVIORS: ["pause", "loop_one", "loop_list"],
  WEB_SEARCH_MODES: ["off", "auto", "force"],
  CHAT_WEB_SEARCH_SETTINGS: ["off", "auto"],
  WEB_SEARCH_STATUSES: ["searched", "partial", "failed", "skipped", "dropped"],
  WEB_SEARCH_REASONS: ["unconfigured", "not_needed", "planner_failed", "budget"],
  WEB_SEARCH_SERVICES: ["tavily"],
};

describe("src/shared/enums.ts", () => {
  it.each(Object.entries(EXPECTED))("%s", (name, members) => {
    expect([...(enums as Record<string, unknown> as Record<string, readonly unknown[]>)[name]!]).toEqual([...members]);
  });

  it("has an expectation for every exported value set", () => {
    const sets = Object.entries(enums).filter(([name, value]) => /S$/u.test(name) && Array.isArray(value)).map(([name]) => name);
    expect(sets.sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});
