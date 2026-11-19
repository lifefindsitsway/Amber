import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrashService } from "../../../src/server/application/trash.ts";
import { TRASH_RETENTION_MS } from "../../../src/server/domain/content.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { MAX_TIMER_MS } from "../../../src/server/pipeline/scheduler.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";
import { TRASH_RETRY_BASE_MS, TRASH_SWEEP_BATCH } from "../../../src/shared/defaults.ts";
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
