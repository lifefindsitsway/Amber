import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const ARTIFACT_TABLES = ["summary_revision", "chapter_revision", "highlight_revision", "collection_summary_revision", "rollup_partial"];

function migrated() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const opened = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 23) });
  insertRow(opened.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(opened.db, "user", { id: "bob", role: "user", status: "active", created_at: T0 });
  insertRow(opened.db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  insertRow(opened.db, "summary_template", { id: "summary.core", builtin: 1, name: "core", current_version: 1 });
  insertRow(opened.db, "summary_template_version", { template_id: "summary.core", version: 1, prompt: "# core", created_at: T0 });
  insertRow(opened.db, "summary_artifact", { id: "sa", content_id: "c", template_id: "summary.core" });
  insertRow(opened.db, "summary_revision", {
    id: "sr",
    artifact_id: "sa",
    inputs_json: "[]",
    prompt_ref_json: JSON.stringify({ id: "summary.core", version: 1 }),
    quality: "normal",
    body: "旧总结",
    citations_json: "[]",
    created_at: T0,
  });
  opened.db.close();
  const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 24) });
  return { db, from, to };
}

describe("migration 0024: prompt overrides", () => {
  it("adds the override tables and an empty prompt_refs_json to every artifact table, keeping old rows", () => {
    const { db, from, to } = migrated();
    expect({ from, to }).toEqual({ from: 23, to: 24 });
    for (const table of ARTIFACT_TABLES) {
      const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>).filter((column) => column.name === "prompt_refs_json");
      expect(columns, table).toEqual([expect.objectContaining({ name: "prompt_refs_json", notnull: 0 })]);
    }
    expect(db.prepare("SELECT body, prompt_ref_json, prompt_refs_json FROM summary_revision").get()).toEqual({
      body: "旧总结",
      prompt_ref_json: JSON.stringify({ id: "summary.core", version: 1 }),
      prompt_refs_json: null,
    });
    expect(() => db.prepare("UPDATE summary_revision SET prompt_refs_json = '[]'").run()).toThrow(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("keeps versions under their own user and prompt, append-only, and drops them with the user", () => {
    const { db } = migrated();
    insertRow(db, "prompt_override", { user_id: "alice", prompt_id: "chapter.ai", updated_at: T0 });
    // The current version must exist first.
    expect(() => db.prepare("UPDATE prompt_override SET current_version = 1 WHERE user_id = 'alice'").run()).toThrow(/FOREIGN KEY/);
    insertRow(db, "prompt_override_version", { user_id: "alice", prompt_id: "chapter.ai", version: 1, text: "v1", created_at: T0 });
    db.prepare("UPDATE prompt_override SET current_version = 1 WHERE user_id = 'alice'").run();
    // A version needs its own user's row for that prompt.
    expect(() => insertRow(db, "prompt_override_version", { user_id: "bob", prompt_id: "chapter.ai", version: 1, text: "x", created_at: T0 })).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "prompt_override_version", { user_id: "alice", prompt_id: "summary.envelope", version: 1, text: "x", created_at: T0 })).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => insertRow(db, "prompt_override_version", { user_id: "alice", prompt_id: "chapter.ai", version: 0, text: "x", created_at: T0 })).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE prompt_override_version SET text = 'rewritten'").run()).toThrow(/immutable/);
    // Restoring the builtin keeps the versions.
    db.prepare("UPDATE prompt_override SET current_version = NULL WHERE user_id = 'alice'").run();
    expect(countRows(db, "prompt_override_version")).toBe(1);

    // Bob's own prompt, in effect when he goes: the cascade passes the circular keys.
    insertRow(db, "prompt_override", { user_id: "bob", prompt_id: "chat.system", updated_at: T0 });
    insertRow(db, "prompt_override_version", { user_id: "bob", prompt_id: "chat.system", version: 1, text: "b", created_at: T0 });
    db.prepare("UPDATE prompt_override SET current_version = 1 WHERE user_id = 'bob'").run();
    db.prepare("DELETE FROM user WHERE id = 'bob'").run();
    expect(countRows(db, "prompt_override_version", "user_id = ?", "bob")).toBe(0);

    db.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(countRows(db, "prompt_override")).toBe(0);
    expect(countRows(db, "prompt_override_version")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
