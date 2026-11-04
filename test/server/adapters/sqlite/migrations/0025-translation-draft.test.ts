import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function atVersion24(): { dir: string; file: string } {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 24) });
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  for (const [id, kind, language] of [["r", "asr", "zh-CN"], ["en", "translated", "en"], ["ja", "translated", "ja"]] as const) {
    insertRow(db, "transcript_revision", {
      id,
      content_id: "c",
      kind,
      parent_revision_id: kind === "translated" ? "r" : null,
      language,
      timing_fidelity: kind === "asr" ? "exact_words" : "segment_only",
      generation_json: "{}",
      segment_count: 0,
      created_at: T0,
    });
  }
  insertRow(db, "transcript_draft", { id: "d", content_id: "c", base_revision_id: "r", segments_json: "[]", updated_at: T0 });
  db.close();
  return { dir, file };
}

describe("migration 0025: translation draft", () => {
  it("keeps the existing draft as the transcript draft at version 1", () => {
    const { dir, file } = atVersion24();
    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 25) });
    expect({ from, to }).toEqual({ from: 24, to: 25 });
    expect(db.prepare("SELECT id, base_revision_id, target_language, version FROM transcript_draft").all()).toEqual([
      { id: "d", base_revision_id: "r", target_language: null, version: 1 },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("allows one transcript draft and one draft per translation language side by side", () => {
    const { dir, file } = atVersion24();
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 25) });
    const draft = (id: string, base: string, language: string | null) =>
      insertRow(db, "transcript_draft", { id, content_id: "c", base_revision_id: base, target_language: language, segments_json: "[]", updated_at: T0 });
    draft("d-en", "en", "en");
    draft("d-ja", "ja", "ja");
    expect(countRows(db, "transcript_draft")).toBe(3);
    expect(() => draft("d2", "r", null)).toThrow(/UNIQUE/);
    expect(() => draft("d-en2", "en", "en")).toThrow(/UNIQUE/);
    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transcript_draft' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name)).toEqual(["transcript_draft_base", "transcript_draft_content", "transcript_draft_translation"]);
    expect(indexes.find((index) => index.name === "transcript_draft_content")?.sql).toMatch(/WHERE target_language IS NULL/);
    db.close();
  });
});
