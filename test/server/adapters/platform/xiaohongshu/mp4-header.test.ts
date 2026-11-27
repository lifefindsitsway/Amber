import { describe, expect, it } from "vitest";
import { probeMp4, type Mp4RangeReader } from "../../../../../src/server/adapters/platform/xiaohongshu/mp4-header.ts";
import { mp4File } from "../../../../fixtures/platform/xiaohongshu/pages.ts";

const LIMITS = { chunkBytes: 4096, moovMaxBytes: 65536, maxReads: 4 };

function reader(file: Uint8Array): { read: Mp4RangeReader; reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    read: async (start, length) => {
      reads.push([start, length]);
      return { bytes: file.subarray(start, start + length), totalBytes: file.byteLength };
    },
  };
}

describe("probeMp4", () => {
  it("reads the video track's size and codec from a header-first file in one read", async () => {
    const file = mp4File({ width: 1080, height: 1440, mdatBytes: 100_000 });
    const { read, reads } = reader(file);
    expect(await probeMp4(read, LIMITS)).toEqual({ track: { width: 1080, height: 1440, codec: "avc1" }, totalBytes: file.byteLength });
    expect(reads).toEqual([[0, LIMITS.chunkBytes]]);
  });

  it("skips mdat by its declared size to reach a moov at the end", async () => {
    const file = mp4File({ width: 1920, height: 1080, codec: "hvc1", moovAtEnd: true, mdatBytes: 100_000 });
    const { read, reads } = reader(file);
    expect(await probeMp4(read, LIMITS)).toEqual({ track: { width: 1920, height: 1080, codec: "hvc1" }, totalBytes: file.byteLength });
    expect(reads).toHaveLength(2);
    expect(reads[1]?.[0]).toBeGreaterThan(100_000);
  });

  it("reads a moov larger than one chunk whole, within the limit", async () => {
    const file = mp4File({ width: 720, height: 960, mdatBytes: 10 });
    const { read, reads } = reader(file);
    expect((await probeMp4(read, { ...LIMITS, chunkBytes: 64 }))?.track).toEqual({ width: 720, height: 960, codec: "avc1" });
    expect(reads.length).toBe(2);
    expect(await probeMp4(reader(file).read, { ...LIMITS, chunkBytes: 64, moovMaxBytes: 100 })).toBeUndefined();
  });

  it("turns the size of a quarter-turned track", async () => {
    const file = mp4File({ width: 1080, height: 1920, rotated: true });
    expect((await probeMp4(reader(file).read, LIMITS))?.track).toMatchObject({ width: 1080, height: 1920 });
  });

  it("gives up on files it cannot walk within its reads", async () => {
    expect(await probeMp4(reader(Buffer.from("<html>not a video</html>")).read, LIMITS)).toBeUndefined();
    expect(await probeMp4(reader(Buffer.alloc(16)).read, LIMITS)).toBeUndefined();
    const far = mp4File({ width: 720, height: 960, moovAtEnd: true, mdatBytes: 100_000 });
    expect(await probeMp4(reader(far).read, { ...LIMITS, maxReads: 1 })).toBeUndefined();
  });
});
