import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { RollupPartial } from "../../../../../src/server/domain/artifact.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SEGMENT = "01J0000000000000000000000A" as SegmentId;
const modelRef = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  insertRow(db, "collection", { id: "course", user_id: "alice", name: "course", created_at: T0 });
  insertRow(db, "summary_template", { id: "summary.core", builtin: 1, name: "summaryTemplate.core", current_version: 1 });
  insertRow(db, "summary_artifact", { id: "sa", content_id: "c", template_id: "summary.core" });
  insertRow(db, "collection_summary_artifact", { id: "csa", collection_id: "course" });
  const provenance = { inputs_json: "[]", quality: "normal", body: "b", citations_json: "[]", created_at: T0 };
  insertRow(db, "summary_revision", { id: "sr", artifact_id: "sa", ...provenance });
  insertRow(db, "collection_summary_revision", { id: "csr", artifact_id: "csa", input_items_json: "[]", partial_ids_json: "[]", ...provenance });
});

function partial(id: string, ownerRevisionId: string, index: number): RollupPartial {
  return {
    id,
    ownerRevisionId,
    index,
    inputs: [{ kind: "chapterRevision", id: "ch" }, { kind: "transcriptRevision", id: "t1" }],
    body: `第 ${index} 组 [[seg:${SEGMENT}]]`,
    citations: [{ transcriptRevisionId: "t1", segmentId: SEGMENT }],
    modelRef,
    promptRef: { id: "rollup.partial", version: 1 },
    promptSnapshot: "snapshot",
    createdAt: T0 + index,
  };
}

describe("rollup partial repository", () => {
  it("stores partials of either owner kind and lists them by index", () => {
    repository.withTransaction((scope) => {
      scope.rollupPartials.insertMany("alice", "summary", [partial("s1", "sr", 1), partial("s0", "sr", 0)]);
      scope.rollupPartials.insertMany("alice", "collection_summary", [partial("c0", "csr", 0)]);
    });
    expect(repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision("alice", "sr"))).toEqual([partial("s0", "sr", 0), partial("s1", "sr", 1)]);
    expect(repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision("alice", "csr")).map((value) => value.id)).toEqual(["c0"]);
  });

  it("refuses another owner, the wrong owner kind and a duplicate index", () => {
    expect(() => repository.withTransaction((scope) => scope.rollupPartials.insertMany("bob", "summary", [partial("x", "sr", 0)]))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.rollupPartials.insertMany("alice", "collection_summary", [partial("x", "sr", 0)]))).toThrow();
    expect(() =>
      repository.withTransaction((scope) => scope.rollupPartials.insertMany("alice", "summary", [partial("x", "sr", 0), partial("y", "sr", 0)])),
    ).toThrow();
    expect(countRows(db, "rollup_partial")).toBe(0);
  });

  it("hides partials from another owner", () => {
    repository.withTransaction((scope) => scope.rollupPartials.insertMany("alice", "summary", [partial("s0", "sr", 0)]));
    expect(repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision("bob", "sr"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision("alice", "missing"))).toEqual([]);
  });

  it("keeps the prompt versions a partial was written with, and reads none for a partial stored without them", () => {
    const withRefs: RollupPartial = { ...partial("s0", "sr", 0), promptRefs: [{ id: "custom:rollup.partial", version: 2 }] };
    repository.withTransaction((scope) => scope.rollupPartials.insertMany("alice", "summary", [withRefs, partial("s1", "sr", 1)]));
    const [first, second] = repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision("alice", "sr"));
    expect(first).toEqual(withRefs);
    expect(second).not.toHaveProperty("promptRefs");
    expect(db.prepare("SELECT prompt_refs_json FROM rollup_partial WHERE id = 's1'").get()).toEqual({ prompt_refs_json: null });
  });
});
