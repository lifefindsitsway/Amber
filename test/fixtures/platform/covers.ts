import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentCoverService } from "../../../src/server/application/content-covers.ts";
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
