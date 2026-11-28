import { afterEach, describe, expect, it } from "vitest";
import { StorageQuota } from "../../../src/server/application/storage-quota.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { BYTES_PER_GB, BYTES_PER_MB } from "../../../src/shared/units.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A quota over a fake store that reports `committed` bytes for every user. */
function quotaWith(committed: number, limitGB?: number) {
  const h = createHarness();
  open.push(h);
  if (limitGB !== undefined) {
    h.db.prepare("UPDATE user SET storage_limit_gb = ? WHERE id = ?").run(limitGB, BOB.userId);
  }
  return new StorageQuota({ repository: h.repository, files: { usedBytes: async () => committed } });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _ of stream) {
    // Consuming is the point.
  }
}

async function* chunks(count: number, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < count; i += 1) yield new Uint8Array(size);
}

describe("StorageQuota", () => {
  it("reports the caller's own usage, with the limit only when one is set", async () => {
    const quota = quotaWith(70 * BYTES_PER_MB, 0.2);
    expect(await quota.usage(BOB)).toEqual({ usedBytes: 70 * BYTES_PER_MB, storageLimitGB: 0.2 });
    expect(await quota.usage(LOCAL)).toEqual({ usedBytes: 70 * BYTES_PER_MB });
  });

  it("says how much is left when an upload does not fit, not counting the upload's own bytes", async () => {
    const quota = quotaWith(70 * BYTES_PER_MB, 0.1);
    const reservation = await quota.begin(BOB.userId);
    const error = await refusal(drain(reservation?.meter(chunks(40, BYTES_PER_MB)) ?? chunks(0, 0)));
    expect(error).toMatchObject({ class: "storage_quota_exceeded", code: "storage_quota_exceeded" });
    expect(error.userMessage).toBe("存储空间不足：剩余 32.4 MB（已用 70.0 MB / 配额 0.1 GB），放不下这次上传的文件。请删除不需要的内容，或联系管理员调整配额");
    reservation?.release();
  });

  it("refuses before reading anything once the limit is already used up", async () => {
    const quota = quotaWith(0.1 * BYTES_PER_GB + 1, 0.1);
    const error = await refusal(quota.begin(BOB.userId));
    expect(error.userMessage).toContain("剩余 0 B（已用 102.4 MB / 配额 0.1 GB）");
  });

  it("counts the user's local cover copies, kept in the database, as used", async () => {
    const h = createHarness();
    open.push(h);
    h.db.prepare("UPDATE user SET storage_limit_gb = ? WHERE id = ?").run(0.1, BOB.userId);
    const quota = new StorageQuota({ repository: h.repository, files: { usedBytes: async () => 10 * BYTES_PER_MB } });
    const coverBytes = 3 * BYTES_PER_MB;
    for (const [owner, id] of [
      [BOB.userId, "bob-cover"],
      [LOCAL.userId, "local-cover"],
    ] as const) {
      h.repository.withTransaction((scope) => {
        scope.contents.insert({ id, userId: owner, source: { kind: "bilibili", platformContentId: `BV${id}` }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
        scope.contentCovers.put(owner, id, { bytes: new Uint8Array(coverBytes), width: 1, height: 1, sha256: "ab".repeat(32) }, 1);
      });
    }
    expect(await quota.usage(BOB)).toEqual({ usedBytes: 10 * BYTES_PER_MB + coverBytes, storageLimitGB: 0.1 });
    // A trashed Content's cover still takes room until it is purged.
    h.trash.trash(BOB, "bob-cover");
    expect((await quota.usage(BOB)).usedBytes).toBe(10 * BYTES_PER_MB + coverBytes);
    // An upload is measured against files plus covers.
    const reservation = await quota.begin(BOB.userId);
    const error = await refusal(drain(reservation?.meter(chunks(100, BYTES_PER_MB)) ?? chunks(0, 0)));
    expect(error.userMessage).toContain("已用 13.0 MB / 配额 0.1 GB");
    reservation?.release();
  });
});
