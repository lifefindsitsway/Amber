import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPackFile, TarPackWriter } from "../../../../src/server/adapters/backup/pack-archive.ts";
import { readTarHeader, tarHeader } from "../../../../src/server/adapters/backup/pack-tar.ts";
import { CONTENT_PACK_FORMAT_VERSION } from "../../../../src/server/domain/content-pack/document.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { CONTENT_PACK_DOCUMENT_MAX_BYTES, CONTENT_PACK_DOCUMENTS_TOTAL_MAX_BYTES, CONTENT_PACK_ENTRIES_MAX } from "../../../../src/shared/defaults.ts";
import {
  ANIMATED_WEBP,
  entriesOf,
  headerOf,
  rawEntriesOf,
  rawTar,
  sampleBuild,
  sha256,
  writeSamplePack,
  type RawEntry,
} from "../../../fixtures/content-pack/pack.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "amber-pack-"));
  dirs.push(dir);
  return dir;
}

const never = new AbortController().signal;

async function refusal(work: () => Promise<unknown>): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return { code: error.appError.code, ...(error.appError.details === undefined ? {} : { details: error.appError.details }) };
    throw error;
  }
  throw new Error("expected a refusal");
}

function writeRaw(dir: string, entries: readonly RawEntry[]): string {
  const path = join(dir, "raw.amberpack");
  writeFileSync(path, rawTar(entries));
  return path;
}

describe("content pack archive", () => {
  it("round-trips: documents, digests, images and staged media come back as written", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir, { count: 2 });
    const target = join(dir, "out.amberpack");
    const size = await writeSamplePack(target, build);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(size).toBe(readFileSync(target).length);

    const source = openPackFile(target);
    expect(await source.sizeBytes()).toBe(size);
    const documents = await source.readDocuments(never);
    expect(documents.contents.map((content) => content.document.key)).toEqual(["origin-1", "origin-2"]);
    expect(documents.contents[0]?.revisions.get("contents/1/revisions/1.json")?.segments[0]?.text).toBe("你好");
    expect([...documents.digests.keys()]).toEqual(
      expect.arrayContaining(["header.json", "collections.json", "manifest.json", "contents/1/content.json", "contents/2/revisions/1.json"]),
    );

    const stageTarget = join(dir, "staged.bin");
    const progress: number[] = [];
    const read = await source.readAll(documents.digests, new Map([["media/2/1.mp4", { path: stageTarget }]]), (bytes) => progress.push(bytes), never, {
      keepImages: new Set(["contents/2/figures/1.webp"]),
    });
    expect([...read.images.keys()]).toEqual(["contents/2/figures/1.webp"]);
    expect(read.staged.get("media/2/1.mp4")).toEqual({ sizeBytes: media[1]?.sizeBytes, sha256: media[1]?.sha256 });
    expect(readFileSync(stageTarget)).toEqual(readFileSync(media[1]?.path ?? ""));
    expect(progress.at(-1)).toBe(size);

    // A standard tar reader sees plain regular files.
    const first = readTarHeader(readFileSync(target).subarray(0, 512));
    expect(first).toMatchObject({ kind: "file", name: "header.json" });
  });

  it("writes sizes beyond the octal field in base-256 and reads them back", () => {
    const size = 9 * 1024 ** 3;
    expect(readTarHeader(tarHeader("media/1/1.mp4", size, 0))).toEqual({ kind: "file", name: "media/1/1.mp4", size });
  });

  it("refuses a manifest digest that disagrees with an entry (tampered hash)", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const manifest = JSON.parse(Buffer.from(entries.at(-1)?.bytes ?? []).toString()) as { entries: Array<{ sha256: string }> };
    (manifest.entries[1] as { sha256: string }).sha256 = "0".repeat(64);
    entries[entries.length - 1] = { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) };
    expect(await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).toEqual({
      code: "backup_invalid.pack_entry",
      details: { reason: "digest", entry: "contents/1/content.json" },
    });
  });

  it("refuses media whose bytes were swapped while the manifest stayed (found by the full read)", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const path = writeRaw(dir, entries);
    const documents = await openPackFile(path).readDocuments(never);
    const index = entries.findIndex((entry) => entry.name === "media/1/1.mp4");
    entries[index] = { name: "media/1/1.mp4", bytes: randomBytes(entries[index]?.bytes.length ?? 0) };
    writeRaw(dir, entries);
    const staged = join(dir, "staged.bin");
    // Damaged, not replaced: the documents and manifest are those of the preview.
    expect(await refusal(() => openPackFile(path).readAll(documents.digests, new Map([["media/1/1.mp4", { path: staged }]]), () => undefined, never))).toEqual({
      code: "backup_invalid.pack_entry",
      details: { reason: "digest", entry: "media/1/1.mp4" },
    });
    expect(existsSync(staged)).toBe(false);
  });

  it("refuses a pack replaced after its preview, even a valid one (T50)", async () => {
    const dir = tempDir();
    const first = sampleBuild(dir);
    const target = join(dir, "pack.amberpack");
    await writeSamplePack(target, first.build);
    const documents = await openPackFile(target).readDocuments(never);
    rmSync(target);
    const second = sampleBuild(join(dir), { count: 1 });
    await writeSamplePack(target, second.build);
    expect((await refusal(() => openPackFile(target).readAll(documents.digests, new Map(), () => undefined, never))).code).toBe("backup_invalid.pack_changed");
  });

  it.each([
    ["path traversal", "../evil.json", "traversal"],
    ["absolute path", "/etc/passwd", "traversal"],
    ["unlisted name", "contents/1/notes.json", "name"],
  ])("refuses an entry with a %s", async (_label, name, reason) => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    entries.splice(1, 0, { name, bytes: Buffer.from("{}") });
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details?.["reason"]).toBe(reason);
  });

  it.each([
    ["symbolic link", "2", "link"],
    ["hard link", "1", "link"],
    ["directory", "5", "directory"],
    ["pax header", "x", "type"],
  ])("refuses a %s entry", async (_label, type, reason) => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    entries[1] = { ...(entries[1] as RawEntry), type };
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details?.["reason"]).toBe(reason);
  });

  it("refuses a duplicated entry", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    entries.splice(2, 0, entries[1] as RawEntry);
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details).toEqual({ reason: "duplicate", entry: "collections.json" });
  });

  it("refuses a tar size that differs from the declared size", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as { entries: Array<{ size: number }> };
    (header.entries[0] as { size: number }).size += 1;
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify(header)) };
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details).toEqual({ reason: "size", entry: "collections.json" });
  });

  it("refuses a document over its size limit before reading it", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as { entries: Array<{ size: number }> };
    (header.entries[0] as { size: number }).size = CONTENT_PACK_DOCUMENT_MAX_BYTES + 1;
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify(header)) };
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details).toEqual({ reason: "too_large", entry: "collections.json" });
  });

  it("refuses more entries than allowed", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as { entries: Array<{ name: string; size: number }> };
    for (let index = 0; index < CONTENT_PACK_ENTRIES_MAX; index += 1) header.entries.push({ name: `media/${Math.floor(index / 1000) + 10}/${index % 1000}.bin`, size: 0 });
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify(header)) };
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details).toEqual({ reason: "count" });
  });

  it("answers pack_newer for a higher format version, before the strict schema", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as Record<string, unknown>;
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify({ ...header, formatVersion: CONTENT_PACK_FORMAT_VERSION + 1, futureField: true })) };
    expect(await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).toEqual({
      code: "invalid_request.pack_newer",
      details: { formatVersion: CONTENT_PACK_FORMAT_VERSION + 1, supportedVersion: CONTENT_PACK_FORMAT_VERSION },
    });
  });

  it("refuses a document with an unknown field", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    (build.contents[0]?.document as unknown as Record<string, unknown>)["extra"] = 1;
    const entries = rawEntriesOf(build, media);
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details).toEqual({ reason: "document", entry: "contents/1/content.json" });
  });

  it("refuses a truncated pack, at preview and at the full read", async () => {
    const dir = tempDir();
    const { build } = sampleBuild(dir, { mediaBytes: 100_000 });
    const target = join(dir, "pack.amberpack");
    await writeSamplePack(target, build);
    const documents = await openPackFile(target).readDocuments(never);
    const bytes = readFileSync(target);
    writeFileSync(target, bytes.subarray(0, bytes.length - 5000));
    expect((await refusal(() => openPackFile(target).readDocuments(never))).details?.["reason"]).toBe("truncated");
    expect((await refusal(() => openPackFile(target).readAll(documents.digests, new Map(), () => undefined, never))).details?.["reason"]).toBe("truncated");
  });

  it("refuses an entry no document refers to", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    build.contents[0]?.media.push({ entry: "media/1/2.mp4", assetId: "x", contentId: "content-1", kind: "original", location: { path: media[0]?.path ?? "" }, sizeBytes: media[0]?.sizeBytes ?? 0, sha256: media[0]?.sha256 ?? "" });
    expect((await refusal(() => openPackFile(writeRaw(dir, rawEntriesOf(build, [...media, { ...(media[0] as (typeof media)[0]), entry: "media/1/2.mp4" }]))).readDocuments(never))).details).toEqual({
      reason: "unreferenced",
      entry: "media/1/2.mp4",
    });
  });

  it("refuses a figure that fails the structural WebP check (animated)", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const content = build.contents[0] as (typeof build.contents)[0];
    content.images[1] = { entry: "contents/1/figures/1.webp", bytes: ANIMATED_WEBP };
    const figure = content.document.figures[0] as (typeof content.document.figures)[0];
    figure.image = { ...figure.image, bytes: ANIMATED_WEBP.length, sha256: sha256(ANIMATED_WEBP) };
    const path = writeRaw(dir, rawEntriesOf(build, media));
    const documents = await openPackFile(path).readDocuments(never);
    expect(await refusal(() => openPackFile(path).readAll(documents.digests, new Map(), () => undefined, never))).toEqual({
      code: "backup_invalid.pack_image",
      details: { entry: "contents/1/figures/1.webp" },
    });
  });

  it("refuses trailing data after the end marker", async () => {
    const dir = tempDir();
    const { build } = sampleBuild(dir);
    const target = join(dir, "pack.amberpack");
    await writeSamplePack(target, build);
    writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("payload")]));
    expect((await refusal(() => openPackFile(target).readDocuments(never))).details).toEqual({ reason: "trailing" });
  });

  it("writer: a media file that changed since it was hashed fails, naming its Content, and leaves no partial", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir, { count: 2 });
    writeFileSync(media[1]?.path ?? "", randomBytes(media[1]?.sizeBytes ?? 0));
    const target = join(dir, "out.amberpack");
    const result = await new TarPackWriter().write({ target, header: headerOf(build), entries: entriesOf(build), signal: never });
    expect(result).toEqual({ ok: false, changedContentId: "content-2", entry: "media/2/1.mp4" });
    expect(existsSync(target) || existsSync(`${target}.partial`)).toBe(false);
  });

  it("streams large media in both directions without memory growing with the file", async () => {
    const dir = tempDir();
    const mediaBytes = 64 * 1024 * 1024;
    const { build } = sampleBuild(dir, { mediaBytes });
    const target = join(dir, "big.amberpack");
    global.gc?.();
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 5);
    try {
      await new TarPackWriter().write({
        target,
        header: headerOf(build),
        entries: entriesOf(build),
        signal: never,
        onProgress: () => {
          peak = Math.max(peak, process.memoryUsage().arrayBuffers);
        },
      });
      const source = openPackFile(target);
      const documents = await source.readDocuments(never);
      await source.readAll(documents.digests, new Map([["media/1/1.mp4", { path: join(dir, "staged.bin") }]]), () => {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      }, never);
    } finally {
      clearInterval(sample);
    }
    // The 64 MiB file and its random source are on disk; buffers in flight stay at a few chunks.
    expect(peak - before).toBeLessThan(12 * 1024 * 1024);
    expect(readFileSync(join(dir, "staged.bin")).length).toBe(mediaBytes);
  }, 60_000);
  it("refuses documents that together exceed their cap, from the header alone", async () => {
    const dir = tempDir();
    const { build, media } = sampleBuild(dir);
    const entries = rawEntriesOf(build, media);
    const header = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString()) as { entries: Array<{ name: string; size: number }> };
    // Each within the per-document cap, together over the total.
    const count = Math.floor(CONTENT_PACK_DOCUMENTS_TOTAL_MAX_BYTES / CONTENT_PACK_DOCUMENT_MAX_BYTES) + 1;
    const each = CONTENT_PACK_DOCUMENT_MAX_BYTES;
    for (let index = 2; index <= count + 1; index += 1) header.entries.push({ name: `contents/1/revisions/${index}.json`, size: each });
    entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify(header)) };
    expect((await refusal(() => openPackFile(writeRaw(dir, entries)).readDocuments(never))).details).toEqual({ reason: "documents_too_large" });
  });

  it("a staged target that cannot be written is reported for its entry; the others are staged; foreign files stay", async () => {
    const dir = tempDir();
    const { build } = sampleBuild(dir, { count: 3 });
    const target = join(dir, "pack.amberpack");
    await writeSamplePack(target, build);
    const source = openPackFile(target);
    const documents = await source.readDocuments(never);
    const foreign = join(dir, "taken.bin");
    writeFileSync(foreign, "someone else's");
    const read = await source.readAll(
      documents.digests,
      new Map([
        ["media/1/1.mp4", { path: join(dir, "no-such-folder", "a.bin") }],
        ["media/2/1.mp4", { path: foreign }],
        ["media/3/1.mp4", { path: join(dir, "c.bin") }],
      ]),
      () => undefined,
      never,
    );
    expect([...read.failed]).toEqual([
      ["media/1/1.mp4", "ENOENT"],
      ["media/2/1.mp4", "EEXIST"],
    ]);
    expect([...read.staged.keys()]).toEqual(["media/3/1.mp4"]);
    expect(readFileSync(foreign, "utf8")).toBe("someone else's");
  });

  it("writes kept images to files in the given directory instead of returning their bytes", async () => {
    const dir = tempDir();
    const { build } = sampleBuild(dir, { count: 2 });
    const target = join(dir, "pack.amberpack");
    await writeSamplePack(target, build);
    const source = openPackFile(target);
    const documents = await source.readDocuments(never);
    const imageDir = join(dir, "images");
    mkdirSync(imageDir);
    const read = await source.readAll(documents.digests, new Map(), () => undefined, never, { keepImages: new Set(["contents/2/figures/1.webp"]), imageDir });
    expect(read.images.size).toBe(0);
    const file = read.imageFiles.get("contents/2/figures/1.webp") ?? "";
    expect(readFileSync(file)).toEqual(Buffer.from(build.contents[1]?.images[1]?.bytes ?? []));
    expect(readdirSync(imageDir)).toHaveLength(1);
  });
});
