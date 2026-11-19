import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  inspectPackAvatar,
  inspectPackWebp,
  PACK_FIGURE_LIMITS,
  readImageSize,
  sniffImageType,
} from "../../../src/server/domain/figure-image.ts";

// Fixtures made with the bundled FFmpeg (see test/fixtures/images/README.md).
const FIXTURES = join(import.meta.dirname, "../../fixtures/images");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

const lossy = fixture("lossy.webp");
const lossless = fixture("lossless.webp");
const alpha = fixture("alpha.webp");
const animated = fixture("animated.webp");

type Chunk = [type: string, payload: Uint8Array];

function chunksOf(webp: Uint8Array): Chunk[] {
  const view = Buffer.from(webp);
  const chunks: Chunk[] = [];
  let at = 12;
  while (at + 8 <= view.length) {
    const size = view.readUInt32LE(at + 4);
    chunks.push([view.toString("latin1", at, at + 4), new Uint8Array(view.subarray(at + 8, at + 8 + size))]);
    at += 8 + size + (size % 2);
  }
  return chunks;
}

function riff(chunks: readonly Chunk[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const [type, payload] of chunks) {
    const header = Buffer.alloc(8);
    header.write(type, 0, "latin1");
    header.writeUInt32LE(payload.length, 4);
    parts.push(header, Buffer.from(payload));
    if (payload.length % 2 === 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return new Uint8Array(Buffer.concat([head, body]));
}

function vp8x(flags: number, width: number, height: number): Uint8Array {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return new Uint8Array(payload);
}

function patched(bytes: Uint8Array, at: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[at] = value;
  return copy;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), Buffer.from(data)])), 0);
  return Buffer.concat([head, Buffer.from(data), crc]);
}

/** The PNG fixture's chunks without the ones a carried avatar may not hold. */
function pngParts(png: Uint8Array): Array<[string, Uint8Array]> {
  const view = Buffer.from(png);
  const parts: Array<[string, Uint8Array]> = [];
  let at = 8;
  while (at < view.length) {
    const length = view.readUInt32BE(at);
    parts.push([view.toString("latin1", at + 4, at + 8), new Uint8Array(view.subarray(at + 8, at + 8 + length))]);
    at += 12 + length;
  }
  return parts;
}

function png(parts: ReadonlyArray<[string, Uint8Array]>): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...parts.map(([type, data]) => pngChunk(type, data))]));
}

const pngSample = fixture("sample.png");
const cleanPngParts = pngParts(pngSample).filter(([type]) => type !== "pHYs");
const cleanPng = png(cleanPngParts);

/** The JPEG fixture without its COM segment (FFmpeg writes an encoder comment). */
function withoutComment(jpeg: Uint8Array): Uint8Array {
  const view = Buffer.from(jpeg);
  let at = 2;
  while (view[at] === 0xff && view[at + 1] !== 0xda) {
    const length = view.readUInt16BE(at + 2);
    if (view[at + 1] === 0xfe) return new Uint8Array(Buffer.concat([view.subarray(0, at), view.subarray(at + 2 + length)]));
    at += 2 + length;
  }
  return jpeg;
}
const jpegSample = fixture("sample.jpg");
const cleanJpeg = withoutComment(jpegSample);

describe("sniffImageType and readImageSize", () => {
  it("identify the three formats by signature and read their declared size", () => {
    expect(sniffImageType(pngSample)).toBe("png");
    expect(sniffImageType(jpegSample)).toBe("jpeg");
    for (const webp of [lossy, lossless, alpha]) expect(sniffImageType(webp)).toBe("webp");
    expect(readImageSize(pngSample, "png")).toEqual({ width: 40, height: 30 });
    expect(readImageSize(jpegSample, "jpeg")).toEqual({ width: 40, height: 30 });
    expect(readImageSize(lossy, "webp")).toEqual({ width: 64, height: 48 });
    expect(readImageSize(lossless, "webp")).toEqual({ width: 64, height: 48 });
    expect(readImageSize(alpha, "webp")).toEqual({ width: 64, height: 48 });
  });

  it("ignore names: a GIF, text or an SVG never passes for an image, whatever it is called", () => {
    expect(sniffImageType(new TextEncoder().encode("GIF89a...."))).toBeUndefined();
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImageType(new Uint8Array(0))).toBeUndefined();
  });

  it("give no size for a header that is cut short or malformed", () => {
    expect(readImageSize(pngSample.subarray(0, 20), "png")).toBeUndefined();
    expect(readImageSize(jpegSample.subarray(0, 30), "jpeg")).toBeUndefined();
    expect(readImageSize(lossy.subarray(0, 16), "webp")).toBeUndefined();
    expect(readImageSize(patched(lossy, 23, 0x00), "webp")).toBeUndefined();
  });

  it("read a huge declared size without decoding, so the caller can refuse it first", () => {
    const header = Buffer.from(pngSample.subarray(0, 33));
    header.writeUInt32BE(100_000, 16);
    header.writeUInt32BE(100_000, 20);
    expect(readImageSize(new Uint8Array(header), "png")).toEqual({ width: 100_000, height: 100_000 });
  });
});

describe("inspectPackWebp", () => {
  it("accepts a lossy, a lossless and an alpha still image", () => {
    expect(inspectPackWebp(lossy)).toEqual({ ok: true, width: 64, height: 48 });
    expect(inspectPackWebp(lossless)).toEqual({ ok: true, width: 64, height: 48 });
    expect(inspectPackWebp(alpha)).toEqual({ ok: true, width: 64, height: 48 });
    // Re-assembling the same chunks gives the same bytes: the builder below is faithful.
    expect(Buffer.from(riff(chunksOf(alpha))).equals(Buffer.from(alpha))).toBe(true);
  });

  it("refuses truncation, a wrong RIFF size and trailing bytes", () => {
    expect(inspectPackWebp(lossy.subarray(0, 8))).toEqual({ ok: false, reason: "truncated" });
    expect(inspectPackWebp(lossy.subarray(0, lossy.length - 10))).toEqual({ ok: false, reason: "container_size" });
    const longer = Buffer.from(lossy);
    longer.writeUInt32LE(longer.readUInt32LE(4) + 2, 4);
    expect(inspectPackWebp(new Uint8Array(longer))).toEqual({ ok: false, reason: "container_size" });
    const trailing = Buffer.concat([Buffer.from(lossy), Buffer.from([0, 0, 0, 0])]);
    trailing.writeUInt32LE(trailing.length - 8, 4);
    expect(inspectPackWebp(new Uint8Array(trailing))).toEqual({ ok: false, reason: "trailing_bytes" });
    const chunkTooLong = Buffer.from(lossy);
    chunkTooLong.writeUInt32LE(chunkTooLong.readUInt32LE(16) + 100, 16);
    expect(inspectPackWebp(new Uint8Array(chunkTooLong))).toEqual({ ok: false, reason: "chunk_size" });
  });

  it("refuses something that is not a WebP", () => {
    expect(inspectPackWebp(pngSample)).toEqual({ ok: false, reason: "not_webp" });
  });

  it("refuses an extra chunk, animation, a colour profile and metadata", () => {
    const [frame] = chunksOf(lossy) as [Chunk];
    expect(inspectPackWebp(riff([frame, ["JUNK", new Uint8Array(4)]]))).toEqual({ ok: false, reason: "chunk_layout" });
    expect(inspectPackWebp(riff([frame, frame]))).toEqual({ ok: false, reason: "chunk_layout" });
    expect(inspectPackWebp(animated)).toEqual({ ok: false, reason: "unsupported_feature" });
    for (const [type, flag] of [["EXIF", 0x08], ["XMP ", 0x04], ["ICCP", 0x20]] as const) {
      expect(inspectPackWebp(riff([["VP8X", vp8x(flag, 64, 48)], frame, [type, new Uint8Array(7)]]))).toEqual({ ok: false, reason: "unsupported_feature" });
      // A flag without its chunk is refused as well.
      expect(inspectPackWebp(riff([["VP8X", vp8x(flag, 64, 48)], frame]))).toEqual({ ok: false, reason: "unsupported_feature" });
    }
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x02, 64, 48)], frame]))).toEqual({ ok: false, reason: "unsupported_feature" });
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x01, 64, 48)], frame]))).toEqual({ ok: false, reason: "chunk_layout" });
  });

  it("refuses an extended header whose canvas disagrees with the bitstream, or whose alpha flag disagrees with its chunks", () => {
    const [, alphaChunk, frame] = chunksOf(alpha) as [Chunk, Chunk, Chunk];
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x10, 65, 48)], alphaChunk, frame]))).toEqual({ ok: false, reason: "size_mismatch" });
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x00, 64, 48)], alphaChunk, frame]))).toEqual({ ok: false, reason: "chunk_layout" });
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x10, 64, 48)], frame]))).toEqual({ ok: false, reason: "chunk_layout" });
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x00, 64, 48)], frame]))).toEqual({ ok: true, width: 64, height: 48 });
    expect(inspectPackWebp(riff([["VP8X", vp8x(0x10, 64, 48)], frame, alphaChunk]))).toEqual({ ok: false, reason: "chunk_layout" });
  });

  it("refuses a bitstream header that is not a still keyframe", () => {
    // Lossy start code lives at payload offset 3 = file offset 23.
    expect(inspectPackWebp(patched(lossy, 23, 0x00))).toEqual({ ok: false, reason: "bitstream" });
    // An inter frame (bit 0 of the frame tag set).
    expect(inspectPackWebp(patched(lossy, 20, (lossy[20] as number) | 0x01))).toEqual({ ok: false, reason: "bitstream" });
    // Lossless signature and version bits.
    expect(inspectPackWebp(patched(lossless, 20, 0x2e))).toEqual({ ok: false, reason: "bitstream" });
    expect(inspectPackWebp(patched(lossless, 24, (lossless[24] as number) | 0x20))).toEqual({ ok: false, reason: "bitstream" });
  });

  it("refuses an image over the edge, pixel or byte limits", () => {
    expect(inspectPackWebp(lossy, { ...PACK_FIGURE_LIMITS, maxLongEdge: 63 })).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectPackWebp(lossy, { ...PACK_FIGURE_LIMITS, maxPixels: 64 * 48 - 1 })).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectPackWebp(lossy, { ...PACK_FIGURE_LIMITS, maxBytes: lossy.length - 1 })).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a non-zero pad byte after an odd chunk", () => {
    // The lossless fixture's VP8L payload is odd, so its file ends with the pad byte.
    expect((chunksOf(lossless)[0] as Chunk)[1].length % 2).toBe(1);
    expect(inspectPackWebp(patched(lossless, lossless.length - 1, 1))).toEqual({ ok: false, reason: "chunk_layout" });
  });
});

describe("inspectPackAvatar", () => {
  it("accepts a WebP, a clean PNG and a clean baseline JPEG within the photo limits", () => {
    expect(inspectPackAvatar(lossy, "image/webp")).toEqual({ ok: true, width: 64, height: 48 });
    expect(inspectPackAvatar(cleanPng, "image/png")).toEqual({ ok: true, width: 40, height: 30 });
    expect(inspectPackAvatar(cleanJpeg, "image/jpeg")).toEqual({ ok: true, width: 40, height: 30 });
  });

  it("refuses bytes that do not match the declared type", () => {
    expect(inspectPackAvatar(cleanPng, "image/webp")).toEqual({ ok: false, reason: "not_webp" });
    expect(inspectPackAvatar(lossy, "image/png")).toEqual({ ok: false, reason: "not_png" });
    expect(inspectPackAvatar(cleanPng, "image/jpeg")).toEqual({ ok: false, reason: "not_jpeg" });
  });

  it("accepts the fixed-size rendering hints encoders add, once each and before the image data", () => {
    expect(inspectPackAvatar(pngSample, "image/png")).toEqual({ ok: true, width: 40, height: 30 });
    const phys = pngParts(pngSample).find(([type]) => type === "pHYs");
    expect(phys).toBeDefined();
    const twice = png([cleanPngParts[0] as [string, Uint8Array], phys as [string, Uint8Array], phys as [string, Uint8Array], ...cleanPngParts.slice(1)]);
    expect(inspectPackAvatar(twice, "image/png")).toEqual({ ok: false, reason: "chunk_layout" });
    const afterData = png([...cleanPngParts.slice(0, -1), phys as [string, Uint8Array], cleanPngParts[cleanPngParts.length - 1] as [string, Uint8Array]]);
    expect(inspectPackAvatar(afterData, "image/png")).toEqual({ ok: false, reason: "chunk_layout" });
  });

  it("refuses a PNG with a bad CRC, a text or unknown chunk, trailing bytes or a cut", () => {
    const badCrc = new Uint8Array(cleanPng);
    badCrc[29] = (badCrc[29] as number) ^ 0xff;
    expect(inspectPackAvatar(badCrc, "image/png")).toEqual({ ok: false, reason: "checksum" });
    const withText = png([cleanPngParts[0] as [string, Uint8Array], ["tEXt", new TextEncoder().encode("Comment\0hi")], ...cleanPngParts.slice(1)]);
    expect(inspectPackAvatar(withText, "image/png")).toEqual({ ok: false, reason: "unsupported_feature" });
    expect(inspectPackAvatar(new Uint8Array([...cleanPng, 0]), "image/png")).toEqual({ ok: false, reason: "trailing_bytes" });
    expect(inspectPackAvatar(cleanPng.subarray(0, cleanPng.length - 12), "image/png")).toEqual({ ok: false, reason: "truncated" });
    const noData = png(cleanPngParts.filter(([type]) => type !== "IDAT"));
    expect(inspectPackAvatar(noData, "image/png")).toEqual({ ok: false, reason: "chunk_layout" });
  });

  it("refuses a JPEG with a comment, EXIF, trailing bytes or a cut", () => {
    expect(inspectPackAvatar(jpegSample, "image/jpeg")).toEqual({ ok: false, reason: "unsupported_feature" });
    const exif = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08]), Buffer.from("Exif\0\0", "latin1"), Buffer.from(cleanJpeg.subarray(2))]);
    expect(inspectPackAvatar(new Uint8Array(exif), "image/jpeg")).toEqual({ ok: false, reason: "unsupported_feature" });
    expect(inspectPackAvatar(new Uint8Array([...cleanJpeg, 0]), "image/jpeg")).toEqual({ ok: false, reason: "trailing_bytes" });
    expect(inspectPackAvatar(cleanJpeg.subarray(0, cleanJpeg.length - 2), "image/jpeg")).toEqual({ ok: false, reason: "truncated" });
  });

  it("applies the photo limits, not the figure limits", () => {
    const big = riff([["VP8X", vp8x(0x00, 600, 400)], ...chunksOf(lossy)]);
    // The canvas disagrees with the frame first; the photo edge limit is checked on a consistent image.
    expect(inspectPackAvatar(big, "image/webp").ok).toBe(false);
    expect(inspectPackAvatar(lossy, "image/webp", { maxBytes: 262144, maxLongEdge: 32, maxPixels: 1024 })).toEqual({ ok: false, reason: "dimensions" });
  });
});

describe("readImageSize on WebP that understates what it carries", () => {
  const [[, lossyBitstream]] = chunksOf(lossy) as [Chunk];

  it("reads an extended still image whose canvas matches its bitstream", () => {
    expect(readImageSize(riff([["VP8X", vp8x(0, 64, 48)], ["VP8 ", lossyBitstream]]), "webp")).toEqual({ width: 64, height: 48 });
    expect(readImageSize(alpha, "webp")).toEqual({ width: 64, height: 48 });
  });

  it("gives no size when the canvas claims less than the bitstream decodes to", () => {
    expect(readImageSize(riff([["VP8X", vp8x(0, 1, 1)], ["VP8 ", lossyBitstream]]), "webp")).toBeUndefined();
    // A bitstream header declaring 16000×16000 behind a 1×1 canvas.
    const huge = Buffer.from(lossyBitstream);
    huge.writeUInt16LE(16_000, 6);
    huge.writeUInt16LE(16_000, 8);
    expect(readImageSize(riff([["VP8X", vp8x(0, 1, 1)], ["VP8 ", new Uint8Array(huge)]]), "webp")).toBeUndefined();
  });

  it("checks an animation's first frame against its canvas", () => {
    const chunks = chunksOf(animated);
    const canvas = chunks[0]?.[1] as Uint8Array;
    const size = { width: Buffer.from(canvas).readUIntLE(4, 3) + 1, height: Buffer.from(canvas).readUIntLE(7, 3) + 1 };
    expect(readImageSize(animated, "webp")).toEqual(size);
    const shrunk = chunks.map(([type, payload]): Chunk => (type === "VP8X" ? [type, vp8x(payload[0] ?? 0, 1, 1)] : [type, payload]));
    expect(readImageSize(riff(shrunk), "webp")).toBeUndefined();
  });

  it("gives no size when the RIFF length disagrees with the file, as with an image appended behind it", () => {
    expect(readImageSize(lossy, "webp", { fileBytes: lossy.length })).toEqual({ width: 64, height: 48 });
    const appended = new Uint8Array(Buffer.concat([lossy, Buffer.from(pngSample)]));
    expect(readImageSize(appended, "webp", { fileBytes: appended.length })).toBeUndefined();
    // Only the start of the file in hand, the length taken from the file itself.
    expect(readImageSize(appended.subarray(0, 64), "webp", { fileBytes: appended.length })).toBeUndefined();
  });
});
