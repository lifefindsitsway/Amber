import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { errors as zhCnErrors } from "../../../../../src/shared/i18n/zh-CN/errors.ts";
import { countRows, insertRow, tableNames, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const json = (value: unknown) => JSON.stringify(value);
const MODEL_REF = json({ providerProfileId: "p", modelId: "m", providerNameSnapshot: "P", modelDisplaySnapshot: "M" });
const PROMPT_REF = json({ id: "summary.core", version: 1 });

/** Each table that gains columns, with the columns it gains. */
const ADDED_COLUMNS: Record<string, string[]> = {
  content_speaker: ["name_confirmed_at"],
  summary_revision: ["speaker_context_json"],
  rollup_partial: ["speaker_context_json"],
  chapter_revision: ["speaker_context_json"],
  highlight_revision: ["speaker_context_json"],
  chat_message: ["speaker_context_json", "context_used_json"],
  chat_compaction: ["speaker_bases_json"],
};
const ADDED = Object.entries(ADDED_COLUMNS).flatMap(([table, columns]) => columns.map((column) => [table, column] as const));
/** Tables seeded before the upgrade whose rows must come through untouched. */
const SEEDED_TABLES = [
  "user", "content", "content_speaker", "transcript_revision", "transcript_segment", "transcript_revision_archive",
  "summary_artifact", "summary_revision", "rollup_partial", "chapter_artifact", "chapter_revision",
  "highlight_artifact", "highlight_revision", "collection", "collection_summary_artifact", "collection_summary_revision",
  "chat_thread", "chat_message", "chat_compaction",
];

const provenance = (createdAt: number) => ({
  inputs_json: json([{ kind: "transcriptRevision", id: "r1" }]), model_ref_json: MODEL_REF, prompt_ref_json: PROMPT_REF,
  prompt_snapshot: "…", quality: "normal", prompt_refs_json: json([PROMPT_REF]), created_at: createdAt,
});

function seed(db: SqliteConnection): void {
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(db, "user", { id: "bob", role: "user", status: "active", created_at: T0 });
  for (const content of ["c1", "c2"]) {
    insertRow(db, "content", { id: content, user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  }
  insertRow(db, "content_speaker", { content_id: "c1", id: "0", user_id: "alice", ordinal: 1, name: "张老师", color_index: 0, created_at: T0, updated_at: T0 + 1 });
  insertRow(db, "content_speaker", { content_id: "c1", id: "1", user_id: "alice", ordinal: 2, color_index: 1, created_at: T0, updated_at: T0 });
  for (const [id, content] of [["r1", "c1"], ["r2", "c1"], ["r3", "c2"]] as const) {
    insertRow(db, "transcript_revision", {
      id, content_id: content, kind: "asr", language: "zh", timing_fidelity: "segment_only",
      generation_json: json({ kind: "asr", asrProfileId: "p", modelId: "m" }), segment_count: 1, created_at: T0,
    });
  }
  insertRow(db, "transcript_segment", { id: "s1", revision_id: "r1", ordinal: 0, start_ms: 0, end_ms: 1000, text: "第一句", speaker_id: "0" });
  insertRow(db, "transcript_segment", { id: "s2", revision_id: "r2", ordinal: 0, start_ms: 0, end_ms: 1000, text: "第一句", speaker_id: "1" });
  insertRow(db, "transcript_segment", { id: "s3", revision_id: "r3", ordinal: 0, start_ms: 0, end_ms: 1000, text: "另一句" });
  insertRow(db, "transcript_revision_archive", { revision_id: "r2", content_id: "c1", archived_at: T0 + 2 });

  insertRow(db, "summary_template", { id: "summary.core", builtin: 1, name: "core", current_version: 1 });
  insertRow(db, "summary_template_version", { template_id: "summary.core", version: 1, prompt: "# core", created_at: T0 });
  insertRow(db, "chapter_artifact", { id: "ca", content_id: "c1" });
  insertRow(db, "chapter_revision", { id: "cr", artifact_id: "ca", ...provenance(T0), origin_json: json({ kind: "ai", transcriptRevisionId: "r1" }), chapters_json: json([]) });
  db.prepare("UPDATE chapter_artifact SET current_revision_id = 'cr' WHERE id = 'ca'").run();
  insertRow(db, "summary_artifact", { id: "sa", content_id: "c1", template_id: "summary.core" });
  insertRow(db, "summary_revision", { id: "sr", artifact_id: "sa", ...provenance(T0), body: "旧总结", citations_json: json([]), chapter_revision_id: "cr", partial_ids_json: json(["rp"]) });
  db.prepare("UPDATE summary_artifact SET current_revision_id = 'sr' WHERE id = 'sa'").run();
  insertRow(db, "rollup_partial", {
    id: "rp", summary_revision_id: "sr", partial_index: 0, inputs_json: json([]), body: "片段", citations_json: json([]),
    model_ref_json: MODEL_REF, prompt_ref_json: PROMPT_REF, prompt_snapshot: "…", created_at: T0,
  });
  insertRow(db, "highlight_artifact", { id: "ha", content_id: "c1" });
  insertRow(db, "highlight_revision", { id: "hr", artifact_id: "ha", ...provenance(T0), transcript_revision_id: "r1", items_json: json([{ segmentId: "s1", score: 90, text: "第一句" }]) });
  db.prepare("UPDATE highlight_artifact SET current_revision_id = 'hr' WHERE id = 'ha'").run();
  insertRow(db, "collection", { id: "col", user_id: "alice", name: "course", created_at: T0 });
  insertRow(db, "collection_summary_artifact", { id: "csa", collection_id: "col" });
  insertRow(db, "collection_summary_revision", { id: "csr", artifact_id: "csa", ...provenance(T0), input_items_json: json([]), partial_ids_json: json([]), body: "合集", citations_json: json([]) });

  insertRow(db, "chat_thread", { id: "t1", content_id: "c1", created_at: T0, custom_title: "讨论" });
  insertRow(db, "chat_message", { id: "m1", thread_id: "t1", role: "user", text: "谁在说话？", status: "complete", citations_json: json([]), created_at: T0 + 10 });
  insertRow(db, "chat_message", {
    id: "m2", thread_id: "t1", role: "assistant", text: "张老师", status: "complete", model_ref_json: MODEL_REF,
    context_transcript_revision_id: "r1", citations_json: json([]), created_at: T0 + 11, finished_at: T0 + 12,
  });
  insertRow(db, "chat_message", { id: "m3", thread_id: "t1", role: "user", text: "继续", status: "complete", citations_json: json([]), created_at: T0 + 20 });
  insertRow(db, "chat_compaction", {
    id: "k1", thread_id: "t1", through_message_id: "m2", body: "摘要", model_ref_json: MODEL_REF,
    prompt_ref_json: json({ id: "chat.compaction", version: 1 }), prompt_snapshot: "…", created_at: T0 + 15,
  });
  db.prepare("UPDATE chat_thread SET current_compaction_id = 'k1' WHERE id = 't1'").run();
}

const snapshot = (db: SqliteConnection) =>
  Object.fromEntries(SEEDED_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>]));

/** A database at schema 28 holding representative rows, then upgraded to 29. */
function upgraded() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const old = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 28) });
  seed(old.db);
  const before = snapshot(old.db);
  old.db.close();
  const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 29) });
  return { db, from, to, before, file };
}

describe("migration 0029: speaker context", () => {
  it("keeps every existing row and value and adds the new columns as NULL", () => {
    const { db, from, to, before } = upgraded();
    expect({ from, to }).toEqual({ from: 28, to: 29 });
    expect(latestSchemaVersion(MIGRATIONS.slice(0, 29))).toBe(29);
    expect(db.pragma("user_version", { simple: true })).toBe(29);
    const after = snapshot(db);
    for (const table of SEEDED_TABLES) {
      const added = ADDED_COLUMNS[table] ?? [];
      const expected = before[table]?.map((row) => ({ ...row, ...Object.fromEntries(added.map((column) => [column, null])) }));
      expect(after[table], table).toEqual(expected);
      expect(after[table]?.length, table).toBeGreaterThan(0);
    }
    for (const [table, column] of ADDED) {
      const info = (db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number; dflt_value: unknown }>).filter((c) => c.name === column);
      expect(info, table).toEqual([expect.objectContaining({ name: column, notnull: 0, dflt_value: null })]);
    }
    // Collection summaries are not given a speaker context.
    expect((db.pragma("table_info(collection_summary_revision)") as Array<{ name: string }>).map((c) => c.name)).not.toContain("speaker_context_json");
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("keeps a confirmation on a revision of its own Content and owner, and drops it with the revision", () => {
    const { db } = upgraded();
    const confirm = (revision: string, content: string, user: string) =>
      insertRow(db, "transcript_revision_speaker_confirmation", { revision_id: revision, content_id: content, user_id: user, confirmed_at: T0 + 30 });
    confirm("r1", "c1", "alice");
    expect(db.prepare("SELECT * FROM transcript_revision_speaker_confirmation").all()).toEqual([
      { revision_id: "r1", content_id: "c1", user_id: "alice", confirmed_at: T0 + 30 },
    ]);
    expect(() => confirm("r1", "c1", "alice")).toThrow(/UNIQUE/u);
    // The composite keys refuse a mark naming another Content or another owner.
    expect(() => confirm("r2", "c2", "alice")).toThrow(/FOREIGN KEY/u);
    expect(() => confirm("r2", "c1", "bob")).toThrow(/FOREIGN KEY/u);
    expect(() => confirm("missing", "c1", "alice")).toThrow(/FOREIGN KEY/u);
    // Withdrawing is deleting the row; the revision itself is never touched.
    db.prepare("DELETE FROM transcript_revision_speaker_confirmation WHERE revision_id = 'r1'").run();
    expect(countRows(db, "transcript_revision", "id = 'r1'")).toBe(1);

    // r2 is referenced by nothing but its sentences and archive mark, so it can go.
    confirm("r2", "c1", "alice");
    db.prepare("DELETE FROM transcript_revision WHERE id = 'r2'").run();
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(0);
    expect(countRows(db, "transcript_revision_archive")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("goes with its Content and its user the same way archive marks do", () => {
    const { db } = upgraded();
    insertRow(db, "transcript_revision_speaker_confirmation", { revision_id: "r1", content_id: "c1", user_id: "alice", confirmed_at: T0 });
    insertRow(db, "transcript_revision_speaker_confirmation", { revision_id: "r2", content_id: "c1", user_id: "alice", confirmed_at: T0 });
    insertRow(db, "transcript_revision_speaker_confirmation", { revision_id: "r3", content_id: "c2", user_id: "alice", confirmed_at: T0 });
    db.prepare("DELETE FROM content WHERE id = 'c1'").run();
    expect(countRows(db, "transcript_revision_speaker_confirmation", "content_id = 'c1'")).toBe(0);
    expect(countRows(db, "transcript_revision_archive", "content_id = 'c1'")).toBe(0);
    expect(countRows(db, "transcript_revision_speaker_confirmation", "content_id = 'c2'")).toBe(1);
    db.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(countRows(db, "transcript_revision_speaker_confirmation")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("accepts NULL or valid JSON and rejects anything else in every new JSON column", () => {
    const { db } = upgraded();
    let n = 0;
    const insertWith = (table: string, column: string, value: string | null) => {
      n += 1;
      const id = `x${n}`;
      const extra = { [column]: value };
      switch (table) {
        case "summary_revision":
          insertRow(db, table, { id, artifact_id: "sa", ...provenance(T0), body: "…", citations_json: "[]", ...extra });
          break;
        case "rollup_partial":
          insertRow(db, table, { id, summary_revision_id: "sr", partial_index: n, inputs_json: "[]", body: "…", citations_json: "[]", model_ref_json: MODEL_REF, prompt_ref_json: PROMPT_REF, prompt_snapshot: "…", created_at: T0, ...extra });
          break;
        case "chapter_revision":
          insertRow(db, table, { id, artifact_id: "ca", ...provenance(T0), origin_json: "{}", chapters_json: "[]", ...extra });
          break;
        case "highlight_revision":
          insertRow(db, table, { id, artifact_id: "ha", ...provenance(T0), transcript_revision_id: "r1", items_json: "[]", ...extra });
          break;
        case "chat_message":
          insertRow(db, table, { id, thread_id: "t1", role: "assistant", text: "…", status: "complete", citations_json: "[]", created_at: T0 + 30, ...extra });
          break;
        case "chat_compaction":
          insertRow(db, table, { id, thread_id: "t1", through_message_id: "m3", body: "…", model_ref_json: MODEL_REF, prompt_ref_json: PROMPT_REF, prompt_snapshot: "…", created_at: T0 + 30, ...extra });
          break;
        default:
          throw new Error(`unexpected table ${table}`);
      }
      return db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id);
    };
    const jsonColumns = ADDED.filter(([, column]) => column.endsWith("_json"));
    expect(jsonColumns).toHaveLength(7);
    for (const [table, column] of jsonColumns) {
      expect(insertWith(table, column, null), table).toEqual({ value: null });
      const valid = json({ speakers: [{ id: "0", ordinal: 1, name: "张老师" }] });
      expect(insertWith(table, column, valid), table).toEqual({ value: valid });
      expect(() => insertWith(table, column, "{not json"), table).toThrow(/CHECK/u);
    }
    db.close();
  });

  it("keeps a compaction immutable, its speaker bases included, except for through_message_id", () => {
    const { db } = upgraded();
    for (const assignment of [
      "speaker_bases_json = '[]'", "body = 'x'", "model_ref_json = '{}'", "prompt_ref_json = '{}'", "prompt_snapshot = 'x'",
      "created_at = 0", "thread_id = 't1'", "id = 'k2'",
    ]) {
      expect(() => db.prepare(`UPDATE chat_compaction SET ${assignment} WHERE id = 'k1'`).run(), assignment).toThrow(/immutable/u);
    }
    db.prepare("UPDATE chat_compaction SET through_message_id = 'm1' WHERE id = 'k1'").run();
    expect(db.prepare("SELECT through_message_id, speaker_bases_json FROM chat_compaction WHERE id = 'k1'").get()).toEqual({ through_message_id: "m1", speaker_bases_json: null });
    // An answer's recorded material is an ordinary column of a message, written once planning is done.
    db.prepare("UPDATE chat_message SET context_used_json = '{\"mode\":\"full\"}' WHERE id = 'm2'").run();
    expect(db.prepare("SELECT context_used_json FROM chat_message WHERE id = 'm2'").get()).toEqual({ context_used_json: '{"mode":"full"}' });
    // A name confirmation is an ordinary update of a speaker.
    db.prepare("UPDATE content_speaker SET name_confirmed_at = ? WHERE content_id = 'c1' AND id = '0'").run(T0 + 40);
    expect(db.prepare("SELECT name, name_confirmed_at FROM content_speaker WHERE content_id = 'c1' AND id = '0'").get()).toEqual({ name: "张老师", name_confirmed_at: T0 + 40 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("is refused by the build before it, which tells the user to upgrade and leaves the file untouched", () => {
    const { db, file } = upgraded();
    db.close();
    const before = createHash("sha256").update(readFileSync(file)).digest("hex");
    let thrown: unknown;
    try {
      openDatabase(file, { backupDir: join(file, "..", "backups"), migrations: MIGRATIONS.slice(0, 28) });
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && thrown.appError).toMatchObject({
      class: "schema_version_unsupported",
      code: "schema_version_unsupported",
      retryDisposition: "never",
      userMessage: zhCnErrors.schema_version_unsupported,
    });
    expect(isAmberError(thrown) && thrown.appError.userMessage).not.toBe("");
    expect(isAmberError(thrown) && thrown.message).toMatch(/\b29\b.*\b28\b/u);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before);
    const reopened = openDatabase(file, { backupDir: join(file, "..", "backups"), migrations: MIGRATIONS.slice(0, 29) });
    expect({ from: reopened.from, to: reopened.to }).toEqual({ from: 29, to: 29 });
    reopened.db.close();
  });

  it("stores no speaker state anywhere: the only schema change is the recorded contexts, the name confirmation and the review mark", () => {
    const columnsOf = (db: SqliteConnection) =>
      Object.fromEntries(
        tableNames(db).map((table) => [table, (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)]),
      );
    const dir = tempDataDir();
    const old = openDatabase(join(dir, "amber.db"), { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 28) });
    const before = columnsOf(old.db);
    old.db.close();
    const { db } = upgraded();
    const after = columnsOf(db);
    const added = Object.fromEntries(
      Object.entries(after).flatMap(([table, columns]) => {
        const fresh = columns.filter((column) => !(before[table] ?? []).includes(column));
        return fresh.length === 0 ? [] : [[table, fresh]];
      }),
    );
    expect(added).toEqual({ ...ADDED_COLUMNS, transcript_revision_speaker_confirmation: ["revision_id", "content_id", "user_id", "confirmed_at"] });
    // Nothing went away either: the state of a result is derived on each read, never kept.
    expect(Object.keys(before).filter((table) => !(table in after))).toEqual([]);
    const resultTables = [
      "summary_artifact", "summary_revision", "rollup_partial", "chapter_artifact", "chapter_revision", "highlight_artifact", "highlight_revision",
      "collection_summary_artifact", "collection_summary_revision", "chat_thread", "chat_message", "chat_compaction",
    ];
    for (const table of resultTables) {
      expect(after[table], table).toBeDefined();
      expect(after[table]?.filter((column) => /state|stale|fresh|consisten|changed|removed|caution/u.test(column)), table).toEqual([]);
    }
    db.close();
  });
});
