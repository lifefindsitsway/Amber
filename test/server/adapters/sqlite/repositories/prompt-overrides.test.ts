import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

const add = (userId: string, promptId: string, version: number, text: string, createdAt = T0 + version) =>
  repository.withTransaction((scope) => scope.promptOverrides.addVersion({ userId, promptId, version, text, createdAt }));

describe("prompt override repository", () => {
  it("appends versions in order, each becoming current, and keeps them all when the builtin is restored", () => {
    add("alice", "chapter.ai", 1, "一");
    add("alice", "chapter.ai", 2, "二");
    expect(repository.withTransaction((scope) => scope.promptOverrides.get("alice", "chapter.ai"))).toEqual({
      userId: "alice",
      promptId: "chapter.ai",
      currentVersion: 2,
      updatedAt: T0 + 2,
    });
    expect(repository.withTransaction((scope) => scope.promptOverrides.clearCurrent("alice", "chapter.ai", T0 + 9))).toBe(true);
    expect(repository.withTransaction((scope) => scope.promptOverrides.get("alice", "chapter.ai"))).toEqual({ userId: "alice", promptId: "chapter.ai", updatedAt: T0 + 9 });
    expect(repository.withTransaction((scope) => scope.promptOverrides.listVersions("alice", "chapter.ai")).map((version) => [version.version, version.text])).toEqual([
      [1, "一"],
      [2, "二"],
    ]);
    // A later save continues the numbering.
    add("alice", "chapter.ai", 3, "三");
    expect(repository.withTransaction((scope) => scope.promptOverrides.getVersion("alice", "chapter.ai", 3))).toEqual({
      userId: "alice",
      promptId: "chapter.ai",
      version: 3,
      text: "三",
      createdAt: T0 + 3,
    });
    expect(repository.withTransaction((scope) => scope.promptOverrides.list("alice")).map((row) => [row.promptId, row.currentVersion])).toEqual([["chapter.ai", 3]]);
  });

  it("refuses a version that does not follow the last one, writing nothing", () => {
    expect(() => add("alice", "chapter.ai", 2, "x")).toThrow();
    add("alice", "chapter.ai", 1, "一");
    expect(() => add("alice", "chapter.ai", 1, "again")).toThrow();
    expect(countRows(db, "prompt_override_version")).toBe(1);
  });

  it("keeps each owner's prompts apart", () => {
    add("alice", "chapter.ai", 1, "alice");
    expect(repository.withTransaction((scope) => scope.promptOverrides.get("bob", "chapter.ai"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.promptOverrides.getVersion("bob", "chapter.ai", 1))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.promptOverrides.listVersions("bob", "chapter.ai"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.promptOverrides.list("bob"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.promptOverrides.clearCurrent("bob", "chapter.ai", T0))).toBe(false);
    add("bob", "chapter.ai", 1, "bob");
    expect(repository.withTransaction((scope) => scope.promptOverrides.getVersion("alice", "chapter.ai", 1))?.text).toBe("alice");
  });
});
