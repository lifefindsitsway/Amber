import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COVER_DOWNLOAD_MAX_BYTES,
  COVER_FETCH_TIMEOUT_MS,
  COVER_FETCH_USER_CONCURRENCY,
  COVER_FETCH_USER_PER_MIN,
  COVER_IMAGE_MAX_BYTES,
  COVER_LONG_EDGE_MAX_PX,
  COVER_REFRESH_USER_PER_MIN,
} from "../../../src/shared/defaults.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import { ContentCoverService, COVER_LIMITS } from "../../../src/server/application/content-covers.ts";
import { CoverFetchCoordinator } from "../../../src/server/application/cover-fetch-coordinator.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import { FIGURE_SCRATCH_DIR, FigureImageProcessor } from "../../../src/server/application/figure-images.ts";
import { AmberError, amberError, appError, isAmberError } from "../../../src/server/domain/errors.ts";
import { inspectPackWebp } from "../../../src/server/domain/figure-image.ts";
import type { LocalMediaIngest } from "../../../src/server/ports/local-media-ingest.ts";
import type { LogFields, Logger } from "../../../src/server/ports/logger.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { childProcessEnv, type ProcessRunner } from "../../../src/server/ports/process-runner.ts";
import { upstreamHttpStatus } from "../../../src/server/ports/upstream-status.ts";
import { coverRig, rigContent, type CoverRigOptions } from "../../fixtures/platform/covers.ts";
import { patternPng, truncatedJpeg } from "../../fixtures/media/figure-images.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { toolsBinDir } from "../../fixtures/tools.ts";
import { countRows, tempDataDir } from "../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const COVER_URL = "https://i0.hdslb.com/bfs/archive/cover.jpg";
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

let samples: string;
let wide: Buffer;
let small: Buffer;
beforeAll(() => {
  samples = tempDataDir("amber-cover-samples-");
  wide = readFileSync(patternPng(samples, 1600, 900));
  small = readFileSync(patternPng(samples, 64, 36));
});

const realIngest = (options: { runner?: ProcessRunner; figureTimeoutMs?: number } = {}): FfmpegMediaIngest =>
  new FfmpegMediaIngest({ runner: options.runner ?? new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env), ...(options.figureTimeoutMs === undefined ? {} : { figureTimeoutMs: options.figureTimeoutMs }) });
const signal = (): AbortSignal => new AbortController().signal;

/** What the scripted `fetchCover` does for one call: write these bytes, throw, or wait until released. */
type CoverScript = Buffer | Error | { gate: Promise<Buffer> } | "hang";

interface CoverCall {
  url: string;
  maxBytes: number;
}

/** Gives the harness's scripted bilibili adapter a `fetchCover` that answers from `script`. */
function scriptCovers(h: Harness, script: () => CoverScript): CoverCall[] {
  const calls: CoverCall[] = [];
  const fetchCover: NonNullable<PlatformSourceAdapter["fetchCover"]> = async (url, output, options) => {
    calls.push({ url, maxBytes: options.maxBytes });
    h.platforms.bilibili.calls.push({ method: "fetchCover", target: url, withAuth: false });
    const answer = script();
    if (answer === "hang") return new Promise<never>(() => undefined);
    const bytes = answer instanceof Error ? undefined : Buffer.isBuffer(answer) ? answer : await answer.gate;
    if (bytes === undefined) throw answer;
    await writeFile(output.path, bytes);
    return { sizeBytes: bytes.length };
  };
  Object.assign(h.platforms.bilibili, { fetchCover });
  return calls;
}

function platformContent(h: Harness, owner = LOCAL.userId, coverUrl: string | undefined = COVER_URL): string {
  const id = h.newId();
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: owner,
      source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/BV1cv${id.slice(-6)}`, platformContentId: `BV1cv${id.slice(-6)}` },
      title: "lecture",
      ...(coverUrl === undefined ? {} : { coverUrl }),
      processingStatus: "succeeded",
      createdAt: T0,
      updatedAt: T0,
    }),
  );
  return id;
}

function capturingLogger(): Logger & { warnings: Array<{ message: string; fields?: LogFields }> } {
  const warnings: Array<{ message: string; fields?: LogFields }> = [];
  const logger: Logger & { warnings: typeof warnings } = {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => void warnings.push({ message, ...(fields === undefined ? {} : { fields }) }),
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function setup(options: { ingest?: LocalMediaIngest; timeoutMs?: number; concurrency?: number; userConcurrency?: number } = {}) {
  const h = createHarness();
  open.push(h);
  const logger = capturingLogger();
  const images = new FigureImageProcessor({
    ingest: options.ingest ?? realIngest(),
    files: h.media.data,
    newId: h.newId,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  const coordinator =
    options.userConcurrency === undefined
      ? undefined
      : new CoverFetchCoordinator({
          platforms: h.platformAccess,
          images,
          limits: COVER_LIMITS,
          userConcurrency: options.userConcurrency,
          globalSlots: new FairSemaphore(() => Number.POSITIVE_INFINITY),
        });
  const covers = new ContentCoverService({
    repository: h.repository,
    platforms: h.platformAccess,
    images,
    details: h.contents,
    logger,
    now: () => T0 + 5_000,
    ...(coordinator === undefined ? {} : { coordinator }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { h, covers, images, logger };
}

const contentOf = (h: Harness, id: string, owner = LOCAL.userId) => h.repository.withTransaction((scope) => scope.contents.getIncludingTrashed(owner, id));
const coverOf = (h: Harness, id: string, owner = LOCAL.userId) => h.repository.withTransaction((scope) => scope.contentCovers.getIncludingTrashed(owner, id));
function scratchLeft(h: Harness): string[] {
  const dir = join(h.dir, FIGURE_SCRATCH_DIR);
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
}

async function failure(promise: Promise<unknown>): Promise<{ class: string; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return { class: error.appError.class, code: error.appError.code };
    throw error;
  }
  throw new Error("expected a rejection");
}

/** A deferred value a test releases by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("ContentCoverService.saveIfAbsent", () => {
  it("stores a WebP within the cover limits as version 1, without touching updatedAt, and never fetches twice", async () => {
    const { h, covers } = setup();
    const calls = scriptCovers(h, () => wide);
    const id = platformContent(h);
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    expect(calls).toEqual([{ url: COVER_URL, maxBytes: COVER_DOWNLOAD_MAX_BYTES }]);
    const stored = coverOf(h, id);
    expect(stored).toMatchObject({ version: 1, width: COVER_LONG_EDGE_MAX_PX, height: 720 });
    expect(inspectPackWebp(stored?.bytes ?? new Uint8Array())).toEqual({ ok: true, width: COVER_LONG_EDGE_MAX_PX, height: 720 });
    expect(stored?.bytes.byteLength).toBeLessThanOrEqual(COVER_IMAGE_MAX_BYTES);
    expect(contentOf(h, id)).toMatchObject({ coverImageVersion: 1, updatedAt: T0 });
    expect(scratchLeft(h)).toEqual([]);

    // A second source run finds the copy: no request, same version.
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    expect(calls).toHaveLength(1);
    expect(contentOf(h, id)?.coverImageVersion).toBe(1);
  });

  it("only logs a refused download, a damaged image, a decoder timeout or a failing decoder, and stores nothing", async () => {
    const failingRunner: ProcessRunner = { run: async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "decoder error" }) };
    const cases: Array<[string, Parameters<typeof setup>[0], CoverScript]> = [
      ["over the download limit", {}, amberError("media_too_large", "too large")],
      ["damaged JPEG", {}, readFileSync(truncatedJpeg(tempDataDir("amber-cover-bad-")))],
      ["not an image", {}, Buffer.from("<html>blocked</html>")],
      ["decoder timeout", { ingest: realIngest({ figureTimeoutMs: 1 }) }, wide],
      ["decoder exits abnormally", { ingest: realIngest({ runner: failingRunner }) }, small],
    ];
    for (const [name, options, answer] of cases) {
      const { h, covers, logger } = setup(options);
      scriptCovers(h, () => answer);
      const id = platformContent(h);
      await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
      expect([name, coverOf(h, id), contentOf(h, id)?.coverImageVersion]).toEqual([name, undefined, undefined]);
      expect([name, logger.warnings.map((warning) => warning.message)]).toEqual([name, ["cover_save_failed"]]);
      // The URL never reaches the log: some platforms carry access parameters in it.
      expect(JSON.stringify(logger.warnings)).not.toContain("hdslb");
      expect([name, scratchLeft(h)]).toEqual([name, []]);
    }
  });

  it("refuses a decoded image whose size disagrees with what the decoder reported", async () => {
    const real = realIngest();
    const lying: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: async (...args: Parameters<LocalMediaIngest["normalizeImage"]>) => ({ ...(await real.normalizeImage(...args)), width: 1 }),
    });
    const { h, covers, logger } = setup({ ingest: lying });
    scriptCovers(h, () => small);
    const id = platformContent(h);
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    expect(coverOf(h, id)).toBeUndefined();
    expect(logger.warnings[0]?.fields).toMatchObject({ errorCode: "internal.tool_failed" });
  });

  it("gives up after the overall time limit even when the download ignores its signal", async () => {
    const { h, covers, logger } = setup({ timeoutMs: 30 });
    scriptCovers(h, () => "hang");
    const id = platformContent(h);
    const started = Date.now();
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(coverOf(h, id)).toBeUndefined();
    expect(logger.warnings[0]?.fields).toMatchObject({ errorClass: "source_unreachable" });
  });

  it("does nothing for a local Content or one already holding a copy", async () => {
    const { h, covers } = setup();
    const calls = scriptCovers(h, () => small);
    const local = createLocalContent(h);
    await covers.saveIfAbsent(LOCAL.userId, local, COVER_URL, signal());
    const id = platformContent(h);
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array([1]), width: 1, height: 1, sha256: "ab".repeat(32) }, T0));
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    expect(calls).toEqual([]);
    expect(coverOf(h, id)?.version).toBe(1);
  });
});

describe("ContentCoverService.fetch", () => {
  it("replaces the copy and raises the version, answering the Content as the detail does", async () => {
    const { h, covers } = setup();
    let answer: Buffer = small;
    scriptCovers(h, () => answer);
    const id = platformContent(h);
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    const first = coverOf(h, id);
    answer = wide;
    const result = await covers.fetch(LOCAL, id, signal());
    expect(result.content).toEqual(h.contents.get(LOCAL, id));
    expect(result.content).toMatchObject({ id, coverImageVersion: 2, updatedAt: T0 });
    const second = coverOf(h, id);
    expect(second?.version).toBe(2);
    expect(second?.sha256).not.toBe(first?.sha256);
  });

  it("keeps the copy and the version on a failure and throws the platform's error", async () => {
    const { h, covers } = setup();
    let answer: CoverScript = small;
    scriptCovers(h, () => answer);
    const id = platformContent(h);
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    const before = coverOf(h, id);
    for (const [error, expected] of [
      [amberError("platform_blocked", "refused"), "platform_blocked"],
      [amberError("source_unreachable", "offline"), "source_unreachable"],
      [amberError("media_too_large", "too large"), "media_too_large"],
    ] as const) {
      answer = error;
      expect((await failure(covers.fetch(LOCAL, id, signal()))).class).toBe(expected);
      expect(coverOf(h, id)).toEqual(before);
    }
    answer = Buffer.from("not an image");
    expect(await failure(covers.fetch(LOCAL, id, signal()))).toEqual({ class: "invalid_request", code: "invalid_request.figure_image" });
    expect(coverOf(h, id)).toEqual(before);
    expect(contentOf(h, id)?.coverImageVersion).toBe(1);
  });

  it("leaves the version and the copy unchanged when the write's transaction fails", async () => {
    const { h, covers } = setup();
    scriptCovers(h, () => small);
    const id = platformContent(h);
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    const before = coverOf(h, id);
    h.db.exec("CREATE TRIGGER refuse_cover_update BEFORE UPDATE ON content_cover_image BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    await expect(covers.fetch(LOCAL, id, signal())).rejects.toThrow(/simulated failure/);
    expect(coverOf(h, id)).toEqual(before);
    expect(contentOf(h, id)).toMatchObject({ coverImageVersion: 1, updatedAt: T0 });
  });

  it("refuses a local Content, and answers not_found for another user's, a trashed one, or an unknown id", async () => {
    const { h, covers } = setup();
    const calls = scriptCovers(h, () => small);
    expect(await failure(covers.fetch(LOCAL, createLocalContent(h), signal()))).toMatchObject({ class: "invalid_request" });
    const bobs = platformContent(h, BOB.userId);
    expect((await failure(covers.fetch(LOCAL, bobs, signal()))).class).toBe("not_found");
    const trashed = platformContent(h);
    h.trash.trash(LOCAL, trashed);
    expect((await failure(covers.fetch(LOCAL, trashed, signal()))).class).toBe("not_found");
    expect((await failure(covers.fetch(LOCAL, "missing", signal()))).class).toBe("not_found");
    expect(calls).toEqual([]);
    expect(coverOf(h, bobs, BOB.userId)).toBeUndefined();
  });

  it("times out like an unreachable platform", async () => {
    const { h, covers } = setup({ timeoutMs: 30 });
    scriptCovers(h, () => "hang");
    expect((await failure(covers.fetch(LOCAL, platformContent(h), signal()))).class).toBe("source_unreachable");
  });
});

describe("ContentCoverService reads", () => {
  it("serves the active cover only outside the trash and the trashed one only inside it", async () => {
    const { h, covers } = setup();
    scriptCovers(h, () => small);
    const id = platformContent(h);
    expect(isAmberError(catching(() => covers.cover(LOCAL, id)))).toBe(true);
    await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    expect(covers.cover(LOCAL, id).version).toBe(1);
    expect(classOf(() => covers.trashedCover(LOCAL, id))).toBe("not_found");
    expect(classOf(() => covers.cover(BOB, id))).toBe("not_found");
    h.trash.trash(LOCAL, id);
    expect(classOf(() => covers.cover(LOCAL, id))).toBe("not_found");
    expect(covers.trashedCover(LOCAL, id).version).toBe(1);
    expect(classOf(() => covers.trashedCover(BOB, id))).toBe("not_found");
  });
});

function catching(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function classOf(work: () => unknown): string | undefined {
  const error = catching(work);
  return isAmberError(error) ? error.appError.class : undefined;
}

describe("covers racing purge, restore and re-import", () => {
  /** Rows of `content_cover_image` whose Content is gone. */
  const orphans = (h: Harness): number => countRows(h.db, "content_cover_image", "NOT EXISTS (SELECT 1 FROM content WHERE content.id = content_cover_image.content_id)");

  it("leaves no cover row behind and reads only an existing cover or not_found", async () => {
    // Enough slots for every download at once: the point here is the races, not the limits.
    const { h, covers } = setup({ userConcurrency: 16 });
    // Downloads in the order they reached the platform; each waits until released.
    const gates: Array<ReturnType<typeof deferred<Buffer>>> = [];
    scriptCovers(h, () => {
      const gate = deferred<Buffer>();
      gates.push(gate);
      return { gate: gate.promise };
    });
    const ids = Array.from({ length: 6 }, () => platformContent(h));
    const saving = ids.map((id) => covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal()));
    while (gates.length < ids.length) await new Promise((resolve) => setTimeout(resolve, 5));
    // Manual fetches of two of them run at the same time; they share the saves' downloads of the same link.
    const manualOnPurged = covers.fetch(LOCAL, ids[4] as string, signal()).then(
      () => "ok",
      (error: unknown) => (isAmberError(error) ? error.appError.class : "other"),
    );
    const manualOnLive = covers.fetch(LOCAL, ids[5] as string, signal());
    const [purged, trashed, restored, reimported, purgedDuringFetch, live] = ids as [string, string, string, string, string, string];

    // Meanwhile: one is purged, one moved to the trash, one trashed and restored, one purged and imported again.
    h.trash.trash(LOCAL, purged);
    await h.trash.purge(LOCAL, purged);
    h.trash.trash(LOCAL, trashed);
    h.trash.trash(LOCAL, restored);
    h.trash.restore(LOCAL, restored);
    const old = contentOf(h, reimported);
    if (old === undefined) throw new Error("no content");
    h.trash.trash(LOCAL, reimported);
    await h.trash.purge(LOCAL, reimported);
    // Imported again under the same platform identity: a new Content with a new id.
    const again = h.newId();
    h.repository.withTransaction((scope) => scope.contents.insert({ ...old, id: again, createdAt: T0 + 1, updatedAt: T0 + 1 }));
    h.trash.trash(LOCAL, purgedDuringFetch);
    await h.trash.purge(LOCAL, purgedDuringFetch);

    // Reads while downloads are still out answer not_found, never an error of another kind.
    for (const id of [...ids, again]) {
      expect([id, classOf(() => covers.cover(LOCAL, id))]).toEqual([id, "not_found"]);
    }
    for (const gate of gates) gate.resolve(small);
    await Promise.all(saving);
    expect(gates).toHaveLength(ids.length);
    expect(await manualOnPurged).toBe("not_found");
    // The save stored the shared image first; the manual fetch finds the same image there and
    // counts that as its success without a second version.
    expect((await manualOnLive).content.coverImageVersion).toBe(1);

    expect(orphans(h)).toBe(0);
    expect(countRows(h.db, "content_cover_image")).toBe(2);
    expect(coverOf(h, purged)).toBeUndefined();
    expect(coverOf(h, reimported)).toBeUndefined();
    expect(coverOf(h, again)).toBeUndefined();
    // Moved to the trash before its download landed: no copy is written to a trashed Content.
    expect(coverOf(h, trashed)).toBeUndefined();
    expect(covers.cover(LOCAL, restored).version).toBe(1);
    expect(covers.cover(LOCAL, live).version).toBe(1);
    for (const id of [...ids, again]) {
      const outcome = classOf(() => covers.cover(LOCAL, id)) ?? "found";
      expect([id, ["found", "not_found"].includes(outcome)]).toEqual([id, true]);
    }
    expect(scratchLeft(h)).toEqual([]);
  });

  it("purges the cover with its Content and keeps it through a trash and restore", async () => {
    const { h, covers } = setup();
    scriptCovers(h, () => small);
    const [kept, gone] = [platformContent(h), platformContent(h)];
    for (const id of [kept, gone]) await covers.saveIfAbsent(LOCAL.userId, id, COVER_URL, signal());
    h.trash.trash(LOCAL, kept);
    h.trash.restore(LOCAL, kept);
    expect(covers.cover(LOCAL, kept).version).toBe(1);
    h.trash.trash(LOCAL, gone);
    await h.trash.purge(LOCAL, gone);
    expect(countRows(h.db, "content_cover_image")).toBe(1);
    expect(orphans(h)).toBe(0);
  });
});

const STALE = (status: number) => new AmberError(appError("source_unreachable"), `media request answered HTTP ${status}`, { cause: upstreamHttpStatus(status) });
const IMAGE_A = Buffer.from("image-a");
const IMAGE_B = Buffer.from("image-b");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function rig(options: CoverRigOptions = {}) {
  const h = createHarness();
  open.push(h);
  return { h, ...coverRig(h, options) };
}

/** Lets pending promise callbacks and file writes run until `ready` holds. */
async function until(ready: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(ready()).toBe(true));
}

describe("conditional cover writes", () => {
  it("shares one download among concurrent manual fetches: one write, one version step", async () => {
    const { h, covers, calls } = rig();
    const id = rigContent(h);
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array(IMAGE_A), width: 1, height: 1, sha256: digest(IMAGE_A) }, T0));
    const fetches = [covers.fetch(LOCAL, id, signal()), covers.fetch(LOCAL, id, signal())];
    await until(() => calls.length === 1);
    calls[0]?.answer(IMAGE_B);
    const results = await Promise.all(fetches);
    expect(results.map((result) => result.content.coverImageVersion)).toEqual([2, 2]);
    expect(calls).toHaveLength(1);
    expect(coverOf(h, id)).toMatchObject({ version: 2, sha256: digest(IMAGE_B) });
  });

  it("drops an older download that lands after a newer cover, keeping the newer bytes and version", async () => {
    const { h, covers, calls } = rig();
    const id = rigContent(h);
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array(IMAGE_A), width: 1, height: 1, sha256: digest(IMAGE_A) }, T0));
    const older = covers.fetch(LOCAL, id, signal());
    await until(() => calls.length === 1);
    // A newer cover lands meanwhile (another fetch, a content pack).
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array(IMAGE_B), width: 1, height: 1, sha256: digest(IMAGE_B) }, T0 + 1));
    calls[0]?.answer(Buffer.from("image-old"));
    expect((await older).content.coverImageVersion).toBe(2);
    expect(coverOf(h, id)).toMatchObject({ version: 2, sha256: digest(IMAGE_B) });
  });

  it("counts an identical image already stored as success without a new version", async () => {
    const { h, covers, calls } = rig();
    const id = rigContent(h);
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array(IMAGE_A), width: 1, height: 1, sha256: digest(IMAGE_A) }, T0));
    const older = covers.fetch(LOCAL, id, signal());
    await until(() => calls.length === 1);
    h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array(IMAGE_B), width: 1, height: 1, sha256: digest(IMAGE_B) }, T0 + 1));
    calls[0]?.answer(IMAGE_B);
    expect((await older).content.coverImageVersion).toBe(2);
    expect(coverOf(h, id)?.version).toBe(2);
  });

  it("writes nothing when the Content moves to the trash, its cover link changes, or the caller gives up", async () => {
    const { h, covers, calls } = rig({ honourSignal: false, coordinator: { userConcurrency: 4 } });
    const [trashed, relinked, abandoned, saved] = [rigContent(h), rigContent(h), rigContent(h), rigContent(h)];
    const onTrashed = failure(covers.fetch(LOCAL, trashed, signal()));
    const onRelinked = covers.fetch(LOCAL, relinked, signal());
    await until(() => calls.length === 2);
    const caller = new AbortController();
    const onAbandoned = covers.saveIfAbsent(LOCAL.userId, abandoned, `https://img.example.com/${abandoned}.jpg`, caller.signal);
    const onSaved = covers.saveIfAbsent(LOCAL.userId, saved, `https://img.example.com/${saved}.jpg`, signal());
    await until(() => calls.length === 4);
    h.trash.trash(LOCAL, trashed);
    h.db.prepare("UPDATE content SET cover_url = 'https://img.example.com/other.jpg' WHERE id = ?").run(relinked);
    caller.abort(new Error("stage cancelled"));
    for (const call of calls) call.answer(IMAGE_A);
    expect((await onTrashed).class).toBe("not_found");
    expect((await onRelinked).content).not.toHaveProperty("coverImageVersion");
    await onAbandoned;
    await onSaved;
    expect([coverOf(h, trashed), coverOf(h, relinked), coverOf(h, abandoned)]).toEqual([undefined, undefined, undefined]);
    expect(coverOf(h, saved)?.version).toBe(1);
  });
});

describe("manual fetch limits", () => {
  it("answers busy at once while the user's slots are taken, and stays within the per-minute budget", async () => {
    let now = T0;
    const { h, covers, calls } = rig({ service: { now: () => now } });
    const ids = Array.from({ length: COVER_FETCH_USER_CONCURRENCY }, () => rigContent(h));
    const saving = ids.map((id) => covers.saveIfAbsent(LOCAL.userId, id, `https://img.example.com/${id}.jpg`, signal()));
    await until(() => calls.length === COVER_FETCH_USER_CONCURRENCY);
    const busy = await failureWithDetails(covers.fetch(LOCAL, rigContent(h), signal()));
    expect(busy).toMatchObject({ class: "conflict", code: "conflict.cover_fetch_busy" });
    for (const call of calls) call.answer(IMAGE_A);
    await Promise.all(saving);

    const { h: h2, covers: limited } = rig({ auto: () => IMAGE_A, service: { now: () => now } });
    const id = rigContent(h2);
    for (let i = 0; i < COVER_FETCH_USER_PER_MIN; i += 1) {
      await limited.fetch(LOCAL, id, signal());
      now += 10;
    }
    const over = await failureWithDetails(limited.fetch(LOCAL, id, signal()));
    expect(over).toMatchObject({ code: "conflict.cover_fetch_busy", details: { retryAfterMs: 60_000 - COVER_FETCH_USER_PER_MIN * 10 } });
    expect(coverOf(h2, id)?.version).toBe(COVER_FETCH_USER_PER_MIN);
    now += 60_000;
    await limited.fetch(LOCAL, id, signal());
  });

  it("answers source_unreachable once queue and download exceed the time limit, keeping the copy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { h, covers, calls } = rig();
      const id = rigContent(h);
      h.repository.withTransaction((scope) => scope.contentCovers.put(LOCAL.userId, id, { bytes: new Uint8Array(IMAGE_A), width: 1, height: 1, sha256: digest(IMAGE_A) }, T0));
      const outcome = failure(covers.fetch(LOCAL, id, signal()));
      await vi.advanceTimersByTimeAsync(COVER_FETCH_TIMEOUT_MS + 1);
      expect((await outcome).class).toBe("source_unreachable");
      expect(calls[0]?.signal.aborted).toBe(true);
      expect(coverOf(h, id)).toMatchObject({ version: 1, sha256: digest(IMAGE_A) });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stale cover links", () => {
  it("re-reads the link once on 403 / 404 / 410 where the platform can, stores it, then downloads it", async () => {
    for (const status of [403, 404, 410]) {
      const { h, covers, calls, refreshes } = rig({
        refreshable: ["xiaohongshu", "douyin"],
        refreshAnswer: (platformId) => `https://img.example.com/fresh-${platformId}.jpg`,
        auto: (url) => (url.includes("fresh-") ? IMAGE_B : STALE(status)),
      });
      const id = rigContent(h, { platform: "xiaohongshu" });
      const result = await covers.fetch(LOCAL, id, signal());
      expect([status, refreshes]).toEqual([status, [`xiaohongshu-${id}`]]);
      expect(calls.map((call) => call.url)).toEqual([`https://img.example.com/${id}.jpg`, `https://img.example.com/fresh-xiaohongshu-${id}.jpg`]);
      expect(result.content).toMatchObject({ coverUrl: `https://img.example.com/fresh-xiaohongshu-${id}.jpg`, coverImageVersion: 1 });
      expect(coverOf(h, id)?.sha256).toBe(digest(IMAGE_B));
    }
  });

  it("leaves other statuses, and platforms that cannot re-read, to fail as they came", async () => {
    const { h, covers, refreshes } = rig({
      refreshable: ["xiaohongshu", "douyin"],
      refreshAnswer: () => "https://img.example.com/fresh.jpg",
      auto: (url) => (url.includes("/b-") ? STALE(404) : STALE(500)),
    });
    expect((await failure(covers.fetch(LOCAL, rigContent(h, { platform: "douyin" }), signal()))).class).toBe("source_unreachable");
    for (const platform of ["bilibili", "youtube"] as const) {
      expect((await failure(covers.fetch(LOCAL, rigContent(h, { platform, coverUrl: `https://img.example.com/b-${platform}.jpg` }), signal()))).class).toBe("source_unreachable");
    }
    expect(refreshes).toEqual([]);
  });

  it("asks the platform once for concurrent fetches of one Content", async () => {
    let release: (url: string) => void = () => undefined;
    const fresh = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { h, covers, refreshes, calls } = rig({ refreshable: ["douyin"], refreshAnswer: () => fresh, auto: (url) => (url.includes("fresh") ? IMAGE_B : STALE(403)) });
    const id = rigContent(h, { platform: "douyin" });
    const fetches = [covers.fetch(LOCAL, id, signal()), covers.fetch(LOCAL, id, signal())];
    await until(() => refreshes.length === 1);
    release("https://img.example.com/fresh.jpg");
    const results = await Promise.all(fetches);
    expect(refreshes).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("fresh"))).toHaveLength(1);
    expect(results.map((result) => result.content.coverImageVersion)).toEqual([1, 1]);
  });

  it("answers link_expired when the source link itself has expired", async () => {
    const { h, covers } = rig({
      refreshable: ["xiaohongshu"],
      refreshAnswer: () => {
        throw amberError("invalid_request", "source link expired", { code: "invalid_request.link_expired", details: { urls: [] } });
      },
      auto: () => STALE(404),
    });
    const id = rigContent(h, { platform: "xiaohongshu" });
    expect(await failure(covers.fetch(LOCAL, id, signal()))).toEqual({ class: "invalid_request", code: "invalid_request.link_expired" });
    expect(contentOf(h, id)?.coverUrl).toBe(`https://img.example.com/${id}.jpg`);
  });

  it("writes the new link only while the stored one is still the stale one", async () => {
    const { h, covers } = rig({
      refreshable: ["douyin"],
      refreshAnswer: (platformId) => {
        // Someone stores another link while the platform is read.
        h.db.prepare("UPDATE content SET cover_url = 'https://img.example.com/elsewhere.jpg' WHERE platform_content_id = ?").run(platformId);
        return "https://img.example.com/fresh.jpg";
      },
      auto: (url) => (url.includes("elsewhere") ? IMAGE_A : STALE(410)),
    });
    const id = rigContent(h, { platform: "douyin" });
    const result = await covers.fetch(LOCAL, id, signal());
    expect(result.content).toMatchObject({ coverUrl: "https://img.example.com/elsewhere.jpg", coverImageVersion: 1 });
  });
});

describe("the link-refresh budget", () => {
  it("refuses a manual refresh over the per-minute budget with the wait, while a backfill item waits for it", async () => {
    let now = T0;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      now += ms;
    };
    const { h, covers, refreshes } = rig({
      refreshable: ["douyin"],
      refreshAnswer: (platformId) => `https://img.example.com/fresh-${platformId}.jpg`,
      auto: (url) => (url.includes("fresh-") ? STALE(404) : STALE(404)),
      service: { now: () => now, sleep },
    });
    const ids = Array.from({ length: COVER_REFRESH_USER_PER_MIN + 1 }, () => rigContent(h, { platform: "douyin" }));
    for (const id of ids.slice(0, COVER_REFRESH_USER_PER_MIN)) {
      expect((await failure(covers.fetch(LOCAL, id, signal()))).class).toBe("source_unreachable");
    }
    expect(refreshes).toHaveLength(COVER_REFRESH_USER_PER_MIN);
    const over = await failureWithDetails(covers.fetch(LOCAL, ids.at(-1) as string, signal()));
    expect(over).toMatchObject({ code: "conflict.cover_fetch_busy", details: { retryAfterMs: 60_000 } });
    expect(refreshes).toHaveLength(COVER_REFRESH_USER_PER_MIN);

    // The backfill shares the budget: it waits for the next allowance instead of failing.
    const item = await covers.backfillOne(LOCAL.userId, ids.at(-1) as string, { refresh: true, blocked: new Set() }, signal());
    expect(slept).toEqual([60_000]);
    expect(refreshes).toHaveLength(COVER_REFRESH_USER_PER_MIN + 1);
    expect(item).toMatchObject({ outcome: "failed", staleLink: true, refreshable: false });
  });

  it("reads the platform through the heavy-job governor and downloads only after releasing it, even with one slot of each", async () => {
    const heavy = new FairSemaphore(() => 1);
    const groups: string[] = [];
    const governor = {
      run: <T>(ref: { key: string; createdAt: number }, s: AbortSignal, work: () => Promise<T>) => {
        groups.push(ref.key);
        return heavy.run(ref, s, work);
      },
    };
    const observed: Array<{ heavy: number; coverSlots: number }> = [];
    const { h, covers, coordinator } = rig({
      refreshable: ["xiaohongshu"],
      refreshAnswer: () => {
        observed.push({ heavy: heavy.inFlight, coverSlots: coordinator.userSlotsInUse(LOCAL.userId) });
        return "https://img.example.com/fresh.jpg";
      },
      auto: (url) => {
        observed.push({ heavy: heavy.inFlight, coverSlots: coordinator.userSlotsInUse(LOCAL.userId) });
        return url.includes("fresh") ? IMAGE_B : STALE(403);
      },
      coordinator: { userConcurrency: 1, globalSlots: new FairSemaphore(() => 1) },
      service: { heavy: governor },
    });
    const id = rigContent(h, { platform: "xiaohongshu" });
    expect((await covers.fetch(LOCAL, id, signal())).content.coverImageVersion).toBe(1);
    expect(groups).toEqual([`foreground:${LOCAL.userId}`]);
    // Download, refresh, download: never a governor slot and a cover slot at the same time.
    expect(observed).toEqual([
      { heavy: 0, coverSlots: 1 },
      { heavy: 1, coverSlots: 0 },
      { heavy: 0, coverSlots: 1 },
    ]);
  });
});

async function failureWithDetails(promise: Promise<unknown>): Promise<{ class: string; code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}
