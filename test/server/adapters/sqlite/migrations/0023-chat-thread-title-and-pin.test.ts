import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0023: chat thread title and pin", () => {
  it("adds an empty custom title and pin to every thread and keeps its messages", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const opened = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 22) });
    insertRow(opened.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
    insertRow(opened.db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    insertRow(opened.db, "chat_thread", { id: "t", content_id: "c", created_at: T0 });
    insertRow(opened.db, "chat_message", { id: "m", thread_id: "t", role: "user", text: "q", status: "complete", citations_json: "[]", created_at: T0 });
    opened.db.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 23) });
    expect({ from, to }).toEqual({ from: 22, to: 23 });
    expect(db.prepare("SELECT custom_title, pinned_at FROM chat_thread").get()).toEqual({ custom_title: null, pinned_at: null });
    expect(countRows(db, "chat_message")).toBe(1);
    db.prepare("UPDATE chat_thread SET custom_title = '我的会话', pinned_at = ?").run(T0 + 1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
