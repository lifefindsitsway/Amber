import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentDescriptionService } from "../../../src/server/application/content-description.ts";
import { DescriptionClock } from "../../../src/server/domain/content-description.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { StageExecutionContext } from "../../../src/server/pipeline/executor.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import { SourceStageExecutor } from "../../../src/server/pipeline/stages/source.ts";
import type { PlatformContentRef, PlatformCredential, PlatformDescription, PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { CONTENT_DESCRIPTION_MAX_CHARS, PLATFORM_METADATA_TIMEOUT_MS } from "../../../src/shared/defaults.ts";
import { contentDescriptionFetchDtoSchema } from "../../../src/shared/dto/content.ts";
import { BOB, createHarness, createLocalContent, gate, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of open.splice(0)) await h.close();
});

const T = 1_790_000_000_000;
const UPDATED_AT = 1_000;

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

interface Setup {
  h: Harness;
  service: ContentDescriptionService;
  clock: DescriptionClock;
  /** The service's `now`, also the clock's source unless `clock` is set; tests move them. */
  time: { now: number; clock?: number };
  heavyKeys: string[];
}

function setup(options: { heavyLimit?: number; h?: Harness } = {}): Setup {
  const h = options.h ?? harness();
  const time: { now: number; clock?: number } = { now: T };
  const clock = new DescriptionClock(() => time.clock ?? time.now);
  const heavyKeys: string[] = [];
  const semaphore = options.heavyLimit === undefined ? undefined : new FairSemaphore(() => options.heavyLimit as number);
  const service = new ContentDescriptionService({
    repository: h.repository,
    platforms: h.platformAccess,
    descriptionClock: clock,
    details: h.contents,
    now: () => time.now,
    ...(semaphore === undefined ? {} : { heavy: { run: (ref, signal, work) => (heavyKeys.push(ref.key), semaphore.run(ref, signal, work)) } }),
  });
  return { h, service, clock, time, heavyKeys };
}

let bvCounter = 0;

/** A bilibili Content of `userId` on its own BV id (a platform identity is unique per user). */
function bilibiliContent(h: Harness, userId = LOCAL.userId): { contentId: string; bvid: string } {
  bvCounter += 1;
  const bvid = `BV1desc${String(bvCounter).padStart(5, "0")}`;
  const contentId = h.newId();
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id: contentId,
      userId,
      source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${bvid}?p=2`, platformContentId: bvid, platformPartId: `${bvid}-cid2` },
      title: "Lecture",
      processingStatus: "succeeded",
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    }),
  );
  return { contentId, bvid };
}

const contentOf = (h: Harness, contentId: string, userId = LOCAL.userId) => h.repository.withTransaction((scope) => scope.contents.getIncludingTrashed(userId, contentId));

function stored(h: Harness, contentId: string) {
  const content = contentOf(h, contentId);
  return { description: content?.description, truncated: content?.descriptionTruncated, checkedAt: content?.descriptionCheckedAt };
}

function descriptionCalls(h: Harness): string[] {
  return [...h.platforms.bilibili.calls, ...h.platforms.youtube.calls].filter((call) => call.method === "fetchDescription").map((call) => call.target);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

async function classOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await failure(promise);
  return isAmberError(error) ? error.appError.class : `not an AmberError: ${String(error)}`;
}

/** Replaces the bilibili adapter's description read with one the test controls; records each call's signal. */
function scriptedRead(h: Harness): {
  signals: AbortSignal[];
  answer: (description: PlatformDescription) => void;
  fail: (error: Error) => void;
} {
  const signals: AbortSignal[] = [];
  const pending: Array<{ resolve: (value: PlatformDescription) => void; reject: (error: Error) => void }> = [];
  // Typed as the port: the fake's own method ignores the signal this one records.
  const adapter: PlatformSourceAdapter = h.platforms.bilibili;
  adapter.fetchDescription = (ref: PlatformContentRef, _auth: PlatformCredential | undefined, signal: AbortSignal) => {
    h.platforms.bilibili.calls.push({ method: "fetchDescription", target: ref.platformContentId, withAuth: false });
    signals.push(signal);
    return new Promise<PlatformDescription>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    signals,
    answer: (description) => {
      for (const entry of pending.splice(0)) entry.resolve(description);
    },
    fail: (error) => {
      for (const entry of pending.splice(0)) entry.reject(error);
    },
  };
}

const signal = () => new AbortController().signal;

describe("ContentDescriptionService: which Contents", () => {
  it("refuses a local Content like the cache check, without asking any platform", async () => {
    const { h, service } = setup();
    const contentId = createLocalContent(h);
    const error = await failure(service.fetch(LOCAL, contentId, signal()));
    expect(isAmberError(error) && error.appError).toMatchObject({ class: "invalid_request", code: "invalid_request" });
    expect(descriptionCalls(h)).toEqual([]);
  });

  it("answers not_found for a missing Content, one in the trash and another user's, without asking any platform", async () => {
    const { h, service } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "text" } });
    expect(await classOf(service.fetch(LOCAL, "missing", signal()))).toBe("not_found");
    expect(await classOf(service.fetch(BOB, contentId, signal()))).toBe("not_found");
    h.trash.trash(LOCAL, contentId);
    expect(await classOf(service.fetch(LOCAL, contentId, signal()))).toBe("not_found");
    expect(descriptionCalls(h)).toEqual([]);
    expect(stored(h, contentId)).toEqual({ description: undefined, truncated: undefined, checkedAt: undefined });
  });

  it("does not let another user's read touch or reveal the owner's Content", async () => {
    const { h, service } = setup();
    const mine = bilibiliContent(h);
    const theirs = bilibiliContent(h, BOB.userId);
    h.platforms.bilibili.video(theirs.bvid, { description: { state: "found", text: "bob's" } });
    const answer = await service.fetch(BOB, theirs.contentId, signal());
    expect(answer.content.id).toBe(theirs.contentId);
    expect(answer.content.description).toBe("bob's");
    expect(stored(h, mine.contentId).checkedAt).toBeUndefined();
  });
});

describe("ContentDescriptionService: outcomes", () => {
  it("stores found text with the time the request was sent and answers the detail, leaving updatedAt alone", async () => {
    const { h, service, time } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "简介\n第二行" } });
    const answer = await service.fetch(LOCAL, contentId, signal());
    expect(contentDescriptionFetchDtoSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({ result: "found", content: { id: contentId, description: "简介\n第二行", descriptionCheckedAt: time.now, updatedAt: UPDATED_AT, media: [] } });
    expect(answer.content).not.toHaveProperty("descriptionTruncated");
    // The video, not the part: bilibili parts share one description.
    expect(descriptionCalls(h)).toEqual([bvid]);
    expect(stored(h, contentId)).toEqual({ description: "简介\n第二行", truncated: undefined, checkedAt: T });
    expect(contentOf(h, contentId)?.updatedAt).toBe(UPDATED_AT);
    // The detail endpoint answers the same.
    expect(h.contents.get(LOCAL, contentId)).toEqual(answer.content);
  });

  it("caps a long description and says it was cut", async () => {
    const { h, service } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "a".repeat(CONTENT_DESCRIPTION_MAX_CHARS + 1) } });
    const answer = await service.fetch(LOCAL, contentId, signal());
    expect(answer.result).toBe("found");
    expect(answer.content.description).toBe("a".repeat(CONTENT_DESCRIPTION_MAX_CHARS));
    expect(answer.content.descriptionTruncated).toBe(true);
  });

  it("clears the text when the platform says there is none, and keeps it when the answer is unreadable", async () => {
    const { h, service, time } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "old" } });
    await service.fetch(LOCAL, contentId, signal());

    time.now = T + 10;
    h.platforms.bilibili.video(bvid, { description: { state: "unknown" } });
    const unknown = await service.fetch(LOCAL, contentId, signal());
    expect(unknown.result).toBe("unknown");
    expect(unknown.content).toMatchObject({ description: "old", descriptionCheckedAt: T });
    expect(stored(h, contentId)).toEqual({ description: "old", truncated: undefined, checkedAt: T });

    time.now = T + 20;
    h.platforms.bilibili.video(bvid, { description: { state: "empty" } });
    const empty = await service.fetch(LOCAL, contentId, signal());
    expect(empty.result).toBe("empty");
    expect(empty.content).not.toHaveProperty("description");
    expect(empty.content.descriptionCheckedAt).toBe(T + 20);
    expect(stored(h, contentId)).toEqual({ description: undefined, truncated: undefined, checkedAt: T + 20 });
    expect(contentOf(h, contentId)?.updatedAt).toBe(UPDATED_AT);
  });

  it("answers superseded and keeps the stored answer when a later request already settled it", async () => {
    const { h, service, time } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    // Settled by a request sent after the one this read will send (and not in the future of now).
    h.repository.withTransaction((scope) => scope.contents.setDescription(LOCAL.userId, contentId, { description: "newer", truncated: false, checkedAt: T + 50 }, T + 50));
    time.now = T + 100;
    time.clock = T;
    for (const description of [{ state: "found", text: "older" }, { state: "empty" }] as const) {
      h.platforms.bilibili.video(bvid, { description });
      const answer = await service.fetch(LOCAL, contentId, signal());
      expect(answer.result).toBe("superseded");
      expect(answer.content).toMatchObject({ description: "newer", descriptionCheckedAt: T + 50 });
    }
  });

  it("passes a platform failure on and writes nothing; the next request reads again", async () => {
    const { h, service } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { descriptionError: amberError("platform_blocked", "scripted") });
    expect(await classOf(service.fetch(LOCAL, contentId, signal()))).toBe("platform_blocked");
    expect(stored(h, contentId)).toEqual({ description: undefined, truncated: undefined, checkedAt: undefined });
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "now" } });
    expect((await service.fetch(LOCAL, contentId, signal())).result).toBe("found");
    expect(descriptionCalls(h)).toEqual([bvid, bvid]);
  });

  it("records a login the platform turns away as expired", async () => {
    const { h, service } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    h.platformAccounts.putCookies(LOCAL, "bilibili", "bili_session=<placeholder>");
    h.platforms.bilibili.video(bvid, { descriptionError: amberError("auth_required", "scripted") });
    expect(await classOf(service.fetch(LOCAL, contentId, signal()))).toBe("auth_required");
    expect(h.platforms.bilibili.calls.filter((call) => call.method === "fetchDescription").map((call) => call.withAuth)).toEqual([true]);
    expect(h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"))?.status).toBe("expired");
  });

  it("answers not_found and writes nothing when the Content goes to the trash while the request is out", async () => {
    const { h, service } = setup();
    const { contentId } = bilibiliContent(h);
    const read = scriptedRead(h);
    const pending = service.fetch(LOCAL, contentId, signal());
    await vi.waitFor(() => expect(read.signals).toHaveLength(1));
    h.trash.trash(LOCAL, contentId);
    read.answer({ state: "found", text: "late" });
    expect(await classOf(pending)).toBe("not_found");
    expect(stored(h, contentId)).toEqual({ description: undefined, truncated: undefined, checkedAt: undefined });
  });

  it("writes nothing when the Content points at another video once the answer arrives", async () => {
    const { h, service } = setup();
    const { contentId } = bilibiliContent(h);
    const read = scriptedRead(h);
    const pending = service.fetch(LOCAL, contentId, signal());
    await vi.waitFor(() => expect(read.signals).toHaveLength(1));
    h.db.prepare("UPDATE content SET platform_content_id = ? WHERE id = ?").run("BV1other00001", contentId);
    read.answer({ state: "found", text: "the old video's" });
    const answer = await pending;
    expect(answer.result).toBe("superseded");
    expect(answer.content).not.toHaveProperty("description");
    expect(stored(h, contentId)).toEqual({ description: undefined, truncated: undefined, checkedAt: undefined });
  });
});

describe("ContentDescriptionService: one read per Content", () => {
  it("lets concurrent requests for one Content share a single platform read", async () => {
    const { h, service } = setup();
    const { contentId, bvid } = bilibiliContent(h);
    const read = scriptedRead(h);
    const first = service.fetch(LOCAL, contentId, signal());
    const second = service.fetch(LOCAL, contentId, signal());
    await vi.waitFor(() => expect(read.signals).toHaveLength(1));
    read.answer({ state: "found", text: "shared" });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.result).toBe("found");
    expect(descriptionCalls(h)).toEqual([bvid]);
  });

  it("does not share a read across owners or Contents", async () => {
    const { h, service } = setup();
    const one = bilibiliContent(h);
    const two = bilibiliContent(h);
    const bobs = bilibiliContent(h, BOB.userId);
    for (const { bvid } of [one, two, bobs]) h.platforms.bilibili.video(bvid, { description: { state: "found", text: bvid } });
    const answers = await Promise.all([service.fetch(LOCAL, one.contentId, signal()), service.fetch(LOCAL, two.contentId, signal()), service.fetch(BOB, bobs.contentId, signal())]);
    expect(answers.map((answer) => answer.content.description)).toEqual([one.bvid, two.bvid, bobs.bvid]);
    expect(descriptionCalls(h).sort()).toEqual([one.bvid, two.bvid, bobs.bvid].sort());
  });

  it("lets a caller whose client went away stop waiting without stopping the read for the others", async () => {
    const { h, service } = setup();
    const { contentId } = bilibiliContent(h);
    const read = scriptedRead(h);
    const gone = new AbortController();
    const first = service.fetch(LOCAL, contentId, gone.signal);
    const second = service.fetch(LOCAL, contentId, signal());
    await vi.waitFor(() => expect(read.signals).toHaveLength(1));
    gone.abort();
    await expect(first).rejects.toBe(gone.signal.reason);
    expect(read.signals[0]?.aborted).toBe(false);
    read.answer({ state: "found", text: "still stored" });
    expect((await second).result).toBe("found");
    expect(stored(h, contentId).description).toBe("still stored");
    expect(read.signals).toHaveLength(1);
  });

  it("still stores the answer when every caller went away", async () => {
    const { h, service } = setup();
    const { contentId } = bilibiliContent(h);
    const read = scriptedRead(h);
    const gone = new AbortController();
    const only = service.fetch(LOCAL, contentId, gone.signal);
    await vi.waitFor(() => expect(read.signals).toHaveLength(1));
    gone.abort();
    await expect(only).rejects.toBe(gone.signal.reason);
    read.answer({ state: "found", text: "stored anyway" });
    await vi.waitFor(() => expect(stored(h, contentId).description).toBe("stored anyway"));
  });

  it("starts nothing for a caller already gone", async () => {
    const { h, service } = setup();
    const { contentId } = bilibiliContent(h);
    const gone = new AbortController();
    gone.abort();
    await expect(service.fetch(LOCAL, contentId, gone.signal)).rejects.toBe(gone.signal.reason);
    expect(descriptionCalls(h)).toEqual([]);
  });

  it("gives up a read slower than PLATFORM_METADATA_TIMEOUT_MS as the platform being unreachable, and the next request reads again", async () => {
    const { h, service } = setup();
    const { contentId } = bilibiliContent(h);
    const read = scriptedRead(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Outcomes are taken at once so the rejections are handled when the deadline passes.
    const first = classOf(service.fetch(LOCAL, contentId, signal()));
    const second = classOf(service.fetch(LOCAL, contentId, signal()));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PLATFORM_METADATA_TIMEOUT_MS - 1);
    expect(read.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe("source_unreachable");
    expect(await second).toBe("source_unreachable");
    // The extractor is told to stop; an answer arriving afterwards is dropped.
    expect(read.signals[0]?.aborted).toBe(true);
    read.answer({ state: "found", text: "too late" });
    await Promise.resolve();
    expect(stored(h, contentId).checkedAt).toBeUndefined();

    const retry = service.fetch(LOCAL, contentId, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(read.signals).toHaveLength(2);
    read.answer({ state: "found", text: "in time" });
    expect((await retry).result).toBe("found");
  });

  it("counts the wait for a heavy-job slot against the deadline and waits in the owner's foreground group", async () => {
    const { h, service, heavyKeys } = setup({ heavyLimit: 0 });
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "never read" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = service.fetch(LOCAL, contentId, signal());
    const outcome = classOf(pending);
    await vi.advanceTimersByTimeAsync(PLATFORM_METADATA_TIMEOUT_MS);
    expect(await outcome).toBe("source_unreachable");
    expect(heavyKeys).toEqual([`foreground:${LOCAL.userId}`]);
    expect(descriptionCalls(h)).toEqual([]);
  });

  it("reads inside a granted heavy-job slot", async () => {
    const { h, service, heavyKeys } = setup({ heavyLimit: 1 });
    const { contentId, bvid } = bilibiliContent(h);
    h.platforms.bilibili.video(bvid, { description: { state: "found", text: "read" } });
    expect((await service.fetch(LOCAL, contentId, signal())).result).toBe("found");
    expect(heavyKeys).toEqual([`foreground:${LOCAL.userId}`]);
  });
});

describe("ContentDescriptionService: order against the source stage", () => {
  it("keeps a manual answer whose request was sent after the stage's, even when the stage publishes later", async () => {
    const h = harness();
    const { service, clock } = setup({ h });
    const { contentId, bvid } = bilibiliContent(h);
    const release = gate();
    const adapter = h.platforms.bilibili;
    adapter.video(bvid, { description: { state: "found", text: "manual" }, metadata: { durationMs: 600_000, description: { state: "found", text: "stage" } } });
    const fetchMetadata = adapter.fetchMetadata.bind(adapter);
    let stageSent = false;
    adapter.fetchMetadata = async (ref, auth) => {
      stageSent = true;
      await release.promise;
      return fetchMetadata(ref, auth);
    };
    const executor = new SourceStageExecutor({ repository: h.repository, platforms: h.platformAccess, newId: h.newId, descriptionClock: clock });
    const context = {
      task: { userId: LOCAL.userId, contentId },
      signal: new AbortController().signal,
      withHeavySlot: <T>(work: () => Promise<T>) => work(),
    } as unknown as StageExecutionContext;
    const stage = executor.run(context);
    await vi.waitFor(() => expect(stageSent).toBe(true));

    const manual = await service.fetch(LOCAL, contentId, signal());
    expect(manual.result).toBe("found");

    release.open();
    const outcome = await stage;
    h.repository.withTransaction((scope) => outcome.publish?.(scope));
    expect(stored(h, contentId).description).toBe("manual");
    // The stage's other metadata is still published.
    expect(contentOf(h, contentId)?.durationMs).toBe(600_000);
  });
});
