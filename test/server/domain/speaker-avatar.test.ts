import { describe, expect, it } from "vitest";
import { SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_MAX_PX } from "../../../src/shared/defaults.ts";
import { inspectSpeakerAvatar } from "../../../src/server/domain/speaker-avatar.ts";

const text = (value: string): number[] => Array.from(value, (character) => character.charCodeAt(0));
const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number): number[] => [...be16(Math.floor(value / 0x10000)), ...be16(value % 0x10000)];
const le16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const le24 = (value: number): number[] => [...le16(value), (value >> 16) & 0xff];
const le32 = (value: number): number[] => [...le16(value), ...le16(Math.floor(value / 0x10000))];

const IEND = [0, 0, 0, 0, ...text("IEND"), 0xae, 0x42, 0x60, 0x82];

/** A PNG of the given size with no pixel data: signature, IHDR and the closing IEND. */
function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x89, ...text("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...IEND]);
}

/** SOI, a JFIF segment, optional fill bytes, a table segment, SOF0 with the size, then SOS. */
function jpeg(width: number, height: number, options: { marker?: number; fill?: number } = {}): Uint8Array {
  const fill = Array.from({ length: options.fill ?? 0 }, () => 0xff);
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, ...be16(16), ...text("JFIF"), 0, 1, 1, 0, ...be16(1), ...be16(1), 0, 0,
    ...fill,
    0xff, 0xc4, ...be16(5), 0, 1, 2,
    ...fill,
    0xff, options.marker ?? 0xc0, ...be16(11), 8, ...be16(height), ...be16(width), 1, 1, 0x11, 0,
    0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0,
    0xff, 0xd9,
  ]);
}

function riff(chunk: string, payload: number[], declaredExtra = 0): Uint8Array {
  const body = [...text("WEBP"), ...text(chunk), ...le32(payload.length), ...payload];
  return Uint8Array.from([...text("RIFF"), ...le32(body.length + declaredExtra), ...body]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);
}

function webpLossless(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return riff("VP8L", [0x2f, ...le32(packed >>> 0), 0, 0]);
}

function webpExtended(width: number, height: number): Uint8Array {
  return riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

describe("inspectSpeakerAvatar", () => {
  it("reads the type and size of a PNG from its header", () => {
    expect(inspectSpeakerAvatar(png(256, 128))).toEqual({ ok: true, mime: "image/png", width: 256, height: 128 });
  });

  it("reads a JPEG's size from the first frame header, past other segments and fill bytes", () => {
    expect(inspectSpeakerAvatar(jpeg(300, 200))).toEqual({ ok: true, mime: "image/jpeg", width: 300, height: 200 });
    expect(inspectSpeakerAvatar(jpeg(300, 200, { fill: 3 }))).toEqual({ ok: true, mime: "image/jpeg", width: 300, height: 200 });
    // A progressive frame header carries the size at the same place.
    expect(inspectSpeakerAvatar(jpeg(64, 48, { marker: 0xc2 }))).toEqual({ ok: true, mime: "image/jpeg", width: 64, height: 48 });
  });

  it("does not take the Huffman table marker for a frame header", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xc4, ...be16(5), 0, 1, 2, 0xff, 0xda, ...be16(2)]);
    expect(inspectSpeakerAvatar(bytes)).toEqual({ ok: false, reason: "malformed" });
  });

  it("reads the size of lossy, lossless and extended WebP", () => {
    expect(inspectSpeakerAvatar(webpLossy(200, 100))).toEqual({ ok: true, mime: "image/webp", width: 200, height: 100 });
    expect(inspectSpeakerAvatar(webpLossless(256, 256))).toEqual({ ok: true, mime: "image/webp", width: 256, height: 256 });
    expect(inspectSpeakerAvatar(webpExtended(512, 1))).toEqual({ ok: true, mime: "image/webp", width: 512, height: 1 });
  });

  it("accepts the largest allowed size and refuses one pixel more", () => {
    expect(inspectSpeakerAvatar(png(SPEAKER_AVATAR_MAX_PX, SPEAKER_AVATAR_MAX_PX)).ok).toBe(true);
    expect(inspectSpeakerAvatar(png(SPEAKER_AVATAR_MAX_PX + 1, 10))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(png(10, SPEAKER_AVATAR_MAX_PX + 1))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(jpeg(SPEAKER_AVATAR_MAX_PX + 1, 10))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(webpLossy(10, SPEAKER_AVATAR_MAX_PX + 1))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(webpLossless(SPEAKER_AVATAR_MAX_PX + 1, 10))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(webpExtended(10, SPEAKER_AVATAR_MAX_PX + 1))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(webpExtended(SPEAKER_AVATAR_MAX_PX + 1, 10))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(webpExtended(SPEAKER_AVATAR_MAX_PX, SPEAKER_AVATAR_MAX_PX)).ok).toBe(true);
  });

  it("refuses a zero width or height", () => {
    expect(inspectSpeakerAvatar(png(0, 10))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(png(10, 0))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(jpeg(0, 10))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectSpeakerAvatar(webpLossy(10, 0))).toEqual({ ok: false, reason: "dimensions" });
  });

  it("refuses a PNG size that overflows 32 bits of signed arithmetic", () => {
    expect(inspectSpeakerAvatar(png(0xffffffff, 1))).toEqual({ ok: false, reason: "dimensions" });
  });

  it("refuses more bytes than allowed, whatever the header says", () => {
    const padded = (total: number): Uint8Array => {
      const bytes = new Uint8Array(total);
      const small = png(10, 10);
      // Header first, closing chunk last, whatever lies between.
      bytes.set(small.subarray(0, small.length - IEND.length));
      bytes.set(IEND, total - IEND.length);
      return bytes;
    };
    expect(inspectSpeakerAvatar(padded(SPEAKER_AVATAR_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
    expect(inspectSpeakerAvatar(padded(SPEAKER_AVATAR_MAX_BYTES)).ok).toBe(true);
  });

  it("refuses empty input, SVG, GIF and plain text", () => {
    expect(inspectSpeakerAvatar(new Uint8Array())).toEqual({ ok: false, reason: "empty" });
    const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
    expect(inspectSpeakerAvatar(encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).toEqual({ ok: false, reason: "unsupported" });
    expect(inspectSpeakerAvatar(encode("<?xml version='1.0'?><svg width='1' height='1'/>"))).toEqual({ ok: false, reason: "unsupported" });
    expect(inspectSpeakerAvatar(encode("GIF89a\n\x01\x00\x01\x00"))).toEqual({ ok: false, reason: "unsupported" });
    expect(inspectSpeakerAvatar(encode("avatar.png"))).toEqual({ ok: false, reason: "unsupported" });
  });

  it("decides by the bytes alone: a PNG named or declared as anything else is still a PNG, an SVG named .png is refused", () => {
    // There is no name or declared type to pass, so the verdict can only come from the bytes.
    expect(inspectSpeakerAvatar(png(16, 16))).toMatchObject({ ok: true, mime: "image/png" });
    expect(inspectSpeakerAvatar(new TextEncoder().encode("<svg/>"))).toMatchObject({ ok: false });
  });

  it("refuses truncated headers", () => {
    expect(inspectSpeakerAvatar(png(10, 10).slice(0, 23))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(png(10, 10).slice(0, 8))).toEqual({ ok: false, reason: "malformed" });
    const frame = jpeg(10, 10);
    const frameAt = frame.findIndex((byte, index) => byte === 0xff && frame[index + 1] === 0xc0);
    expect(inspectSpeakerAvatar(frame.slice(0, frameAt + 6))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(frame.slice(0, 3))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(Uint8Array.from([0xff, 0xd8, 0xff]))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(webpLossy(10, 10).slice(0, 27))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(webpExtended(10, 10).slice(0, 26))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(Uint8Array.from([...text("RIFF"), ...le32(100), ...text("WEBP")]))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a PNG or JPEG cut short after its header, without the closing chunk or end marker", () => {
    const whole = png(10, 10);
    expect(inspectSpeakerAvatar(whole.slice(0, whole.length - 1))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(whole.slice(0, whole.length - IEND.length))).toEqual({ ok: false, reason: "malformed" });
    // A closing chunk that is not IEND, or has a wrong CRC, is not one.
    const wrongCrc = Uint8Array.from(whole);
    wrongCrc[wrongCrc.length - 1] = 0x00;
    expect(inspectSpeakerAvatar(wrongCrc)).toEqual({ ok: false, reason: "malformed" });
    const image = jpeg(10, 10);
    expect(inspectSpeakerAvatar(image.slice(0, image.length - 2))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(image.slice(0, image.length - 1))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a WebP whose RIFF size claims more bytes than there are", () => {
    expect(inspectSpeakerAvatar(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(10), ...le16(10), 0, 0], 4096))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a PNG without IHDR first and a lossy WebP without its start code", () => {
    const bytes = png(10, 10);
    bytes.set(text("IDAT"), 12);
    expect(inspectSpeakerAvatar(bytes)).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(riff("VP8 ", [0, 0, 0, 0, 0, 0, ...le16(10), ...le16(10), 0, 0]))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(riff("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a JPEG that reaches scan data or the end of the image before any frame header", () => {
    expect(inspectSpeakerAvatar(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0]))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]))).toEqual({ ok: false, reason: "malformed" });
    expect(inspectSpeakerAvatar(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...be16(1)]))).toEqual({ ok: false, reason: "malformed" });
  });
});
