import type { PriceSnapshot } from "../../../../shared/model-pricing.ts";
import type { ModelRefSnapshot } from "../../../domain/model-ref.ts";
import type { TokenUsage } from "../../../domain/usage.ts";
import type { TokenUsageRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface TokenUsageRow {
  id: string;
  user_id: string;
  model_ref_json: string;
  provider_profile_id: string | null;
  model_id: string | null;
  feature: TokenUsage["feature"];
  task_id: string | null;
  work_unit_id: string | null;
  artifact_revision_id: string | null;
  chat_message_id: string | null;
  content_id: string | null;
  outcome: TokenUsage["outcome"];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_1h_tokens: number | null;
  reasoning_tokens: number | null;
  sent_at: number | null;
  credential_version: string | null;
  credential_set_at: number | null;
  price_snapshot_json: string | null;
  raw_usage_json: string | null;
  created_at: number;
}

function toUsage(row: TokenUsageRow): TokenUsage {
  return withoutNulls<TokenUsage>({
    id: row.id,
    userId: row.user_id,
    modelRef: parseJson<ModelRefSnapshot>(row.model_ref_json),
    providerProfileId: row.provider_profile_id,
    modelId: row.model_id,
    feature: row.feature,
    taskId: row.task_id,
    workUnitId: row.work_unit_id,
    artifactRevisionId: row.artifact_revision_id,
    chatMessageId: row.chat_message_id,
    contentId: row.content_id,
    outcome: row.outcome,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheWrite1hTokens: row.cache_write_1h_tokens,
    reasoningTokens: row.reasoning_tokens,
    sentAt: row.sent_at,
    credentialVersion: row.credential_version,
    credentialSetAt: row.credential_set_at,
    priceSnapshot: parseJsonOrNull<PriceSnapshot>(row.price_snapshot_json),
    rawUsageJson: row.raw_usage_json,
    createdAt: row.created_at,
  });
}

/**
 * Usage rows reference only the inserting user's own Task, WorkUnit, Content and chat
 * message. The profile is kept as a snapshot, not a key, so rows outlive the profile.
 */
export function sqliteTokenUsageRepository(db: SqliteConnection): TokenUsageRepository {
  const insert = db.prepare(
    `INSERT INTO token_usage (id, user_id, model_ref_json, provider_profile_id, model_id, feature, task_id, work_unit_id, artifact_revision_id,
       chat_message_id, content_id, outcome, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
       reasoning_tokens, sent_at, credential_version, credential_set_at, price_snapshot_json, raw_usage_json, created_at)
     VALUES (@id, @userId, @modelRefJson, @providerProfileId, @modelId, @feature, @taskId, @workUnitId, @artifactRevisionId,
       @chatMessageId, @contentId, @outcome, @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @cacheWrite1hTokens,
       @reasoningTokens, @sentAt, @credentialVersion, @credentialSetAt, @priceSnapshotJson, @rawUsageJson, @createdAt)`,
  );
  const list = db.prepare(
    `SELECT * FROM token_usage
     WHERE user_id = @userId
       AND (@taskId IS NULL OR task_id = @taskId)
       AND (@contentId IS NULL OR content_id = @contentId)
       AND (@feature IS NULL OR feature = @feature)
       AND (@since IS NULL OR created_at >= @since)
       AND (@until IS NULL OR created_at < @until)
     ORDER BY created_at, id`,
  );
  // Ids go in as one JSON array so a single statement serves any number of them.
  const attach = db.prepare(
    `UPDATE token_usage SET artifact_revision_id = @artifactRevisionId
     WHERE user_id = @userId AND id IN (SELECT value FROM json_each(@ids))`,
  );
  const owned = {
    task: db.prepare("SELECT 1 FROM task WHERE id = ? AND user_id = ?"),
    "work unit": db.prepare(
      "SELECT 1 FROM work_unit JOIN stage_run ON stage_run.id = work_unit.stage_run_id JOIN task ON task.id = stage_run.task_id WHERE work_unit.id = ? AND task.user_id = ?",
    ),
    content: db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?"),
    "chat message": db.prepare(
      "SELECT 1 FROM chat_message JOIN chat_thread ON chat_thread.id = chat_message.thread_id JOIN content ON content.id = chat_thread.content_id WHERE chat_message.id = ? AND content.user_id = ?",
    ),
  };
  const requireOwned = (kind: keyof typeof owned, id: string | undefined, ownerUserId: string): void => {
    if (id !== undefined && owned[kind].get(id, ownerUserId) === undefined) {
      throw notFound(kind, id);
    }
  };

  return {
    insert(usage) {
      requireOwned("task", usage.taskId, usage.userId);
      requireOwned("work unit", usage.workUnitId, usage.userId);
      requireOwned("content", usage.contentId, usage.userId);
      requireOwned("chat message", usage.chatMessageId, usage.userId);
      insert.run({
        id: usage.id,
        userId: usage.userId,
        modelRefJson: JSON.stringify(usage.modelRef),
        providerProfileId: nullable(usage.providerProfileId),
        modelId: nullable(usage.modelId),
        feature: usage.feature,
        taskId: nullable(usage.taskId),
        workUnitId: nullable(usage.workUnitId),
        artifactRevisionId: nullable(usage.artifactRevisionId),
        chatMessageId: nullable(usage.chatMessageId),
        contentId: nullable(usage.contentId),
        outcome: usage.outcome,
        inputTokens: nullable(usage.inputTokens),
        outputTokens: nullable(usage.outputTokens),
        cacheReadTokens: nullable(usage.cacheReadTokens),
        cacheWriteTokens: nullable(usage.cacheWriteTokens),
        cacheWrite1hTokens: nullable(usage.cacheWrite1hTokens),
        reasoningTokens: nullable(usage.reasoningTokens),
        sentAt: nullable(usage.sentAt),
        credentialVersion: nullable(usage.credentialVersion),
        credentialSetAt: nullable(usage.credentialSetAt),
        priceSnapshotJson: jsonOrNull(usage.priceSnapshot),
        rawUsageJson: nullable(usage.rawUsageJson),
        createdAt: usage.createdAt,
      });
    },
    list(ownerUserId, query = {}) {
      const rows = list.all({
        userId: ownerUserId,
        taskId: nullable(query.taskId),
        contentId: nullable(query.contentId),
        feature: nullable(query.feature),
        since: nullable(query.since),
        until: nullable(query.until),
      }) as TokenUsageRow[];
      return rows.map(toUsage);
    },
    attach(ownerUserId, invocationIds, artifactRevisionId) {
      if (invocationIds.length === 0) {
        return 0;
      }
      return attach.run({ userId: ownerUserId, ids: JSON.stringify(invocationIds), artifactRevisionId }).changes;
    },
  };
}
