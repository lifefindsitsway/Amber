import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { TranscriptSegment } from "../../../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { lectureTranscripts } from "../../../../fixtures/transcripts/lecture.ts";
import { countRows, insertRow, openTempDatabase, tableNames } from "../../../../tools/sqlite.ts";

const nextId = monotonicFactory();
const T0 = 1_790_000_000_000;
const json = (value: unknown) => JSON.stringify(value);
const modelRef = json({ providerProfileId: "p", modelId: "m", providerNameSnapshot: "P", modelDisplaySnapshot: "M" });
const promptRef = json({ id: "summary.core", version: 1 });

/** Instance-level and meta tables that have no owner; everything else must trace to a User. */
const OWNERLESS_TABLES = ["instance_settings", "network_allowlist", "pending_file_delete"];
/**
 * Tables whose owner is established by a row invariant rather than a non-null key, such as
 * `summary_template`, where `builtin = 1` exactly when `user_id` is null.
 */
const ROW_INVARIANT_TABLES = ["summary_template", "rollup_partial"];
/**
 * The FTS search projection and its shadow tables: derived data rebuilt from
 * the tables above, keyed by `user_id` in every row but without foreign keys.
 */
const isProjectionTable = (table: string): boolean => table === "search_index" || table.startsWith("search_index_");

interface Column {
  name: string;
  notnull: number;
}
interface ForeignKey {
  id: number;
  table: string;
  from: string;
  /** Null when the key names the parent's primary key implicitly. */
  to?: string | null;
}

const columnsOf = (db: SqliteConnection, table: string) => db.pragma(`table_info(${table})`) as Column[];
const foreignKeysOf = (db: SqliteConnection, table: string) => db.pragma(`foreign_key_list(${table})`) as ForeignKey[];

/**
 * Whether `key` alone identifies one parent row by its `id`: a single-column key does, and so
 * does the `id` column of a composite key whose columns are all NOT NULL.
 */
function joinsOnId(keys: readonly ForeignKey[], columns: readonly Column[], key: ForeignKey): boolean {
  const parts = keys.filter((other) => other.id === key.id);
  if (parts.length === 1) return true;
  return key.to === "id" && parts.every((part) => columns.find((column) => column.name === part.from)?.notnull === 1);
}

function secretRow(userId: string): Record<string, unknown> {
  return {
    id: nextId(),
    user_id: userId,
    envelope_version: 1,
    kdf_salt: Buffer.alloc(16, 1),
    nonce: Buffer.alloc(12, 2),
    ciphertext: Buffer.from([3, 4, 5]),
    auth_tag: Buffer.alloc(16, 6),
    created_at: T0,
    updated_at: T0,
  };
}

/** Everything one user can own, wired together the way the pipeline would. */
interface Seed {
  userId: string;
  content: string;
  otherContent: string;
  collection: string;
  task: string;
  collectionTask: string;
  workUnit: string;
  providerProfile: string;
  asrProfile: string;
  platformAccount: string;
  secrets: { provider: string; asr: string; platform: string };
  externalFile: string;
  tokenUsage: { content: string; collection: string };
  asrUsage: string;
}

function seedUser(db: SqliteConnection, repository: SqliteRepository, dir: string, userId: string): Seed {
  const row = (table: string, values: Record<string, unknown>) => insertRow(db, table, values);
  row("user", { id: userId, role: "user", status: "active", created_at: T0 });
  row("user_credential", { user_id: userId, username: `name-${userId}`, password_hash: "<argon2id>", must_change_password: 0 });
  row("user_settings", { user_id: userId, theme: "light", language: "zh-CN", shortcuts_json: json({}), updated_at: T0 });
  row("session", { session_id_hash: `hash-${userId}`, user_id: userId, created_at: T0, last_seen_at: T0, expires_at: T0 + 1 });

  const secrets = { provider: secretRow(userId), asr: secretRow(userId), platform: secretRow(userId) };
  for (const secret of Object.values(secrets)) row("secret", secret);
  const providerProfile = nextId();
  row("provider_profile", {
    id: providerProfile, user_id: userId, name: "relay", protocol: "openai_compatible", base_url: "https://example.com/v1",
    credential_ref: secrets.provider.id, created_at: T0,
  });
  row("model_capability", {
    profile_id: providerProfile, model_id: "m", position: 0, flags_declared_json: json({}), limits_declared_json: json({}),
  });
  const asrProfile = nextId();
  row("asr_provider_profile", { id: asrProfile, user_id: userId, name: "ElevenLabs", provider: "elevenlabs", models_json: '[{"modelId":"scribe_v2"}]', credential_ref: secrets.asr.id, created_at: T0 });
  row("other_model_profile", { id: nextId(), user_id: userId, name: "百炼", models_json: '[{"modelId":"cosyvoice-v2","kind":"tts"}]', created_at: T0 });
  row("web_search_profile", { user_id: userId, service: "tavily", created_at: T0, updated_at: T0 });
  const platformAccount = nextId();
  row("platform_account", { id: platformAccount, user_id: userId, platform: "bilibili", credential_ref: secrets.platform.id, status: "unknown" });

  const batch = nextId();
  row("import_batch", { id: batch, user_id: userId, source_type: "links", total_items: 2, created_at: T0 });
  const content = nextId();
  const otherContent = nextId();
  for (const [id, kind, platformId] of [[content, "local", null], [otherContent, "bilibili", `BV${nextId()}`]] as const) {
    row("content", {
      id, user_id: userId, source_kind: kind, platform_content_id: platformId, import_batch_id: batch,
      processing_status: "succeeded", created_at: T0, updated_at: T0,
    });
  }
  const collection = nextId();
  row("collection", { id: collection, user_id: userId, name: "course", created_at: T0 });
  row("collection_item", { id: nextId(), collection_id: collection, content_id: content, position: 0, added_at: T0 });
  row("collection_item", { id: nextId(), collection_id: collection, content_id: otherContent, position: 1, added_at: T0 });

  const task = nextId();
  row("task", { id: task, user_id: userId, content_id: content, kind: "process_content", request_json: json({ requestSchemaVersion: 1 }), status_projection: "succeeded", created_at: T0 });
  const stageRun = nextId();
  row("stage_run", { id: stageRun, task_id: task, stage: "proofread", attempt: 1, status: "succeeded", progress: 1, dependencies_json: json(["asr"]) });
  const workUnit = nextId();
  row("work_unit", { id: workUnit, stage_run_id: stageRun, unit_key: "proofread:chunk:0", status: "succeeded", attempt: 1, input_digest: "sha256:in" });
  row("work_unit_result", { work_unit_id: workUnit, payload_json: json({ lines: [] }), output_digest: "sha256:out", created_at: T0 });
  const collectionTask = nextId();
  row("task", { id: collectionTask, user_id: userId, collection_id: collection, kind: "summarize_collection", request_json: json({ requestSchemaVersion: 1 }), status_projection: "succeeded", created_at: T0 });

  const externalFile = join(dir, `lecture-${userId}.mp4`);
  writeFileSync(externalFile, "not really a video");
  const asset = (kind: string, extra: Record<string, unknown>) =>
    row("media_asset", {
      id: nextId(), user_id: userId, content_id: content, kind, storage_ref: externalFile, mime_type: "video/mp4",
      size_bytes: 18, availability: "available", retention_policy: "keep", created_at: T0, ...extra,
    });
  asset("external_local", { retention_policy: "never_delete" });
  asset("managed_upload", {});
  asset("extracted_audio", { task_id: task, retention_policy: "ephemeral" });

  const transcripts = lectureTranscripts(content, { asrProfileId: asrProfile, modelProfileId: providerProfile });
  repository.withTransaction((scope) => {
    for (const part of [transcripts.platform, transcripts.asr, transcripts.corrected]) {
      scope.transcripts.insertRevision(userId, part.revision, part.segments);
    }
    scope.contents.setPrimaryTranscript(userId, content, transcripts.corrected.revision.id, T0);
  });
  const translatedId = nextId();
  const translatedSegments: TranscriptSegment[] = transcripts.corrected.segments.map((parent, ordinal) => ({
    id: nextId() as SegmentId, revisionId: translatedId, ordinal, startMs: parent.startMs, endMs: parent.endMs,
    text: `EN ${ordinal}`, sourceSegmentIds: [parent.id],
  }));
  repository.withTransaction((scope) =>
    scope.transcripts.insertRevision(
      userId,
      {
        id: translatedId, contentId: content, kind: "translated", parentRevisionId: transcripts.corrected.revision.id,
        language: "en", timingFidelity: "segment_only", segmentCount: translatedSegments.length, createdAt: T0 + 3,
        generation: { kind: "llm", modelRef: { providerProfileId: providerProfile, modelId: "m", providerNameSnapshot: "p", modelDisplaySnapshot: "m" }, promptRef: { id: "translate", version: 1 }, promptSnapshot: "…" },
      },
      translatedSegments,
    ),
  );
  const primary = transcripts.corrected.revision.id;
  const firstSegment = transcripts.corrected.segments[0]?.id;
  row("transcript_draft", { id: nextId(), content_id: content, base_revision_id: primary, segments_json: json([]), updated_at: T0 });
  row("transcript_revision_archive", { revision_id: transcripts.asr.revision.id, content_id: content, archived_at: T0 });
  row("reference_text", { id: nextId(), content_id: content, origin: "md_import", text: "# notes", created_at: T0 });
  row("note", {
    id: nextId(), user_id: userId, content_id: content, transcript_revision_id: primary, start_segment_id: firstSegment,
    start_offset: 0, end_segment_id: firstSegment, end_offset: 1, quote: "大", mark: "background", color: "yellow", comment: "…",
    created_at: T0, updated_at: T0,
  });

  const terminology = (scope_kind: string, extra: Record<string, unknown>) => {
    const id = nextId();
    row("terminology_set", { id, user_id: userId, scope_kind, ...extra });
    row("terminology_entry", { id: nextId(), set_id: id, ordinal: 0, term: "RAG", normalized_key: "rag" });
  };
  terminology("global", {});
  terminology("collection", { collection_id: collection });
  terminology("content", { content_id: content });

  const customTemplate = nextId();
  row("summary_template", { id: customTemplate, user_id: userId, builtin: 0, name: "mine", current_version: 1 });
  row("summary_template_version", { template_id: customTemplate, version: 1, prompt: "# mine", created_at: T0 });

  const provenance = { inputs_json: json([{ kind: "transcriptRevision", id: primary }]), model_ref_json: modelRef, prompt_ref_json: promptRef, prompt_snapshot: "…", quality: "normal", created_at: T0 };
  const chapterArtifact = nextId();
  const chapterRevision = nextId();
  row("chapter_artifact", { id: chapterArtifact, content_id: content });
  row("chapter_revision", { id: chapterRevision, artifact_id: chapterArtifact, ...provenance, origin_json: json({ kind: "ai", transcriptRevisionId: primary }), chapters_json: json([]) });
  db.prepare("UPDATE chapter_artifact SET current_revision_id = ? WHERE id = ?").run(chapterRevision, chapterArtifact);

  const summaryArtifact = nextId();
  const summaryRevision = nextId();
  row("summary_artifact", { id: summaryArtifact, content_id: content, template_id: customTemplate });
  row("summary_revision", { id: summaryRevision, artifact_id: summaryArtifact, ...provenance, body: "…", citations_json: json([]), chapter_revision_id: chapterRevision });
  db.prepare("UPDATE summary_artifact SET current_revision_id = ? WHERE id = ?").run(summaryRevision, summaryArtifact);
  row("rollup_partial", { id: nextId(), summary_revision_id: summaryRevision, partial_index: 0, inputs_json: json([]), body: "…", citations_json: json([]), model_ref_json: modelRef, prompt_ref_json: promptRef, prompt_snapshot: "…", created_at: T0 });

  const highlightArtifact = nextId();
  row("highlight_artifact", { id: highlightArtifact, content_id: content });
  row("highlight_revision", { id: nextId(), artifact_id: highlightArtifact, ...provenance, transcript_revision_id: primary, items_json: json([{ segmentId: firstSegment, score: 90, text: "…" }]) });
  row("translation_artifact", { id: nextId(), content_id: content, target_language: "en", current_revision_id: translatedId });

  const collectionArtifact = nextId();
  const collectionRevision = nextId();
  row("collection_summary_artifact", { id: collectionArtifact, collection_id: collection });
  row("collection_summary_revision", { id: collectionRevision, artifact_id: collectionArtifact, ...provenance, input_items_json: json([]), partial_ids_json: json([]), body: "…", citations_json: json([]) });
  db.prepare("UPDATE collection_summary_artifact SET current_revision_id = ? WHERE id = ?").run(collectionRevision, collectionArtifact);
  row("rollup_partial", { id: nextId(), collection_summary_revision_id: collectionRevision, partial_index: 0, inputs_json: json([]), body: "…", citations_json: json([]), model_ref_json: modelRef, prompt_ref_json: promptRef, prompt_snapshot: "…", created_at: T0 });

  const thread = nextId();
  const message = nextId();
  const compaction = nextId();
  row("chat_thread", { id: thread, content_id: content, created_at: 0 });
  row("chat_message", { id: message, thread_id: thread, role: "user", text: "?", status: "complete", context_transcript_revision_id: primary, citations_json: json([]), created_at: T0 });
  row("chat_compaction", { id: compaction, thread_id: thread, through_message_id: message, body: "…", model_ref_json: modelRef, prompt_ref_json: promptRef, prompt_snapshot: "…", created_at: T0 });
  db.prepare("UPDATE chat_thread SET current_compaction_id = ? WHERE id = ?").run(compaction, thread);

  const tokenUsage = { content: nextId(), collection: nextId() };
  row("token_usage", {
    id: tokenUsage.content, user_id: userId, model_ref_json: modelRef, feature: "summary", task_id: task, work_unit_id: workUnit,
    artifact_revision_id: summaryRevision, chat_message_id: message, content_id: content, outcome: "succeeded", created_at: T0,
  });
  row("token_usage", {
    id: tokenUsage.collection, user_id: userId, model_ref_json: modelRef, feature: "collection_summary", task_id: collectionTask,
    artifact_revision_id: collectionRevision, outcome: "outcome_unknown", created_at: T0,
  });
  const asrUsage = nextId();
  row("asr_usage", { id: asrUsage, user_id: userId, asr_profile_id: asrProfile, provider: "elevenlabs", model: "scribe_v2", outcome: "succeeded", audio_ms: 21000, task_id: task, content_id: content, created_at: T0 });
  row("idempotency_record", {
    user_id: userId, route: "POST /api/contents/import", idempotency_key: "k1", request_digest: "sha256:0",
    response_status: 202, response_body_json: json({ taskIds: [task] }), resource_refs_json: json([task]), created_at: T0,
  });

  return {
    userId, content, otherContent, collection, task, collectionTask, workUnit, providerProfile, asrProfile, platformAccount,
    secrets: { provider: secrets.provider.id as string, asr: secrets.asr.id as string, platform: secrets.platform.id as string },
    externalFile, tokenUsage, asrUsage,
  };
}

/** Row count of every table restricted to what traces back to `userId`, via the same chains the ownership test checks. */
function ownedCounts(db: SqliteConnection, userId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tableNames(db).filter((name) => !isProjectionTable(name))) {
    if (table.startsWith("sqlite_") || OWNERLESS_TABLES.includes(table)) continue;
    counts[table] = ownedRowCount(db, table, userId);
  }
  return counts;
}

function ownedRowCount(db: SqliteConnection, table: string, userId: string): number {
  // Build `table → ... → a table with user_id` joins along non-null foreign keys.
  const path = ownerPath(db, table);
  let sql = `SELECT count(*) AS n FROM ${table} AS t0`;
  path.forEach((step, index) => {
    sql += ` JOIN ${step.table} AS t${index + 1} ON t${index + 1}.id = t${index}.${step.from}`;
  });
  const last = path.length === 0 ? "t0" : `t${path.length}`;
  const ownerColumn = table === "user" ? "id" : "user_id";
  return (db.prepare(`${sql} WHERE ${last}.${ownerColumn} = ?`).get(userId) as { n: number }).n;
}

function ownerPath(db: SqliteConnection, table: string): ForeignKey[] {
  if (table === "user" || columnsOf(db, table).some((column) => column.name === "user_id")) return [];
  if (table === "rollup_partial") return [{ id: 0, table: "summary_revision", from: "summary_revision_id" }, ...ownerPath(db, "summary_revision")];
  const columns = columnsOf(db, table);
  for (const key of foreignKeysOf(db, table)) {
    const single = joinsOnId(foreignKeysOf(db, table), columns, key);
    const notNull = columns.find((column) => column.name === key.from)?.notnull === 1;
    if (single && notNull && key.table !== table) return [key, ...ownerPath(db, key.table)];
  }
  throw new Error(`no owner path for ${table}`);
}

let db: SqliteConnection;
let dir: string;
let repository: SqliteRepository;

beforeEach(() => {
  const opened = openTempDatabase();
  db = opened.db;
  dir = opened.dir;
  repository = new SqliteRepository(db);
  insertRow(db, "summary_template", { id: "summary.core", builtin: 1, name: "core", current_version: 1 });
  insertRow(db, "summary_template_version", { template_id: "summary.core", version: 1, prompt: "# core", created_at: T0 });
});

describe("every persistent table traces to a userId", () => {
  it("classifies each table by owner column, non-null foreign-key chain or row invariant, with an explicit whitelist", () => {
    const traceable = new Set<string>(["user"]);
    const tables = tableNames(db).filter((table) => !table.startsWith("sqlite_") && !isProjectionTable(table));
    let changed = true;
    while (changed) {
      changed = false;
      for (const table of tables) {
        if (traceable.has(table)) continue;
        const columns = columnsOf(db, table);
        const userColumn = columns.find((column) => column.name === "user_id");
        const viaColumn = userColumn !== undefined && (userColumn.notnull === 1 || ROW_INVARIANT_TABLES.includes(table));
        const keys = foreignKeysOf(db, table);
        const viaChain = keys.some((key) => {
          const single = joinsOnId(keys, columns, key);
          const notNull = columns.find((column) => column.name === key.from)?.notnull === 1;
          return traceable.has(key.table) && key.table !== table && (notNull || ROW_INVARIANT_TABLES.includes(table)) && single;
        });
        if (viaColumn || viaChain) {
          traceable.add(table);
          changed = true;
        }
      }
    }
    const untraced = tables.filter((table) => !traceable.has(table));
    expect(untraced).toEqual(OWNERLESS_TABLES);
  });

  it("enforces the summary_template row invariant: builtin ⇔ no owner, builtins never soft-deleted", () => {
    insertRow(db, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    expect(() => insertRow(db, "summary_template", { id: "a", builtin: 0, name: "x", current_version: 1 })).toThrow(/CHECK/);
    expect(() => insertRow(db, "summary_template", { id: "b", user_id: "u", builtin: 1, name: "x", current_version: 1 })).toThrow(/CHECK/);
    expect(() => insertRow(db, "summary_template", { id: "c", builtin: 1, name: "x", current_version: 1, deleted_at: T0 })).toThrow(/CHECK/);
  });

  it("enforces the rollup_partial row invariant: exactly one owning revision", () => {
    const base = { partial_index: 0, inputs_json: "[]", body: "…", citations_json: "[]", model_ref_json: modelRef, prompt_ref_json: promptRef, prompt_snapshot: "…", created_at: T0 };
    expect(() => insertRow(db, "rollup_partial", { id: "p", ...base })).toThrow(/CHECK/);
  });

  it("traces every seeded row to its owner and nothing to anyone else", () => {
    const seed = seedUser(db, repository, dir, "owner-a");
    seedUser(db, repository, dir, "owner-b");
    const a = ownedCounts(db, seed.userId);
    const b = ownedCounts(db, "owner-b");
    for (const table of Object.keys(a)) {
      if (table === "summary_template" || table === "summary_template_version") continue;
      expect({ table, a: a[table] }).not.toEqual({ table, a: 0 });
      expect({ table, count: a[table] }).toEqual({ table, count: b[table] });
    }
  });
});

describe("deletion cascades of Content, Collection, Profile, PlatformAccount and User", () => {
  const contentScoped = [
    "transcript_revision", "transcript_draft", "reference_text", "summary_artifact", "chapter_artifact",
    "highlight_artifact", "translation_artifact", "chat_thread", "media_asset", "note",
  ];

  it("deleting a Content removes its tasks, transcripts, artifacts, chat and every MediaAsset row, keeps usage unlinked and leaves external_local files alone", () => {
    const seed = seedUser(db, repository, dir, "u1");
    expect(countRows(db, "media_asset", "content_id = ?", seed.content)).toBe(3);

    db.prepare("DELETE FROM content WHERE id = ?").run(seed.content);

    for (const table of contentScoped) {
      expect({ table, n: countRows(db, table, "content_id = ?", seed.content) }).toEqual({ table, n: 0 });
    }
    for (const table of ["transcript_segment", "transcript_segment_source", "summary_revision", "chapter_revision", "highlight_revision", "chat_message", "chat_compaction", "stage_run", "work_unit", "work_unit_result"]) {
      expect({ table, n: countRows(db, table) }).toEqual({ table, n: 0 });
    }
    expect(countRows(db, "rollup_partial", "summary_revision_id IS NOT NULL")).toBe(0);
    expect(countRows(db, "task", "id = ?", seed.task)).toBe(0);
    expect(countRows(db, "terminology_set", "content_id = ?", seed.content)).toBe(0);
    expect(countRows(db, "collection_item", "content_id = ?", seed.content)).toBe(0);

    expect(existsSync(seed.externalFile)).toBe(true);
    expect(db.prepare("SELECT content_id, task_id, work_unit_id, artifact_revision_id, chat_message_id FROM token_usage WHERE id = ?").get(seed.tokenUsage.content))
      .toEqual({ content_id: null, task_id: null, work_unit_id: null, artifact_revision_id: null, chat_message_id: null });
    expect(db.prepare("SELECT task_id, content_id, asr_profile_id FROM asr_usage WHERE id = ?").get(seed.asrUsage))
      .toEqual({ task_id: null, content_id: null, asr_profile_id: seed.asrProfile });

    expect(countRows(db, "content", "id = ?", seed.otherContent)).toBe(1);
    expect(countRows(db, "collection", "id = ?", seed.collection)).toBe(1);
    expect(countRows(db, "terminology_set", "scope_kind IN ('global', 'collection')")).toBe(2);
    expect(countRows(db, "task", "id = ?", seed.collectionTask)).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("deleting a Collection removes its items, summary, partials, tasks and terminology, keeping member Content and usage", () => {
    const seed = seedUser(db, repository, dir, "u1");
    db.prepare("DELETE FROM collection WHERE id = ?").run(seed.collection);

    expect(countRows(db, "collection_item")).toBe(0);
    expect(countRows(db, "collection_summary_artifact")).toBe(0);
    expect(countRows(db, "collection_summary_revision")).toBe(0);
    expect(countRows(db, "rollup_partial", "collection_summary_revision_id IS NOT NULL")).toBe(0);
    expect(countRows(db, "task", "id = ?", seed.collectionTask)).toBe(0);
    expect(countRows(db, "terminology_set", "scope_kind = 'collection'")).toBe(0);
    expect(countRows(db, "content", "user_id = ?", seed.userId)).toBe(2);
    expect(db.prepare("SELECT task_id, artifact_revision_id FROM token_usage WHERE id = ?").get(seed.tokenUsage.collection))
      .toEqual({ task_id: null, artifact_revision_id: null });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("deleting a Profile or PlatformAccount deletes its exclusive Secret and unlinks AsrUsage", () => {
    const seed = seedUser(db, repository, dir, "u1");
    db.prepare("DELETE FROM provider_profile WHERE id = ?").run(seed.providerProfile);
    db.prepare("DELETE FROM asr_provider_profile WHERE id = ?").run(seed.asrProfile);
    db.prepare("DELETE FROM platform_account WHERE id = ?").run(seed.platformAccount);

    expect(countRows(db, "secret", "user_id = ?", seed.userId)).toBe(0);
    expect(countRows(db, "model_capability")).toBe(0);
    expect(db.prepare("SELECT asr_profile_id, provider, model FROM asr_usage WHERE id = ?").get(seed.asrUsage))
      .toEqual({ asr_profile_id: null, provider: "elevenlabs", model: "scribe_v2" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("deleting a User removes everything it owns, including usage and secrets, and nothing of other users or builtins", () => {
    const seed = seedUser(db, repository, dir, "u1");
    seedUser(db, repository, dir, "u2");
    // The derived search projection of both users, then the repository's user deletion.
    repository.withTransaction((scope) => scope.search.rebuild());
    const searchRows = (userId: string) => countRows(db, "search_index", "user_id = ?", userId);
    expect(searchRows(seed.userId)).toBeGreaterThan(0);
    const survivingSearchRows = searchRows("u2");
    const survivor = ownedCounts(db, "u2");

    repository.withTransaction((scope) => scope.users.delete(seed.userId));

    const remaining = Object.entries(ownedCounts(db, seed.userId)).filter(([, n]) => n > 0);
    expect(remaining).toEqual([]);
    expect(ownedCounts(db, "u2")).toEqual(survivor);
    expect(searchRows(seed.userId)).toBe(0);
    expect(searchRows("u2")).toBe(survivingSearchRows);
    // Both of u2's partials survive, including the collection-owned one outside the counted path.
    expect(countRows(db, "rollup_partial")).toBe(2);
    expect(countRows(db, "summary_template", "builtin = 1")).toBe(1);
    expect(countRows(db, "summary_template_version", "template_id = 'summary.core'")).toBe(1);
    expect(existsSync(seed.externalFile)).toBe(true);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("structural invariants", () => {
  let seed: Seed;
  beforeEach(() => {
    seed = seedUser(db, repository, dir, "u1");
    insertRow(db, "user", { id: "intruder", role: "user", status: "active", created_at: T0 });
  });

  const asset = (extra: Record<string, unknown>) => ({
    id: nextId(), user_id: "u1", content_id: seed.content, kind: "managed_upload", storage_ref: "x", mime_type: "video/mp4",
    size_bytes: 1, availability: "available", retention_policy: "keep", created_at: T0, ...extra,
  });

  it("rejects cross-owner links through composite keys", () => {
    expect(() => insertRow(db, "media_asset", asset({ user_id: "intruder" }))).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "task", { id: nextId(), user_id: "intruder", content_id: seed.content, kind: "reproofread", request_json: "{}", status_projection: "queued", created_at: T0 })).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "terminology_set", { id: nextId(), user_id: "intruder", scope_kind: "content", content_id: seed.content })).toThrow(/FOREIGN KEY/);
    const secret = secretRow("intruder");
    insertRow(db, "secret", secret);
    expect(() => insertRow(db, "provider_profile", { id: nextId(), user_id: "u1", name: "x", protocol: "openai_compatible", base_url: "https://example.com", credential_ref: secret.id, created_at: T0 })).toThrow(/FOREIGN KEY/);
  });

  it("pairs MediaAsset.taskId with the task-scoped kinds", () => {
    expect(() => insertRow(db, "media_asset", asset({ kind: "extracted_audio" }))).toThrow(/CHECK/);
    expect(() => insertRow(db, "media_asset", asset({ task_id: seed.task }))).toThrow(/CHECK/);
    expect(() => insertRow(db, "media_asset", asset({ kind: "temporary", task_id: seed.task }))).not.toThrow();
  });

  it("requires exactly one Task target and keeps request_json immutable", () => {
    const task = { user_id: "u1", kind: "regenerate_summary", request_json: "{}", status_projection: "queued", created_at: T0 };
    expect(() => insertRow(db, "task", { id: nextId(), ...task })).toThrow(/CHECK/);
    expect(() => insertRow(db, "task", { id: nextId(), ...task, content_id: seed.content, collection_id: seed.collection })).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE task SET request_json = '{}' WHERE id = ?").run(seed.task)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE task SET status_projection = 'failed' WHERE id = ?").run(seed.task)).not.toThrow();
  });

  it("rejects zero-length and negative segment spans", () => {
    const revision = (db.prepare("SELECT id FROM transcript_revision LIMIT 1").get() as { id: string }).id;
    const segment = (startMs: number, endMs: number) => ({ id: nextId(), revision_id: revision, ordinal: 1000 + startMs, start_ms: startMs, end_ms: endMs, text: "x" });
    expect(() => insertRow(db, "transcript_segment", segment(5, 5))).toThrow(/CHECK/);
    expect(() => insertRow(db, "transcript_segment", segment(-1, 5))).toThrow(/CHECK/);
  });

  it("keeps committed transcripts, template versions and revisions immutable", () => {
    for (const table of ["transcript_revision", "transcript_segment", "transcript_segment_source", "summary_revision", "chapter_revision", "highlight_revision", "collection_summary_revision", "rollup_partial", "summary_template_version"]) {
      expect(() => db.prepare(`UPDATE ${table} SET rowid = rowid`).run(), table).toThrow(/immutable/);
    }
    // A compaction's end may move to an earlier kept message; nothing else of it changes.
    expect(() => db.prepare("UPDATE chat_compaction SET body = body").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE chat_compaction SET through_message_id = through_message_id").run()).not.toThrow();
  });

  it("validates JSON columns", () => {
    expect(() => insertRow(db, "work_unit_result", { work_unit_id: seed.workUnit, payload_json: "{broken", output_digest: "x", created_at: T0 })).toThrow(/CHECK/);
  });

  it("keeps the canonical platform identity unique per user", () => {
    const platformId = (db.prepare("SELECT platform_content_id AS id FROM content WHERE id = ?").get(seed.otherContent) as { id: string }).id;
    const duplicate = { user_id: "u1", source_kind: "bilibili", platform_content_id: platformId, processing_status: "queued", created_at: T0, updated_at: T0 };
    expect(() => insertRow(db, "content", { id: nextId(), ...duplicate })).toThrow(/UNIQUE/);
    expect(() => insertRow(db, "content", { id: nextId(), ...duplicate, platform_part_id: "cid-2" })).not.toThrow();
    expect(() => insertRow(db, "content", { id: nextId(), ...duplicate, user_id: "intruder" })).not.toThrow();
  });

  it("keeps the primary transcript within its own Content", () => {
    const otherRevision = (db.prepare("SELECT id FROM transcript_revision WHERE content_id = ? LIMIT 1").get(seed.content) as { id: string }).id;
    expect(() => db.prepare("UPDATE content SET primary_transcript_revision_id = ? WHERE id = ?").run(otherRevision, seed.otherContent)).toThrow(/FOREIGN KEY/);
  });
});
