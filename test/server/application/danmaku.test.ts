import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { DanmakuService, danmakuSummaryIn } from "../../../src/server/application/danmaku.ts";
import { PlatformRegistry } from "../../../src/server/application/platforms.ts";
import type { Content } from "../../../src/server/domain/content.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { RequestPrincipal } from "../../../src/server/domain/user.ts";
import type { PlatformContentRef, PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { DANMAKU_FETCH_COOLDOWN_MS, DANMAKU_FETCH_TIMEOUT_MS } from "../../../src/shared/defaults.ts";
import { danmakuFetchResultDtoSchema, danmakuSnapshotDtoSchema, type DanmakuItem } from "../../../src/shared/dto/danmaku.ts";
import type { AppError } from "../../../src/shared/errors.ts";
import { insertRow, openTempDatabase } from "../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const ALICE: RequestPrincipal = { userId: "alice", mode: "server", role: "user", mustChangePassword: false };
const BOB: RequestPrincipal = { ...ALICE, userId: "bob" };

type Answer = { items: DanmakuItem[]; truncated: boolean };

/** A platform whose danmaku requests are answered by the test, one deferred per call. */
class FakeDanmakuPlatform {
  readonly calls: Array<{ ref: PlatformContentRef; signal: AbortSignal; resolve: (answer: Answer) => void; reject: (error: unknown) => void }> = [];
  readonly adapter: PlatformSourceAdapter;

  constructor(kind: "bilibili" | "youtube", withDanmaku: boolean) {
    const base = { kind, cookieDomains: [], parse: () => null };
    const fetchDanmaku = (ref: PlatformContentRef, signal: AbortSignal): Promise<Answer> =>
      new Promise((resolve, reject) => {
        this.calls.push({ ref, signal, resolve, reject });
      });
    this.adapter = (withDanmaku ? { ...base, fetchDanmaku } : base) as unknown as PlatformSourceAdapter;
  }

  /** Answers the latest call. */
  answer(answer: Answer | Error): void {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error("no call to answer");
    if (answer instanceof Error) call.reject(answer);
    else call.resolve(answer);
  }
}

const item = (timeMs: number, text = "x"): DanmakuItem => ({ timeMs, mode: "scroll", color: 0xffffff, weight: 5, text });

let db: SqliteConnection;
let repository: SqliteRepository;
let bilibili: FakeDanmakuPlatform;
let youtube: FakeDanmakuPlatform;
let time: { now: number };
let service: DanmakuService;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  bilibili = new FakeDanmakuPlatform("bilibili", true);
  youtube = new FakeDanmakuPlatform("youtube", false);
  time = { now: T0 };
  service = new DanmakuService({ repository, platforms: new PlatformRegistry([bilibili.adapter, youtube.adapter]), now: () => time.now });
});

afterEach(() => {
  vi.useRealTimers();
});

let counter = 0;
function content(source: Content["source"], userId = "alice"): string {
  counter += 1;
  const id = `content-${counter}`;
  repository.withTransaction((scope) => scope.contents.insert({ id, userId, source, title: "t", processingStatus: "succeeded", createdAt: T0, updatedAt: T0 }));
  return id;
}

const bilibiliContent = (partId: string | null = "1001"): string =>
  content({ kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD", platformContentId: "BV1xx411c7mD", ...(partId === null ? {} : { platformPartId: partId }) });

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Lets the service's microtasks run so a pending request reaches the fake platform. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function fetched(contentId: string, answer: Answer | Error) {
  const pending = service.fetch(ALICE, contentId);
  await settle();
  bilibili.answer(answer);
  return danmakuFetchResultDtoSchema.parse(await pending);
}

describe("DanmakuService.get", () => {
  it("is supported only where the platform's adapter offers danmaku and the Content names a part", () => {
    expect(service.get(ALICE, content({ kind: "local" }))).toEqual({ supported: false });
    expect(service.get(ALICE, content({ kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=abc", platformContentId: "abc" }))).toEqual({ supported: false });
    expect(service.get(ALICE, bilibiliContent(null))).toEqual({ supported: false });
    expect(service.get(ALICE, bilibiliContent())).toEqual({ supported: true });
  });

  it("is not_found for another owner and for a trashed Content", async () => {
    const id = bilibiliContent();
    expect((await failure(Promise.resolve().then(() => service.get(BOB, id)))).class).toBe("not_found");
    repository.withTransaction((scope) => scope.contents.trash("alice", id, T0));
    expect((await failure(Promise.resolve().then(() => service.get(ALICE, id)))).class).toBe("not_found");
  });

  it("shows a snapshot only while it belongs to the part the Content names", async () => {
    const id = bilibiliContent();
    await fetched(id, { items: [item(1)], truncated: false });
    expect(danmakuSnapshotDtoSchema.parse(service.get(ALICE, id))).toEqual({ supported: true, snapshot: { fetchedAt: T0, count: 1, items: [item(1)] } });
    db.prepare("UPDATE content SET platform_part_id = '2002' WHERE id = ?").run(id);
    expect(service.get(ALICE, id)).toEqual({ supported: true });
    expect(repository.withTransaction((scope) => danmakuSummaryIn(new PlatformRegistry([bilibili.adapter]), scope, "alice", scope.contents.get("alice", id) as Content))).toEqual({});
  });
});

describe("DanmakuService.fetch", () => {
  it("fetched: replaces the snapshot with the answer, and the detail summary follows", async () => {
    const id = bilibiliContent();
    expect(summary(id)).toEqual({});
    const first = await fetched(id, { items: [item(1, "a"), item(2, "b")], truncated: false });
    expect(first).toEqual({ result: "fetched", snapshot: { fetchedAt: T0, count: 2, items: [item(1, "a"), item(2, "b")] } });
    expect(bilibili.calls.map((call) => call.ref)).toEqual([{ platformContentId: "BV1xx411c7mD", platformPartId: "1001" }]);
    time.now += DANMAKU_FETCH_COOLDOWN_MS;
    const second = await fetched(id, { items: [item(3, "c")], truncated: true });
    expect(second).toEqual({ result: "fetched", snapshot: { fetchedAt: time.now, count: 1, items: [item(3, "c")] }, truncated: true });
    expect(service.get(ALICE, id).snapshot?.items).toEqual([item(3, "c")]);
    expect(summary(id)).toEqual({ fetchedAt: time.now, count: 1 });
  });

  it("empty: a video without danmaku records an empty snapshot", async () => {
    const id = bilibiliContent();
    await fetched(id, { items: [item(1)], truncated: false });
    time.now += DANMAKU_FETCH_COOLDOWN_MS;
    expect(await fetched(id, { items: [], truncated: false })).toEqual({ result: "empty", snapshot: { fetchedAt: time.now, count: 0, items: [] } });
    expect(summary(id)).toEqual({ fetchedAt: time.now, count: 0 });
  });

  it("failed: keeps the previous snapshot, sends nothing more, and drops a login action from the error", async () => {
    const id = bilibiliContent();
    await fetched(id, { items: [item(1)], truncated: false });
    time.now += DANMAKU_FETCH_COOLDOWN_MS;
    const blocked = await fetched(id, amberError("platform_blocked", "risk control"));
    expect(blocked).toMatchObject({ result: "failed", snapshot: { fetchedAt: T0, count: 1, items: [item(1)] }, error: { class: "platform_blocked" } });
    expect(blocked.error?.action).toBeUndefined();
    expect(bilibili.calls).toHaveLength(2);
    time.now += DANMAKU_FETCH_COOLDOWN_MS;
    const unexpected = await fetched(id, new TypeError("boom"));
    expect(unexpected).toMatchObject({ result: "failed", error: { class: "internal" } });
    expect(JSON.stringify(unexpected.error)).not.toContain("boom");
    expect(service.get(ALICE, id).snapshot?.items).toEqual([item(1)]);
  });

  it("failed without any earlier snapshot answers without one", async () => {
    const id = bilibiliContent();
    expect(await fetched(id, amberError("source_unreachable", "down"))).toEqual({ result: "failed", error: expect.objectContaining({ class: "source_unreachable" }) });
    expect(service.get(ALICE, id)).toEqual({ supported: true });
  });

  it("refuses an unsupported Content, an unknown one and another owner's without sending anything", async () => {
    expect((await failure(service.fetch(ALICE, content({ kind: "local" })))).code).toBe("invalid_request.danmaku_unsupported");
    expect((await failure(service.fetch(ALICE, content({ kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=abc", platformContentId: "abc" })))).code).toBe(
      "invalid_request.danmaku_unsupported",
    );
    expect((await failure(service.fetch(ALICE, "missing"))).class).toBe("not_found");
    expect((await failure(service.fetch(BOB, bilibiliContent()))).class).toBe("not_found");
    expect(bilibili.calls).toEqual([]);
  });

  it("merges concurrent requests for one Content into one", async () => {
    const id = bilibiliContent();
    const first = service.fetch(ALICE, id);
    const second = service.fetch(ALICE, id);
    await settle();
    expect(bilibili.calls).toHaveLength(1);
    bilibili.answer({ items: [item(1)], truncated: false });
    expect(await second).toEqual(await first);
    expect((await first).result).toBe("fetched");
  });

  it("refuses a new request within the cooldown of the last one sent, failed ones included", async () => {
    const id = bilibiliContent();
    await fetched(id, amberError("source_unreachable", "down"));
    time.now += 10_000;
    const refused = await failure(service.fetch(ALICE, id));
    expect(refused).toMatchObject({ class: "rate_limited", code: "rate_limited.danmaku_cooldown", details: { retryAfterMs: DANMAKU_FETCH_COOLDOWN_MS - 10_000 } });
    expect(bilibili.calls).toHaveLength(1);
    // Another Content is not held back.
    const other = bilibiliContent("3003");
    expect((await fetched(other, { items: [], truncated: false })).result).toBe("empty");
    time.now = T0 + DANMAKU_FETCH_COOLDOWN_MS;
    expect((await fetched(id, { items: [item(1)], truncated: false })).result).toBe("fetched");
  });

  it("writes nothing when the Content's part changed while the request was out", async () => {
    const id = bilibiliContent();
    const pending = service.fetch(ALICE, id);
    await settle();
    db.prepare("UPDATE content SET platform_part_id = '2002' WHERE id = ?").run(id);
    bilibili.answer({ items: [item(1)], truncated: false });
    expect(await pending).toMatchObject({ result: "failed", error: { class: "conflict" } });
    expect(repository.withTransaction((scope) => scope.danmaku.get("alice", id))).toBeUndefined();
  });

  it("is not_found and writes nothing when the Content went to the trash meanwhile", async () => {
    const id = bilibiliContent();
    const pending = service.fetch(ALICE, id);
    await settle();
    repository.withTransaction((scope) => scope.contents.trash("alice", id, T0));
    bilibili.answer({ items: [item(1)], truncated: false });
    expect((await failure(pending)).class).toBe("not_found");
    expect(repository.withTransaction((scope) => scope.danmaku.get("alice", id))).toBeUndefined();
  });

  it("gives up after the danmaku timeout, aborting the request, and keeps the old snapshot", async () => {
    const id = bilibiliContent();
    await fetched(id, { items: [item(1)], truncated: false });
    time.now += DANMAKU_FETCH_COOLDOWN_MS;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = service.fetch(ALICE, id);
    await vi.advanceTimersByTimeAsync(DANMAKU_FETCH_TIMEOUT_MS - 1);
    expect(bilibili.calls[1]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(bilibili.calls[1]?.signal.aborted).toBe(true);
    expect(await pending).toMatchObject({ result: "failed", error: { class: "source_unreachable" }, snapshot: { count: 1 } });
    expect(bilibili.calls).toHaveLength(2);
  });

  it("lets a caller stop waiting while the request goes on and its answer is stored", async () => {
    const id = bilibiliContent();
    const caller = new AbortController();
    const pending = service.fetch(ALICE, id, caller.signal);
    await settle();
    caller.abort(new Error("gone"));
    await expect(pending).rejects.toThrow("gone");
    expect(bilibili.calls[0]?.signal.aborted).toBe(false);
    bilibili.answer({ items: [item(1)], truncated: false });
    await settle();
    expect(service.get(ALICE, id).snapshot?.count).toBe(1);
  });
});

/** The detail's danmaku summary, read the way the Content detail reads it. */
function summary(contentId: string) {
  return repository.withTransaction((scope) => service.summaryIn(scope, "alice", scope.contents.get("alice", contentId) as Content));
}
