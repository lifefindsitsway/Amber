import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { migrate, MIGRATIONS, type Migration } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SNAPSHOT = JSON.stringify({ providerProfileId: "p", modelId: "m", providerNameSnapshot: "P", modelDisplaySnapshot: "m" });

/** A version 21 database with two conversations, one of them compacted and both with usage links. */
function atVersion21(foreignKeys: "ON" | "OFF"): SqliteConnection {
  const db: SqliteConnection = new Database(join(tempDataDir(), "amber.db"));
  db.pragma(`foreign_keys = ${foreignKeys}`);
  migrate(db, MIGRATIONS.slice(0, 21));
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  for (const id of ["c1", "c2"]) {
    insertRow(db, "content", { id, user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  }
  insertRow(db, "chat_thread", { id: "t1", content_id: "c1", current_compaction_id: null });
  insertRow(db, "chat_thread", { id: "t2", content_id: "c2", current_compaction_id: null });
  const message = (id: string, thread: string, role: string, at: number) =>
    insertRow(db, "chat_message", { id, thread_id: thread, role, text: `${id} text`, status: "complete", model_ref_json: role === "assistant" ? SNAPSHOT : null, citations_json: "[]", created_at: at });
  message("m1", "t1", "user", T0 + 10);
  message("m2", "t1", "assistant", T0 + 11);
  message("m3", "t1", "user", T0 + 20);
  message("m4", "t1", "assistant", T0 + 21);
  message("m5", "t2", "user", T0 + 30);
  message("m6", "t2", "assistant", T0 + 31);
  insertRow(db, "chat_compaction", {
    id: "k1", thread_id: "t1", through_message_id: "m2", body: "summary", model_ref_json: SNAPSHOT,
    prompt_ref_json: JSON.stringify({ id: "chat.compaction", version: 1 }), prompt_snapshot: "prompt", created_at: T0 + 25,
  });
  db.prepare("UPDATE chat_thread SET current_compaction_id = 'k1' WHERE id = 't1'").run();
  for (const [id, messageId] of [["u1", "m2"], ["u2", "m4"], ["u3", "m6"]] as const) {
    insertRow(db, "token_usage", { id, user_id: "alice", model_ref_json: SNAPSHOT, feature: "chat", chat_message_id: messageId, content_id: "c1", outcome: "succeeded", created_at: T0 });
  }
  return db;
}

describe("migration 0022: chat threads and web search", () => {
  it.each(["ON", "OFF"] as const)("keeps every message, compaction and usage link with foreign keys %s and restores the setting", (foreignKeys) => {
    const db = atVersion21(foreignKeys);
    expect(migrate(db, MIGRATIONS.slice(0, 22))).toEqual({ from: 21, to: 22 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(foreignKeys === "ON" ? 1 : 0);
    expect(countRows(db, "chat_message")).toBe(6);
    expect(countRows(db, "chat_compaction")).toBe(1);
    expect(countRows(db, "token_usage", "chat_message_id IS NOT NULL")).toBe(3);
    expect(db.prepare("SELECT id, content_id AS contentId, current_compaction_id AS compaction, created_at AS createdAt FROM chat_thread ORDER BY id").all()).toEqual([
      { id: "t1", contentId: "c1", compaction: "k1", createdAt: T0 + 10 },
      { id: "t2", contentId: "c2", compaction: null, createdAt: T0 + 30 },
    ]);
    expect(db.prepare("SELECT finished_at, web_search_json, replaces_message_id FROM chat_message WHERE id = 'm2'").get()).toEqual({ finished_at: null, web_search_json: null, replaces_message_id: null });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("dates a thread without messages by its Content and allows a second thread per Content", () => {
    const db = atVersion21("ON");
    insertRow(db, "content", { id: "c3", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0 + 5, updated_at: T0 + 5 });
    insertRow(db, "chat_thread", { id: "t3", content_id: "c3", current_compaction_id: null });
    migrate(db, MIGRATIONS.slice(0, 22));
    expect(db.prepare("SELECT created_at FROM chat_thread WHERE id = 't3'").get()).toEqual({ created_at: T0 + 5 });
    insertRow(db, "chat_thread", { id: "t4", content_id: "c1", created_at: T0 + 40 });
    expect(countRows(db, "chat_thread", "content_id = 'c1'")).toBe(2);
    db.prepare("DELETE FROM content WHERE id = 'c1'").run();
    expect(countRows(db, "chat_thread", "content_id = 'c1'")).toBe(0);
    expect(countRows(db, "chat_message", "thread_id = 't1'")).toBe(0);
    db.close();
  });

  it("lets a compaction move its end to an earlier message and nothing else", () => {
    const db = atVersion21("ON");
    migrate(db, MIGRATIONS.slice(0, 22));
    db.prepare("UPDATE chat_compaction SET through_message_id = 'm1' WHERE id = 'k1'").run();
    expect(db.prepare("SELECT through_message_id FROM chat_compaction").get()).toEqual({ through_message_id: "m1" });
    expect(() => db.prepare("UPDATE chat_compaction SET body = 'x'").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE chat_compaction SET model_ref_json = '{}'").run()).toThrow(/immutable/);
    db.close();
  });

  it("stores one web search service per user whose Secret goes with it", () => {
    const db = atVersion21("ON");
    migrate(db, MIGRATIONS.slice(0, 22));
    insertRow(db, "secret", {
      id: "s1", user_id: "alice", envelope_version: 1, kdf_salt: Buffer.alloc(16), nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(4), auth_tag: Buffer.alloc(16), created_at: T0, updated_at: T0,
    });
    insertRow(db, "web_search_profile", { user_id: "alice", service: "tavily", credential_ref: "s1", created_at: T0, updated_at: T0 });
    expect(() => insertRow(db, "web_search_profile", { user_id: "alice", service: "tavily", created_at: T0, updated_at: T0 })).toThrow(/UNIQUE|PRIMARY/);
    db.prepare("DELETE FROM web_search_profile").run();
    expect(countRows(db, "secret")).toBe(0);
    db.prepare("UPDATE user_settings SET chat_web_search_mode = 'auto'").run();
    db.close();
  });

  it.each(["ON", "OFF"] as const)("rolls the whole version back when verification fails, with foreign keys %s restored", (foreignKeys) => {
    const db = atVersion21(foreignKeys);
    const failing: Migration = {
      ...(MIGRATIONS[21] as Migration),
      verify() {
        throw new Error("injected verification failure");
      },
    };
    expect(() => migrate(db, [...MIGRATIONS.slice(0, 21), failing])).toThrow(/injected/);
    expect(db.pragma("user_version", { simple: true })).toBe(21);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(foreignKeys === "ON" ? 1 : 0);
    expect(db.prepare("SELECT name FROM pragma_table_info('chat_thread') ORDER BY cid").all()).toEqual([{ name: "id" }, { name: "content_id" }, { name: "current_compaction_id" }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('web_search_profile', 'chat_thread_v22')").all()).toEqual([]);
    expect(countRows(db, "chat_message")).toBe(6);
    db.close();
  });

  it("rolls back a migration that leaves a foreign key violation before its version is bumped", () => {
    const db = atVersion21("ON");
    const dangling: Migration = { version: 22, name: "dangling", rebuildsReferencedTable: true, sql: "INSERT INTO chat_message (id, thread_id, role, text, status, citations_json, created_at) VALUES ('x', 'missing', 'user', '', 'complete', '[]', 0);" };
    expect(() => migrate(db, [...MIGRATIONS.slice(0, 21), dangling])).toThrow(/foreign key violations/);
    expect(db.pragma("user_version", { simple: true })).toBe(21);
    expect(countRows(db, "chat_message", "id = 'x'")).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});
