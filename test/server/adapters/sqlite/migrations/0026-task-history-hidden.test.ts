import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0026: task history hidden", () => {
  it("adds empty history marks to every Task and indexes the removal batch", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const opened = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 25) });
    insertRow(opened.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
    insertRow(opened.db, "content", { id: "c", user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    insertRow(opened.db, "task", { id: "t", user_id: "alice", content_id: "c", kind: "process_content", request_json: "{}", status_projection: "succeeded", created_at: T0, finished_at: T0 + 1 });
    opened.db.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 26) });
    expect({ from, to }).toEqual({ from: 25, to: 26 });
    expect(db.prepare("SELECT finished_at, history_hidden_at, history_hide_batch FROM task").get()).toEqual({ finished_at: T0 + 1, history_hidden_at: null, history_hide_batch: null });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_history_hide_batch'").get()).toEqual({ sql: expect.stringMatching(/WHERE history_hide_batch IS NOT NULL/) });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
