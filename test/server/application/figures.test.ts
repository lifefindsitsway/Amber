import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  FIGURE_DELETED_RETENTION_DAYS,
  FIGURE_IMAGE_MAX_BYTES,
  FIGURE_PIXELS_MAX,
  FIGURE_PROCESS_CONCURRENCY,
  FIGURE_UPLOAD_MAX_BYTES,
  FIGURE_WEBP_QUALITY,
  FIGURE_WEBP_QUALITY_MIN,
  FIGURE_WIDTH_DEFAULT,
  FIGURES_PER_CONTENT_MAX,
} from "../../../src/shared/defaults.ts";
import type { FigureDto, FigurePlacement } from "../../../src/shared/dto/figure.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import { FIGURE_SCRATCH_DIR, figureQualities } from "../../../src/server/application/figure-images.ts";
import { FigureService, type FigureUploadPart } from "../../../src/server/application/figures.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { ContentFigure } from "../../../src/server/domain/figure.ts";
import { inspectPackWebp } from "../../../src/server/domain/figure-image.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { LocalMediaIngest } from "../../../src/server/ports/local-media-ingest.ts";
import { childProcessEnv } from "../../../src/server/ports/process-runner.ts";
import { audioOnly, decodePixels, ffmpeg, frameLevels, headerOnlyPng, nearestFrame, orientedJpeg, patternPng, TIMED_VIDEO_FPS, TIMED_VIDEO_MS, timedVideo, truncatedJpeg } from "../../fixtures/media/figure-images.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { toolsBinDir } from "../../fixtures/tools.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../fixtures/transcripts/lecture.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

const DAY_MS = 86_400_000;
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

let samples: string;
let video: string;
let levels: number[];
beforeAll(() => {
  samples = tempDataDir("amber-figure-samples-");
  video = timedVideo(samples);
  levels = frameLevels(video);
});

const realIngest = (): FfmpegMediaIngest => new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) });
const signal = (): AbortSignal => new AbortController().signal;

function setup(options: { ingest?: LocalMediaIngest; concurrency?: number } = {}) {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
  });
  const clock = { now: 1_800_000_000_000 };
  const figures = new FigureService({
    repository: h.repository,
    ingest: options.ingest ?? realIngest(),
    media: h.media,
    files: h.media.data,
    now: () => clock.now,
    newId: h.newId,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  return { h, contentId, fixture, clock, figures };
}

function addAsset(h: Harness, contentId: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  const asset: MediaAsset = {
    id: h.newId(),
    userId: LOCAL.userId,
    contentId,
    kind: "external_local",
    storageRef: video,
    mimeType: "video/mp4",
    sizeBytes: readFileSync(video).length,
    durationMs: TIMED_VIDEO_MS,
    availability: "available",
    retentionPolicy: "never_delete",
    createdAt: 1,
    ...overrides,
  };
  h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  return asset;
}

/** A real 64×48 lossy WebP. */
function smallWebp(): Buffer {
  const path = join(samples, "small.webp");
  if (!existsSync(path)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x48", "-frames:v", "1", "-c:v", "libwebp", "-f", "webp", path]);
  return readFileSync(path);
}

/** `smallWebp`'s bitstream behind an extended header whose canvas says 1×1. */
function understatedWebp(): Buffer {
  const simple = smallWebp();
  const bitstream = simple.subarray(12);
  const vp8x = Buffer.alloc(18);
  vp8x.write("VP8X", 0, "latin1");
  vp8x.writeUInt32LE(10, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), vp8x, bitstream]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const placement = (overrides: Partial<FigurePlacement> = {}): FigurePlacement => ({ displayMs: 0, anchor: null, sortKey: 0, ...overrides });

async function* uploadParts(bytes: Buffer, meta: unknown = { placement: placement() }): AsyncIterable<FigureUploadPart> {
  yield { kind: "field", name: "meta", value: JSON.stringify(meta) };
  yield {
    kind: "file",
    name: "file",
    stream: (async function* () {
      yield new Uint8Array(bytes);
    })(),
  };
}

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    if (isAmberError(error)) return { code: error.appError.code, ...(error.appError.details === undefined ? {} : { details: error.appError.details as Record<string, unknown> }) };
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Whatever the image jobs left in the scratch area. */
function scratchLeft(h: Harness): string[] {
  const dir = join(h.dir, FIGURE_SCRATCH_DIR);
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
}

const anchorOf = (fixture: TranscriptFixture, index = 0) => {
  const segment = fixture.corrected.segments[index];
  if (segment === undefined) throw new Error("no segment");
  return { revisionId: fixture.corrected.revision.id, segmentId: segment.id, side: "after" as const };
};

/** Inserts a figure directly, for tests about the cap, deletion and retention. */
function seedFigure(h: Harness, contentId: string, overrides: Partial<ContentFigure> = {}): ContentFigure {
  const bytes = Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00", "latin1");
  const figure: ContentFigure = {
    id: h.newId(),
    contentId,
    userId: LOCAL.userId,
    source: "upload",
    displayMs: 0,
    sortKey: 0,
    widthRatio: FIGURE_WIDTH_DEFAULT,
    image: { width: 1, height: 1, bytes: bytes.length, sha256: "0".repeat(64) },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  h.repository.withTransaction((scope) => scope.figures.insert(figure, new Uint8Array(bytes)));
  return figure;
}

describe("FigureService capture", () => {
  it("captures the frame at the requested time (within one frame), defaulting the display time and width", async () => {
    const { h, contentId, figures } = setup();
    const asset = addAsset(h, contentId);
    const figure = await figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 4_250 }, signal());
    expect(figure).toMatchObject({ source: "capture", capturedAtMs: 4_250, placement: { displayMs: 4_250, anchor: null, sortKey: 0 }, widthRatio: FIGURE_WIDTH_DEFAULT, version: 1 });
    expect(figure.image).toMatchObject({ width: 64, height: 48 });
    const { bytes, sha256 } = figures.image(LOCAL, figure.id);
    expect(sha256).toBe(figure.image.sha256);
    expect(inspectPackWebp(bytes)).toMatchObject({ ok: true });
    const stored = join(h.dir, "captured.webp");
    writeFileSync(stored, bytes);
    const frame = nearestFrame(levels, decodePixels(stored, "gray", "1:1")[0] ?? -1);
    expect(Math.abs(frame - Math.floor((4_250 * TIMED_VIDEO_FPS) / 1000))).toBeLessThanOrEqual(1);
    expect(scratchLeft(h)).toEqual([]);
    // A second capture without a placement goes after the first in the same gap.
    expect((await figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 4_250, widthRatio: 0.4 }, signal())).placement.sortKey).toBe(1);
  });

  it("clamps the time to the media's length", async () => {
    const { h, contentId, figures } = setup();
    const asset = addAsset(h, contentId, { durationMs: 5_000 });
    expect((await figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 9_000 }, signal())).capturedAtMs).toBe(5_000);
  });

  it("captures the last frame for a time clamped to the media's length", async () => {
    const { h, contentId, figures } = setup();
    const asset = addAsset(h, contentId);
    const figure = await figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: TIMED_VIDEO_MS + 3_000 }, signal());
    expect(figure.capturedAtMs).toBe(TIMED_VIDEO_MS);
    const stored = join(h.dir, "last.webp");
    writeFileSync(stored, figures.image(LOCAL, figure.id).bytes);
    expect(nearestFrame(levels, decodePixels(stored, "gray", "1:1")[0] ?? -1)).toBe(levels.length - 1);
    expect(scratchLeft(h)).toEqual([]);
  });

  it("waits for the start-up sweep before any capture or upload, telling others only not_found", async () => {
    const { h, contentId } = setup();
    let ready = false;
    const figures = new FigureService({ repository: h.repository, ingest: realIngest(), media: h.media, files: h.media.data, newId: h.newId, backgroundReady: () => ready });
    const asset = addAsset(h, contentId);
    const png = readFileSync(patternPng(samples, 16, 16));
    expect((await failure(figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 0 }, signal()))).code).toBe("conflict.starting_up");
    expect((await failure(figures.upload(LOCAL, contentId, uploadParts(png), signal()))).code).toBe("conflict.starting_up");
    expect((await failure(figures.upload(BOB, contentId, uploadParts(png), signal()))).code).toBe("not_found");
    // Reading and editing do not touch the scratch area.
    expect(figures.list(LOCAL, contentId).items).toEqual([]);
    ready = true;
    expect((await figures.upload(LOCAL, contentId, uploadParts(png), signal())).source).toBe("upload");
  });

  it("refuses audio, foreign or unavailable assets", async () => {
    const { h, contentId, figures } = setup();
    const audio = addAsset(h, contentId, { storageRef: audioOnly(samples), mimeType: "audio/mp4" });
    expect(await failure(figures.capture(LOCAL, contentId, { assetId: audio.id, atMs: 0 }, signal()))).toEqual({ code: "invalid_request.figure_frame", details: { reason: "no_video" } });
    const other = addAsset(h, createLocalContent(h));
    expect((await failure(figures.capture(LOCAL, contentId, { assetId: other.id, atMs: 0 }, signal()))).code).toBe("invalid_request");
    const audioCache = addAsset(h, contentId, { kind: "platform_cache", storageRef: "cache.m4a", mimeType: "audio/mp4", retentionPolicy: "evictable" });
    expect((await failure(figures.capture(LOCAL, contentId, { assetId: audioCache.id, atMs: 0 }, signal()))).code).toBe("invalid_request");
    const missing = addAsset(h, contentId, { availability: "missing" });
    expect((await failure(figures.capture(LOCAL, contentId, { assetId: missing.id, atMs: 0 }, signal()))).code).toBe("media_missing");
  });
});

describe("FigureService upload", () => {
  it("stores a normalized WebP of an upright, metadata-free image, placed as asked", async () => {
    const { h, contentId, fixture, figures } = setup();
    const anchor = anchorOf(fixture, 1);
    const figure = await figures.upload(LOCAL, contentId, uploadParts(readFileSync(orientedJpeg(samples)), { placement: placement({ displayMs: 777, anchor, sortKey: 3 }), widthRatio: 1 }), signal());
    expect(figure).toMatchObject({ source: "upload", placement: { displayMs: 777, anchor, sortKey: 3 }, widthRatio: 1, image: { width: 40, height: 80 } });
    expect(figure.capturedAtMs).toBeUndefined();
    expect(inspectPackWebp(figures.image(LOCAL, figure.id).bytes)).toEqual({ ok: true, width: 40, height: 80 });
    expect(scratchLeft(h)).toEqual([]);
  });

  it("refuses unsupported, disguised, truncated and oversized images, leaving nothing behind", async () => {
    let decoded = 0;
    const real = realIngest();
    const counting: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: (...args: Parameters<LocalMediaIngest["normalizeImage"]>) => {
        decoded += 1;
        return real.normalizeImage(...args);
      },
    });
    const { h, contentId, figures } = setup({ ingest: counting });
    const cases: Array<[string, Buffer, string]> = [
      ["text named .png", Buffer.from("plain text\n".repeat(30)), "unsupported"],
      ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"), "unsupported"],
      ["header over the pixel limit", headerOnlyPng(10_000, Math.floor(FIGURE_PIXELS_MAX / 10_000) + 1), "too_many_pixels"],
      ["header without a size", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "corrupt"],
      ["WebP canvas smaller than its bitstream", understatedWebp(), "corrupt"],
      ["WebP with an image appended", Buffer.concat([smallWebp(), readFileSync(patternPng(samples, 64, 64))]), "corrupt"],
    ];
    for (const [name, bytes, reason] of cases) {
      expect([name, await failure(figures.upload(LOCAL, contentId, uploadParts(bytes), signal()))]).toEqual([name, { code: "invalid_request.figure_image", details: { reason } }]);
    }
    // None of those reached the decoder.
    expect(decoded).toBe(0);
    expect(await failure(figures.upload(LOCAL, contentId, uploadParts(readFileSync(truncatedJpeg(samples))), signal()))).toEqual({
      code: "invalid_request.figure_image",
      details: { reason: "corrupt" },
    });
    expect(await failure(figures.upload(LOCAL, contentId, uploadParts(Buffer.alloc(FIGURE_UPLOAD_MAX_BYTES + 1)), signal()))).toEqual({
      code: "invalid_request.figure_image",
      details: { reason: "too_large" },
    });
    expect(figures.list(LOCAL, contentId)).toMatchObject({ items: [], recentlyDeleted: [] });
    expect(scratchLeft(h)).toEqual([]);
  });

  it("lowers the quality step by step when the WebP is over the byte limit, and refuses it below the minimum", async () => {
    expect(figureQualities()[0]).toBe(FIGURE_WEBP_QUALITY);
    expect(figureQualities().at(-1)).toBe(FIGURE_WEBP_QUALITY_MIN);
    const real = realIngest();
    let fitsAt = FIGURE_WEBP_QUALITY_MIN;
    const tried: number[] = [];
    // Pads the real output past the limit above `fitsAt`; the header still reads the same size.
    const padding: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: async (input: { path: string }, output: { path: string }, options: { maxLongEdge: number; quality: number }, abort: AbortSignal) => {
        tried.push(options.quality);
        const result = await real.normalizeImage(input, output, options, abort);
        if (options.quality > fitsAt) {
          const fs = await import("node:fs/promises");
          await fs.appendFile(output.path, Buffer.alloc(FIGURE_IMAGE_MAX_BYTES));
          return { ...result, bytes: result.bytes + FIGURE_IMAGE_MAX_BYTES };
        }
        return result;
      },
    });
    const { h, contentId, figures } = setup({ ingest: padding });
    const png = readFileSync(patternPng(samples, 64, 32));
    const figure = await figures.upload(LOCAL, contentId, uploadParts(png), signal());
    expect(tried).toEqual(figureQualities());
    expect(figure.image.bytes).toBeLessThanOrEqual(FIGURE_IMAGE_MAX_BYTES);
    fitsAt = -1;
    tried.length = 0;
    expect(await failure(figures.upload(LOCAL, contentId, uploadParts(png), signal()))).toEqual({ code: "invalid_request.figure_image", details: { reason: "too_large" } });
    expect(tried).toEqual(figureQualities());
    expect(scratchLeft(h)).toEqual([]);
  });

  it("decodes at most FIGURE_PROCESS_CONCURRENCY images at once; four parallel uploads all land", async () => {
    const real = realIngest();
    let running = 0;
    let peak = 0;
    const tracking: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: async (...args: Parameters<LocalMediaIngest["normalizeImage"]>) => {
        running += 1;
        peak = Math.max(peak, running);
        try {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return await real.normalizeImage(...args);
        } finally {
          running -= 1;
        }
      },
    });
    const { h, contentId, figures } = setup({ ingest: tracking });
    const png = readFileSync(patternPng(samples, 320, 240));
    const results = await Promise.all([0, 1, 2, 3].map((index) => figures.upload(LOCAL, contentId, uploadParts(png, { placement: placement({ sortKey: index }) }), signal())));
    expect(results.map((figure) => figure.placement.sortKey)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(FIGURE_PROCESS_CONCURRENCY);
    expect(figures.list(LOCAL, contentId).items).toHaveLength(4);
    expect(scratchLeft(h)).toEqual([]);
  });

  it("removes the job when the upload is cancelled while waiting or decoding", async () => {
    const real = realIngest();
    const gate: { open?: () => void } = {};
    const slow: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: async (input: { path: string }, output: { path: string }, options: { maxLongEdge: number; quality: number }, abort: AbortSignal) => {
        await new Promise<void>((resolve) => {
          gate.open = resolve;
          abort.addEventListener("abort", () => resolve(), { once: true });
        });
        return real.normalizeImage(input, output, options, abort);
      },
    });
    const { h, contentId, figures } = setup({ ingest: slow, concurrency: 1 });
    const png = readFileSync(patternPng(samples, 32, 32));
    const first = new AbortController();
    const second = new AbortController();
    const decoding = figures.upload(LOCAL, contentId, uploadParts(png), first.signal).catch((error: unknown) => error);
    const waiting = figures.upload(LOCAL, contentId, uploadParts(png), second.signal).catch((error: unknown) => error);
    while (gate.open === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    second.abort();
    first.abort();
    expect(isAmberError(await decoding)).toBe(false);
    expect(isAmberError(await waiting)).toBe(false);
    expect(figures.list(LOCAL, contentId).items).toEqual([]);
    expect(scratchLeft(h)).toEqual([]);
  });

  it("needs the meta field first and exactly one file after it", async () => {
    const { contentId, figures } = setup();
    const png = readFileSync(patternPng(samples, 16, 16));
    async function* fileOnly(): AsyncIterable<FigureUploadPart> {
      yield { kind: "file", name: "file", stream: (async function* () { yield new Uint8Array(png); })() };
    }
    async function* metaOnly(): AsyncIterable<FigureUploadPart> {
      yield { kind: "field", name: "meta", value: JSON.stringify({ placement: placement() }) };
    }
    expect((await failure(figures.upload(LOCAL, contentId, fileOnly(), signal()))).code).toBe("invalid_request");
    expect((await failure(figures.upload(LOCAL, contentId, metaOnly(), signal()))).code).toBe("invalid_request");
    expect((await failure(figures.upload(LOCAL, contentId, uploadParts(png, { placement: placement(), extra: 1 }), signal()))).code).toBe("invalid_request");
    expect((await failure(figures.upload(LOCAL, contentId, uploadParts(png, "not an object"), signal()))).code).toBe("invalid_request");
  });
});

describe("FigureService rules", () => {
  it("counts recently deleted figures against the cap, but not expired ones", async () => {
    const { h, contentId, clock, figures } = setup();
    for (let index = 0; index < FIGURES_PER_CONTENT_MAX - 1; index += 1) seedFigure(h, contentId);
    const deleted = seedFigure(h, contentId, { deletedAt: clock.now - DAY_MS });
    const png = readFileSync(patternPng(samples, 16, 16));
    expect(await failure(figures.upload(LOCAL, contentId, uploadParts(png), signal()))).toEqual({ code: "invalid_request.figure_limit", details: { limit: FIGURES_PER_CONTENT_MAX } });
    const asset = addAsset(h, contentId);
    expect((await failure(figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 0 }, signal()))).code).toBe("invalid_request.figure_limit");
    clock.now = deleted.deletedAt! + FIGURE_DELETED_RETENTION_DAYS * DAY_MS;
    expect((await figures.upload(LOCAL, contentId, uploadParts(png), signal())).id).toBeTruthy();
  });

  it("accepts anchors only on a sentence of a revision of this Content", async () => {
    const { h, contentId, fixture, figures } = setup();
    const otherContent = createLocalContent(h);
    const other = lectureTranscripts(otherContent);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, other.asr.revision, other.asr.segments));
    const png = readFileSync(patternPng(samples, 16, 16));
    const foreignRevision = { revisionId: other.asr.revision.id, segmentId: other.asr.segments[0]!.id, side: "after" as const };
    const mixed = { revisionId: fixture.corrected.revision.id, segmentId: fixture.asr.segments[0]!.id, side: "before" as const };
    const unknown = { revisionId: "01NOSUCHREVISION", segmentId: fixture.corrected.segments[0]!.id, side: "before" as const };
    for (const anchor of [foreignRevision, mixed, unknown]) {
      expect((await failure(figures.upload(LOCAL, contentId, uploadParts(png, { placement: placement({ anchor }) }), signal()))).code).toBe("invalid_request.figure_anchor");
    }
    const figure = await figures.upload(LOCAL, contentId, uploadParts(png, { placement: placement({ anchor: anchorOf(fixture) }) }), signal());
    expect((await failure(() => figures.patch(LOCAL, figure.id, { version: 1, placement: placement({ anchor: foreignRevision }) }))).code).toBe("invalid_request.figure_anchor");
    const asset = addAsset(h, contentId);
    expect((await failure(figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 0, placement: placement({ anchor: mixed }) }, signal()))).code).toBe("invalid_request.figure_anchor");
  });

  it("patches caption, width and place at the version read; a stale version is a conflict with the current one", async () => {
    const { h, contentId, fixture, figures } = setup();
    const id = seedFigure(h, contentId).id;
    const captioned = figures.patch(LOCAL, id, { version: 1, caption: "第一行\n第二行" });
    expect(captioned).toMatchObject({ version: 2, caption: "第一行\n第二行" });
    expect(await failure(() => figures.patch(LOCAL, id, { version: 1, widthRatio: 0.4 }))).toEqual({ code: "conflict.figure_changed", details: { currentVersion: 2 } });
    const moved = figures.patch(LOCAL, id, { version: 2, widthRatio: 0.4, placement: placement({ displayMs: 5, anchor: anchorOf(fixture), sortKey: -1 }) });
    expect(moved).toMatchObject({ version: 3, widthRatio: 0.4, caption: "第一行\n第二行", placement: { displayMs: 5, anchor: anchorOf(fixture), sortKey: -1 } });
    expect(figures.patch(LOCAL, id, { version: 3, caption: "   " }).caption).toBeUndefined();
    figures.patch(LOCAL, id, { version: 4, caption: "again" });
    const cleared: FigureDto = figures.patch(LOCAL, id, { version: 5, caption: null, placement: placement({ displayMs: 9 }) });
    expect(cleared).toMatchObject({ version: 6, placement: { displayMs: 9, anchor: null } });
    expect(cleared.caption).toBeUndefined();
  });

  it("deletes softly and idempotently, restores within retention, and reports a purged figure", async () => {
    const { h, contentId, clock, figures } = setup();
    const id = seedFigure(h, contentId).id;
    const deleted = figures.delete(LOCAL, id);
    expect(deleted).toMatchObject({ version: 2, deletedAt: clock.now });
    clock.now += 1_000;
    expect(figures.delete(LOCAL, id)).toEqual(deleted);
    expect(figures.list(LOCAL, contentId)).toMatchObject({ items: [], recentlyDeleted: [{ id }], limit: FIGURES_PER_CONTENT_MAX });
    // A deleted figure cannot be edited, but its image still shows in the recently deleted list.
    expect(await failure(() => figures.patch(LOCAL, id, { version: 2, caption: "x" }))).toEqual({ code: "conflict.figure_changed", details: { currentVersion: 2 } });
    expect(figures.image(LOCAL, id).bytes.length).toBeGreaterThan(0);
    const restored = figures.restore(LOCAL, id);
    expect(restored).toMatchObject({ version: 3 });
    expect(restored.deletedAt).toBeUndefined();
    expect(figures.restore(LOCAL, id)).toEqual(restored);

    figures.delete(LOCAL, id);
    clock.now += FIGURE_DELETED_RETENTION_DAYS * DAY_MS;
    expect(figures.list(LOCAL, contentId).recentlyDeleted).toEqual([]);
    expect((await failure(() => figures.image(LOCAL, id))).code).toBe("not_found");
    expect((await failure(() => figures.restore(LOCAL, id))).code).toBe("not_found.figure_purged");
    expect(figures.purgeExpired()).toBe(1);
    expect(figures.purgeExpired()).toBe(0);
    expect((await failure(() => figures.restore(LOCAL, id))).code).toBe("not_found.figure_purged");
    expect((await failure(() => figures.delete(LOCAL, id))).code).toBe("not_found");
  });

  it("purges only figures past retention, of every user", async () => {
    const { h, contentId, clock, figures } = setup();
    const bobContent = createLocalContent(h, BOB.userId);
    const old = seedFigure(h, contentId, { deletedAt: clock.now - FIGURE_DELETED_RETENTION_DAYS * DAY_MS - 1 });
    const bobs = seedFigure(h, bobContent, { userId: BOB.userId, deletedAt: clock.now - FIGURE_DELETED_RETENTION_DAYS * DAY_MS - 1 });
    const recent = seedFigure(h, contentId, { deletedAt: clock.now - DAY_MS });
    const live = seedFigure(h, contentId);
    expect(figures.purgeExpired()).toBe(2);
    h.repository.withTransaction((scope) => {
      expect(scope.figures.get(LOCAL.userId, old.id)).toBeUndefined();
      expect(scope.figures.get(BOB.userId, bobs.id)).toBeUndefined();
      expect(scope.figures.get(LOCAL.userId, recent.id)).toBeDefined();
      expect(scope.figures.get(LOCAL.userId, live.id)).toBeDefined();
    });
  });

  it("shows another user's figures and Content to no one else, and a trashed Content's figures to no one", async () => {
    const { h, contentId, figures } = setup();
    const id = seedFigure(h, contentId).id;
    const asset = addAsset(h, contentId);
    const png = readFileSync(patternPng(samples, 16, 16));
    const bobCalls: Array<() => unknown> = [
      () => figures.list(BOB, contentId),
      () => figures.capture(BOB, contentId, { assetId: asset.id, atMs: 0 }, signal()),
      () => figures.upload(BOB, contentId, uploadParts(png), signal()),
      () => figures.patch(BOB, id, { version: 1, caption: "bob" }),
      () => figures.delete(BOB, id),
      () => figures.restore(BOB, id),
      () => figures.image(BOB, id),
    ];
    for (const call of bobCalls) expect((await failure(call)).code).toMatch(/^not_found/u);
    h.repository.withTransaction((scope) => scope.contents.trash(LOCAL.userId, contentId, Date.now()));
    for (const call of [
      () => figures.list(LOCAL, contentId),
      () => figures.capture(LOCAL, contentId, { assetId: asset.id, atMs: 0 }, signal()),
      () => figures.upload(LOCAL, contentId, uploadParts(png), signal()),
      () => figures.patch(LOCAL, id, { version: 1, caption: "x" }),
      () => figures.delete(LOCAL, id),
      () => figures.restore(LOCAL, id),
      () => figures.image(LOCAL, id),
    ]) {
      expect((await failure(call)).code).toBe("not_found");
    }
    h.repository.withTransaction((scope) => expect(scope.figures.get(LOCAL.userId, id)).toMatchObject({ version: 1 }));
  });
});
