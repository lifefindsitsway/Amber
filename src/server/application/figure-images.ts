import {
  FIGURE_IMAGE_MAX_BYTES,
  FIGURE_LONG_EDGE_MAX_PX,
  FIGURE_PIXELS_MAX,
  FIGURE_PROCESS_CONCURRENCY,
  FIGURE_UPLOAD_MAX_BYTES,
  FIGURE_WEBP_QUALITY,
  FIGURE_WEBP_QUALITY_MIN,
} from "../../shared/defaults.ts";
import type { FigureFrameProblem, FigureImageProblem } from "../../shared/dto/figure.ts";
import { amberError, type AmberError } from "../domain/errors.ts";
import { readImageSize, sniffImageType } from "../domain/figure-image.ts";
import { FileTooLargeError, type FileStore } from "../ports/file-store.ts";
import type { LocalMediaIngest } from "../ports/local-media-ingest.ts";
import { FairSemaphore } from "../pipeline/fair-semaphore.ts";

/**
 * Scratch area of figure image jobs under the data directory. Each job works in its own
 * `<id>/` below it and removes it when done; nothing in it outlives the process, so start-up
 * clears the whole directory.
 */
export const FIGURE_SCRATCH_DIR = "tmp/figures";

/**
 * Encodings tried from `FIGURE_WEBP_QUALITY` down to `FIGURE_WEBP_QUALITY_MIN` when an image
 * comes out over `FIGURE_IMAGE_MAX_BYTES`: this many evenly spaced steps after the first.
 */
const QUALITY_STEPS = 4;

/**
 * How much of an upload is read to find its size. JPEG puts EXIF, XMP and ICC segments (each at
 * most 64 KiB, several of them in a camera file) before the frame header; an image whose size
 * is not found within this prefix is refused as corrupt rather than read further into memory.
 */
const HEADER_PREFIX_BYTES = 1024 * 1024;

/** The qualities to try, best first, ending exactly at the minimum. */
export function figureQualities(): number[] {
  const qualities: number[] = [];
  for (let step = 0; step <= QUALITY_STEPS; step += 1) {
    const quality = Math.round(FIGURE_WEBP_QUALITY - ((FIGURE_WEBP_QUALITY - FIGURE_WEBP_QUALITY_MIN) * step) / QUALITY_STEPS);
    if (qualities.at(-1) !== quality) qualities.push(quality);
  }
  return qualities;
}

/** A stored-ready figure image: WebP bytes, their size in pixels and their hex SHA-256. */
export interface FigureImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  sha256: string;
}

export interface FigureImageProcessorOptions {
  ingest: Pick<LocalMediaIngest, "captureFrame" | "normalizeImage">;
  /** The data directory's store; jobs live under `FIGURE_SCRATCH_DIR`. */
  files: Pick<FileStore, "writeAtomic" | "read" | "remove" | "pathOf">;
  newId: () => string;
  /** Image jobs running at once across all users; `FIGURE_PROCESS_CONCURRENCY` by default. */
  concurrency?: number;
}

export function figureImageError(reason: FigureImageProblem, message: string): AmberError {
  return amberError("invalid_request", message, { code: "invalid_request.figure_image", details: { reason } });
}

export function figureFrameError(reason: FigureFrameProblem, message: string): AmberError {
  return amberError("invalid_request", message, { code: "invalid_request.figure_frame", details: { reason } });
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Turns frames and uploaded images into the one stored form: a WebP within the byte and edge
 * limits, made by FFmpeg from files in a per-job scratch directory (the process interface
 * neither feeds stdin nor returns binary output). At most `concurrency` jobs decode at once;
 * an upload is received before it waits for a slot, so a slow sender holds none. Whatever
 * happens, the job directory is gone when a call returns: a refused image leaves nothing.
 */
export class FigureImageProcessor {
  private readonly options: FigureImageProcessorOptions;
  private readonly slots: FairSemaphore;

  constructor(options: FigureImageProcessorOptions) {
    this.options = options;
    const limit = options.concurrency ?? FIGURE_PROCESS_CONCURRENCY;
    this.slots = new FairSemaphore(() => limit);
  }

  /** Jobs decoding right now, for tests and diagnostics. */
  get inFlight(): number {
    return this.slots.inFlight;
  }

  /** One frame of the video at `path`, `atMs` already clamped to its length. */
  async capture(owner: string, source: { path: string; atMs: number }, signal: AbortSignal): Promise<FigureImage> {
    return this.inJob(async (job) => {
      const image = await this.inSlot(owner, signal, () =>
        this.encode(job, (quality, output) => this.options.ingest.captureFrame(source, output, { maxLongEdge: FIGURE_LONG_EDGE_MAX_PX, quality }, signal), signal),
      );
      if (image === undefined) {
        throw figureFrameError("failed", "the frame stays over the byte limit at the lowest quality");
      }
      return image;
    });
  }

  /**
   * An uploaded or pasted image: at most `FIGURE_UPLOAD_MAX_BYTES`, PNG, JPEG or WebP by its
   * signature, at most `FIGURE_PIXELS_MAX` pixels by its header (checked before any decoding),
   * then re-encoded strictly.
   */
  async upload(owner: string, stream: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<FigureImage> {
    return this.inJob(async (job) => {
      const inputRef = `${job}/input`;
      let fileBytes: number;
      try {
        fileBytes = (await this.options.files.writeAtomic(inputRef, stream, { maxBytes: FIGURE_UPLOAD_MAX_BYTES })).sizeBytes;
      } catch (error) {
        throw error instanceof FileTooLargeError ? figureImageError("too_large", "the image file is over the upload limit") : error;
      }
      const head = await readAll(this.options.files.read(inputRef, { start: 0, end: HEADER_PREFIX_BYTES - 1 }));
      const type = sniffImageType(head);
      if (type === undefined) {
        throw figureImageError("unsupported", "not a PNG, JPEG or WebP by its signature");
      }
      const size = readImageSize(head, type, { fileBytes });
      if (size === undefined) {
        throw figureImageError("corrupt", "the image header gives no size");
      }
      if (size.width * size.height > FIGURE_PIXELS_MAX) {
        throw figureImageError("too_many_pixels", `the image declares ${size.width}×${size.height} pixels`);
      }
      const input = { path: this.options.files.pathOf(inputRef) };
      const image = await this.inSlot(owner, signal, () =>
        this.encode(job, (quality, output) => this.options.ingest.normalizeImage(input, output, { maxLongEdge: FIGURE_LONG_EDGE_MAX_PX, quality }, signal), signal),
      );
      if (image === undefined) {
        throw figureImageError("too_large", "the image stays over the byte limit at the lowest quality");
      }
      return image;
    });
  }

  private async inJob<T>(work: (job: string) => Promise<T>): Promise<T> {
    const job = `${FIGURE_SCRATCH_DIR}/${this.options.newId()}`;
    try {
      return await work(job);
    } finally {
      await this.options.files.remove(job).catch(() => undefined);
    }
  }

  private async inSlot<T>(owner: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return this.slots.run({ key: `figures:${owner}`, createdAt: 0 }, signal, work);
  }

  /**
   * Encodes at falling qualities until the WebP fits `FIGURE_IMAGE_MAX_BYTES`; `undefined`
   * when even the lowest does not. The result is read back and checked: a WebP by signature
   * whose header agrees with the size the tool reported.
   */
  private async encode(
    job: string,
    run: (quality: number, output: { path: string }) => Promise<{ width: number; height: number; bytes: number }>,
    signal: AbortSignal,
  ): Promise<FigureImage | undefined> {
    const outputRef = `${job}/output.webp`;
    for (const quality of figureQualities()) {
      signal.throwIfAborted();
      let reported: { width: number; height: number; bytes: number } | undefined;
      const stored = await this.options.files.writeAtomic(outputRef, async (partialPath) => {
        reported = await run(quality, { path: partialPath });
      });
      if (stored.sizeBytes > FIGURE_IMAGE_MAX_BYTES) {
        continue;
      }
      const bytes = await readAll(this.options.files.read(outputRef));
      const size = sniffImageType(bytes) === "webp" ? readImageSize(bytes, "webp", { fileBytes: bytes.length }) : undefined;
      if (reported === undefined || size === undefined || size.width !== reported.width || size.height !== reported.height || bytes.length !== stored.sizeBytes) {
        throw amberError("internal", "the encoded figure does not match what the tool reported", { code: "internal.tool_failed" });
      }
      return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), width: size.width, height: size.height, sha256: stored.digest.replace(/^sha256:/u, "") };
    }
    return undefined;
  }
}
