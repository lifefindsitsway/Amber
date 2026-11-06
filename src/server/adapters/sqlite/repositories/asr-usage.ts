import type { PriceSnapshot } from "../../../../shared/model-pricing.ts";
import type { AsrUsage } from "../../../domain/usage.ts";
import type { AsrUsageRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface AsrUsageRow {
  id: string;
  user_id: string;
  asr_profile_id: string | null;
  profile_id_snapshot: string | null;
  profile_name_snapshot: string | null;
  provider: string;
  model: string;
  feature: AsrUsage["feature"];
  outcome: AsrUsage["outcome"];
  job_id: string | null;
  job_outcome: NonNullable<AsrUsage["jobOutcome"]> | null;
  audio_ms: number;
  billed_input_tokens: number | null;
  billed_output_tokens: number | null;
  billed_audio_ms: number | null;
  sent_at: number | null;
  credential_version: string | null;
  credential_set_at: number | null;
  price_snapshot_json: string | null;
  task_id: string | null;
  content_id: string | null;
  raw_usage_json: string | null;
  created_at: number;
}

function toUsage(row: AsrUsageRow): AsrUsage {
  return withoutNulls<AsrUsage>({
    id: row.id,
    userId: row.user_id,
    asrProfileId: row.asr_profile_id,
    profileIdSnapshot: row.profile_id_snapshot,
    profileNameSnapshot: row.profile_name_snapshot,
    provider: row.provider,
    model: row.model,
    feature: row.feature,
    outcome: row.outcome,
    jobId: row.job_id,
    jobOutcome: row.job_outcome,
    audioMs: row.audio_ms,
    billedInputTokens: row.billed_input_tokens,
    billedOutputTokens: row.billed_output_tokens,
    billedAudioMs: row.billed_audio_ms,
    sentAt: row.sent_at,
    credentialVersion: row.credential_version,
    credentialSetAt: row.credential_set_at,
    priceSnapshot: parseJsonOrNull<PriceSnapshot>(row.price_snapshot_json),
    taskId: row.task_id,
    contentId: row.content_id,
    rawUsageJson: row.raw_usage_json,
    createdAt: row.created_at,
  });
}

/** Usage rows reference only the inserting user's own profile, Task and Content. */
export function sqliteAsrUsageRepository(db: SqliteConnection): AsrUsageRepository {
  const insert = db.prepare(
    `INSERT INTO asr_usage (id, user_id, asr_profile_id, profile_id_snapshot, profile_name_snapshot, provider, model, feature, outcome,
       job_id, job_outcome, audio_ms, billed_input_tokens, billed_output_tokens, billed_audio_ms, sent_at, credential_version,
       credential_set_at, price_snapshot_json, task_id, content_id, raw_usage_json, created_at)
     VALUES (@id, @userId, @asrProfileId, @profileIdSnapshot, @profileNameSnapshot, @provider, @model, @feature, @outcome,
       @jobId, @jobOutcome, @audioMs, @billedInputTokens, @billedOutputTokens, @billedAudioMs, @sentAt, @credentialVersion,
       @credentialSetAt, @priceSnapshotJson, @taskId, @contentId, @rawUsageJson, @createdAt)`,
  );
  // Each column is only filled while empty, so a repeated or late report can never overwrite
  // what an earlier one recorded, and a job outcome never changes once it is set.
  const fill = db.prepare(
    `UPDATE asr_usage SET
       job_outcome = COALESCE(job_outcome, @jobOutcome),
       billed_input_tokens = COALESCE(billed_input_tokens, @billedInputTokens),
       billed_output_tokens = COALESCE(billed_output_tokens, @billedOutputTokens),
       billed_audio_ms = COALESCE(billed_audio_ms, @billedAudioMs),
       raw_usage_json = COALESCE(raw_usage_json, @rawUsageJson)
     WHERE id = @id AND user_id = @userId`,
  );
  const list = db.prepare(
    `SELECT * FROM asr_usage
     WHERE user_id = @userId
       AND (@taskId IS NULL OR task_id = @taskId)
       AND (@contentId IS NULL OR content_id = @contentId)
       AND (@since IS NULL OR created_at >= @since)
       AND (@until IS NULL OR created_at < @until)
     ORDER BY created_at, id`,
  );
  const owned = {
    profile: db.prepare("SELECT 1 FROM asr_provider_profile WHERE id = ? AND user_id = ?"),
    task: db.prepare("SELECT 1 FROM task WHERE id = ? AND user_id = ?"),
    content: db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?"),
  };
  const requireOwned = (kind: keyof typeof owned, id: string | undefined, ownerUserId: string): void => {
    if (id !== undefined && owned[kind].get(id, ownerUserId) === undefined) {
      throw notFound(kind === "profile" ? "asr profile" : kind, id);
    }
  };

  return {
    insert(usage) {
      requireOwned("profile", usage.asrProfileId, usage.userId);
      requireOwned("task", usage.taskId, usage.userId);
      requireOwned("content", usage.contentId, usage.userId);
      insert.run({
        id: usage.id,
        userId: usage.userId,
        asrProfileId: nullable(usage.asrProfileId),
        profileIdSnapshot: nullable(usage.profileIdSnapshot),
        profileNameSnapshot: nullable(usage.profileNameSnapshot),
        provider: usage.provider,
        model: usage.model,
        feature: usage.feature,
        outcome: usage.outcome,
        jobId: nullable(usage.jobId),
        jobOutcome: nullable(usage.jobOutcome),
        audioMs: usage.audioMs,
        billedInputTokens: nullable(usage.billedInputTokens),
        billedOutputTokens: nullable(usage.billedOutputTokens),
        billedAudioMs: nullable(usage.billedAudioMs),
        sentAt: nullable(usage.sentAt),
        credentialVersion: nullable(usage.credentialVersion),
        credentialSetAt: nullable(usage.credentialSetAt),
        priceSnapshotJson: jsonOrNull(usage.priceSnapshot),
        taskId: nullable(usage.taskId),
        contentId: nullable(usage.contentId),
        rawUsageJson: nullable(usage.rawUsageJson),
        createdAt: usage.createdAt,
      });
    },
    list(ownerUserId, query = {}) {
      const rows = list.all({
        userId: ownerUserId,
        taskId: nullable(query.taskId),
        contentId: nullable(query.contentId),
        since: nullable(query.since),
        until: nullable(query.until),
      }) as AsrUsageRow[];
      return rows.map(toUsage);
    },
    fillJobReport(ownerUserId, id, report) {
      return (
        fill.run({
          id,
          userId: ownerUserId,
          jobOutcome: nullable(report.jobOutcome),
          billedInputTokens: nullable(report.billedInputTokens),
          billedOutputTokens: nullable(report.billedOutputTokens),
          billedAudioMs: nullable(report.billedAudioMs),
          rawUsageJson: nullable(report.rawUsageJson),
        }).changes > 0
      );
    },
  };
}
