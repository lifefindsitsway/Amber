import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../src/server/adapters/sqlite/database.ts";
import type { RequestPrincipal } from "../../../src/server/domain/user.ts";
import type { SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { insertRow, openTempDatabase, tempDataDir } from "../../tools/sqlite.ts";

/**
 * Raw rows for usage analytics tests. They are written with plain SQL, column by column, so
 * the read side is exercised against the stored shape and not against the repositories that
 * write it.
 */

export const OWNER = "alice";
export const OTHER_OWNER = "bob";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Monday 2026-09-21 00:00 Beijing time (the Sunday before, 16:00 UTC). */
export const MONDAY = Date.UTC(2026, 8, 20, 16, 0, 0);
/** A fixed "now", Friday 2026-09-25 12:00 Beijing time, so presets and buckets are predictable. */
export const NOW = MONDAY + 4 * DAY + 12 * HOUR;

export function principalOf(userId: string): RequestPrincipal {
  return { userId, mode: "server", role: "user", mustChangePassword: false };
}

export interface UsageDb {
  db: SqliteConnection;
  file: string;
}

let template: string | undefined;

/** A migrated database with the two owners, built once per test file and copied per use (migrating takes about a second). */
function templateFile(): string {
  if (template === undefined) {
    const { db, file } = openTempDatabase();
    for (const id of [OWNER, OTHER_OWNER]) {
      insertRow(db, "user", { id, role: "user", status: "active", created_at: 1 });
    }
    db.close();
    template = file;
  }
  return template;
}

/** A fresh migrated database holding the two owners every test uses. */
export function usageDb(): UsageDb {
  const dir = tempDataDir("amber-usage-");
  const file = join(dir, "amber.db");
  copyFileSync(templateFile(), file);
  const { db } = openDatabase(file, { backupDir: join(dir, "backups") });
  return { db, file };
}

export interface LlmUsageInput {
  id: string;
  userId?: string;
  profileId?: string | null;
  modelId?: string | null;
  profileName?: string;
  feature?: string;
  outcome?: string;
  taskId?: string | null;
  chatMessageId?: string | null;
  contentId?: string | null;
  input?: number | bigint | null;
  output?: number | bigint | null;
  cacheRead?: number | bigint | null;
  cacheWrite?: number | bigint | null;
  cacheWrite1h?: number | bigint | null;
  reasoning?: number | bigint | null;
  sentAt?: number | null;
  createdAt?: number;
  credentialVersion?: string | null;
  credentialSetAt?: number | null;
  /** An object is stored as JSON; a string is stored as given (to plant unusable snapshots). */
  snapshot?: object | string | null;
}

function jsonOf(value: object | string | null | undefined): string | null {
  return value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value);
}

export function insertLlmUsage(db: SqliteConnection, row: LlmUsageInput): void {
  const profileId = row.profileId === undefined ? "p-1" : row.profileId;
  const modelId = row.modelId === undefined ? "model-a" : row.modelId;
  insertRow(db, "token_usage", {
    id: row.id,
    user_id: row.userId ?? OWNER,
    model_ref_json: JSON.stringify({
      providerProfileId: profileId ?? "",
      modelId: modelId ?? "",
      providerNameSnapshot: row.profileName ?? "Relay",
      modelDisplaySnapshot: modelId ?? "",
    }),
    provider_profile_id: profileId,
    model_id: modelId,
    feature: row.feature ?? "summary",
    outcome: row.outcome ?? "succeeded",
    task_id: row.taskId ?? null,
    chat_message_id: row.chatMessageId ?? null,
    content_id: row.contentId ?? null,
    input_tokens: row.input === undefined ? null : row.input,
    output_tokens: row.output === undefined ? null : row.output,
    cache_read_tokens: row.cacheRead === undefined ? null : row.cacheRead,
    cache_write_tokens: row.cacheWrite === undefined ? null : row.cacheWrite,
    cache_write_1h_tokens: row.cacheWrite1h === undefined ? null : row.cacheWrite1h,
    reasoning_tokens: row.reasoning === undefined ? null : row.reasoning,
    sent_at: row.sentAt ?? null,
    credential_version: row.credentialVersion ?? null,
    credential_set_at: row.credentialSetAt ?? null,
    price_snapshot_json: jsonOf(row.snapshot),
    created_at: row.createdAt ?? row.sentAt ?? NOW - DAY,
  });
}

export interface AsrUsageInput {
  id: string;
  userId?: string;
  profileId?: string | null;
  profileName?: string | null;
  modelId?: string;
  feature?: string;
  outcome?: string;
  jobId?: string | null;
  jobOutcome?: string | null;
  audioMs?: number | bigint;
  billedInput?: number | bigint | null;
  billedOutput?: number | bigint | null;
  billedAudioMs?: number | bigint | null;
  taskId?: string | null;
  contentId?: string | null;
  sentAt?: number | null;
  createdAt?: number;
  credentialVersion?: string | null;
  credentialSetAt?: number | null;
  snapshot?: object | string | null;
}

export function insertAsrUsage(db: SqliteConnection, row: AsrUsageInput): void {
  insertRow(db, "asr_usage", {
    id: row.id,
    user_id: row.userId ?? OWNER,
    asr_profile_id: null,
    profile_id_snapshot: row.profileId === undefined ? "ap-1" : row.profileId,
    profile_name_snapshot: row.profileName === undefined ? "Scribe" : row.profileName,
    provider: "elevenlabs",
    model: row.modelId ?? "scribe_v2",
    feature: row.feature ?? "transcribe",
    outcome: row.outcome ?? "succeeded",
    job_id: row.jobId ?? null,
    job_outcome: row.jobOutcome ?? null,
    audio_ms: row.audioMs ?? 0,
    billed_input_tokens: row.billedInput === undefined ? null : row.billedInput,
    billed_output_tokens: row.billedOutput === undefined ? null : row.billedOutput,
    billed_audio_ms: row.billedAudioMs === undefined ? null : row.billedAudioMs,
    task_id: row.taskId ?? null,
    content_id: row.contentId ?? null,
    sent_at: row.sentAt ?? null,
    credential_version: row.credentialVersion ?? null,
    credential_set_at: row.credentialSetAt ?? null,
    price_snapshot_json: jsonOf(row.snapshot),
    created_at: row.createdAt ?? row.sentAt ?? NOW - DAY,
  });
}

/** A content that exists, with the titles the page shows (custom title wins). */
export function insertContent(db: SqliteConnection, id: string, options: { userId?: string; title?: string | null; customTitle?: string | null } = {}): void {
  insertRow(db, "content", {
    id,
    user_id: options.userId ?? OWNER,
    source_kind: "local",
    title: options.title === undefined ? `Title of ${id}` : options.title,
    custom_title: options.customTitle ?? null,
    processing_status: "queued",
    created_at: 1,
    updated_at: 1,
  });
}

export function insertTask(db: SqliteConnection, id: string, contentId: string, userId = OWNER): void {
  insertRow(db, "task", {
    id,
    user_id: userId,
    content_id: contentId,
    kind: "process_content",
    request_json: "{}",
    status_projection: "{}",
    created_at: 1,
  });
}

/** A chat answer on a content, through the thread the content owns. */
export function insertChatMessage(db: SqliteConnection, id: string, contentId: string): void {
  const thread = `thread-${contentId}`;
  const known = db.prepare("SELECT 1 AS present FROM chat_thread WHERE id = ?").get(thread);
  if (known === undefined) {
    insertRow(db, "chat_thread", { id: thread, content_id: contentId, created_at: 1 });
  }
  insertRow(db, "chat_message", {
    id,
    thread_id: thread,
    role: "assistant",
    text: "",
    status: "complete",
    citations_json: "[]",
    created_at: 1,
  });
}

export function insertAsrProfile(db: SqliteConnection, id: string, options: { userId?: string; name?: string; models?: object[] } = {}): void {
  insertRow(db, "asr_provider_profile", {
    id,
    user_id: options.userId ?? OWNER,
    name: options.name ?? "Scribe",
    provider: "elevenlabs",
    models_json: JSON.stringify(options.models ?? [{ modelId: "scribe_v2" }]),
    created_at: 1,
  });
}

export function insertLlmProfile(db: SqliteConnection, id: string, options: { userId?: string; name?: string; models?: Array<{ modelId: string; pricing?: object }> } = {}): void {
  insertRow(db, "provider_profile", {
    id,
    user_id: options.userId ?? OWNER,
    name: options.name ?? "Relay",
    protocol: "openai_compatible",
    base_url: "https://llm.invalid/v1",
    created_at: 1,
  });
  options.models?.forEach((model, position) => {
    insertRow(db, "model_capability", {
      profile_id: id,
      model_id: model.modelId,
      position,
      flags_declared_json: "{}",
      limits_declared_json: "{}",
      pricing_json: model.pricing === undefined ? null : JSON.stringify(model.pricing),
    });
  });
}
