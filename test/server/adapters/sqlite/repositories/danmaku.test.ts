import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { DanmakuSnapshotRecord, NotPromise, RepositoryScope } from "../../../../../src/server/ports/repository.ts";
import type { DanmakuItem } from "../../../../../src/shared/dto/danmaku.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c1", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
});

const run = <T>(work: (scope: RepositoryScope) => NotPromise<T>): T => repository.withTransaction(work);

const ITEMS: DanmakuItem[] = [
  { timeMs: 0, mode: "scroll", color: 0xffffff, weight: 10, text: "a" },
  { timeMs: 1500, mode: "top", color: 0, weight: 0, text: '"<b>&\u202E' },
  { timeMs: 9000, mode: "bottom", color: 0x123456, weight: 5, text: "弹幕" },
];

function snapshot(overrides: Partial<DanmakuSnapshotRecord> = {}): DanmakuSnapshotRecord {
  return { contentId: "c1", platformPartId: "1001", fetchedAt: T0, items: ITEMS, ...overrides };
}

describe("danmaku repository", () => {
  it("round-trips a snapshot for its owner only, stored as compact tuples", () => {
    run((scope) => scope.danmaku.put("alice", snapshot()));
    expect(run((scope) => scope.danmaku.get("alice", "c1"))).toEqual(snapshot());
    expect(run((scope) => scope.danmaku.summary("alice", "c1"))).toEqual({ platformPartId: "1001", fetchedAt: T0, count: 3 });
    expect(run((scope) => scope.danmaku.get("bob", "c1"))).toBeUndefined();
    expect(run((scope) => scope.danmaku.summary("bob", "c1"))).toBeUndefined();
    const row = db.prepare("SELECT items_json, item_count FROM content_danmaku").get() as { items_json: string; item_count: number };
    expect(JSON.parse(row.items_json)).toEqual([
      [0, 0, 0xffffff, 10, "a"],
      [1500, 1, 0, 0, '"<b>&\u202E'],
      [9000, 2, 0x123456, 5, "弹幕"],
    ]);
    expect(row.item_count).toBe(3);
  });

  it("replaces the snapshot whole, including with an empty one", () => {
    run((scope) => scope.danmaku.put("alice", snapshot()));
    run((scope) => scope.danmaku.put("alice", snapshot({ platformPartId: "1002", fetchedAt: T0 + 1, items: [ITEMS[2] as DanmakuItem] })));
    expect(run((scope) => scope.danmaku.get("alice", "c1"))).toEqual(snapshot({ platformPartId: "1002", fetchedAt: T0 + 1, items: [ITEMS[2] as DanmakuItem] }));
    run((scope) => scope.danmaku.put("alice", snapshot({ fetchedAt: T0 + 2, items: [] })));
    expect(run((scope) => scope.danmaku.summary("alice", "c1"))).toEqual({ platformPartId: "1001", fetchedAt: T0 + 2, count: 0 });
    expect(countRows(db, "content_danmaku")).toBe(1);
  });

  it("reads the summary without the items", () => {
    run((scope) => scope.danmaku.put("alice", snapshot()));
    // Break the items: a summary that parsed them would throw.
    db.prepare("UPDATE content_danmaku SET items_json = '{}'").run();
    expect(run((scope) => scope.danmaku.summary("alice", "c1"))).toEqual({ platformPartId: "1001", fetchedAt: T0, count: 3 });
  });

  it("refuses a snapshot for another owner's Content and goes with its Content", () => {
    expect(() => run((scope) => scope.danmaku.put("bob", snapshot()))).toThrow(/FOREIGN KEY/);
    run((scope) => scope.danmaku.put("alice", snapshot()));
    db.prepare("DELETE FROM content WHERE id = 'c1'").run();
    expect(countRows(db, "content_danmaku")).toBe(0);
  });
});
