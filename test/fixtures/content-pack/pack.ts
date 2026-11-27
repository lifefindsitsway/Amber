import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TarPackWriter } from "../../../src/server/adapters/backup/pack-archive.ts";
import type { PackWriteEntry } from "../../../src/server/ports/content-pack.ts";
import { tarHeader, tarPadding, TAR_END_BYTES } from "../../../src/server/adapters/backup/pack-tar.ts";
import type { PackExportBuild } from "../../../src/server/application/content-pack-engine.ts";
import {
  CONTENT_PACK_BASE_FORMAT_VERSION,
  CONTENT_PACK_COVER_FORMAT_VERSION,
  CONTENT_PACK_FORMAT,
  PACK_COLLECTIONS_ENTRY,
  type ContentDocument,
  type ContentPackHeader,
} from "../../../src/server/domain/content-pack/document.ts";

/**
 * Content packs built for tests: valid documents (one revision, one figure, one speaker
 * photo, one media file per Content, and with `cover` a platform source and a cover copy), the
 * real writer, and a raw tar writer for archives the real writer would never produce.
 */

const IMAGES = join(import.meta.dirname, "../images");
export const FIGURE_WEBP = new Uint8Array(readFileSync(join(IMAGES, "lossy.webp")));
export const AVATAR_WEBP = new Uint8Array(readFileSync(join(IMAGES, "lossless.webp")));
export const ANIMATED_WEBP = new Uint8Array(readFileSync(join(IMAGES, "animated.webp")));
/** The cover samples carry: the lossy sample image, 64 × 48 as its VP8 header states. */
export const COVER_WEBP = FIGURE_WEBP;
export const COVER_WIDTH = 64;
export const COVER_HEIGHT = 48;

/** The leading `ftyp` box of an MP4 file (brand `isom`). */
export const MP4_HEAD = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface SampleMedia {
  entry: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  contentId: string;
  key: string;
}

export interface SamplePack {
  build: PackExportBuild;
  media: SampleMedia[];
}

/** `count` Contents, each with a media file of `mediaBytes` random bytes written under `dir`. */
export function sampleBuild(
  dir: string,
  options: { count?: number; mediaBytes?: number; cacheFileName?: (index: number) => string; cover?: (index: number) => boolean } = {},
): SamplePack {
  const count = options.count ?? 1;
  const media: SampleMedia[] = [];
  const contents: PackExportBuild["contents"] = [];
  for (let index = 1; index <= count; index += 1) {
    const key = `origin-${index}`;
    const contentId = `content-${index}`;
    const mediaEntry = `media/${index}/1.mp4`;
    const path = join(dir, `source-${index}.mp4`);
    // An ISO BMFF `ftyp` box first, so the file is the MP4 its document declares; the rest is noise.
    const bytes = Buffer.concat([MP4_HEAD, randomBytes(Math.max(0, (options.mediaBytes ?? 4096) - MP4_HEAD.length))]);
    writeFileSync(path, bytes);
    const mediaSha = sha256(bytes);
    media.push({ entry: mediaEntry, path, sizeBytes: bytes.length, sha256: mediaSha, contentId, key: `${key}-media` });
    const covered = options.cover?.(index) === true;
    const coverEntry = `contents/${index}/cover.webp`;
    const platformId = `BV1${String(index).padStart(9, "0")}`;
    const document: ContentDocument = {
      key,
      source: covered ? { kind: "bilibili", platformContentId: platformId, sourceUrl: `https://www.bilibili.com/video/${platformId}` } : { kind: "local" },
      ...(covered ? { cover: { entry: coverEntry, width: COVER_WIDTH, height: COVER_HEIGHT, bytes: COVER_WEBP.length, sha256: sha256(COVER_WEBP) } } : {}),
      title: `内容 ${index}`,
      fingerprint: `sha256:${mediaSha}`,
      speakers: [{ originContentKey: key, originSpeakerId: "0", ordinal: 1, name: "主讲", colorIndex: 0, avatar: { entry: `contents/${index}/avatars/1.webp`, mime: "image/webp" } }],
      revisions: [
        {
          key: `${key}-rev`,
          entry: `contents/${index}/revisions/1.json`,
          kind: "imported",
          language: "zh-CN",
          timingFidelity: "segment_only",
          generation: { kind: "pack", originalKind: "imported", originalGeneration: "imported" },
          segmentCount: 1,
          createdAt: 1,
        },
      ],
      notes: [],
      figures: [
        {
          key: `${key}-fig`,
          entry: `contents/${index}/figures/1.webp`,
          source: "upload",
          displayMs: 0,
          sortKey: 0,
          widthRatio: 0.7,
          image: { width: 16, height: 16, bytes: FIGURE_WEBP.length, sha256: sha256(FIGURE_WEBP) },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      media: [
        {
          key: `${key}-media`,
          entry: mediaEntry,
          kind: "original",
          displayName: `原片 ${index}.mp4`,
          mimeType: "video/mp4",
          sizeBytes: bytes.length,
          sha256: mediaSha,
          ...(options.cacheFileName === undefined ? {} : { cacheFileName: options.cacheFileName(index) }),
        },
      ],
      createdAt: 1,
    };
    contents.push({
      contentId,
      title: `内容 ${index}`,
      entry: `contents/${index}/content.json`,
      document,
      revisions: [{ entry: `contents/${index}/revisions/1.json`, document: { key: `${key}-rev`, segments: [{ startMs: 0, endMs: 1000, text: "你好" }] } }],
      images: [
        ...(covered ? [{ entry: coverEntry, bytes: COVER_WEBP }] : []),
        { entry: `contents/${index}/avatars/1.webp`, bytes: AVATAR_WEBP },
        { entry: `contents/${index}/figures/1.webp`, bytes: FIGURE_WEBP },
      ],
      media: [{ entry: mediaEntry, assetId: `asset-${index}`, contentId, kind: "original", location: { path }, sizeBytes: bytes.length, sha256: mediaSha }],
    });
  }
  return { build: { collections: { collections: [] }, contents }, media };
}

export function headerOf(build: PackExportBuild): Omit<ContentPackHeader, "entries"> {
  return {
    format: CONTENT_PACK_FORMAT,
    formatVersion: build.contents.some((content) => content.document.cover !== undefined) ? CONTENT_PACK_COVER_FORMAT_VERSION : CONTENT_PACK_BASE_FORMAT_VERSION,
    amberVersion: "0.0.0-test",
    encryption: "none",
    createdAt: 1_700_000_000_000,
    contents: build.contents.map((content) => ({ key: content.document.key, entry: content.entry, ...(content.title === undefined ? {} : { title: content.title }) })),
  };
}

/** The archive entries of a build in pack order, media read straight from their paths. */
export function entriesOf(build: PackExportBuild): PackWriteEntry[] {
  const json = (name: string, value: unknown): PackWriteEntry => ({ name, bytes: Buffer.from(JSON.stringify(value), "utf8") });
  const entries: PackWriteEntry[] = [json(PACK_COLLECTIONS_ENTRY, build.collections)];
  for (const content of build.contents) {
    entries.push(json(content.entry, content.document));
    for (const revision of content.revisions) entries.push(json(revision.entry, revision.document));
    for (const image of content.images) entries.push({ name: image.entry, bytes: image.bytes });
  }
  for (const content of build.contents) {
    for (const media of content.media) {
      const path = "path" in media.location ? media.location.path : "";
      entries.push({ name: media.entry, size: media.sizeBytes, sha256: media.sha256, contentId: media.contentId, withFile: (work) => work(path) });
    }
  }
  return entries;
}

/** Writes a valid pack of `build` to `target` with the real writer. */
export async function writeSamplePack(target: string, build: PackExportBuild): Promise<number> {
  const result = await new TarPackWriter().write({ target, header: headerOf(build), entries: entriesOf(build), signal: new AbortController().signal });
  if (!result.ok) throw new Error("sample pack media changed");
  return result.sizeBytes;
}

export interface RawEntry {
  name: string;
  bytes: Uint8Array;
  /** Overrides the tar type flag (`"2"` symlink, `"5"` directory, `"x"` pax header…). */
  type?: string;
  /** Overrides the size written in the tar header. */
  size?: number;
}

/** A tar of exactly these entries, headers patched as asked, then the end marker. */
export function rawTar(entries: readonly RawEntry[]): Buffer {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const header = tarHeader("placeholder", entry.size ?? entry.bytes.length, 0);
    const name = Buffer.from(entry.name, "utf8");
    header.fill(0, 0, 100);
    header.set(name.subarray(0, 100), 0);
    if (entry.type !== undefined) header[156] = entry.type.charCodeAt(0);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
    parts.push(header, entry.bytes, new Uint8Array(tarPadding(entry.bytes.length)));
  }
  parts.push(new Uint8Array(TAR_END_BYTES));
  return Buffer.concat(parts);
}

/** The documents and files of a build as raw entries, header and manifest included, for tampering. */
export function rawEntriesOf(build: PackExportBuild, media: readonly SampleMedia[]): RawEntry[] {
  const body = entriesOf(build).map((entry): RawEntry => {
    if ("bytes" in entry) return { name: entry.name, bytes: entry.bytes };
    const file = media.find((item) => item.entry === entry.name);
    return { name: entry.name, bytes: readFileSync(file?.path ?? "") };
  });
  const header: ContentPackHeader = { ...headerOf(build), entries: body.map((entry) => ({ name: entry.name, size: entry.bytes.length })) };
  const manifest = { entries: body.map((entry) => ({ name: entry.name, size: entry.bytes.length, sha256: sha256(entry.bytes) })) };
  return [{ name: "header.json", bytes: Buffer.from(JSON.stringify(header)) }, ...body, { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }];
}
