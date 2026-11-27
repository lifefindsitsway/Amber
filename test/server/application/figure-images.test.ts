import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  COVER_IMAGE_MAX_BYTES,
  COVER_LONG_EDGE_MAX_PX,
  FIGURE_IMAGE_MAX_BYTES,
  FIGURE_LONG_EDGE_MAX_PX,
  FIGURE_PROCESS_CONCURRENCY,
} from "../../../src/shared/defaults.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import { COVER_LIMITS, ContentCoverService } from "../../../src/server/application/content-covers.ts";
import { FIGURE_SCRATCH_DIR, FigureImageProcessor } from "../../../src/server/application/figure-images.ts";
import { FigureService, type FigureUploadPart } from "../../../src/server/application/figures.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { inspectPackWebp } from "../../../src/server/domain/figure-image.ts";
import type { LocalMediaIngest } from "../../../src/server/ports/local-media-ingest.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { childProcessEnv } from "../../../src/server/ports/process-runner.ts";
import { headerOnlyPng, patternPng } from "../../fixtures/media/figure-images.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { toolsBinDir } from "../../fixtures/tools.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

let samples: string;
beforeAll(() => {
  samples = tempDataDir("amber-figure-image-samples-");
});

const realIngest = (): FfmpegMediaIngest => new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) });
const signal = (): AbortSignal => new AbortController().signal;

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

function scratchLeft(h: Harness): string[] {
  const dir = join(h.dir, FIGURE_SCRATCH_DIR);
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
}

const fillWith = (bytes: Buffer) => async (input: { path: string }) => writeFile(input.path, bytes);

async function* uploadParts(bytes: Buffer): AsyncIterable<FigureUploadPart> {
  yield { kind: "field", name: "meta", value: JSON.stringify({ placement: { displayMs: 0, anchor: null, sortKey: 0 } }) };
  yield {
    kind: "file",
    name: "file",
    stream: (async function* () {
      yield new Uint8Array(bytes);
    })(),
  };
}

describe("FigureImageProcessor.normalizeFetched", () => {
  it("re-encodes a fetched image within the limits it is given, figures keeping theirs", async () => {
    const h = harness();
    const images = new FigureImageProcessor({ ingest: realIngest(), files: h.media.data, newId: h.newId });
    const png = readFileSync(patternPng(samples, 3000, 1000));
    const cover = await images.normalizeFetched(LOCAL.userId, fillWith(png), COVER_LIMITS, signal());
    expect([cover.width, cover.height]).toEqual([COVER_LONG_EDGE_MAX_PX, Math.round((COVER_LONG_EDGE_MAX_PX * 1000) / 3000)]);
    expect(inspectPackWebp(cover.bytes)).toEqual({ ok: true, width: cover.width, height: cover.height });
    expect(cover.bytes.byteLength).toBeLessThanOrEqual(COVER_IMAGE_MAX_BYTES);
    const figure = await images.upload(LOCAL.userId, streamOf(png), signal());
    expect(figure.width).toBe(FIGURE_LONG_EDGE_MAX_PX);
    expect(figure.bytes.byteLength).toBeLessThanOrEqual(FIGURE_IMAGE_MAX_BYTES);
    expect(scratchLeft(h)).toEqual([]);
  });

  it("checks a fetched image like an upload before decoding it, and removes the job either way", async () => {
    const h = harness();
    let decoded = 0;
    const real = realIngest();
    const counting: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: (...args: Parameters<LocalMediaIngest["normalizeImage"]>) => {
        decoded += 1;
        return real.normalizeImage(...args);
      },
    });
    const images = new FigureImageProcessor({ ingest: counting, files: h.media.data, newId: h.newId });
    for (const [bytes, reason] of [
      [Buffer.from("<html>not an image</html>"), "unsupported"],
      [headerOnlyPng(100_000, 100_000), "too_many_pixels"],
    ] as const) {
      const error = await images.normalizeFetched(LOCAL.userId, fillWith(bytes), COVER_LIMITS, signal()).catch((caught: unknown) => caught);
      expect(isAmberError(error) && error.appError.details).toEqual({ reason });
    }
    expect(decoded).toBe(0);
    const failed = await images.normalizeFetched(LOCAL.userId, () => Promise.reject(new Error("download failed")), COVER_LIMITS, signal()).catch((caught: unknown) => caught);
    expect(failed).toBeInstanceOf(Error);
    expect(scratchLeft(h)).toEqual([]);
  });

  it("refuses a WebP whose longer edge comes out over the limit", async () => {
    const h = harness();
    const real = realIngest();
    // A decoder that ignores the edge it is asked for.
    const unscaled: LocalMediaIngest = Object.assign(Object.create(real) as LocalMediaIngest, {
      normalizeImage: (input: { path: string }, output: { path: string }, options: { maxLongEdge: number; quality: number }, abort: AbortSignal) =>
        real.normalizeImage(input, output, { ...options, maxLongEdge: FIGURE_LONG_EDGE_MAX_PX }, abort),
    });
    const images = new FigureImageProcessor({ ingest: unscaled, files: h.media.data, newId: h.newId });
    const error = await images.normalizeFetched(LOCAL.userId, fillWith(readFileSync(patternPng(samples, 2000, 500))), COVER_LIMITS, signal()).catch((caught: unknown) => caught);
    expect(isAmberError(error) && error.appError.code).toBe("internal.tool_failed");
    expect(scratchLeft(h)).toEqual([]);
  });
});

describe("one image processor for figures and covers", () => {
  it("decodes at most FIGURE_PROCESS_CONCURRENCY images at once across figure uploads and cover fetches", async () => {
    const h = harness();
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
    const images = new FigureImageProcessor({ ingest: tracking, files: h.media.data, newId: h.newId });
    const figures = new FigureService({ repository: h.repository, ingest: tracking, media: h.media, files: h.media.data, newId: h.newId, images });
    const covers = new ContentCoverService({ repository: h.repository, platforms: h.platformAccess, images, details: h.contents });
    const png = readFileSync(patternPng(samples, 320, 180));
    const fetchCover: NonNullable<PlatformSourceAdapter["fetchCover"]> = async (_url, output) => {
      await writeFile(output.path, png);
      return { sizeBytes: png.length };
    };
    Object.assign(h.platforms.bilibili, { fetchCover });
    const local = createLocalContent(h);
    const platform = Array.from({ length: 3 }, (_, index) => {
      const id = h.newId();
      h.repository.withTransaction((scope) =>
        scope.contents.insert({
          id,
          userId: LOCAL.userId,
          source: { kind: "bilibili", platformContentId: `BV1sh4r3d00${index}`, sourceUrl: `https://www.bilibili.com/video/BV1sh4r3d00${index}` },
          processingStatus: "succeeded",
          createdAt: 1,
          updatedAt: 1,
        }),
      );
      return id;
    });
    await Promise.all([
      ...[0, 1, 2].map(() => figures.upload(LOCAL, local, uploadParts(png), signal())),
      ...platform.map((id) => covers.saveIfAbsent(LOCAL.userId, id, "https://i0.hdslb.com/bfs/archive/c.jpg", signal())),
    ]);
    expect(peak).toBe(FIGURE_PROCESS_CONCURRENCY);
    expect(figures.list(LOCAL, local).items).toHaveLength(3);
    expect(platform.map((id) => h.repository.withTransaction((scope) => scope.contentCovers.get(LOCAL.userId, id))?.version)).toEqual([1, 1, 1]);
    expect(scratchLeft(h)).toEqual([]);
  });
});

async function* streamOf(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}
