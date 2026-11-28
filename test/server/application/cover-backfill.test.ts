import { afterEach, describe, expect, it, vi } from "vitest";
import { COVER_BACKFILL_INTERVAL_MS, COVER_BACKFILL_MAX_ITEMS } from "../../../src/shared/defaults.ts";
import type { CoverBackfillStatusDto } from "../../../src/shared/dto/cover-backfill.ts";
import type { CoverBackfillItemResult } from "../../../src/server/application/content-covers.ts";
import { coverBackfillFailureReason, CoverBackfillService, type CoverBackfillServiceOptions } from "../../../src/server/application/cover-backfill.ts";
import { AmberError, amberError, appError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { upstreamHttpStatus } from "../../../src/server/ports/upstream-status.ts";
import { createAdmin } from "../../fixtures/pipeline/admin.ts";
import { coverRig, rigContent, type CoverRigOptions } from "../../fixtures/platform/covers.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const IMAGE = Buffer.from("cover-image");
const STALE = (status: number) => new AmberError(appError("source_unreachable"), `media request answered HTTP ${status}`, { cause: upstreamHttpStatus(status) });

interface Setup {
  h: Harness;
  backfill: CoverBackfillService;
  slept: number[];
  rig: ReturnType<typeof coverRig>;
}

function setup(options: { rig?: CoverRigOptions; backfill?: Partial<CoverBackfillServiceOptions>; onSleep?: () => void } = {}): Setup {
  const h = createHarness();
  open.push(h);
  const slept: number[] = [];
  const rig = coverRig(h, options.rig);
  const backfill = new CoverBackfillService({
    repository: h.repository,
    covers: rig.covers,
    disk: h.disk,
    settings: h.settings,
    newId: h.newId,
    sleep: async (ms, signal) => {
      slept.push(ms);
      options.onSleep?.();
      signal.throwIfAborted();
    },
    ...options.backfill,
  });
  return { h, backfill, slept, rig };
}

/** Polls until the caller's job has finished. */
async function finished(backfill: CoverBackfillService, principal = LOCAL): Promise<CoverBackfillStatusDto> {
  let status = backfill.status(principal);
  await vi.waitFor(() => {
    status = backfill.status(principal);
    expect(["running", "stopping"]).not.toContain(status.job?.state);
  });
  return status;
}

async function failureOf(work: () => unknown): Promise<{ class: string; code: string }> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

const versionOf = (h: Harness, id: string) => h.repository.withTransaction((scope) => scope.contents.getIncludingTrashed(LOCAL.userId, id))?.coverImageVersion;

describe("backfill candidates and cursor", () => {
  it("takes only the caller's platform Contents outside the trash with a link and no copy, in ascending id", async () => {
    const { h, backfill, rig } = setup({ rig: { auto: () => IMAGE } });
    const ids = [rigContent(h), rigContent(h, { platform: "youtube" }), rigContent(h, { platform: "douyin" })];
    rigContent(h, { coverUrl: null });
    const trashed = rigContent(h);
    h.trash.trash(LOCAL, trashed);
    const withCopy = rigContent(h);
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, withCopy, { bytes: new Uint8Array([1]), width: 1, height: 1, sha256: "ab".repeat(32) }, 1));
    rigContent(h, { owner: BOB.userId });
    expect(backfill.status(LOCAL)).toEqual({ candidates: 3 });
    backfill.start(LOCAL, { mode: "stored" });
    const status = await finished(backfill);
    expect(rig.calls.map((call) => call.url)).toEqual(ids.map((id) => `https://img.example.com/${id}.jpg`));
    expect(status).toMatchObject({ candidates: 0, job: { mode: "stored", state: "completed", total: 3, processed: 3, saved: 3, skipped: 0, failed: {}, remaining: 0 } });
    for (const id of ids) expect(versionOf(h, id)).toBe(1);
    expect(backfill.status(BOB)).toEqual({ candidates: 1 });
  });

  it("stops at the item limit with what remains, continues after the cursor, and leaves failures to retry", async () => {
    const h = createHarness();
    open.push(h);
    const ids: string[] = [];
    h.repository.withTransaction((scope) => {
      for (let i = 0; i < COVER_BACKFILL_MAX_ITEMS + 3; i += 1) {
        const id = `c${String(i).padStart(6, "0")}`;
        ids.push(id);
        scope.contents.insert({
          id,
          userId: LOCAL.userId,
          source: { kind: "bilibili", platformContentId: `BV${id}` },
          coverUrl: `https://img.example.com/${id}.jpg`,
          processingStatus: "succeeded",
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    const seen: string[] = [];
    // Fails the first item temporarily, stores every other one.
    const covers = {
      backfillOne: async (owner: string, contentId: string): Promise<CoverBackfillItemResult> => {
        seen.push(contentId);
        if (contentId === ids[0]) return { outcome: "failed", downloaded: true, platform: "bilibili", error: amberError("source_unreachable", "offline"), staleLink: false, refreshable: false };
        h.repository.withTransaction((scope) => scope.contentCovers.put(owner, contentId, { bytes: new Uint8Array([1]), width: 1, height: 1, sha256: "ab".repeat(32) }, 1));
        return { outcome: "saved", downloaded: true };
      },
    };
    const backfill = new CoverBackfillService({ repository: h.repository, covers, disk: h.disk, settings: h.settings, sleep: async () => undefined });
    backfill.start(LOCAL, { mode: "stored" });
    const first = await finished(backfill);
    expect(first.job).toMatchObject({
      state: "completed",
      total: COVER_BACKFILL_MAX_ITEMS,
      processed: COVER_BACKFILL_MAX_ITEMS,
      remaining: 3,
      nextAfterId: ids[COVER_BACKFILL_MAX_ITEMS - 1],
      failed: { platform_unreachable: 1 },
      retryable: 1,
    });
    expect(seen).toEqual(ids.slice(0, COVER_BACKFILL_MAX_ITEMS));
    const firstJob = first.job?.id as string;

    seen.length = 0;
    backfill.start(LOCAL, { mode: "stored", afterId: first.job?.nextAfterId as string });
    const second = await finished(backfill);
    // The failure stays behind the cursor.
    expect(seen).toEqual(ids.slice(COVER_BACKFILL_MAX_ITEMS));
    expect(second.job).toMatchObject({ total: 3, saved: 3, remaining: 0, retryable: 0 });
    // The earlier job was replaced, so its id is no longer the caller's.
    expect(await failureOf(() => backfill.start(LOCAL, { mode: "retry", jobId: firstJob }))).toMatchObject({ class: "not_found" });
  });
});

describe("backfill execution", () => {
  it("re-checks each item, spaces downloads apart, and skips a platform's rest once it refuses", async () => {
    const refused = amberError("platform_blocked", "visitor refused", { code: "platform_blocked.visitor_refused" });
    const { h, backfill, slept, rig } = setup({ rig: { auto: (_url, platform) => (platform === "douyin" ? refused : IMAGE) } });
    const [a, gotCopy, b, trashed, deleted, d1, d2, c] = [
      rigContent(h),
      rigContent(h),
      rigContent(h),
      rigContent(h),
      rigContent(h),
      rigContent(h, { platform: "douyin" }),
      rigContent(h, { platform: "douyin" }),
      rigContent(h, { platform: "youtube" }),
    ];
    backfill.start(LOCAL, { mode: "stored" });
    // Meanwhile the job is underway: one gets a copy, one goes to the trash, one is deleted.
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, gotCopy, { bytes: new Uint8Array([7]), width: 1, height: 1, sha256: "cd".repeat(32) }, 1));
    h.trash.trash(LOCAL, trashed);
    h.repository.withTransaction((scope) => scope.contents.delete(LOCAL.userId, deleted));
    const status = await finished(backfill);
    expect(status.job).toMatchObject({ state: "completed", total: 8, processed: 8, saved: 3, skipped: 4, failed: { platform_refused: 1 }, retryable: 2 });
    expect(rig.calls.map((call) => call.url)).toEqual([a, b, d1, c].map((id) => `https://img.example.com/${id}.jpg`));
    expect(versionOf(h, gotCopy)).toBe(1);
    expect(versionOf(h, d2)).toBeUndefined();
    // One pause after each download but the last item's, none after a skipped item.
    expect(slept).toEqual([COVER_BACKFILL_INTERVAL_MS, COVER_BACKFILL_INTERVAL_MS, COVER_BACKFILL_INTERVAL_MS]);
  });

  it("spaces consecutive downloads at least the interval apart on a real timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = createHarness();
      open.push(h);
      const rig = coverRig(h, { auto: () => IMAGE });
      const started: number[] = [];
      let clock = 0;
      const adapter: PlatformSourceAdapter = h.platforms.bilibili;
      const original = adapter.fetchCover?.bind(adapter);
      Object.assign(adapter, {
        fetchCover: (...args: Parameters<NonNullable<PlatformSourceAdapter["fetchCover"]>>) => {
          started.push(clock);
          return original?.(...args);
        },
      });
      const backfill = new CoverBackfillService({ repository: h.repository, covers: rig.covers, disk: h.disk, settings: h.settings });
      for (let i = 0; i < 3; i += 1) rigContent(h);
      backfill.start(LOCAL, { mode: "stored" });
      // The fake clock moves in quarter steps; between steps the downloads' file writes may finish.
      for (let step = 0; step < 400 && backfill.status(LOCAL).job?.state === "running"; step += 1) {
        await vi.advanceTimersByTimeAsync(COVER_BACKFILL_INTERVAL_MS / 4);
        clock += COVER_BACKFILL_INTERVAL_MS / 4;
        for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
      }
      expect(backfill.status(LOCAL).job?.state).toBe("completed");
      expect(started).toHaveLength(3);
      for (let i = 1; i < started.length; i += 1) expect((started[i] as number) - (started[i - 1] as number)).toBeGreaterThanOrEqual(COVER_BACKFILL_INTERVAL_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends as aborted_disk below the low-water mark, with the unprocessed count", async () => {
    let downloads = 0;
    const s = setup({
      rig: {
        auto: () => {
          downloads += 1;
          return IMAGE;
        },
      },
      onSleep: () => {
        if (downloads === 2) s.h.disk.low();
      },
    });
    const ids = Array.from({ length: 5 }, () => rigContent(s.h));
    s.backfill.start(LOCAL, { mode: "stored" });
    const status = await finished(s.backfill);
    expect(status.job).toMatchObject({ state: "aborted_disk", total: 5, processed: 2, saved: 2, remaining: 3, nextAfterId: ids[1] });
    s.h.disk.plenty();
    s.backfill.start(LOCAL, { mode: "stored", afterId: status.job?.nextAfterId as string });
    expect((await finished(s.backfill)).job).toMatchObject({ state: "completed", total: 3, saved: 3 });
  });
});

describe("backfill lifecycle and ownership", () => {
  it("stops after the current item, keeping what it saved; one job per user; a running one cannot be closed", async () => {
    const { h, backfill, rig } = setup();
    const ids = Array.from({ length: 3 }, () => rigContent(h));
    const started = backfill.start(LOCAL, { mode: "stored" });
    const jobId = started.job?.id as string;
    await vi.waitFor(() => expect(rig.calls).toHaveLength(1));
    expect(await failureOf(() => backfill.start(LOCAL, { mode: "stored" }))).toMatchObject({ code: "conflict.cover_backfill_active" });
    expect(await failureOf(() => backfill.remove(LOCAL, jobId))).toMatchObject({ code: "conflict.cover_backfill_active" });
    expect(backfill.cancel(LOCAL, jobId).job?.state).toBe("stopping");
    expect(await failureOf(() => backfill.start(LOCAL, { mode: "stored" }))).toMatchObject({ code: "conflict.cover_backfill_active" });
    rig.calls[0]?.answer(IMAGE);
    const stopped = await finished(backfill);
    expect(stopped.job).toMatchObject({ state: "stopped", processed: 1, saved: 1, remaining: 2, nextAfterId: ids[0] });
    expect(rig.calls).toHaveLength(1);
    expect(versionOf(h, ids[0] as string)).toBe(1);
    // Another user's view of the same id is unknown.
    for (const work of [() => backfill.cancel(BOB, jobId), () => backfill.remove(BOB, jobId), () => backfill.start(BOB, { mode: "retry", jobId })]) {
      expect(await failureOf(work)).toMatchObject({ class: "not_found" });
    }
    expect(backfill.status(BOB)).toEqual({ candidates: 0 });
    expect(backfill.remove(LOCAL, jobId)).toEqual({ candidates: 2 });
    expect(await failureOf(() => backfill.remove(LOCAL, jobId))).toMatchObject({ class: "not_found" });
  });

  it("abandons and forgets a deleted user's job", async () => {
    const { h, backfill, rig } = setup();
    rigContent(h, { owner: BOB.userId });
    backfill.start(BOB, { mode: "stored" });
    await vi.waitFor(() => expect(rig.calls).toHaveLength(1));
    const { admin } = createAdmin(h, { coverBackfill: backfill });
    await admin.deleteUser(LOCAL, BOB.userId);
    expect(rig.calls[0]?.signal.aborted).toBe(true);
    expect(backfill.status(BOB)).toEqual({ candidates: 0 });
  });
});

describe("backfill failures, retry and refresh", () => {
  it("groups failures by reason", () => {
    const cases: Array<[unknown, boolean, string]> = [
      [STALE(404), true, "link_expired"],
      [amberError("source_unreachable", "offline"), false, "platform_unreachable"],
      [amberError("platform_blocked", "refused"), false, "platform_refused"],
      [amberError("invalid_request", "bad image", { code: "invalid_request.figure_image", details: { reason: "corrupt" } }), false, "image_rejected"],
      [amberError("media_too_large", "too big"), false, "image_rejected"],
      [amberError("network_proxy_failed", "proxy down"), false, "proxy_unavailable"],
      [amberError("network_proxy_unsupported", "pac"), false, "proxy_unavailable"],
      [amberError("disk_low", "full"), false, "disk_low"],
      [new Error("socket hang up"), false, "platform_unreachable"],
    ];
    for (const [error, stale, reason] of cases) expect([reason, coverBackfillFailureReason(error, stale)]).toEqual([reason, reason]);
  });

  it("retries only temporary failures, and refreshes only stale links of platforms that can re-read them", async () => {
    let offline = true;
    const { h, backfill, rig } = setup({
      rig: {
        refreshable: ["xiaohongshu", "douyin"],
        refreshAnswer: (platformId) => `https://img.example.com/fresh-${platformId}.jpg`,
        auto: (url) => {
          if (url.includes("fresh-")) return IMAGE;
          if (url.includes("/gone-")) return STALE(404);
          if (url.includes("/bad-")) return amberError("invalid_request", "bad image", { code: "invalid_request.figure_image", details: { reason: "corrupt" } });
          if (url.includes("/flaky-") && offline) return amberError("source_unreachable", "offline");
          return IMAGE;
        },
      },
    });
    const ok = rigContent(h);
    const flaky = rigContent(h, { coverUrl: "https://img.example.com/flaky-1.jpg" });
    const bad = rigContent(h, { coverUrl: "https://img.example.com/bad-1.jpg" });
    const goneXhs = rigContent(h, { platform: "xiaohongshu", coverUrl: "https://img.example.com/gone-1.jpg" });
    const goneBili = rigContent(h, { coverUrl: "https://img.example.com/gone-2.jpg" });
    backfill.start(LOCAL, { mode: "stored" });
    const first = await finished(backfill);
    expect(first.job).toMatchObject({ saved: 1, failed: { link_expired: 2, platform_unreachable: 1, image_rejected: 1 }, retryable: 1, refreshable: 1 });
    expect(rig.refreshes).toEqual([]);

    offline = false;
    rig.calls.length = 0;
    backfill.start(LOCAL, { mode: "retry", jobId: first.job?.id as string });
    const retried = await finished(backfill);
    expect(rig.calls.map((call) => call.url)).toEqual(["https://img.example.com/flaky-1.jpg"]);
    expect(retried.job).toMatchObject({ mode: "retry", total: 1, saved: 1, retryable: 0, refreshable: 0 });
    // Retrying keeps the place where stored jobs continue.
    expect(retried.job?.nextAfterId).toBe(first.job?.nextAfterId);

    // The retry job is now the caller's job; refresh takes up its stale links, of which it has none.
    backfill.start(LOCAL, { mode: "refresh", jobId: retried.job?.id as string });
    expect((await finished(backfill)).job).toMatchObject({ mode: "refresh", total: 0 });

    // A fresh stored pass meets the stale ones again; refresh then re-reads the one platform that can.
    backfill.remove(LOCAL, backfill.status(LOCAL).job?.id as string);
    backfill.start(LOCAL, { mode: "stored" });
    const again = await finished(backfill);
    expect(again.job).toMatchObject({ refreshable: 1, failed: { link_expired: 2, image_rejected: 1 } });
    backfill.start(LOCAL, { mode: "refresh", jobId: again.job?.id as string });
    const refreshed = await finished(backfill);
    expect(rig.refreshes).toEqual([`xiaohongshu-${goneXhs}`]);
    expect(refreshed.job).toMatchObject({ mode: "refresh", total: 1, saved: 1 });
    expect(versionOf(h, goneXhs)).toBe(1);
    for (const id of [goneBili, bad]) expect(versionOf(h, id)).toBeUndefined();
    expect([versionOf(h, ok), versionOf(h, flaky)]).toEqual([1, 1]);
  });

  it("needs the caller's current job for retry and refresh", async () => {
    const { backfill } = setup();
    expect(await failureOf(() => backfill.start(LOCAL, { mode: "retry", jobId: "01JNOTAJOB" }))).toMatchObject({ class: "not_found" });
    expect(await failureOf(() => backfill.start(LOCAL, { mode: "refresh" }))).toMatchObject({ class: "invalid_request" });
  });
});
