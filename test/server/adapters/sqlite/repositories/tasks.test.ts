import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { StageRun, Task } from "../../../../../src/server/domain/task.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function task(id: string, userId: string, createdAt: number, extra: Partial<Task> = {}): Task {
  return { id, userId, contentId: `c-${userId}`, kind: "regenerate_summary", requestJson: "{}", statusProjection: "queued", createdAt, ...extra };
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) {
    insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
    insertRow(db, "content", { id: `c-${id}`, user_id: id, source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  }
});

describe("task repository", () => {
  it("lists newest first with a strict cursor, per owner", () => {
    repository.withTransaction((scope) => {
      for (const [id, at] of [["t1", 1], ["t2", 2], ["t3", 2], ["t4", 3]] as const) scope.tasks.insert(task(id, "alice", at));
      scope.tasks.insert(task("b1", "bob", 5));
    });
    const page = repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 2 }));
    expect(page.map((t) => t.id)).toEqual(["t4", "t3"]);
    const next = repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 5, after: { createdAt: 2, id: "t3" } }));
    expect(next.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(repository.withTransaction((scope) => scope.tasks.get("bob", "t1"))).toBeUndefined();
  });

  it("narrows the list to unfinished Tasks and to one Content or Collection, cursor included", () => {
    insertRow(db, "content", { id: "c2", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    insertRow(db, "collection", { id: "k", user_id: "alice", name: "K", created_at: T0 });
    repository.withTransaction((scope) => {
      scope.tasks.insert(task("open-1", "alice", 1));
      scope.tasks.insert(task("done-1", "alice", 2, { statusProjection: "succeeded", finishedAt: 3 }));
      scope.tasks.insert(task("open-2", "alice", 4, { contentId: "c2" }));
      const { contentId: _content, ...rest } = task("coll", "alice", 5, { kind: "summarize_collection" });
      scope.tasks.insert({ ...rest, collectionId: "k" });
    });
    type Filters = { unfinished?: boolean; contentId?: string; collectionId?: string; after?: { createdAt: number; id: string } };
    const ids = (options: Filters) => repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 10, ...options })).map((t) => t.id);
    expect(ids({ unfinished: true })).toEqual(["coll", "open-2", "open-1"]);
    expect(ids({ contentId: "c-alice" })).toEqual(["done-1", "open-1"]);
    expect(ids({ contentId: "c-alice", unfinished: true })).toEqual(["open-1"]);
    expect(ids({ collectionId: "k" })).toEqual(["coll"]);
    expect(ids({ unfinished: true, after: { createdAt: 4, id: "open-2" } })).toEqual(["open-1"]);
  });

  it("narrows the list to finished Tasks, newest first, cursor included", () => {
    repository.withTransaction((scope) => {
      scope.tasks.insert(task("done-1", "alice", 1, { statusProjection: "succeeded", finishedAt: 2 }));
      scope.tasks.insert(task("open-1", "alice", 3));
      scope.tasks.insert(task("done-2", "alice", 4, { statusProjection: "failed", finishedAt: 5 }));
      scope.tasks.insert(task("done-3", "alice", 4, { statusProjection: "cancelled", finishedAt: 6 }));
      scope.tasks.insert(task("bobs-done", "bob", 7, { statusProjection: "succeeded", finishedAt: 8 }));
    });
    const ids = (options: { limit?: number; after?: { createdAt: number; id: string }; contentId?: string }) =>
      repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 10, ...options, finished: true })).map((t) => t.id);
    expect(ids({})).toEqual(["done-3", "done-2", "done-1"]);
    expect(ids({ limit: 1 })).toEqual(["done-3"]);
    expect(ids({ after: { createdAt: 4, id: "done-3" } })).toEqual(["done-2", "done-1"]);
    expect(ids({ contentId: "c-bob" })).toEqual([]);
  });

  it("narrows the list to one Task kind, combined with the Content and unfinished filters", () => {
    repository.withTransaction((scope) => {
      scope.tasks.insert(task("process-done", "alice", 1, { kind: "process_content", statusProjection: "succeeded", finishedAt: 2 }));
      scope.tasks.insert(task("process-open", "alice", 3, { kind: "process_content" }));
      scope.tasks.insert(task("cache-open", "alice", 4, { kind: "cache_media" }));
      scope.tasks.insert(task("summary", "alice", 5));
      scope.tasks.insert(task("bobs-cache", "bob", 6, { kind: "cache_media" }));
    });
    const ids = (options: { kind?: Task["kind"]; unfinished?: boolean; contentId?: string }) =>
      repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 10, ...options })).map((t) => t.id);
    expect(ids({ kind: "process_content" })).toEqual(["process-open", "process-done"]);
    expect(ids({ kind: "process_content", contentId: "c-alice", unfinished: true })).toEqual(["process-open"]);
    expect(ids({ kind: "cache_media", contentId: "c-alice" })).toEqual(["cache-open"]);
    expect(ids({ kind: "cache_media", contentId: "c-bob" })).toEqual([]);
    expect(ids({ kind: "summarize_collection" })).toEqual([]);
    expect(ids({ contentId: "c-alice" })).toEqual(["summary", "cache-open", "process-open", "process-done"]);
  });

  it("queues unfinished tasks of every user FIFO and tracks finishedAt with the projection", () => {
    repository.withTransaction((scope) => {
      scope.tasks.insert(task("late", "alice", 9));
      scope.tasks.insert(task("early", "bob", 1));
      scope.tasks.insert(task("done", "alice", 0, { statusProjection: "succeeded", finishedAt: 5 }));
    });
    expect(repository.withTransaction((scope) => scope.tasks.listUnfinished()).map((t) => t.id)).toEqual(["early", "late"]);
    repository.withTransaction((scope) => scope.tasks.setProjection("alice", "late", "failed", 10));
    expect(repository.withTransaction((scope) => scope.tasks.get("alice", "late"))).toMatchObject({ statusProjection: "failed", finishedAt: 10 });
    repository.withTransaction((scope) => scope.tasks.setProjection("alice", "late", "queued", undefined));
    expect(repository.withTransaction((scope) => scope.tasks.get("alice", "late"))?.finishedAt).toBeUndefined();
    expect(() => repository.withTransaction((scope) => scope.tasks.setProjection("bob", "late", "queued", undefined))).toThrow();
  });

  it("lists one owner's unfinished tasks FIFO", () => {
    repository.withTransaction((scope) => {
      scope.tasks.insert(task("late", "alice", 9));
      scope.tasks.insert(task("tie-b", "alice", 3));
      scope.tasks.insert(task("tie-a", "alice", 3));
      scope.tasks.insert(task("bobs", "bob", 1));
      scope.tasks.insert(task("done", "alice", 0, { statusProjection: "cancelled", finishedAt: 5 }));
    });
    expect(repository.withTransaction((scope) => scope.tasks.listUnfinishedOf("alice")).map((t) => t.id)).toEqual(["tie-a", "tie-b", "late"]);
    expect(repository.withTransaction((scope) => scope.tasks.listUnfinishedOf("bob")).map((t) => t.id)).toEqual(["bobs"]);
    expect(repository.withTransaction((scope) => scope.tasks.listUnfinishedOf("nobody"))).toEqual([]);
  });

  it("looks a Task up by id alone only for maintenance", () => {
    repository.withTransaction((scope) => scope.tasks.insert(task("t1", "bob", 1)));
    expect(repository.withTransaction((scope) => scope.tasks.getUnscoped("t1"))?.userId).toBe("bob");
    expect(repository.withTransaction((scope) => scope.tasks.getUnscoped("missing"))).toBeUndefined();
  });

  it("keeps the request immutable", () => {
    repository.withTransaction((scope) => scope.tasks.insert(task("t", "alice", 1)));
    expect(() => db.prepare("UPDATE task SET request_json = '{\"x\":1}'").run()).toThrow(/immutable/);
  });
});

describe("stage runs and work units reach their owner through the task", () => {
  const run: StageRun = { id: "s1", taskId: "t", stage: "summary", attempt: 1, status: "pending", progress: 0, dependencies: [] };

  beforeEach(() => {
    repository.withTransaction((scope) => scope.tasks.insert(task("t", "alice", 1)));
  });

  it("rejects writes under another owner exactly like an unknown id", () => {
    const code = (work: () => unknown) => {
      try {
        work();
      } catch (error) {
        return isAmberError(error) ? error.appError.code : String(error);
      }
      return undefined;
    };
    expect(code(() => repository.withTransaction((scope) => scope.stageRuns.insert("bob", run)))).toBe("not_found");
    repository.withTransaction((scope) => scope.stageRuns.insert("alice", run));
    expect(repository.withTransaction((scope) => scope.stageRuns.listByTask("bob", "t"))).toEqual([]);
    expect(code(() => repository.withTransaction((scope) => scope.stageRuns.update("bob", { ...run, status: "running" })))).toBe("not_found");

    const unit = { id: "w1", stageRunId: "s1", key: "k", status: "pending" as const, attempt: 1, retryCount: 0, inputDigest: "d" };
    expect(code(() => repository.withTransaction((scope) => scope.workUnits.insert("bob", unit)))).toBe("not_found");
    repository.withTransaction((scope) => scope.workUnits.insert("alice", unit));
    expect(repository.withTransaction((scope) => scope.workUnits.get("bob", "w1"))).toBeUndefined();
    expect(code(() => repository.withTransaction((scope) => scope.workUnits.putResult("bob", { workUnitId: "w1", payloadJson: "{}", outputDigest: "d", createdAt: 1 })))).toBe("not_found");
  });

  it("round-trips every StageRun and WorkUnit field and writes inputJson only once", () => {
    const full: StageRun = {
      ...run, condition: "auto_proofread_enabled", status: "failed", progress: 0.5, error: { class: "llm_failed", code: "llm_failed", retryDisposition: "policy", userMessage: "x" },
      resultJson: '{"reasons":[]}', startedAt: 1, finishedAt: 2,
    };
    repository.withTransaction((scope) => {
      scope.stageRuns.insert("alice", full);
      scope.stageRuns.update("alice", { ...full, inputJson: '{"modelRef":{"providerProfileId":"p","modelId":"m"}}' });
    });
    const [stored] = repository.withTransaction((scope) => scope.stageRuns.listByTask("alice", "t"));
    expect(stored).toEqual({ ...full, inputJson: '{"modelRef":{"providerProfileId":"p","modelId":"m"}}' });
    expect(() => repository.withTransaction((scope) => scope.stageRuns.update("alice", { ...full, inputJson: "{}" }))).toThrow(/immutable/);
    repository.withTransaction((scope) => scope.stageRuns.update("alice", { ...(stored as StageRun), status: "succeeded" }));

    const unit = { id: "w1", stageRunId: "s1", key: "k", status: "succeeded" as const, attempt: 2, retryCount: 0, inputDigest: "d", outputRef: "r", outputDigest: "o" };
    repository.withTransaction((scope) => {
      scope.workUnits.insert("alice", unit);
      scope.workUnits.putResult("alice", { workUnitId: "w1", payloadJson: "[1]", outputDigest: "o", createdAt: 3 });
      scope.workUnits.putResult("alice", { workUnitId: "w1", payloadJson: "[2]", outputDigest: "o2", createdAt: 4 });
    });
    expect(repository.withTransaction((scope) => scope.workUnits.listByTask("alice", "t"))).toEqual([unit]);
    expect(repository.withTransaction((scope) => scope.workUnits.getResult("alice", "w1"))).toEqual({ workUnitId: "w1", payloadJson: "[2]", outputDigest: "o2", createdAt: 4 });

    // Billing round-trips, is stored as `none` when absent and can change on update.
    const paid = { id: "w2", stageRunId: "s1", key: "asr:submit", status: "running" as const, attempt: 1, retryCount: 0, inputDigest: "d", billing: "asr" as const };
    repository.withTransaction((scope) => scope.workUnits.insert("alice", paid));
    expect(repository.withTransaction((scope) => scope.workUnits.get("alice", "w2"))).toEqual(paid);
    expect(db.prepare("SELECT id, billing FROM work_unit ORDER BY id").all()).toEqual([{ id: "w1", billing: "none" }, { id: "w2", billing: "asr" }]);
    repository.withTransaction((scope) => scope.workUnits.update("alice", { ...unit, billing: "llm" }));
    expect(repository.withTransaction((scope) => scope.workUnits.get("alice", "w1"))?.billing).toBe("llm");

    // The retry count and the earliest next run round-trip; an absent time is stored as NULL.
    const waiting = { id: "w3", stageRunId: "s1", key: "proofread:0", status: "pending" as const, attempt: 1, retryCount: 2, retryNotBefore: 1_790_000_000_000, inputDigest: "d" };
    repository.withTransaction((scope) => scope.workUnits.insert("alice", waiting));
    expect(repository.withTransaction((scope) => scope.workUnits.get("alice", "w3"))).toEqual(waiting);
    expect(db.prepare("SELECT retry_count, retry_not_before FROM work_unit WHERE id = 'w3'").get()).toEqual({ retry_count: 2, retry_not_before: 1_790_000_000_000 });
    const { retryNotBefore: _cleared, ...resumed } = waiting;
    repository.withTransaction((scope) => scope.workUnits.update("alice", { ...resumed, status: "running", retryCount: 3 }));
    const reread = repository.withTransaction((scope) => scope.workUnits.get("alice", "w3"));
    expect(reread).toEqual({ ...resumed, status: "running", retryCount: 3 });
    expect(reread).not.toHaveProperty("retryNotBefore");
    expect(db.prepare("SELECT retry_count, retry_not_before FROM work_unit WHERE id = 'w3'").get()).toEqual({ retry_count: 3, retry_not_before: null });
    expect(() => repository.withTransaction((scope) => scope.workUnits.update("alice", { ...resumed, retryCount: -1 }))).toThrow(/CHECK/);
  });
});

describe("task listing and the trash", () => {
  it("never lists the Tasks of a trashed Content, while the Task itself stays", () => {
    insertRow(db, "content", { id: "tc", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    insertRow(db, "task", { id: "tt", user_id: "alice", content_id: "tc", kind: "process_content", request_json: "{}", status_projection: "succeeded", created_at: T0, finished_at: T0 });
    const listed = () => repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 50 })).map((task) => task.id);
    const listedFinished = () => repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 50, finished: true })).map((task) => task.id);
    expect(listed()).toContain("tt");
    expect(listedFinished()).toContain("tt");
    repository.withTransaction((scope) => scope.contents.trash("alice", "tc", T0 + 1));
    expect(listed()).not.toContain("tt");
    expect(listedFinished()).not.toContain("tt");
    expect(repository.withTransaction((scope) => scope.tasks.get("alice", "tt"))?.id).toBe("tt");
  });
});

describe("task history in the task panel", () => {
  const ids = (owner = "alice") => repository.withTransaction((scope) => scope.tasks.list(owner, { limit: 50, history: true })).map((t) => t.id);
  const hidden = (id: string) => db.prepare("SELECT history_hidden_at AS at, history_hide_batch AS batch FROM task WHERE id = ?").get(id);

  beforeEach(() => {
    repository.withTransaction((scope) => {
      scope.tasks.insert(task("a", "alice", 1, { statusProjection: "succeeded", finishedAt: 2 }));
      scope.tasks.insert(task("b", "alice", 3, { statusProjection: "failed", finishedAt: 4 }));
      scope.tasks.insert(task("c", "alice", 5, { statusProjection: "cancelled", finishedAt: 6 }));
      scope.tasks.insert(task("open", "alice", 7));
      scope.tasks.insert(task("bobs", "bob", 8, { statusProjection: "succeeded", finishedAt: 9 }));
    });
  });

  it("lists finished Tasks not hidden, while finished, unfinished and the Task's state stay as they were", () => {
    expect(ids()).toEqual(["c", "b", "a"]);
    expect(repository.withTransaction((scope) => scope.tasks.hideHistory("alice", ["b"], "batch-1", 10))).toBe(1);
    expect(ids()).toEqual(["c", "a"]);
    expect(repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 50, finished: true })).map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(repository.withTransaction((scope) => scope.tasks.list("alice", { limit: 50, unfinished: true })).map((t) => t.id)).toEqual(["open"]);
    expect(repository.withTransaction((scope) => scope.tasks.get("alice", "b"))).toEqual(
      task("b", "alice", 3, { statusProjection: "failed", finishedAt: 4, historyHiddenAt: 10, historyHideBatch: "batch-1" }),
    );
    expect(hidden("b")).toEqual({ at: 10, batch: "batch-1" });
  });

  it("hides only the owner's finished, shown Tasks and counts only the rows it changed", () => {
    repository.withTransaction((scope) => scope.tasks.hideHistory("alice", ["a"], "earlier", 10));
    const changed = repository.withTransaction((scope) => scope.tasks.hideHistory("alice", ["a", "b", "b", "open", "bobs", "missing"], "batch-2", 11));
    expect(changed).toBe(1);
    expect(hidden("a")).toEqual({ at: 10, batch: "earlier" });
    expect(hidden("b")).toEqual({ at: 11, batch: "batch-2" });
    expect(hidden("open")).toEqual({ at: null, batch: null });
    expect(hidden("bobs")).toEqual({ at: null, batch: null });
    expect(ids("bob")).toEqual(["bobs"]);
  });

  it("clears exactly what the history lists; a trashed Content's Tasks stay and return with it", () => {
    insertRow(db, "content", { id: "tc", user_id: "alice", source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    repository.withTransaction((scope) => scope.tasks.insert(task("trashed", "alice", 9, { contentId: "tc", statusProjection: "succeeded", finishedAt: 10 })));
    repository.withTransaction((scope) => scope.contents.trash("alice", "tc", T0 + 1));
    expect(repository.withTransaction((scope) => scope.tasks.clearHistory("alice", "clear-1", 20))).toBe(3);
    expect(ids()).toEqual([]);
    expect(hidden("trashed")).toEqual({ at: null, batch: null });
    expect(hidden("open")).toEqual({ at: null, batch: null });
    expect(ids("bob")).toEqual(["bobs"]);
    repository.withTransaction((scope) => scope.contents.restore("alice", "tc"));
    expect(ids()).toEqual(["trashed"]);
  });

  it("restores only the rows one batch changed", () => {
    repository.withTransaction((scope) => scope.tasks.hideHistory("alice", ["a"], "manual", 10));
    repository.withTransaction((scope) => scope.tasks.clearHistory("alice", "clear", 11));
    expect(ids()).toEqual([]);
    expect(repository.withTransaction((scope) => scope.tasks.restoreHistory("bob", "clear"))).toBe(0);
    expect(repository.withTransaction((scope) => scope.tasks.restoreHistory("alice", "clear"))).toBe(2);
    expect(ids()).toEqual(["c", "b"]);
    expect(hidden("a")).toEqual({ at: 10, batch: "manual" });
    expect(repository.withTransaction((scope) => scope.tasks.restoreHistory("alice", "unknown"))).toBe(0);
  });

  it("shows a restarted Task again once it finishes", () => {
    repository.withTransaction((scope) => scope.tasks.hideHistory("alice", ["b"], "batch", 10));
    repository.withTransaction((scope) => scope.tasks.setProjection("alice", "b", "succeeded", 12));
    expect(hidden("b")).toEqual({ at: 10, batch: "batch" });
    repository.withTransaction((scope) => scope.tasks.setProjection("alice", "b", "queued", undefined));
    expect(hidden("b")).toEqual({ at: null, batch: null });
    expect(ids()).toEqual(["c", "a"]);
    repository.withTransaction((scope) => scope.tasks.setProjection("alice", "b", "succeeded", 13));
    expect(ids()).toEqual(["c", "b", "a"]);
  });
});
