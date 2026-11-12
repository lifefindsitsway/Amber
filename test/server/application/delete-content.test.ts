import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeleteContentService } from "../../../src/server/application/delete-content.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { BOB, createLocalContent, createTaskOfKind, LOCAL } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";
import { lectureTranscripts } from "../../fixtures/transcripts/lecture.ts";
import { countRows, tempDataDir } from "../../tools/sqlite.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

function asset(contentId: string, id: string, kind: MediaAsset["kind"], extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, userId: LOCAL.userId, contentId, kind, storageRef: `assets/${LOCAL.userId}/${contentId}/${id}`, mimeType: "video/mp4", sizeBytes: 4,
    availability: "available", retentionPolicy: kind === "external_local" ? "never_delete" : kind === "managed_upload" ? "keep" : "ephemeral", createdAt: 1, ...extra,
  };
}

function trash(s: MediaStack, contentId: string): void {
  s.h.repository.withTransaction((scope) => scope.contents.trash(LOCAL.userId, contentId, Date.now()));
}

describe("DeleteContentService.purge", () => {
  it("deletes rows, queues managed files and the worker removes them, keeping the user's own file", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    const taskId = createTaskOfKind(s.h, "process_content", { autoProofread: false }, { contentId });
    s.h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "failed", 5));
    const userFile = join(tempDataDir("amber-user-files-"), "lecture.mp4");
    writeFileSync(userFile, "user bytes");
    const assets = [
      asset(contentId, "local", "external_local", { storageRef: userFile }),
      asset(contentId, "upload", "managed_upload"),
      asset(contentId, "audio", "extracted_audio", { taskId }),
      asset(contentId, "temp", "temporary", { taskId }),
    ];
    s.h.repository.withTransaction((scope) => assets.forEach((item) => scope.mediaAssets.insert(item)));
    for (const item of assets.slice(1)) await s.files.writeAtomic(item.storageRef, Buffer.from("data"));
    await s.files.writeAtomic(`tmp/tasks/${taskId}/asr-1.json`, Buffer.from("{}"));

    await s.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: false });

    // The commit is the purge: rows are gone and every managed file is queued, the user's own never.
    expect(countRows(s.h.db, "media_asset")).toBe(0);
    expect(countRows(s.h.db, "content", "id = ?", contentId)).toBe(0);
    expect(countRows(s.h.db, "task", "id = ?", taskId)).toBe(0);
    expect(s.h.db.prepare("SELECT store, storage_ref AS ref, expected_size_bytes AS size FROM pending_file_delete ORDER BY storage_ref").all()).toEqual([
      { store: "data", ref: assets[2]?.storageRef, size: 4 },
      { store: "data", ref: assets[3]?.storageRef, size: 4 },
      { store: "data", ref: assets[1]?.storageRef, size: 4 },
      { store: "data", ref: `tmp/tasks/${taskId}`, size: null },
    ].sort((a, b) => (a.ref as string).localeCompare(b.ref as string)));

    await s.fileDeleter.whenIdle();
    expect(countRows(s.h.db, "pending_file_delete")).toBe(0);
    expect(readFileSync(userFile, "utf8")).toBe("user bytes");
    expect(await s.files.list("assets")).toEqual([]);
    expect(await s.files.list("tmp")).toEqual([]);
    // The Content's own directory goes too once empty; the user's stays for their other Contents.
    expect(existsSync(join(s.h.dir, "assets", LOCAL.userId, contentId))).toBe(false);
    expect(existsSync(join(s.h.dir, "assets", LOCAL.userId))).toBe(true);
  });

  it("refuses while a Task is unfinished and hides other owners' content", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    createTaskOfKind(s.h, "process_content", { autoProofread: false }, { contentId });
    expect(await codeOf(s.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: false }))).toBe("conflict.tasks_unfinished");
    expect(await codeOf(s.deleteContent.purge(BOB.userId, contentId, { onlyTrashed: false }))).toBe("not_found");
    expect(await codeOf(s.deleteContent.delete(LOCAL, "01UNKNOWNCONTENT0000000000"))).toBe("not_found");
    expect(countRows(s.h.db, "content", "id = ?", contentId)).toBe(1);
  });

  it("with onlyTrashed purges only what is in the trash", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    expect(await codeOf(s.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: true }))).toBe("not_found");
    trash(s, contentId);
    await s.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: true });
    expect(countRows(s.h.db, "content", "id = ?", contentId)).toBe(0);
  });

  it("refuses during a cache move and while an answer about the Content streams", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    const release = s.h.gate.tryExclusive("cache_migration");
    expect(await codeOf(s.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: false }))).toBe("conflict.cache_migrating");
    release?.();
    const streaming = new DeleteContentService({
      repository: s.h.repository,
      gate: s.h.gate,
      fileDeleter: s.fileDeleter,
      chat: { hasInflightFor: (owner, id) => owner === LOCAL.userId && id === contentId },
    });
    expect(await codeOf(streaming.purge(LOCAL.userId, contentId, { onlyTrashed: false }))).toBe("conflict.chat_inflight");
    expect(countRows(s.h.db, "content", "id = ?", contentId)).toBe(1);
  });

  it("queues cache files of the cache directory and leaves the old nested layout to the sweep", async () => {
    const s = createMediaStack();
    open.push(s);
    const contentId = createLocalContent(s.h);
    const other = createLocalContent(s.h);
    const legacyRef = `assets/${LOCAL.userId}/${contentId}/legacy`;
    const size = (ref: string) => Buffer.byteLength(ref);
    const assets = [
      asset(contentId, "video", "platform_cache", { storageRef: "media/第一讲.mp4", retentionPolicy: "evictable", sizeBytes: size("media/第一讲.mp4") }),
      asset(contentId, "audio", "platform_cache", {
        storageRef: "media/第一讲.mp3", mimeType: "audio/mpeg", retentionPolicy: "evictable", availability: "evicted", sizeBytes: size("media/第一讲.mp3"),
      }),
      asset(contentId, "legacy", "platform_cache", { storageRef: legacyRef, retentionPolicy: "evictable", availability: "evicted" }),
      // An evicted cache whose name a newer cache of another Content took since.
      asset(contentId, "stale", "platform_cache", { storageRef: "media/Other.mp4", retentionPolicy: "evictable", availability: "evicted" }),
      asset(other, "others", "platform_cache", { storageRef: "media/Other.mp4", retentionPolicy: "evictable", sizeBytes: size("media/Other.mp4") }),
    ];
    s.h.repository.withTransaction((scope) => assets.forEach((item) => scope.mediaAssets.insert(item)));
    for (const ref of ["media/第一讲.mp4", "media/第一讲.mp3", "media/Other.mp4"]) await s.stores.cache.writeAtomic(ref, Buffer.from(ref));
    await s.files.writeAtomic(legacyRef, Buffer.from("old layout"));

    await s.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: false });
    await s.fileDeleter.whenIdle();

    expect(countRows(s.h.db, "content", "id = ?", contentId)).toBe(0);
    expect(await s.stores.cache.list("media")).toEqual(["media/Other.mp4"]);
    // The evicted name another Content holds now was never queued; the rest are done.
    expect(countRows(s.h.db, "pending_file_delete")).toBe(0);
    // No row points at it any more: the janitor collects it from the data directory.
    expect(await s.files.stat(legacyRef)).not.toBeNull();
    await s.janitor.sweep();
    expect(await s.files.stat(legacyRef)).toBeNull();
  });
});

describe("DeleteContentService.purge and speaker review marks", () => {
  it("purging a Content from the trash takes its revisions' review marks and its speakers with it, and no one else's", async () => {
    const s = createMediaStack();
    open.push(s);
    const [gone, kept] = [createLocalContent(s.h), createLocalContent(s.h)];
    for (const contentId of [gone, kept]) {
      const fixture = lectureTranscripts(contentId);
      s.h.repository.withTransaction((scope) => {
        scope.speakers.insert(LOCAL.userId, contentId, [{ id: `${contentId}-a`, name: "Ann", nameConfirmedAt: 1 }], 1);
        scope.transcripts.insertRevision(LOCAL.userId, fixture.asr.revision, fixture.asr.segments);
        scope.speakerConfirmations.set(LOCAL.userId, contentId, fixture.asr.revision.id, 2);
      });
    }
    trash(s, gone);
    await s.deleteContent.purge(LOCAL.userId, gone, { onlyTrashed: true });
    expect(countRows(s.h.db, "transcript_revision_speaker_confirmation", "content_id = ?", gone)).toBe(0);
    expect(countRows(s.h.db, "content_speaker", "content_id = ?", gone)).toBe(0);
    expect(countRows(s.h.db, "transcript_revision_speaker_confirmation", "content_id = ?", kept)).toBe(1);
  });
});
