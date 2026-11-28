import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentCoverService, COVER_LIMITS, type ContentCoverServiceOptions } from "../../../src/server/application/content-covers.ts";
import { CoverFetchCoordinator, type CoverFetchCoordinatorOptions } from "../../../src/server/application/cover-fetch-coordinator.ts";
import { PLATFORMS, type Platform } from "../../../src/server/domain/platform.ts";
import type { FigureImage } from "../../../src/server/application/figure-images.ts";
import type { PlatformSourceAdapter } from "../../../src/server/ports/platform-source.ts";
import { LOCAL, type Harness } from "../pipeline/harness.ts";

/** A tiny lossless WebP (1×1); a route serves the stored bytes as they are. */
export const TINY_WEBP = Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00", "latin1");

/** What the scripted platform answers for a cover: bytes to "decode", or an error to throw. */
export type ScriptedCover = Buffer | Error;

/**
 * A cover service over the harness: the bilibili and YouTube adapters get a scripted
 * `fetchCover`, and the image processor stands in for FFmpeg by storing the fetched bytes as
 * they are, so routes and services can be tested without decoding.
 */
export function scriptedCovers(h: Harness, answer: () => ScriptedCover = () => TINY_WEBP): { covers: ContentCoverService; fetched: string[] } {
  const fetched: string[] = [];
  const fetchCover: NonNullable<PlatformSourceAdapter["fetchCover"]> = async (url, output) => {
    fetched.push(url);
    const bytes = answer();
    if (bytes instanceof Error) throw bytes;
    await writeFile(output.path, bytes);
    return { sizeBytes: bytes.length };
  };
  Object.assign(h.platforms.bilibili, { fetchCover });
  Object.assign(h.platforms.youtube, { fetchCover });
  const images = {
    normalizeFetched: async (_owner: string, fill: (input: { path: string }) => Promise<unknown>): Promise<FigureImage> => {
      const path = join(h.dir, `cover-${h.newId()}`);
      await fill({ path });
      const bytes = await readFile(path);
      return { bytes: new Uint8Array(bytes), width: 1, height: 1, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  };
  const covers = new ContentCoverService({ repository: h.repository, platforms: h.platformAccess, images, details: h.contents });
  return { covers, fetched };
}

/** A bilibili Content of `owner` with a cover URL and no local copy. */
export function platformContentWithCover(h: Harness, owner = LOCAL.userId): string {
  const id = h.newId();
  const bvid = `BV1cvr${id.slice(-6)}`;
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: owner,
      source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${bvid}`, platformContentId: bvid },
      title: "Lecture",
      coverUrl: "https://i0.hdslb.com/bfs/archive/cover.jpg",
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return id;
}

/** One `fetchCover` call of a cover rig, answered by the test unless the rig answers it at once. */
export interface RigCoverCall {
  platform: Platform;
  url: string;
  signal: AbortSignal;
  answer(bytes: Buffer): void;
  fail(error: unknown): void;
  /** True once answered, failed, or ended by its signal. */
  readonly settled: boolean;
}

export interface CoverRig {
  covers: ContentCoverService;
  coordinator: CoverFetchCoordinator;
  /** Every `fetchCover` call so far, in order. */
  calls: RigCoverCall[];
  /** `refreshCoverUrl` calls by Content (platform id), answered by `refreshAnswer`. */
  refreshes: string[];
}

export interface CoverRigOptions {
  /** Answers a call at once; `undefined` leaves it to the test. */
  auto?: (url: string, platform: Platform) => Buffer | Error | undefined;
  /** Platforms whose adapter can re-read a cover link, and what each read answers. */
  refreshable?: readonly Platform[];
  refreshAnswer?: (platformContentId: string) => Promise<string | undefined> | string | undefined;
  /** When false, a pending call ignores its signal, like a step that never looks at it. */
  honourSignal?: boolean;
  coordinator?: Partial<CoverFetchCoordinatorOptions>;
  service?: Partial<ContentCoverServiceOptions>;
}

/**
 * Covers over the harness with every platform's `fetchCover` scripted and an image processor
 * that stores the fetched bytes as they are, so the coordinator and the services can be driven
 * call by call without decoding.
 */
export function coverRig(h: Harness, options: CoverRigOptions = {}): CoverRig {
  const calls: RigCoverCall[] = [];
  const refreshes: string[] = [];
  for (const platform of PLATFORMS) {
    const adapter = h.platforms[platform];
    const fetchCover: NonNullable<PlatformSourceAdapter["fetchCover"]> = async (url, output, _limits, signal) => {
      const auto = options.auto?.(url, platform);
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        const call: RigCoverCall = {
          platform,
          url,
          signal,
          answer: (value) => {
            settled = true;
            resolve(value);
          },
          fail: (error) => {
            settled = true;
            reject(error);
          },
          get settled() {
            return settled;
          },
        };
        calls.push(call);
        if (options.honourSignal !== false) {
          signal.addEventListener("abort", () => call.fail(signal.reason), { once: true });
        }
        if (auto instanceof Error) call.fail(auto);
        else if (auto !== undefined) call.answer(auto);
      });
      await writeFile(output.path, bytes);
      return { sizeBytes: bytes.length };
    };
    Object.assign(adapter, { fetchCover });
    if (options.refreshable?.includes(platform) === true) {
      const refreshCoverUrl: NonNullable<PlatformSourceAdapter["refreshCoverUrl"]> = async (ref) => {
        refreshes.push(ref.platformContentId);
        return options.refreshAnswer?.(ref.platformContentId);
      };
      Object.assign(adapter, { refreshCoverUrl });
    }
  }
  const images = {
    normalizeFetched: async (_owner: string, fill: (input: { path: string }) => Promise<unknown>): Promise<FigureImage> => {
      const path = join(h.dir, `cover-${h.newId()}`);
      await fill({ path });
      const bytes = await readFile(path);
      return { bytes: new Uint8Array(bytes), width: 1, height: 1, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  };
  const coordinator = new CoverFetchCoordinator({ platforms: h.platformAccess, images, limits: COVER_LIMITS, ...options.coordinator });
  const covers = new ContentCoverService({ repository: h.repository, platforms: h.platformAccess, images, details: h.contents, coordinator, ...options.service });
  return { covers, coordinator, calls, refreshes };
}

/** A platform Content of `owner` with `coverUrl` and no local copy; its platform id is `<platform>-<id>`. */
export function rigContent(h: Harness, options: { owner?: string; platform?: Platform; coverUrl?: string | null; id?: string } = {}): string {
  const id = options.id ?? h.newId();
  const platform = options.platform ?? "bilibili";
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: options.owner ?? LOCAL.userId,
      source: { kind: platform, sourceUrl: `https://example.com/${platform}/${id}`, platformContentId: `${platform}-${id}` },
      title: "Lecture",
      ...(options.coverUrl === null ? {} : { coverUrl: options.coverUrl ?? `https://img.example.com/${id}.jpg` }),
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return id;
}
