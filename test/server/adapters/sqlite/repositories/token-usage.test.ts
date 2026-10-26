import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { TokenUsage } from "../../../../../src/server/domain/usage.ts";
import type { TokenUsageQuery } from "../../../../../src/server/ports/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) {
    insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
    insertRow(db, "content", { id: `c-${id}`, user_id: id, source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    insertRow(db, "task", { id: `t-${id}`, user_id: id, content_id: `c-${id}`, kind: "regenerate_summary", request_json: "{}", status_projection: "running", created_at: T0 });
    insertRow(db, "stage_run", { id: `s-${id}`, task_id: `t-${id}`, stage: "summary", attempt: 1, status: "running", progress: 0, dependencies_json: "[]" });
    insertRow(db, "work_unit", { id: `w-${id}`, stage_run_id: `s-${id}`, unit_key: "k", status: "running", attempt: 1, input_digest: "d" });
    insertRow(db, "chat_thread", { id: `th-${id}`, content_id: `c-${id}`, created_at: 0 });
    insertRow(db, "chat_message", { id: `m-${id}`, thread_id: `th-${id}`, role: "assistant", text: "", status: "streaming", citations_json: "[]", created_at: T0 });
  }
});

const MODEL_REF = { providerProfileId: "p-alice", modelId: "model-a", providerNameSnapshot: "relay", modelDisplaySnapshot: "model-a" };

function usage(id: string, extra: Partial<TokenUsage> = {}): TokenUsage {
  return { id, userId: "alice", modelRef: MODEL_REF, feature: "summary", outcome: "succeeded", createdAt: T0, ...extra };
}

const list = (owner: string, query?: TokenUsageQuery) => repository.withTransaction((scope) => scope.tokenUsage.list(owner, query));

const code = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
};

describe("token usage repository", () => {
  it("round-trips every field, leaving unknown token counts absent", () => {
    const full = usage("u1", {
      taskId: "t-alice", workUnitId: "w-alice", contentId: "c-alice", chatMessageId: "m-alice", feature: "chat", outcome: "outcome_unknown",
      inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 7, rawUsageJson: '{"prompt_tokens":120}',
    });
    repository.withTransaction((scope) => {
      scope.tokenUsage.insert(full);
      scope.tokenUsage.insert(usage("u2", { createdAt: T0 + 1 }));
    });
    const [first, second] = list("alice");
    expect(first).toEqual(full);
    expect(second).toEqual(usage("u2", { createdAt: T0 + 1 }));
    expect(second).not.toHaveProperty("inputTokens");
  });

  it("lists the owner's rows oldest first, filtered by task, content, feature and a half-open time range", () => {
    repository.withTransaction((scope) => {
      scope.tokenUsage.insert(usage("u3", { feature: "test_connection", createdAt: T0 + 3 }));
      scope.tokenUsage.insert(usage("u2", { taskId: "t-alice", contentId: "c-alice", createdAt: T0 + 2 }));
      scope.tokenUsage.insert(usage("u1", { createdAt: T0 + 1 }));
      scope.tokenUsage.insert(usage("b1", { userId: "bob", taskId: "t-bob", createdAt: T0 }));
    });
    const ids = (query?: TokenUsageQuery) => list("alice", query).map((row) => row.id);
    expect(ids()).toEqual(["u1", "u2", "u3"]);
    expect(ids({ taskId: "t-alice" })).toEqual(["u2"]);
    expect(ids({ contentId: "c-alice" })).toEqual(["u2"]);
    expect(ids({ feature: "test_connection" })).toEqual(["u3"]);
    expect(ids({ since: T0 + 2 })).toEqual(["u2", "u3"]);
    expect(ids({ until: T0 + 2 })).toEqual(["u1"]);
    expect(ids({ since: T0 + 1, until: T0 + 3 })).toEqual(["u1", "u2"]);
    expect(ids({ taskId: "t-bob" })).toEqual([]);
    expect(list("bob").map((row) => row.id)).toEqual(["b1"]);
  });

  it("refuses references to another user's task, work unit, content or chat message", () => {
    for (const extra of [{ taskId: "t-bob" }, { workUnitId: "w-bob" }, { contentId: "c-bob" }, { chatMessageId: "m-bob" }]) {
      expect(code(() => repository.withTransaction((scope) => scope.tokenUsage.insert(usage("x", extra))))).toBe("not_found");
    }
    expect(countRows(db, "token_usage")).toBe(0);
  });

  it("attributes exactly the given invocations of the owner to the revision", () => {
    repository.withTransaction((scope) => {
      for (const id of ["a1", "a2", "a3"]) scope.tokenUsage.insert(usage(id));
      scope.tokenUsage.insert(usage("b1", { userId: "bob" }));
    });
    expect(repository.withTransaction((scope) => scope.tokenUsage.attach("alice", ["a1", "a3", "b1", "missing"], "rev-1"))).toBe(2);
    expect(repository.withTransaction((scope) => scope.tokenUsage.attach("alice", [], "rev-2"))).toBe(0);
    expect(list("alice").map((row) => [row.id, row.artifactRevisionId])).toEqual([
      ["a1", "rev-1"],
      ["a2", undefined],
      ["a3", "rev-1"],
    ]);
    expect(list("bob")[0]?.artifactRevisionId).toBeUndefined();
  });

  it("keeps rows when the task, work unit or content goes away", () => {
    repository.withTransaction((scope) => scope.tokenUsage.insert(usage("u1", { taskId: "t-alice", workUnitId: "w-alice", contentId: "c-alice", chatMessageId: "m-alice" })));
    db.prepare("DELETE FROM content WHERE id = 'c-alice'").run();
    expect(list("alice")).toEqual([usage("u1")]);
  });
});
