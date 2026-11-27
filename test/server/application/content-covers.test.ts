import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { COVER_DOWNLOAD_MAX_BYTES, COVER_IMAGE_MAX_BYTES, COVER_LONG_EDGE_MAX_PX } from "../../../src/shared/defaults.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import { ContentCoverService } from "../../../src/server/application/content-covers.ts";
import { FIGURE_SCRATCH_DIR, FigureImageProcessor } from "../../../src/server/application/figure-images.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import { inspectPackWebp } from "../../../src/server/domain/figure-image.ts";
import type { LocalMediaIngest } from "../../../src/server/ports/local-media-ingest.ts";
import type { LogFields, Logger } from "../../../src/server/ports/logger.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { childProcessEnv, type ProcessRunner } from "../../../src/server/ports/process-runner.ts";
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

function setup(options: { ingest?: LocalMediaIngest; timeoutMs?: number; concurrency?: number } = {}) {
  const h = createHarness();
  open.push(h);
  const logger = capturingLogger();
  const images = new FigureImageProcessor({
    ingest: options.ingest ?? realIngest(),
    files: h.media.data,
    newId: h.newId,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  const covers = new ContentCoverService({
    repository: h.repository,
    platforms: h.platformAccess,
    images,
    details: h.contents,
    logger,
    now: () => T0 + 5_000,
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
    const { h, covers } = setup();
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
    // Manual fetches of two of them run at the same time.
    const manualOnPurged = covers.fetch(LOCAL, ids[4] as string, signal()).then(
      () => "ok",
      (error: unknown) => (isAmberError(error) ? error.appError.class : "other"),
    );
    const manualOnLive = covers.fetch(LOCAL, ids[5] as string, signal());
    while (gates.length < ids.length + 2) await new Promise((resolve) => setTimeout(resolve, 5));
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
    // The source-stage saves land first, then the manual fetches replace what they wrote.
    for (const gate of gates.slice(0, ids.length)) gate.resolve(small);
    await Promise.all(saving);
    for (const gate of gates.slice(ids.length)) gate.resolve(wide);
    expect(await manualOnPurged).toBe("not_found");
    expect((await manualOnLive).content.coverImageVersion).toBe(2);

    expect(orphans(h)).toBe(0);
    expect(countRows(h.db, "content_cover_image")).toBe(2);
    expect(coverOf(h, purged)).toBeUndefined();
    expect(coverOf(h, reimported)).toBeUndefined();
    expect(coverOf(h, again)).toBeUndefined();
    // Moved to the trash before its download landed: no copy is written to a trashed Content.
    expect(coverOf(h, trashed)).toBeUndefined();
    expect(covers.cover(LOCAL, restored).version).toBe(1);
    expect(covers.cover(LOCAL, live).version).toBe(2);
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
