import { describe, expect, it } from "vitest";
import { checkZip, ZIP_MAX_ENTRIES, ZIP_MAX_OFFSET, ZipLimitError, zipStream, type ZipEntry } from "../../../../src/server/domain/export/zip.ts";
import { readZip } from "../../../../src/tooling/zip-reader.ts";

const AT = new Date(2026, 10, 18, 14, 30, 42).getTime();

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("did not fail");
}

const entry = (name: string, text: string): ZipEntry => ({ name, data: Buffer.from(text, "utf8") });

describe("zipStream", () => {
  it("marks every entry as made on Unix with ordinary file permissions, so unzip keeps UTF-8 names as they are", async () => {
    const archive = await collect(zipStream([entry("讲义.md", "x"), entry("images/001.webp", "y")], { modifiedAt: AT }));
    const records: Array<{ madeBy: number; flags: number; attributes: number }> = [];
    for (let at = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0; at = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) {
      records.push({ madeBy: archive.readUInt16LE(at + 4), flags: archive.readUInt16LE(at + 8), attributes: archive.readUInt32LE(at + 38) });
    }
    expect(records).toEqual([
      { madeBy: 0x0314, flags: 0x0800, attributes: 0o100644 * 0x10000 },
      { madeBy: 0x0314, flags: 0x0800, attributes: 0o100644 * 0x10000 },
    ]);
  });

  it("writes stored entries a zip reader takes back byte for byte, Chinese names included", async () => {
    const image = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
    const archive = await collect(zipStream([entry("第一讲：导论.md", "# 标题\n\n正文\n"), { name: "images/001.webp", data: image }], { modifiedAt: AT }));
    const entries = readZip(archive);
    expect(entries.map((item) => item.name)).toEqual(["第一讲：导论.md", "images/001.webp"]);
    expect(entries[0]?.read().toString("utf8")).toBe("# 标题\n\n正文\n");
    expect(entries[1]?.read().equals(image)).toBe(true);
    // Stored, not deflated: the compressed size is the size.
    expect(entries.map((item) => item.compressedSize)).toEqual(entries.map((item) => item.size));
  });

  it("flags names as UTF-8 and stamps the local date and time in every header", async () => {
    const archive = await collect(zipStream([entry("图.txt", "x")], { modifiedAt: AT }));
    const flags = archive.readUInt16LE(6);
    expect(flags & 0x0800).toBe(0x0800);
    expect(archive.readUInt16LE(8)).toBe(0);
    const time = archive.readUInt16LE(10);
    const date = archive.readUInt16LE(12);
    expect({ hour: time >> 11, minute: (time >> 5) & 0x3f, second: (time & 0x1f) * 2 }).toEqual({ hour: 14, minute: 30, second: 42 });
    expect({ year: (date >> 9) + 1980, month: (date >> 5) & 0x0f, day: date & 0x1f }).toEqual({ year: 2026, month: 11, day: 18 });
    // The central record carries the same flag.
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(archive.readUInt16LE(central + 8) & 0x0800).toBe(0x0800);
  });

  it("writes empty files and an empty archive", async () => {
    const archive = await collect(zipStream([entry("empty.md", ""), entry("images/001.webp", "")], { modifiedAt: AT }));
    const entries = readZip(archive);
    expect(entries.map((item) => [item.name, item.size, item.read().length])).toEqual([
      ["empty.md", 0, 0],
      ["images/001.webp", 0, 0],
    ]);
    const none = await collect(zipStream([], { modifiedAt: AT }));
    expect(none.length).toBe(22);
    expect(readZip(none)).toEqual([]);
  });

  it("records each entry at the offset its local header starts", async () => {
    const items = [entry("a.md", "aaa"), entry("images/001.webp", "bb"), entry("images/002.webp", "")];
    const archive = await collect(zipStream(items, { modifiedAt: AT }));
    expect(archive.length).toBe(checkZip(items.map((item) => ({ name: item.name, size: item.data.length }))));
    let offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const locals: number[] = [];
    for (let index = 0; index < items.length; index++) {
      locals.push(archive.readUInt32LE(offset + 42));
      offset += 46 + archive.readUInt16LE(offset + 28);
    }
    expect(locals.map((local) => archive.readUInt32LE(local))).toEqual([0x04034b50, 0x04034b50, 0x04034b50]);
    expect(locals).toEqual([0, 30 + 4 + 3, 30 + 4 + 3 + 30 + 15 + 2]);
  });

  it("takes as many entries as classic zip records and refuses one more before the first byte", async () => {
    expect(ZIP_MAX_ENTRIES).toBe(0xfffe);
    const many = Array.from({ length: ZIP_MAX_ENTRIES }, (_, index): ZipEntry => ({ name: `images/${index}.webp`, data: new Uint8Array(0) }));
    const entries = readZip(await collect(zipStream(many, { modifiedAt: AT })));
    expect(entries).toHaveLength(ZIP_MAX_ENTRIES);
    expect(entries.at(-1)?.name).toBe(`images/${ZIP_MAX_ENTRIES - 1}.webp`);

    const chunks: Uint8Array[] = [];
    const error = await failure(async () => {
      for await (const chunk of zipStream([...many, { name: "one-more", data: new Uint8Array(0) }], { modifiedAt: AT })) chunks.push(chunk);
    });
    expect(error).toBeInstanceOf(ZipLimitError);
    expect((error as ZipLimitError).reason).toBe("entries");
    expect(chunks).toEqual([]);
  });

  it("refuses an archive whose offsets would pass the limit, exactly at the boundary", async () => {
    expect(ZIP_MAX_OFFSET).toBe(0xfffffffe);
    // One entry "a" of n bytes ends at 30 + 1 + n, where the central directory starts.
    const limits = { entries: ZIP_MAX_ENTRIES, offset: 100 };
    expect(checkZip([{ name: "a", size: 69 }], limits)).toBe(100 + 46 + 1 + 22);
    expect(() => checkZip([{ name: "a", size: 70 }], limits)).toThrow(ZipLimitError);
    const fits = await collect(zipStream([{ name: "a", data: new Uint8Array(69) }], { modifiedAt: AT, limits }));
    expect(readZip(fits)[0]?.size).toBe(69);
    const chunks: Uint8Array[] = [];
    const error = await failure(async () => {
      for await (const chunk of zipStream([{ name: "a", data: new Uint8Array(70) }], { modifiedAt: AT, limits })) chunks.push(chunk);
    });
    expect((error as ZipLimitError).reason).toBe("size");
    expect(chunks).toEqual([]);
  });

  it("refuses unusable and repeated names", () => {
    for (const name of ["", "/abs.md", "a\\b.md", "../up.md", "images//001.webp", "images/./001.webp", "a\nb"]) {
      expect(() => checkZip([{ name, size: 0 }]), name).toThrow(ZipLimitError);
    }
    expect(() => checkZip([{ name: "a.md", size: 0 }, { name: "a.md", size: 1 }])).toThrow(ZipLimitError);
    expect(checkZip([{ name: "第一讲.md", size: 0 }])).toBeGreaterThan(0);
  });

  it("stops without a central directory when the entry source fails halfway, so no reader takes the part for a whole archive", async () => {
    async function* source(): AsyncGenerator<ZipEntry> {
      yield entry("doc.md", "正文");
      yield entry("images/001.webp", "img");
      throw new Error("disk went away");
    }
    const chunks: Uint8Array[] = [];
    const error = await failure(async () => {
      for await (const chunk of zipStream(source(), { modifiedAt: AT })) chunks.push(chunk);
    });
    expect((error as Error).message).toBe("disk went away");
    const partial = Buffer.concat(chunks);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBe(false);
    expect(() => readZip(partial)).toThrow(/end of central directory/);
  });

  it("checks a streamed entry against the limits as it arrives, before writing it", async () => {
    async function* source(): AsyncGenerator<ZipEntry> {
      yield { name: "a", data: new Uint8Array(10) };
      yield { name: "b", data: new Uint8Array(60) };
    }
    const chunks: Uint8Array[] = [];
    const error = await failure(async () => {
      for await (const chunk of zipStream(source(), { modifiedAt: AT, limits: { entries: 10, offset: 100 } })) chunks.push(chunk);
    });
    expect((error as ZipLimitError).reason).toBe("size");
    // Only the first entry was written, and no central directory.
    expect(Buffer.concat(chunks).length).toBe(30 + 1 + 10);
  });
});
