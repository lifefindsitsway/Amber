import { beforeEach, describe, expect, it } from "vitest";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { IdempotencyRecord } from "../../../../../src/server/domain/runtime-support.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let repository: SqliteRepository;

function record(userId: string, key: string, refs: string[]): IdempotencyRecord {
  return { userId, route: "POST /api/x", key, requestDigest: "d", responseStatus: 200, responseBodyJson: "{}", resourceRefsJson: JSON.stringify(refs), createdAt: T0 };
}

const refsOf = (userId: string, key: string) => JSON.parse(repository.withTransaction((scope) => scope.idempotency.get(userId, "POST /api/x", key))?.resourceRefsJson ?? "null") as unknown;

beforeEach(() => {
  const { db } = openTempDatabase();
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("idempotency repository", () => {
  it("repoints the owner's records naming a replaced id, keeping the order of their refs", () => {
    repository.withTransaction((scope) => {
      scope.idempotency.insert(record("alice", "k1", ["user-1", "old"]));
      scope.idempotency.insert(record("alice", "k2", ["old-2", "user-2", "keep"]));
      scope.idempotency.insert(record("alice", "k3", ["other"]));
      scope.idempotency.insert(record("bob", "k1", ["user-1", "old"]));
    });
    expect(repository.withTransaction((scope) => scope.idempotency.rebindResourceRefs("alice", ["old", "old-2"], "new"))).toBe(2);
    expect(refsOf("alice", "k1")).toEqual(["user-1", "new"]);
    expect(refsOf("alice", "k2")).toEqual(["new", "user-2", "keep"]);
    expect(refsOf("alice", "k3")).toEqual(["other"]);
    expect(refsOf("bob", "k1")).toEqual(["user-1", "old"]);
    expect(repository.withTransaction((scope) => scope.idempotency.rebindResourceRefs("alice", [], "new"))).toBe(0);
  });
});
