import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

/** A database at schema 27 with two Contents whose ASR revisions carry raw provider labels. */
function legacyDatabase() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const opened = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 27) });
  const db = opened.db;
  insertRow(db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
  insertRow(db, "user_settings", { user_id: "alice", theme: "light", language: "zh-CN", shortcuts_json: "{}", updated_at: T0 });
  for (const content of ["c1", "c2"]) {
    insertRow(db, "content", { id: content, user_id: "alice", source_kind: "local_file", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  }
  const revision = (id: string, content: string, at: number) =>
    insertRow(db, "transcript_revision", {
      id, content_id: content, kind: "asr", language: "zh", timing_fidelity: "segment_only",
      generation_json: JSON.stringify({ kind: "asr", asrProfileId: "p", modelId: "m" }), segment_count: 0, created_at: at,
    });
  const segment = (id: string, rev: string, ordinal: number, speaker: string | null) =>
    insertRow(db, "transcript_segment", { id, revision_id: rev, ordinal, start_ms: ordinal * 1000, end_ms: ordinal * 1000 + 500, text: id, speaker_id: speaker });
  revision("r1", "c1", T0);
  segment("s1", "r1", 0, "1");
  segment("s2", "r1", 1, "0");
  segment("s3", "r1", 2, null);
  // A later transcription of the same Content reusing label "0" and adding "2".
  revision("r1b", "c1", T0 + 10);
  segment("s4", "r1b", 0, "2");
  segment("s5", "r1b", 1, "0");
  revision("r2", "c2", T0 + 5);
  segment("s6", "r2", 0, "0");
  db.close();
  return { dir, file };
}

describe("migration 0028: content speakers", () => {
  it("registers each Content's raw labels by first appearance without rewriting a sentence", () => {
    const { dir, file } = legacyDatabase();
    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 28) });
    expect({ from, to }).toEqual({ from: 27, to: 28 });
    expect(db.prepare("SELECT content_id, id, user_id, ordinal, name, color_index, avatar, avatar_version FROM content_speaker ORDER BY content_id, ordinal").all()).toEqual([
      { content_id: "c1", id: "1", user_id: "alice", ordinal: 1, name: null, color_index: 0, avatar: null, avatar_version: 0 },
      { content_id: "c1", id: "0", user_id: "alice", ordinal: 2, name: null, color_index: 1, avatar: null, avatar_version: 0 },
      { content_id: "c1", id: "2", user_id: "alice", ordinal: 3, name: null, color_index: 2, avatar: null, avatar_version: 0 },
      // The same label in another Content is another identity; the keys do not collide.
      { content_id: "c2", id: "0", user_id: "alice", ordinal: 1, name: null, color_index: 0, avatar: null, avatar_version: 0 },
    ]);
    expect(db.prepare("SELECT id, speaker_id FROM transcript_segment ORDER BY id").all()).toEqual([
      { id: "s1", speaker_id: "1" },
      { id: "s2", speaker_id: "0" },
      { id: "s3", speaker_id: null },
      { id: "s4", speaker_id: "2" },
      { id: "s5", speaker_id: "0" },
      { id: "s6", speaker_id: "0" },
    ]);
    expect(db.prepare("SELECT asr_diarization FROM user_settings").get()).toEqual({ asr_diarization: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("refuses a sentence naming a speaker of no Content or of another Content", () => {
    const { dir, file } = legacyDatabase();
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 28) });
    insertRow(db, "transcript_revision", {
      id: "r3", content_id: "c2", kind: "manual", parent_revision_id: "r2", language: "zh", timing_fidelity: "inherited_segment",
      generation_json: JSON.stringify({ kind: "manual" }), segment_count: 0, created_at: T0 + 20,
    });
    const insert = (id: string, speaker: string | null) =>
      insertRow(db, "transcript_segment", { id, revision_id: "r3", ordinal: id === "a" ? 0 : id === "b" ? 1 : 2, start_ms: 0, end_ms: 1, text: "x", speaker_id: speaker });
    expect(() => insert("a", "0")).not.toThrow();
    expect(() => insert("b", "1")).toThrow(/not a speaker of its content/);
    expect(() => insert("c", null)).not.toThrow();
    db.close();
  });

  it("goes with its Content and keeps ordinals unique per Content", () => {
    const { dir, file } = legacyDatabase();
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 28) });
    expect(() => insertRow(db, "content_speaker", { content_id: "c2", id: "x", user_id: "alice", ordinal: 1, color_index: 0, created_at: T0, updated_at: T0 })).toThrow(/UNIQUE/);
    expect(() => insertRow(db, "content_speaker", { content_id: "c2", id: "x", user_id: "bob", ordinal: 2, color_index: 0, created_at: T0, updated_at: T0 })).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM content WHERE id = 'c2'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM content_speaker WHERE content_id = 'c2'").get()).toEqual({ n: 0 });
    db.close();
  });
});
