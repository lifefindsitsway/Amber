import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "../../../src/server/application/tasks.ts";
import { TrashService } from "../../../src/server/application/trash.ts";
import { canonicalJson } from "../../../src/server/domain/canonical-json.ts";
import { TRASH_RETENTION_MS } from "../../../src/server/domain/content.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { transact } from "../../../src/server/pipeline/publish.ts";
import { MAX_TIMER_MS } from "../../../src/server/pipeline/scheduler.ts";
import { createTask } from "../../../src/server/pipeline/task-state.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";
import { CONTENT_TRASH_BATCH_MAX, TRASH_RETRY_BASE_MS, TRASH_SWEEP_BATCH } from "../../../src/shared/defaults.ts";
import { FakeLlmProvider } from "../../fixtures/llm/fake-llm.ts";
import { configureChatModel, seedChatContent } from "../../fixtures/pipeline/chat-data.ts";
import { BOB, createHarness, createLocalContent, createTaskOfKind, LOCAL, silentLogger, type Harness } from "../../fixtures/pipeline/harness.ts";
import { seedContent } from "../../fixtures/search/corpus.ts";
import { countRows } from "../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const open: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of open.splice(0)) await h.close();
});

/** A harness on a fake clock: the services read `Date.now()` when they act. */
function clocked(options: Parameters<typeof createHarness>[0] = {}): { h: Harness; at: (ms: number) => void } {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const h = createHarness(options);
  open.push(h);
  return { h, at: (ms) => vi.setSystemTime(ms) };
}

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  return undefined;
}

function finishedContent(h: Harness): string {
  const contentId = createLocalContent(h);
  const taskId = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
  h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "succeeded", 2));
  return contentId;
}

function asset(contentId: string, id: string, kind: MediaAsset["kind"], extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, userId: LOCAL.userId, contentId, kind, storageRef: `assets/${LOCAL.userId}/${contentId}/${id}`, mimeType: "video/mp4", sizeBytes: 10,
    availability: "available", retentionPolicy: "keep", createdAt: 1, ...extra,
  };
}

describe("moving to the trash", () => {
  it("hides the Content everywhere while its rows and files stay, and the collections holding it change", async () => {
    const { h, at } = clocked();
    const seeded = seedContent(h, { title: "梯度下降", lines: ["今天讲梯度下降"] });
    const contentId = seeded.contentId;
    const course = h.collections.create(LOCAL, { name: "Course" });
    await h.collections.addItem(LOCAL, course.id, { contentId });
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset(contentId, "upload", "managed_upload")));
    await h.media.data.writeAtomic(`assets/${LOCAL.userId}/${contentId}/upload`, Buffer.from("0123456789"));
    at(T0 + 5);
    h.trash.trash(LOCAL, contentId);

    expect(await codeOf(() => h.contents.get(LOCAL, contentId))).toBe("not_found");
    expect(h.contents.list(LOCAL, { limit: 10 }).items.map((item) => item.id)).not.toContain(contentId);
    expect(h.search.search(LOCAL, { q: "梯度", scope: "global" })).toEqual({ contents: [], segments: [], summaries: [], collections: [], figures: [] });
    expect(h.collections.get(LOCAL, course.id)).toMatchObject({ itemCount: 0, items: [], updatedAt: T0 + 5 });
    expect(h.collections.list(LOCAL).items[0]?.itemCount).toBe(0);
    expect(countRows(h.db, "content", "id = ? AND trashed_at = ?", contentId, T0 + 5)).toBe(1);
    expect(countRows(h.db, "collection_item", "content_id = ?", contentId)).toBe(1);
    expect(await h.media.data.stat(`assets/${LOCAL.userId}/${contentId}/upload`)).toEqual({ sizeBytes: 10 });
    // Already in the trash, or another user's: unknown.
    expect(await codeOf(() => h.trash.trash(LOCAL, contentId))).toBe("not_found");
    expect(await codeOf(() => h.trash.trash(BOB, finishedContent(h)))).toBe("not_found");
  });

  it("refuses while a Task is unfinished or a running collection summary uses it", async () => {
    const { h } = clocked();
    const busy = createLocalContent(h);
    createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId: busy });
    expect(await codeOf(() => h.trash.trash(LOCAL, busy))).toBe("conflict.tasks_unfinished");

    const used = finishedContent(h);
    const spare = finishedContent(h);
    const course = h.collections.create(LOCAL, { name: "Course" });
    const item = (await h.collections.addItem(LOCAL, course.id, { contentId: used })).body as { id: string };
    await h.collections.addItem(LOCAL, course.id, { contentId: spare });
    h.repository.withTransaction((scope) =>
      scope.tasks.insert({
        id: "summarizing",
        userId: LOCAL.userId,
        collectionId: course.id,
        kind: "summarize_collection",
        requestJson: JSON.stringify({
          requestSchemaVersion: 1,
          kind: "summarize_collection",
          outputLanguage: "zh-CN",
          inputItems: [{ collectionItemId: item.id, contentId: used, summaryRevisionId: "s", transcriptRevisionId: "t", position: 0 }],
        }),
        statusProjection: "running",
        createdAt: T0,
      }),
    );
    expect(await codeOf(() => h.trash.trash(LOCAL, used))).toBe("conflict.tasks_unfinished");
    // The summary does not summarise this member: free to go.
    h.trash.trash(LOCAL, spare);
    h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, "summarizing", "succeeded", T0 + 1));
    h.trash.trash(LOCAL, used);
  });

  it("aborts an answer streaming about it without waiting for the answer to settle", async () => {
    const provider = new FakeLlmProvider();
    const h = createHarness({ llmProviders: [provider] });
    open.push(h);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "开头" };
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "done", stopReason: "aborted" };
    });
    // Nobody reads the stream: the answer cannot settle until someone does.
    const result = h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, new AbortController().signal);
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(true);
    h.trash.trash(LOCAL, contentId);
    expect(await codeOf(() => h.trash.purge(LOCAL, contentId))).toBe("conflict.chat_inflight");
    // Draining lets the aborted answer store its final state.
    const events: string[] = [];
    if (result.kind === "stream") {
      for await (const event of result.events) {
        events.push(event.type === "done" ? `done:${event.data.status}` : event.type);
      }
    }
    expect(events.at(-1)).toBe("done:interrupted");
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(false);
    await h.trash.purge(LOCAL, contentId);
  });
});

describe("restoring", () => {
  it("brings everything back as it was: updatedAt, pin, membership and position; only the collection changes", async () => {
    const { h, at } = clocked();
    const seeded = seedContent(h, { title: "梯度下降", lines: ["今天讲梯度下降"] });
    const contentId = seeded.contentId;
    h.contents.patch(LOCAL, contentId, { pinned: true });
    const course = h.collections.create(LOCAL, { name: "Course" });
    const first = finishedContent(h);
    await h.collections.addItem(LOCAL, course.id, { contentId: first });
    await h.collections.addItem(LOCAL, course.id, { contentId });
    const before = h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
    at(T0 + 10);
    h.trash.trash(LOCAL, contentId);
    at(T0 + 20);
    const restored = h.trash.restore(LOCAL, contentId);
    expect(restored).toMatchObject({ id: contentId, pinnedAt: before?.pinnedAt, updatedAt: before?.updatedAt, collections: [{ id: course.id }] });
    expect(restored).not.toHaveProperty("trashedAt");
    expect(h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId))).toEqual(before);
    expect(h.collections.get(LOCAL, course.id)).toMatchObject({ updatedAt: T0 + 20, items: [{ contentId: first, position: 0 }, { contentId, position: 1 }] });
    expect(h.search.search(LOCAL, { q: "梯度", scope: "global" }).contents.map((hit) => hit.contentId)).toEqual([contentId]);
  });

  it("is strict about the retention: a millisecond before purgeAt restores, at purgeAt it is expired", async () => {
    const { h, at } = clocked();
    const early = finishedContent(h);
    const late = finishedContent(h);
    h.trash.trash(LOCAL, early);
    h.trash.trash(LOCAL, late);
    at(T0 + TRASH_RETENTION_MS - 1);
    expect(h.trash.restore(LOCAL, early).id).toBe(early);
    at(T0 + TRASH_RETENTION_MS);
    expect(await codeOf(() => h.trash.restore(LOCAL, late))).toBe("conflict.trash_expired");
    expect(await codeOf(() => h.trash.restore(LOCAL, early))).toBe("not_found");
    expect(await codeOf(() => h.trash.restore(BOB, late))).toBe("not_found");
  });
});

describe("listing the trash", () => {
  it("lists latest first with a cursor, purgeAt and expired, and the bytes a purge would free", async () => {
    const { h, at } = clocked();
    const a = finishedContent(h);
    const b = finishedContent(h);
    const c = finishedContent(h);
    h.repository.withTransaction((scope) => {
      scope.contents.setCustomTitle(LOCAL.userId, a, "第一讲", 1);
      scope.mediaAssets.insert(asset(a, "upload", "managed_upload", { sizeBytes: 100 }));
      scope.mediaAssets.insert(asset(a, "cache", "platform_cache", { storageRef: "media/第一讲.mp4", sizeBytes: 50, retentionPolicy: "evictable" }));
      scope.mediaAssets.insert(asset(a, "gone", "platform_cache", { storageRef: "media/x.mp3", sizeBytes: 7, availability: "evicted", retentionPolicy: "evictable" }));
      scope.mediaAssets.insert(asset(a, "mine", "external_local", { storageRef: "/home/user/lecture.mp4", sizeBytes: 1000, retentionPolicy: "never_delete" }));
    });
    h.trash.trash(LOCAL, a);
    at(T0 + 1);
    h.trash.trash(LOCAL, b);
    at(T0 + 2);
    h.trash.trash(LOCAL, c);
    at(T0 + 1 + TRASH_RETENTION_MS);
    const first = h.trash.list(LOCAL, { limit: 2 });
    expect(first.total).toBe(3);
    expect(first.items.map((item) => [item.id, item.expired])).toEqual([[c, false], [b, true]]);
    const second = h.trash.list(LOCAL, { limit: 2, cursor: first.nextCursor as string });
    expect(second.nextCursor).toBeUndefined();
    expect(second.items).toEqual([
      { id: a, title: "第一讲", source: { kind: "local" }, trashedAt: T0, purgeAt: T0 + TRASH_RETENTION_MS, expired: true, mediaBytes: 150 },
    ]);
    expect(h.trash.list(BOB, { limit: 10 })).toEqual({ items: [], total: 0 });
    expect(await codeOf(() => h.trash.list(LOCAL, { limit: 2, cursor: "nonsense" }))).toBe("invalid_request");
  });

  it("pages by number in the cursor's order, ties included, with no nextCursor and an empty page past the end", () => {
    const { h, at } = clocked();
    const ids = Array.from({ length: 5 }, () => finishedContent(h));
    // Two pairs share their trashedAt, so only the id keeps them apart.
    [T0, T0, T0 + 1, T0 + 1, T0 + 2].forEach((trashedAt, index) => {
      at(trashedAt);
      h.trash.trash(LOCAL, ids[index] as string);
    });
    const everything = h.trash.list(LOCAL, { limit: 10 }).items.map((item) => item.id);
    expect(everything).toHaveLength(5);

    const pageOne = h.trash.list(LOCAL, { limit: 2, page: 1 });
    const { nextCursor, ...cursorFirst } = h.trash.list(LOCAL, { limit: 2 });
    expect(nextCursor).toBeDefined();
    expect(pageOne).toEqual(cursorFirst);
    expect(pageOne).not.toHaveProperty("nextCursor");
    const pages = [1, 2, 3].map((page) => h.trash.list(LOCAL, { limit: 2, page }));
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(everything);
    expect(pages.every((page) => page.total === 5 && !("nextCursor" in page))).toBe(true);
    expect(h.trash.list(LOCAL, { limit: 2, page: 4 })).toEqual({ items: [], total: 5 });
    expect(h.trash.list(LOCAL, { limit: 5, page: 2 })).toEqual({ items: [], total: 5 });

    // The cursor path walks the same order as before.
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = h.trash.list(LOCAL, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      walked.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(walked).toEqual(everything);
  });

  it("counts first in one transaction: an empty trash or a page past the end never lists, and page excludes cursor", async () => {
    const { h, at } = clocked();
    for (let index = 0; index < 3; index += 1) {
      at(T0 + index);
      h.trash.trash(LOCAL, finishedContent(h));
    }
    const calls: string[] = [];
    let transactions = 0;
    const repository: Repository = {
      withTransaction: (work) =>
        h.repository.withTransaction((scope) => {
          transactions += 1;
          const contents = {
            ...scope.contents,
            listTrashed: (owner: string, position: Parameters<typeof scope.contents.listTrashed>[1]) => {
              calls.push(`listTrashed ${JSON.stringify(position)}`);
              return scope.contents.listTrashed(owner, position);
            },
            countTrashed: (owner: string) => {
              calls.push("countTrashed");
              return scope.contents.countTrashed(owner);
            },
          };
          return work({ ...scope, contents });
        }),
    };
    const trash = new TrashService({
      repository, deleteContent: { purge: async () => undefined }, fileDeleter: { kick: () => undefined, nextDueAt: () => undefined },
      chat: { abortContent: () => undefined }, logger: silentLogger,
    });

    expect(trash.list(LOCAL, { limit: 2, page: 2 }).items).toHaveLength(1);
    expect([calls.splice(0), transactions]).toEqual([["countTrashed", 'listTrashed {"limit":2,"offset":2}'], 1]);
    expect(trash.list(LOCAL, { limit: 2, page: Number.MAX_SAFE_INTEGER })).toEqual({ items: [], total: 3 });
    expect(trash.list(LOCAL, { limit: 3, page: 2 })).toEqual({ items: [], total: 3 });
    expect(trash.list(BOB, { limit: 2, page: 1 })).toEqual({ items: [], total: 0 });
    expect(calls.splice(0)).toEqual(["countTrashed", "countTrashed", "countTrashed"]);

    const cursor = trash.list(LOCAL, { limit: 2 }).nextCursor as string;
    calls.splice(0);
    const before = transactions;
    let refused: unknown;
    try {
      trash.list(LOCAL, { limit: 2, page: 1, cursor });
    } catch (error) {
      refused = isAmberError(error) ? error.appError : error;
    }
    expect(refused).toMatchObject({ class: "invalid_request", userMessage: expect.stringMatching(/\bpage$/) });
    expect([calls, transactions]).toEqual([[], before]);
  });
});

describe("purging", () => {
  it("purges only what is in the trash, and the worker removes its files", async () => {
    const { h } = clocked();
    const contentId = finishedContent(h);
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset(contentId, "upload", "managed_upload")));
    await h.media.data.writeAtomic(`assets/${LOCAL.userId}/${contentId}/upload`, Buffer.from("0123456789"));
    expect(await codeOf(() => h.trash.purge(LOCAL, contentId))).toBe("not_found");
    h.trash.trash(LOCAL, contentId);
    expect(await codeOf(() => h.trash.purge(BOB, contentId))).toBe("not_found");
    const release = h.gate.tryExclusive("cache_migration");
    expect(await codeOf(() => h.trash.purge(LOCAL, contentId))).toBe("conflict.cache_migrating");
    release?.();
    await h.trash.purge(LOCAL, contentId);
    expect(countRows(h.db, "content", "id = ?", contentId)).toBe(0);
    await h.fileDeleter.whenIdle();
    expect(await h.media.data.stat(`assets/${LOCAL.userId}/${contentId}/upload`)).toBeNull();
    expect(countRows(h.db, "pending_file_delete")).toBe(0);
  });

  it("empties the trash entry by entry, reporting the ones that cannot go and going on with the rest", async () => {
    const { h } = clocked();
    const ids = [finishedContent(h), finishedContent(h), finishedContent(h)];
    for (const id of ids) h.trash.trash(LOCAL, id);
    // A Task that appeared behind the service's back keeps one of them.
    createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId: ids[1] as string });
    const result = await h.trash.purgeAll(LOCAL);
    expect(result).toEqual({ purgedIds: [ids[2], ids[0]], failed: [{ contentId: ids[1], code: "conflict.tasks_unfinished" }] });
    expect(h.trash.list(LOCAL, { limit: 10 }).items.map((item) => item.id)).toEqual([ids[1]]);
    expect(await h.trash.purgeAll(BOB)).toEqual({ purgedIds: [], failed: [] });
  });
});

/** A trash service with a recorded timer: `timers` lists every timer set, `live` the pending ones. */
function timed(h: Harness, overrides: Partial<ConstructorParameters<typeof TrashService>[0]> = {}) {
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const infos: Array<[string, unknown]> = [];
  const logger: Logger = { ...silentLogger, info: (message, fields) => void infos.push([message, fields]), child: () => logger };
  const trash = new TrashService({
    repository: h.repository,
    deleteContent: h.deleteContent,
    fileDeleter: h.fileDeleter,
    chat: h.chat,
    logger,
    setTimer: (ms, fire) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  /** Fires the one live timer and waits for its sweep and re-arm. */
  const fire = async () => {
    const [timer] = live();
    timer?.fire();
    if (timer !== undefined) timer.cancelled = true;
    await vi.waitFor(() => expect(infos.some(([message]) => message === "trash_sweep_done")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { trash, timers, live, infos, fire };
}

describe("the sweep and its timer", () => {
  it("purges exactly at purgeAt, not a millisecond before, and logs what it did", async () => {
    const { h, at } = clocked();
    const contentId = finishedContent(h);
    h.trash.trash(LOCAL, contentId);
    const { trash, infos } = timed(h);
    at(T0 + TRASH_RETENTION_MS - 1);
    expect(await trash.sweep()).toEqual({ purged: 0, deferred: 0 });
    expect(countRows(h.db, "content", "id = ?", contentId)).toBe(1);
    at(T0 + TRASH_RETENTION_MS);
    expect(await trash.sweep()).toEqual({ purged: 1, deferred: 0 });
    expect(countRows(h.db, "content", "id = ?", contentId)).toBe(0);
    expect(infos).toEqual([
      ["trash_sweep_done", { purged: 0, deferred: 0 }],
      ["trash_sweep_done", { purged: 1, deferred: 0 }],
    ]);
  });

  it("works through more expired entries than one batch, of every user", async () => {
    const { h, at } = clocked();
    const count = TRASH_SWEEP_BATCH + 5;
    h.repository.withTransaction((scope) => {
      for (let index = 0; index < count; index += 1) {
        const userId = index % 2 === 0 ? LOCAL.userId : BOB.userId;
        const id = h.newId();
        scope.contents.insert({ id, userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
        scope.contents.trash(userId, id, T0);
      }
    });
    at(T0 + TRASH_RETENTION_MS);
    const { trash } = timed(h);
    expect(await trash.sweep()).toEqual({ purged: count, deferred: 0 });
    expect(countRows(h.db, "content")).toBe(0);
  });

  it("keeps a single timer at the next expiry, clamped to the longest setTimeout delay, and none when nothing is due", async () => {
    const { h, at } = clocked();
    const { trash, timers, live } = timed(h);
    trash.arm();
    expect(timers).toEqual([]);
    const first = finishedContent(h);
    h.trash.trash(LOCAL, first);
    trash.refresh();
    expect(live().map((timer) => timer.ms)).toEqual([MAX_TIMER_MS]);
    at(T0 + TRASH_RETENTION_MS - 1000);
    trash.refresh();
    expect(live().map((timer) => timer.ms)).toEqual([1000]);
    // Re-arming replaces the timer, never adds one.
    trash.refresh();
    expect(live()).toHaveLength(1);
    expect(timers.length).toBe(3);
  });

  it("re-arms after firing; an expired entry it cannot purge is retried with the backoff", async () => {
    const { h, at } = clocked();
    const contentId = finishedContent(h);
    h.trash.trash(LOCAL, contentId);
    createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
    const { trash, live, fire } = timed(h);
    at(T0 + TRASH_RETENTION_MS - 10);
    trash.arm();
    expect(live().map((timer) => timer.ms)).toEqual([10]);
    at(T0 + TRASH_RETENTION_MS);
    await fire();
    expect(countRows(h.db, "content", "id = ?", contentId)).toBe(1);
    expect(live().map((timer) => timer.ms)).toEqual([TRASH_RETRY_BASE_MS]);
    expect(await trash.sweep()).toEqual({ purged: 0, deferred: 1 });
    trash.refresh();
    expect(live().map((timer) => timer.ms)).toEqual([2 * TRASH_RETRY_BASE_MS]);
  });

  it("wakes for the next due pending file", async () => {
    const { h } = clocked();
    h.repository.withTransaction((scope) =>
      scope.pendingFileDeletes.insert({ id: "p", store: "data", rootPath: h.dir, storageRef: "tmp/tasks/x", attempts: 1, nextAttemptAt: T0 + 5000, createdAt: T0 }),
    );
    const { trash, live } = timed(h);
    trash.arm();
    expect(live().map((timer) => timer.ms)).toEqual([5000]);
  });

  it("re-arms even when a sweep fails, and stop ends the timer for good", async () => {
    const { h, at } = clocked();
    const contentId = finishedContent(h);
    h.trash.trash(LOCAL, contentId);
    at(T0 + TRASH_RETENTION_MS - 10);
    const warnings: string[] = [];
    const { trash, live } = timed(h, {
      fileDeleter: { kick: () => { throw new Error("worker gone"); }, nextDueAt: () => undefined },
      logger: { ...silentLogger, warn: (message) => void warnings.push(message), child: () => silentLogger },
    });
    trash.arm();
    at(T0 + TRASH_RETENTION_MS);
    const [pending] = live();
    pending?.fire();
    if (pending !== undefined) pending.cancelled = true;
    await vi.waitFor(() => expect(warnings).toContain("trash_sweep_failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Purged before the failure; the next expiry is none, so the re-arm leaves no timer behind.
    expect(countRows(h.db, "content", "id = ?", contentId)).toBe(0);
    const other = finishedContent(h);
    h.trash.trash(LOCAL, other);
    trash.refresh();
    expect(live()).toHaveLength(1);
    await trash.stop();
    expect(live()).toHaveLength(0);
    trash.refresh();
    trash.arm();
    expect(live()).toHaveLength(0);
  });

  it("shares one sweep between concurrent calls", async () => {
    const { h } = clocked();
    const { trash } = timed(h);
    const [a, b] = [trash.sweep(), trash.sweep()];
    expect(a).toBe(b);
    await a;
  });
});

describe("files in the trash", () => {
  it("stay untouched until the purge", async () => {
    const { h } = clocked();
    const contentId = finishedContent(h);
    const path = join(h.dir, "assets", LOCAL.userId, contentId, "upload");
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset(contentId, "upload", "managed_upload")));
    await h.media.data.writeAtomic(`assets/${LOCAL.userId}/${contentId}/upload`, Buffer.from("0123456789"));
    h.trash.trash(LOCAL, contentId);
    await h.fileDeleter.whenIdle();
    expect(existsSync(path)).toBe(true);
    expect(countRows(h.db, "pending_file_delete")).toBe(0);
  });
});

/**
 * A trash service with the task service and the scheduler's execution view behind test
 * seams: Tasks are cancelled for real but nothing is scheduled, `executing` stands for the
 * executions still running, and `settle` runs while the delete waits for them.
 */
function rig(options: { drainTimeoutMs?: number } = {}) {
  const { h, at } = clocked();
  const executing = new Set<string>();
  const order: string[] = [];
  const hooks: { settle: (taskIds: readonly string[]) => Promise<void> | void; beforeCancel: (taskId: string) => void } = {
    settle: () => undefined,
    beforeCancel: () => undefined,
  };
  const tasks = new TaskService({
    repository: h.repository,
    bus: h.bus,
    control: { kick: () => undefined, abortTask: (taskId) => order.push(`abort:${taskId}`) },
    secrets: h.secrets,
  });
  const chatAborts: string[] = [];
  const trash = new TrashService({
    repository: h.repository,
    deleteContent: h.deleteContent,
    fileDeleter: h.fileDeleter,
    chat: { abortContent: (_owner, contentId) => void chatAborts.push(contentId) },
    logger: silentLogger,
    tasks: {
      cancel: (principal, taskId) => {
        hooks.beforeCancel(taskId);
        const detail = tasks.cancel(principal, taskId);
        order.push(`cancelled:${taskId}`);
        return detail;
      },
    },
    execution: {
      isExecuting: (taskId) => executing.has(taskId),
      settleTasks: async (taskIds) => {
        order.push(`settle:${[...taskIds].sort().join(",")}`);
        await hooks.settle(taskIds);
      },
    },
    drainTimeoutMs: options.drainTimeoutMs ?? 1000,
  });
  const refresh = vi.spyOn(trash, "refresh");
  return { h, at, trash, executing, order, hooks, chatAborts, refresh };
}

function unfinishedTask(h: Harness, contentId: string): string {
  return createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
}

function projectionOf(h: Harness, taskId: string): string | undefined {
  return h.repository.withTransaction((scope) => scope.tasks.get(LOCAL.userId, taskId)?.statusProjection);
}

function trashedAtOf(h: Harness, contentId: string, userId = LOCAL.userId): number | undefined {
  return h.repository.withTransaction((scope) => scope.contents.getIncludingTrashed(userId, contentId)?.trashedAt);
}

/** A queued summary of `collectionId` that froze `contentIds` as its input, created the way the collection service does. */
function summaryTask(h: Harness, collectionId: string, contentIds: readonly string[]): string {
  return transact(h.repository, h.bus, (scope, outbox) =>
    createTask(scope, outbox, {
      task: {
        id: h.newId(),
        userId: LOCAL.userId,
        collectionId,
        kind: "summarize_collection",
        requestJson: canonicalJson({
          requestSchemaVersion: 1,
          kind: "summarize_collection",
          outputLanguage: "zh-CN",
          inputItems: contentIds.map((contentId, position) => ({ collectionItemId: `item-${position}`, contentId, summaryRevisionId: "s", transcriptRevisionId: "t", position })),
        }),
        createdAt: Date.now(),
      },
      sourceKind: undefined,
      newId: h.newId,
    }).id,
  );
}

async function collectionWith(h: Harness, name: string, contentIds: readonly string[]): Promise<string> {
  const collection = h.collections.create(LOCAL, { name });
  for (const contentId of contentIds) {
    await h.collections.addItem(LOCAL, collection.id, { contentId });
  }
  return collection.id;
}

async function errorOf(work: () => unknown): Promise<{ code: string; details?: unknown }> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return { code: error.appError.code, ...(error.appError.details === undefined ? {} : { details: error.appError.details }) };
    throw error;
  }
  throw new Error("expected an error");
}

describe("what blocks a move to the trash", () => {
  it("is the summary's frozen input: a member taken out of the collection while its summary runs still cannot go", async () => {
    const { h, trash } = rig();
    const used = finishedContent(h);
    const course = await collectionWith(h, "Course", [used]);
    const summary = summaryTask(h, course, [used]);
    h.collections.removeItems(LOCAL, course, [used]);
    expect(h.repository.withTransaction((scope) => scope.collections.membershipsOf(LOCAL.userId, [used]).get(used))).toEqual([]);

    expect(await codeOf(() => trash.trash(LOCAL, used))).toBe("conflict.tasks_unfinished");
    expect(trash.plan(LOCAL, [used]).items).toEqual([{ contentId: used, state: "blocked", blockingCollections: [{ id: course, name: "Course" }] }]);
    expect(await trash.trashMany(LOCAL, { contentIds: [used], cancelTasks: true })).toEqual({
      trashedIds: [], alreadyTrashedIds: [], failed: [{ contentId: used, reason: "summarizing" }], cancelledTaskCount: 0,
    });
    // That summary is never cancelled on the Content's behalf.
    expect(projectionOf(h, summary)).toBe("queued");
    h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, summary, "succeeded", T0 + 1));
    trash.trash(LOCAL, used);
    expect(trashedAtOf(h, used)).toBe(T0);
  });

  it("includes a cancelled Task whose execution has not stopped yet", async () => {
    const { h, trash, executing } = rig();
    const contentId = finishedContent(h);
    const [taskId] = h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId).map((task) => task.id));
    executing.add(taskId as string);
    expect(await codeOf(() => trash.trash(LOCAL, contentId))).toBe("conflict.tasks_unfinished");
    expect(trash.plan(LOCAL, [contentId]).items).toEqual([{ contentId, state: "tasks", unfinishedTaskCount: 1 }]);
    executing.clear();
    trash.trash(LOCAL, contentId);
  });
});

describe("planning a move to the trash", () => {
  it("tells the five states apart in request order, blocked before tasks, and changes nothing", async () => {
    const { h, trash } = rig();
    const ready = seedContent(h, { title: "第一讲", lines: ["a"] }).contentId;
    const busy = finishedContent(h);
    unfinishedTask(h, busy);
    unfinishedTask(h, busy);
    const frozen = finishedContent(h);
    unfinishedTask(h, frozen);
    const course = await collectionWith(h, "Course", [frozen]);
    summaryTask(h, course, [frozen]);
    const trashed = finishedContent(h);
    trash.trash(LOCAL, trashed);
    const bobs = createLocalContent(h, BOB.userId);
    const before = countRows(h.db, "task", "status_projection = 'queued'");

    expect(trash.plan(LOCAL, [bobs, ready, busy, frozen, trashed, "01UNKNOWNCONTENT000000000"]).items).toEqual([
      { contentId: bobs, state: "missing" },
      { contentId: ready, title: "第一讲", state: "ready" },
      { contentId: busy, state: "tasks", unfinishedTaskCount: 2 },
      { contentId: frozen, state: "blocked", blockingCollections: [{ id: course, name: "Course" }] },
      { contentId: trashed, state: "trashed" },
      { contentId: "01UNKNOWNCONTENT000000000", state: "missing" },
    ]);
    expect(countRows(h.db, "task", "status_projection = 'queued'")).toBe(before);
    expect(await errorOf(() => trash.plan(LOCAL, Array.from({ length: CONTENT_TRASH_BATCH_MAX + 1 }, (_, index) => `c${index}`)))).toEqual({
      code: "invalid_request.batch_too_large",
      details: { itemCount: CONTENT_TRASH_BATCH_MAX + 1, limit: CONTENT_TRASH_BATCH_MAX },
    });
  });
});

describe("moving several Contents to the trash", () => {
  it("cancels, waits for the executions to stop, then moves each; counts every outcome and re-arms the timer once", async () => {
    const { h, at, trash, order, hooks, chatAborts, refresh } = rig();
    const plain = finishedContent(h);
    const busy = finishedContent(h);
    const first = unfinishedTask(h, busy);
    const second = unfinishedTask(h, busy);
    const frozen = finishedContent(h);
    const frozenOwn = unfinishedTask(h, frozen);
    const other = await collectionWith(h, "Other", [frozen]);
    const otherSummary = summaryTask(h, other, [frozen]);
    const earlier = finishedContent(h);
    trash.trash(LOCAL, earlier);
    refresh.mockClear();
    hooks.settle = () => {
      // Cancelled before the wait, moved only after it.
      expect([projectionOf(h, first), projectionOf(h, second), trashedAtOf(h, busy)]).toEqual(["cancelled", "cancelled", undefined]);
      order.push("settled");
    };
    at(T0 + 7);
    const result = await trash.trashMany(LOCAL, { contentIds: [plain, earlier, busy, frozen, "01UNKNOWNCONTENT000000000"], cancelTasks: true });

    expect(result).toEqual({
      trashedIds: [plain, busy],
      alreadyTrashedIds: [earlier],
      failed: [{ contentId: frozen, reason: "summarizing" }, { contentId: "01UNKNOWNCONTENT000000000", reason: "missing" }],
      cancelledTaskCount: 2,
    });
    expect(order).toEqual([`abort:${first}`, `cancelled:${first}`, `abort:${second}`, `cancelled:${second}`, `settle:${[first, second].sort().join(",")}`, "settled"]);
    // The frozen Content's own Task and the other collection's summary are left alone.
    expect([projectionOf(h, frozenOwn), projectionOf(h, otherSummary)]).toEqual(["queued", "queued"]);
    // Already in the trash: its trash time is kept.
    expect([trashedAtOf(h, plain), trashedAtOf(h, busy), trashedAtOf(h, earlier)]).toEqual([T0 + 7, T0 + 7, T0]);
    expect(chatAborts).toEqual([earlier, plain, busy]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h.contents.list(LOCAL, { limit: 10 }).items.map((item) => item.id)).toEqual([frozen]);

    // Repeating the request is safe: nothing new is cancelled or moved.
    refresh.mockClear();
    expect(await trash.trashMany(LOCAL, { contentIds: [plain, busy], cancelTasks: true })).toEqual({
      trashedIds: [], alreadyTrashedIds: [plain, busy], failed: [], cancelledTaskCount: 0,
    });
    expect(trashedAtOf(h, plain)).toBe(T0 + 7);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("without cancelTasks leaves unfinished Tasks running and reports their Contents", async () => {
    const { h, trash, order } = rig();
    const busy = finishedContent(h);
    const taskId = unfinishedTask(h, busy);
    const plain = finishedContent(h);
    expect(await trash.trashMany(LOCAL, { contentIds: [busy, plain], cancelTasks: false })).toEqual({
      trashedIds: [plain], alreadyTrashedIds: [], failed: [{ contentId: busy, reason: "tasks" }], cancelledTaskCount: 0,
    });
    expect(projectionOf(h, taskId)).toBe("queued");
    expect(order).toEqual([]);
  });

  it("goes on when a Task finished on its own just before it was cancelled", async () => {
    const { h, trash, hooks } = rig();
    const a = finishedContent(h);
    const ending = unfinishedTask(h, a);
    const b = finishedContent(h);
    const running = unfinishedTask(h, b);
    hooks.beforeCancel = (taskId) => {
      if (taskId === ending) h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, ending, "succeeded", T0));
    };
    expect(await trash.trashMany(LOCAL, { contentIds: [a, b], cancelTasks: true })).toEqual({
      trashedIds: [a, b], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 1,
    });
    expect([projectionOf(h, ending), projectionOf(h, running)]).toEqual(["succeeded", "cancelled"]);
  });

  it("refuses a Content that got a new Task while the delete waited, and moves the rest", async () => {
    const { h, trash, hooks } = rig();
    const a = finishedContent(h);
    unfinishedTask(h, a);
    const b = finishedContent(h);
    unfinishedTask(h, b);
    hooks.settle = () => void unfinishedTask(h, a);
    expect(await trash.trashMany(LOCAL, { contentIds: [a, b], cancelTasks: true })).toEqual({
      trashedIds: [b], alreadyTrashedIds: [], failed: [{ contentId: a, reason: "tasks" }], cancelledTaskCount: 2,
    });
    expect(trashedAtOf(h, a)).toBeUndefined();
  });

  it("does not move a Content whose cancelled execution is still running when the wait times out", async () => {
    const { h, trash, executing, hooks } = rig({ drainTimeoutMs: 20 });
    const stuck = finishedContent(h);
    const taskId = unfinishedTask(h, stuck);
    const plain = finishedContent(h);
    executing.add(taskId);
    hooks.settle = () => new Promise<void>(() => undefined);
    expect(await trash.trashMany(LOCAL, { contentIds: [stuck, plain], cancelTasks: true })).toEqual({
      trashedIds: [plain], alreadyTrashedIds: [], failed: [{ contentId: stuck, reason: "stopping" }], cancelledTaskCount: 1,
    });
    expect(projectionOf(h, taskId)).toBe("cancelled");
    // Once it has stopped, the same request finishes the job.
    executing.clear();
    hooks.settle = () => undefined;
    expect(await trash.trashMany(LOCAL, { contentIds: [stuck, plain], cancelTasks: true })).toEqual({
      trashedIds: [stuck], alreadyTrashedIds: [plain], failed: [], cancelledTaskCount: 0,
    });
  });

  it("sees another user's Content as missing and never cancels their Tasks; too many ids are refused", async () => {
    const { h, trash } = rig();
    const bobs = createLocalContent(h, BOB.userId);
    const bobTask = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId: bobs, userId: BOB.userId });
    expect(await trash.trashMany(LOCAL, { contentIds: [bobs], cancelTasks: true })).toEqual({
      trashedIds: [], alreadyTrashedIds: [], failed: [{ contentId: bobs, reason: "missing" }], cancelledTaskCount: 0,
    });
    expect(h.repository.withTransaction((scope) => scope.tasks.get(BOB.userId, bobTask)?.statusProjection)).toBe("queued");
    expect(trashedAtOf(h, bobs, BOB.userId)).toBeUndefined();
    const ids = Array.from({ length: CONTENT_TRASH_BATCH_MAX + 1 }, () => finishedContent(h));
    expect((await errorOf(() => trash.trashMany(LOCAL, { contentIds: ids, cancelTasks: false }))).code).toBe("invalid_request.batch_too_large");
    expect(h.contents.list(LOCAL, { limit: 1 }).items).toHaveLength(1);
  });
});

describe("restoring several Contents", () => {
  it("reports restored, already active, expired and missing apart, with everything a single restore does", async () => {
    const { h, at, trash } = rig();
    const back = seedContent(h, { title: "梯度下降", lines: ["今天讲梯度下降"] }).contentId;
    const course = await collectionWith(h, "Course", [back]);
    const active = finishedContent(h);
    const old = finishedContent(h);
    const purged = finishedContent(h);
    const bobs = createLocalContent(h, BOB.userId);
    trash.trash(LOCAL, old);
    at(T0 + 10);
    trash.trash(LOCAL, back);
    trash.trash(LOCAL, purged);
    await trash.purge(LOCAL, purged);
    at(T0 + TRASH_RETENTION_MS);

    expect(trash.restoreMany(LOCAL, [back, active, old, purged, bobs])).toEqual({
      restoredIds: [back],
      alreadyActiveIds: [active],
      failed: [{ contentId: old, reason: "expired" }, { contentId: purged, reason: "missing" }, { contentId: bobs, reason: "missing" }],
    });
    expect(h.search.search(LOCAL, { q: "梯度", scope: "global" }).contents.map((hit) => hit.contentId)).toEqual([back]);
    expect(h.collections.get(LOCAL, course)).toMatchObject({ itemCount: 1, updatedAt: T0 + TRASH_RETENTION_MS });
    expect(trashedAtOf(h, old)).toBe(T0);
    expect((await errorOf(() => trash.restoreMany(LOCAL, Array.from({ length: CONTENT_TRASH_BATCH_MAX + 1 }, (_, index) => `c${index}`)))).code).toBe(
      "invalid_request.batch_too_large",
    );
  });
});

describe("deleting a collection with its contents", () => {
  /** Two exclusive members, one shared with "Elsewhere" and one in the trash since T0. */
  async function course(r: ReturnType<typeof rig>) {
    const { h } = r;
    const exclusive = [finishedContent(h), finishedContent(h)];
    const shared = finishedContent(h);
    const binned = finishedContent(h);
    const id = await collectionWith(h, "Course", [...exclusive, shared, binned]);
    const elsewhere = await collectionWith(h, "Elsewhere", [shared]);
    r.trash.trash(LOCAL, binned);
    r.chatAborts.length = 0;
    r.refresh.mockClear();
    return { id, exclusive, shared, binned, elsewhere };
  }

  it("plans exclusive members in collection order, shared and trashed ones, Tasks and blockers", async () => {
    const r = rig();
    const { h, trash } = r;
    const c = await course(r);
    unfinishedTask(h, c.exclusive[1] as string);
    summaryTask(h, c.id, c.exclusive);
    expect(trash.collectionDeletePlan(LOCAL, c.id)).toEqual({
      memberCount: 3,
      exclusiveContentIds: c.exclusive,
      sharedCount: 1,
      trashedMemberCount: 1,
      exclusiveWithTasksCount: 1,
      collectionTaskCount: 1,
      blocked: [],
    });
    // Another collection's summary froze an exclusive member, though it is no member there any more.
    const third = await collectionWith(h, "Third", [c.exclusive[0] as string]);
    summaryTask(h, third, [c.exclusive[0] as string]);
    h.collections.removeItems(LOCAL, third, [c.exclusive[0] as string]);
    expect(trash.collectionDeletePlan(LOCAL, c.id).blocked).toEqual([{ contentId: c.exclusive[0], collections: [{ id: third, name: "Third" }] }]);
    expect(await codeOf(() => trash.collectionDeletePlan(BOB, c.id))).toBe("not_found");
  });

  it("moves the exclusive members, keeps shared ones and trashed members' time, and the members can be restored", async () => {
    const r = rig();
    const { h, at, trash, order, chatAborts, refresh } = r;
    const c = await course(r);
    const memberTask = unfinishedTask(h, c.exclusive[0] as string);
    const ownSummary = summaryTask(h, c.id, [...c.exclusive, c.shared]);
    at(T0 + 5);
    const result = await trash.deleteCollection(LOCAL, c.id, { contents: "exclusive", cancelTasks: true, expectedContentIds: [...c.exclusive].reverse() });

    expect(result).toEqual({ trashedIds: c.exclusive, cancelledTaskCount: 2 });
    expect(order.filter((entry) => entry.startsWith("cancelled:")).sort()).toEqual([`cancelled:${memberTask}`, `cancelled:${ownSummary}`].sort());
    expect(h.collections.list(LOCAL).items.map((item) => item.name)).toEqual(["Elsewhere"]);
    expect(countRows(h.db, "collection_item", "collection_id = ?", c.id)).toBe(0);
    expect(c.exclusive.map((id) => trashedAtOf(h, id))).toEqual([T0 + 5, T0 + 5]);
    expect([trashedAtOf(h, c.binned), trashedAtOf(h, c.shared)]).toEqual([T0, undefined]);
    expect(h.collections.get(LOCAL, c.elsewhere).items.map((item) => item.contentId)).toEqual([c.shared]);
    expect(chatAborts).toEqual(c.exclusive);
    expect(refresh).toHaveBeenCalledTimes(1);

    const restored = trash.restoreMany(LOCAL, [...c.exclusive, c.binned]);
    expect(restored.restoredIds).toEqual([...c.exclusive, c.binned]);
    expect(h.contents.get(LOCAL, c.exclusive[0] as string).collections).toEqual([]);
  });

  it("refuses before cancelling anything when the exclusive members are no longer what was confirmed", async () => {
    const r = rig();
    const { h, trash, order } = r;
    const c = await course(r);
    const taskId = unfinishedTask(h, c.exclusive[0] as string);
    const plan = trash.collectionDeletePlan(LOCAL, c.id);
    // Added to another collection between the plan and the confirmation.
    await h.collections.addItem(LOCAL, c.elsewhere, { contentId: c.exclusive[1] as string });
    expect(await errorOf(() => trash.deleteCollection(LOCAL, c.id, { contents: "exclusive", cancelTasks: true, expectedContentIds: plan.exclusiveContentIds }))).toEqual({
      code: "conflict.collection_members_changed",
      details: { cancelledTaskCount: 0 },
    });
    expect(order).toEqual([]);
    expect(projectionOf(h, taskId)).toBe("queued");
    expect(h.collections.get(LOCAL, c.id).itemCount).toBe(3);
    expect(c.exclusive.map((id) => trashedAtOf(h, id))).toEqual([undefined, undefined]);
  });

  it("refuses before cancelling anything while another collection's summary froze a member", async () => {
    const r = rig();
    const { h, trash, order } = r;
    const c = await course(r);
    const ownSummary = summaryTask(h, c.id, c.exclusive);
    const third = await collectionWith(h, "Third", [c.exclusive[0] as string]);
    const otherSummary = summaryTask(h, third, [c.exclusive[0] as string]);
    h.collections.removeItems(LOCAL, third, [c.exclusive[0] as string]);
    expect((await errorOf(() => trash.deleteCollection(LOCAL, c.id, { contents: "exclusive", cancelTasks: true, expectedContentIds: c.exclusive }))).code).toBe(
      "conflict.tasks_unfinished",
    );
    expect(order).toEqual([]);
    expect([projectionOf(h, ownSummary), projectionOf(h, otherSummary)]).toEqual(["queued", "queued"]);
  });

  it("rolls back when the members change after the Tasks were cancelled, reporting them and doing nothing after the commit", async () => {
    const r = rig();
    const { h, trash, hooks, chatAborts, refresh } = r;
    const c = await course(r);
    const memberTask = unfinishedTask(h, c.exclusive[0] as string);
    const ownSummary = summaryTask(h, c.id, c.exclusive);
    hooks.settle = async () => {
      await h.collections.addItem(LOCAL, c.elsewhere, { contentId: c.exclusive[1] as string });
    };
    expect(await errorOf(() => trash.deleteCollection(LOCAL, c.id, { contents: "exclusive", cancelTasks: true, expectedContentIds: c.exclusive }))).toEqual({
      code: "conflict.collection_members_changed",
      details: { cancelledTaskCount: 2 },
    });
    // Cancelling cannot be undone; everything else is as it was.
    expect([projectionOf(h, memberTask), projectionOf(h, ownSummary)]).toEqual(["cancelled", "cancelled"]);
    expect(h.collections.get(LOCAL, c.id).itemCount).toBe(3);
    expect(c.exclusive.map((id) => trashedAtOf(h, id))).toEqual([undefined, undefined]);
    expect(chatAborts).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(countRows(h.db, "idempotency_record")).toBe(0);
  });

  it("rolls back when the collection's own summary is still stopping after the wait", async () => {
    const r = rig({ drainTimeoutMs: 20 });
    const { h, trash, executing, hooks } = r;
    const c = await course(r);
    const ownSummary = summaryTask(h, c.id, c.exclusive);
    executing.add(ownSummary);
    hooks.settle = () => new Promise<void>(() => undefined);
    expect(await errorOf(() => trash.deleteCollection(LOCAL, c.id, { contents: "exclusive", cancelTasks: true, expectedContentIds: c.exclusive }))).toEqual({
      code: "conflict.collection_members_changed",
      details: { cancelledTaskCount: 1 },
    });
    expect(h.collections.get(LOCAL, c.id).itemCount).toBe(3);
  });

  it("with only shared members still asks before cancelling the running summary, then deletes just the collection", async () => {
    const { h, trash } = rig();
    const shared = finishedContent(h);
    const id = await collectionWith(h, "Course", [shared]);
    await collectionWith(h, "Elsewhere", [shared]);
    const ownSummary = summaryTask(h, id, [shared]);
    expect(trash.collectionDeletePlan(LOCAL, id)).toMatchObject({ exclusiveContentIds: [], sharedCount: 1, collectionTaskCount: 1 });
    expect((await errorOf(() => trash.deleteCollection(LOCAL, id, { contents: "exclusive", cancelTasks: false, expectedContentIds: [] }))).code).toBe("conflict.tasks_unfinished");
    expect(projectionOf(h, ownSummary)).toBe("queued");
    expect(await trash.deleteCollection(LOCAL, id, { contents: "exclusive", cancelTasks: true, expectedContentIds: [] })).toEqual({ trashedIds: [], cancelledTaskCount: 1 });
    expect(h.collections.list(LOCAL).items.map((item) => item.name)).toEqual(["Elsewhere"]);
    expect(trashedAtOf(h, shared)).toBeUndefined();
  });

  it("with contents kept only deletes the collection, cancelling its summary when asked", async () => {
    const r = rig();
    const { h, trash } = r;
    const c = await course(r);
    const memberTask = unfinishedTask(h, c.exclusive[0] as string);
    const ownSummary = summaryTask(h, c.id, c.exclusive);
    expect((await errorOf(() => trash.deleteCollection(LOCAL, c.id, { contents: "keep", cancelTasks: false }))).code).toBe("conflict.tasks_unfinished");
    expect(await trash.deleteCollection(LOCAL, c.id, { contents: "keep", cancelTasks: true })).toEqual({ trashedIds: [], cancelledTaskCount: 1 });
    expect([projectionOf(h, memberTask), projectionOf(h, ownSummary)]).toEqual(["queued", undefined]);
    expect(h.contents.list(LOCAL, { limit: 10 }).items).toHaveLength(3);
  });

  it("with contents kept answers tasks_unfinished when its summary is still stopping or a new one started after the wait", async () => {
    const stopping = rig({ drainTimeoutMs: 20 });
    const c = await course(stopping);
    const ownSummary = summaryTask(stopping.h, c.id, c.exclusive);
    stopping.executing.add(ownSummary);
    stopping.hooks.settle = () => new Promise<void>(() => undefined);
    expect(await errorOf(() => stopping.trash.deleteCollection(LOCAL, c.id, { contents: "keep", cancelTasks: true }))).toEqual({ code: "conflict.tasks_unfinished" });
    expect(projectionOf(stopping.h, ownSummary)).toBe("cancelled");
    expect(stopping.h.collections.get(LOCAL, c.id).itemCount).toBe(3);

    const started = rig();
    const d = await course(started);
    summaryTask(started.h, d.id, d.exclusive);
    started.hooks.settle = () => void summaryTask(started.h, d.id, d.exclusive);
    expect(await errorOf(() => started.trash.deleteCollection(LOCAL, d.id, { contents: "keep", cancelTasks: true }, "key-1"))).toEqual({ code: "conflict.tasks_unfinished" });
    expect(started.h.collections.get(LOCAL, d.id).itemCount).toBe(3);
    expect(countRows(started.h.db, "idempotency_record")).toBe(0);
  });

  it("gives two concurrent requests with the same key one delete and the same answer", async () => {
    const r = rig();
    const { h, trash, chatAborts, refresh } = r;
    const c = await course(r);
    const memberTask = unfinishedTask(h, c.exclusive[0] as string);
    const body = { contents: "exclusive" as const, cancelTasks: true, expectedContentIds: c.exclusive };
    const [first, second] = await Promise.all([trash.deleteCollection(LOCAL, c.id, body, "key-1"), trash.deleteCollection(LOCAL, c.id, body, "key-1")]);
    // Whichever commits first answers both; the other one's transaction replays it.
    expect(first.trashedIds).toEqual(c.exclusive);
    expect(second).toEqual(first);
    expect(projectionOf(h, memberTask)).toBe("cancelled");
    expect(chatAborts).toEqual(c.exclusive);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(countRows(h.db, "idempotency_record")).toBe(1);
  });

  it("answers a retry with the same key with the first result, not not_found", async () => {
    const r = rig();
    const { h, trash, chatAborts } = r;
    const c = await course(r);
    const body = { contents: "exclusive" as const, cancelTasks: true, expectedContentIds: c.exclusive };
    const first = await trash.deleteCollection(LOCAL, c.id, body, "key-1");
    expect(first).toEqual({ trashedIds: c.exclusive, cancelledTaskCount: 0 });
    expect(await trash.deleteCollection(LOCAL, c.id, body, "key-1")).toEqual(first);
    expect(chatAborts).toEqual(c.exclusive);
    expect(await codeOf(() => trash.deleteCollection(LOCAL, c.id, { ...body, cancelTasks: false }, "key-1"))).toBe("idempotency_conflict");
    expect(await codeOf(() => trash.deleteCollection(LOCAL, c.id, body, "key-2"))).toBe("not_found");
    expect(await codeOf(() => trash.deleteCollection(BOB, c.id, body, "key-1"))).toBe("not_found");
  });
});
