import { afterEach, describe, expect, it, vi } from "vitest";
import { COVER_FETCH_CONCURRENCY, COVER_FETCH_TIMEOUT_MS, COVER_FETCH_USER_CONCURRENCY, COVER_FETCH_USER_PER_MIN } from "../../../src/shared/defaults.ts";
import { PerMinuteLimiter, type CoverDownloadRequest } from "../../../src/server/application/cover-fetch-coordinator.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import { coverRig, rigContent, type RigCoverCall } from "../../fixtures/platform/covers.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { insertRow } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const created of open.splice(0)) await created.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

/** Lets pending promise callbacks and file writes run. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const BYTES = Buffer.from("cover-bytes");

/**
 * Answers downloads as they start until `total` have been answered, checking that no more than
 * `limit` ever run at once. A queued download starts only after an earlier one has really ended,
 * file writes included, so each round waits for the next to appear.
 */
async function answerAll(calls: RigCoverCall[], total: number, limit: number): Promise<void> {
  let answered = 0;
  while (answered < total) {
    await vi.waitFor(() => expect(calls.some((call) => !call.settled)).toBe(true));
    const pending = calls.filter((call) => !call.settled);
    expect(pending.length).toBeLessThanOrEqual(limit);
    for (const call of pending) call.answer(BYTES);
    answered += pending.length;
  }
}

function request(id: string, url: string, overrides: Partial<CoverDownloadRequest> = {}): CoverDownloadRequest {
  return { ownerUserId: LOCAL.userId, contentId: id, platform: "bilibili", coverUrl: url, priority: "queued", signal: new AbortController().signal, ...overrides };
}

async function failureOf(promise: Promise<unknown>): Promise<{ class: string; code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("CoverFetchCoordinator sharing", () => {
  it("downloads once for concurrent callers of one user, Content and link, and gives each the result", async () => {
    const h = harness();
    const { coordinator, calls } = coverRig(h);
    const id = rigContent(h);
    const url = `https://img.example.com/${id}.jpg`;
    const waits = [
      coordinator.download(request(id, url)),
      coordinator.download(request(id, url)),
      coordinator.download(request(id, url, { priority: "manual" })),
    ];
    await settle();
    expect(calls).toHaveLength(1);
    calls[0]?.answer(BYTES);
    const images = await Promise.all(waits);
    expect(new Set(images.map((image) => image.sha256)).size).toBe(1);
    expect(Buffer.from(images[0]?.bytes ?? []).equals(BYTES)).toBe(true);

    // Another link, Content or user is another download.
    const other = rigContent(h);
    const separate = [
      coordinator.download(request(id, `${url}?v=2`)),
      coordinator.download(request(other, url)),
      coordinator.download(request(id, url, { ownerUserId: BOB.userId })),
    ];
    await settle();
    expect(calls).toHaveLength(4);
    for (const call of calls.slice(1)) call.answer(BYTES);
    await Promise.all(separate);
    // Once settled, the same key downloads afresh.
    const again = coordinator.download(request(id, url));
    await settle();
    expect(calls).toHaveLength(5);
    calls[4]?.answer(BYTES);
    await again;
  });
});

describe("CoverFetchCoordinator lifecycles and slots", () => {
  it("keeps the download running while one caller remains and cancels it once every caller has gone", async () => {
    const h = harness();
    const { coordinator, calls } = coverRig(h);
    const id = rigContent(h);
    const url = "https://img.example.com/a.jpg";
    const [first, second] = [new AbortController(), new AbortController()];
    const one = coordinator.download(request(id, url, { signal: first.signal }));
    const two = coordinator.download(request(id, url, { signal: second.signal }));
    await settle();
    first.abort(new Error("first left"));
    await expect(one).rejects.toThrow("first left");
    await settle();
    expect(calls[0]?.signal.aborted).toBe(false);
    second.abort(new Error("second left"));
    await expect(two).rejects.toThrow("second left");
    await settle();
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it("holds the slot until the underlying work has ended, not when its caller gives up", async () => {
    const h = harness();
    // A download that does not watch its signal: it ends only when the test answers it.
    const { coordinator, calls } = coverRig(h, { honourSignal: false });
    const ids = [rigContent(h), rigContent(h), rigContent(h)];
    const callers = ids.slice(0, COVER_FETCH_USER_CONCURRENCY).map(() => new AbortController());
    const waits = callers.map((caller, index) => coordinator.download(request(ids[index] as string, "https://img.example.com/x.jpg", { signal: caller.signal })));
    await settle();
    expect(calls).toHaveLength(COVER_FETCH_USER_CONCURRENCY);
    for (const caller of callers) caller.abort(new Error("gone"));
    for (const wait of waits) await expect(wait).rejects.toThrow("gone");
    // Every caller has gone and the work is cancelled, but it has not ended: the slots stay taken.
    expect(coordinator.userSlotsInUse(LOCAL.userId)).toBe(COVER_FETCH_USER_CONCURRENCY);
    expect(await failureOf(coordinator.download(request(ids[2] as string, "https://img.example.com/y.jpg", { priority: "manual" })))).toMatchObject({
      code: "conflict.cover_fetch_busy",
    });
    calls[0]?.answer(BYTES);
    await vi.waitFor(() => expect(coordinator.userSlotsInUse(LOCAL.userId)).toBe(COVER_FETCH_USER_CONCURRENCY - 1));
    const manual = coordinator.download(request(ids[2] as string, "https://img.example.com/y.jpg", { priority: "manual" }));
    await settle();
    calls.at(-1)?.answer(BYTES);
    await manual;
  });

  it("runs at most the user's slots at once and queues the rest, and refuses a manual fetch at once when they are taken", async () => {
    const h = harness();
    const { coordinator, calls } = coverRig(h);
    const ids = Array.from({ length: COVER_FETCH_USER_CONCURRENCY + 2 }, () => rigContent(h));
    const waits = ids.map((id) => coordinator.download(request(id, `https://img.example.com/${id}.jpg`)));
    await settle();
    expect(calls).toHaveLength(COVER_FETCH_USER_CONCURRENCY);
    const manual = await failureOf(coordinator.download(request(rigContent(h), "https://img.example.com/m.jpg", { priority: "manual" })));
    expect(manual).toMatchObject({ class: "conflict", code: "conflict.cover_fetch_busy" });
    // Joining a queued download needs a free slot too.
    expect(await failureOf(coordinator.download(request(ids.at(-1) as string, `https://img.example.com/${ids.at(-1)}.jpg`, { priority: "manual" })))).toMatchObject({
      code: "conflict.cover_fetch_busy",
    });
    // Joining a running one does not.
    const joined = coordinator.download(request(ids[0] as string, `https://img.example.com/${ids[0]}.jpg`, { priority: "manual" }));
    await answerAll(calls, ids.length, COVER_FETCH_USER_CONCURRENCY);
    await Promise.all([...waits, joined]);
    expect(calls).toHaveLength(ids.length);
  });

  it("never runs more than the instance's slots across users", async () => {
    const h = harness();
    const users = ["u1", "u2", "u3"];
    for (const id of users) insertRow(h.db, "user", { id, role: "user", status: "active", created_at: 1 });
    const { coordinator, calls } = coverRig(h, { coordinator: { globalSlots: new FairSemaphore(() => COVER_FETCH_CONCURRENCY) } });
    const waits = users.flatMap((owner) =>
      Array.from({ length: COVER_FETCH_USER_CONCURRENCY }, () => {
        const id = rigContent(h, { owner });
        return coordinator.download(request(id, `https://img.example.com/${id}.jpg`, { ownerUserId: owner }));
      }),
    );
    await settle();
    expect(calls).toHaveLength(Math.min(COVER_FETCH_CONCURRENCY, users.length * COVER_FETCH_USER_CONCURRENCY));
    // Fair across users: nobody holds more than their share while others wait.
    expect(new Set(calls.map((call) => call.url)).size).toBe(calls.length);
    await answerAll(calls, waits.length, COVER_FETCH_CONCURRENCY);
    await Promise.all(waits);
    expect(calls).toHaveLength(users.length * COVER_FETCH_USER_CONCURRENCY);
  });

  it("bounds a manual caller's whole wait, queue included, and the download's own run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    // One instance slot, held by another user's download that never ends.
    const { coordinator, calls } = coverRig(h, { coordinator: { globalSlots: new FairSemaphore(() => 1) } });
    const bobs = rigContent(h, { owner: BOB.userId });
    void coordinator.download(request(bobs, "https://img.example.com/b.jpg", { ownerUserId: BOB.userId })).catch(() => undefined);
    await settle();
    expect(calls).toHaveLength(1);
    const manual = coordinator.download(request(rigContent(h), "https://img.example.com/m.jpg", { priority: "manual", waitTimeoutMs: COVER_FETCH_TIMEOUT_MS }));
    const outcome = failureOf(manual);
    await vi.advanceTimersByTimeAsync(COVER_FETCH_TIMEOUT_MS - 1);
    await settle();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(COVER_FETCH_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ class: "source_unreachable" });
  });
});

describe("PerMinuteLimiter", () => {
  it("allows the limit within a sliding minute and says how long until the next", async () => {
    let now = 1_000_000;
    const limiter = new PerMinuteLimiter(COVER_FETCH_USER_PER_MIN, { now: () => now });
    for (let i = 0; i < COVER_FETCH_USER_PER_MIN; i += 1) {
      expect(limiter.tryTake("u")).toEqual({ ok: true });
      now += 100;
    }
    const refused = limiter.tryTake("u");
    expect(refused).toEqual({ ok: false, retryAfterMs: 60_000 - COVER_FETCH_USER_PER_MIN * 100 });
    expect(limiter.tryTake("other")).toEqual({ ok: true });
    now = 1_000_000 + 60_000;
    expect(limiter.tryTake("u")).toEqual({ ok: true });
  });

  it("waits for the next allowance through its sleep", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new PerMinuteLimiter(1, {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    await limiter.take("u", new AbortController().signal);
    await limiter.take("u", new AbortController().signal);
    expect(slept).toEqual([60_000]);
  });
});
