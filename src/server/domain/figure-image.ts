import { crc32 } from "node:zlib";
import { FIGURE_IMAGE_MAX_BYTES, FIGURE_LONG_EDGE_MAX_PX, FIGURE_PIXELS_MAX, SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_MAX_PX } from "../../shared/defaults.ts";
import type { SpeakerAvatarMime } from "../../shared/dto/speaker.ts";

/**
 * Image checks done on bytes alone, without decoding a single pixel.
 *
 * Two jobs. An image a user uploads or pastes is identified by its signature and refused by
 * its header size before FFmpeg ever decodes it (a few bytes can declare a picture that
 * would take gigabytes to decode). An image a content pack carries is never decoded by the
 * server at all: decoding proves nothing about bytes (a bit-flipped WebP still decodes), and
 * re-encoding would lose quality on every hop and break byte identity across devices. So a
 * carried image must match a narrow structural whitelist instead — exact lengths, the basic
 * image chunks only, one frame, no metadata — and the browser's sandboxed decoder draws it.
 */

export type ImageType = "png" | "jpeg" | "webp";

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, at: number, expected: ArrayLike<number>): boolean {
  if (at < 0 || at + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[at + index] !== expected[index]) return false;
  }
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

const byte = (bytes: Uint8Array, at: number): number => bytes[at] ?? 0;
const be16 = (bytes: Uint8Array, at: number): number => (byte(bytes, at) << 8) | byte(bytes, at + 1);
const be32 = (bytes: Uint8Array, at: number): number => be16(bytes, at) * 0x10000 + be16(bytes, at + 2);
const le16 = (bytes: Uint8Array, at: number): number => byte(bytes, at) | (byte(bytes, at + 1) << 8);
const le24 = (bytes: Uint8Array, at: number): number => le16(bytes, at) | (byte(bytes, at + 2) << 16);
const le32 = (bytes: Uint8Array, at: number): number => le16(bytes, at) + le16(bytes, at + 2) * 0x10000;

/** The image type by file signature only; names and declared types are never trusted. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) return "webp";
  return undefined;
}

/** Marker bytes that stand alone, without a length: TEM, the restarts and SOI. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

/** Start-of-frame markers: C0–CF without DHT (C4), JPG (C8) and DAC (CC). */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24 || be32(bytes, 8) !== 13 || !startsWith(bytes, 12, ascii("IHDR"))) return undefined;
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/**
 * Walks the marker segments after SOI up to the first frame header; anything that would end
 * the headers first, or a length running past the bytes, gives no size.
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    while (bytes[at] === 0xff) at += 1;
    const marker = bytes[at];
    if (marker === undefined || marker === 0x00) return undefined;
    at += 1;
    if (isStandaloneMarker(marker)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (at + 2 > bytes.length) return undefined;
    const length = be16(bytes, at);
    if (length < 2 || at + length > bytes.length) return undefined;
    if (isFrameMarker(marker)) {
      if (length < 8) return undefined;
      return { height: be16(bytes, at + 3), width: be16(bytes, at + 5) };
    }
    at += length;
  }
  return undefined;
}

/** The size a lossy or lossless bitstream header declares, from its chunk payload at `at`. */
function bitstreamSize(bytes: Uint8Array, type: string, at: number, size: number): ImageSize | undefined {
  if (type === "VP8 ") {
    if (size < 10 || at + 10 > bytes.length || !startsWith(bytes, at + 3, [0x9d, 0x01, 0x2a])) return undefined;
    return { width: le16(bytes, at + 6) & 0x3fff, height: le16(bytes, at + 8) & 0x3fff };
  }
  if (type === "VP8L") {
    if (size < 5 || at + 5 > bytes.length || bytes[at] !== 0x2f) return undefined;
    const packed = le32(bytes, at + 1);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Bytes of an ANMF payload before its frame data: offsets, frame size, duration, flags. */
const ANMF_HEADER_BYTES = 16;

/**
 * The size the image declares. A simple file has one bitstream and its header is the size. An
 * extended file (`VP8X`) declares a canvas, and the decoder allocates by the bitstream, so the
 * two must agree: the still image's bitstream must be exactly the canvas, an animation's first
 * frame must lie inside it with a bitstream of the frame's declared size. A file that cannot be
 * checked that far within `bytes` gives no size.
 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 20) return undefined;
  const first = fourcc(bytes, 12);
  if (first !== "VP8X") return bitstreamSize(bytes, first, 20, le32(bytes, 16));
  if (bytes.length < 30) return undefined;
  const canvas = { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
  let at = 20 + le32(bytes, 16);
  while (at + 8 <= bytes.length) {
    const type = fourcc(bytes, at);
    const size = le32(bytes, at + 4);
    const payload = at + 8;
    if (type === "VP8 " || type === "VP8L") {
      const frame = bitstreamSize(bytes, type, payload, size);
      return frame !== undefined && frame.width === canvas.width && frame.height === canvas.height ? canvas : undefined;
    }
    if (type === "ANMF") {
      if (size < ANMF_HEADER_BYTES + 8 || payload + ANMF_HEADER_BYTES > bytes.length) return undefined;
      const x = le24(bytes, payload) * 2;
      const y = le24(bytes, payload + 3) * 2;
      const frame = { width: le24(bytes, payload + 6) + 1, height: le24(bytes, payload + 9) + 1 };
      if (x + frame.width > canvas.width || y + frame.height > canvas.height) return undefined;
      // Frame data: an optional ALPH chunk, then the bitstream.
      let inner = payload + ANMF_HEADER_BYTES;
      if (inner + 8 <= bytes.length && fourcc(bytes, inner) === "ALPH") inner += 8 + le32(bytes, inner + 4) + (le32(bytes, inner + 4) % 2);
      if (inner + 8 > bytes.length) return undefined;
      const coded = bitstreamSize(bytes, fourcc(bytes, inner), inner + 8, le32(bytes, inner + 4));
      return coded !== undefined && coded.width === frame.width && coded.height === frame.height ? canvas : undefined;
    }
    at = payload + size + (size % 2);
  }
  return undefined;
}

/**
 * The pixel size an image declares in its header, read without decoding; `undefined` when
 * the header cannot be read. Only a guard before decoding: the decoder still checks the rest.
 * With `fileBytes` (the whole file's length, when `bytes` may be only its start) a WebP must
 * also declare exactly that length in its RIFF header, so nothing rides along behind it.
 */
export function readImageSize(bytes: Uint8Array, type: ImageType, options: { fileBytes?: number } = {}): ImageSize | undefined {
  if (type === "webp" && options.fileBytes !== undefined && (bytes.length < 8 || le32(bytes, 4) + 8 !== options.fileBytes)) return undefined;
  const size = type === "png" ? pngSize(bytes) : type === "jpeg" ? jpegSize(bytes) : webpSize(bytes);
  return size === undefined || size.width <= 0 || size.height <= 0 ? undefined : size;
}

// ---------------------------------------------------------------------------------------------
// Structural whitelists for carried images

/**
 * Why a carried image was refused. `too_large`: over the byte cap; `truncated`: shorter than
 * its own headers; `not_webp` / `not_png` / `not_jpeg`: wrong signature for what it claims;
 * `container_size`: the RIFF size field disagrees with the file; `chunk_size`: a chunk or
 * segment runs past the data or has an impossible length; `chunk_layout`: chunks other than an
 * allowed sequence; `unsupported_feature`: animation, colour profile or metadata;
 * `trailing_bytes`: data after the image's end; `bitstream`: a bitstream header that is not a
 * still keyframe of the declared kind; `size_mismatch`: canvas and bitstream disagree;
 * `dimensions`: zero, or over the edge or pixel limits; `checksum`: a PNG chunk CRC failed.
 */
export const PACK_IMAGE_REJECTIONS = [
  "too_large",
  "truncated",
  "not_webp",
  "not_png",
  "not_jpeg",
  "container_size",
  "chunk_size",
  "chunk_layout",
  "unsupported_feature",
  "trailing_bytes",
  "bitstream",
  "size_mismatch",
  "dimensions",
  "checksum",
] as const;
export type PackImageRejection = (typeof PACK_IMAGE_REJECTIONS)[number];

export type PackImageCheck = { ok: true; width: number; height: number } | { ok: false; reason: PackImageRejection };

export interface PackImageLimits {
  maxBytes: number;
  maxLongEdge: number;
  maxPixels: number;
}

export const PACK_FIGURE_LIMITS: PackImageLimits = { maxBytes: FIGURE_IMAGE_MAX_BYTES, maxLongEdge: FIGURE_LONG_EDGE_MAX_PX, maxPixels: FIGURE_PIXELS_MAX };
export const PACK_AVATAR_LIMITS: PackImageLimits = {
  maxBytes: SPEAKER_AVATAR_MAX_BYTES,
  maxLongEdge: SPEAKER_AVATAR_MAX_PX,
  maxPixels: SPEAKER_AVATAR_MAX_PX * SPEAKER_AVATAR_MAX_PX,
};

const reject = (reason: PackImageRejection): PackImageCheck => ({ ok: false, reason });

function withinLimits(size: ImageSize, limits: PackImageLimits): PackImageCheck {
  if (size.width <= 0 || size.height <= 0) return reject("dimensions");
  if (Math.max(size.width, size.height) > limits.maxLongEdge || size.width * size.height > limits.maxPixels) return reject("dimensions");
  return { ok: true, width: size.width, height: size.height };
}

interface RiffChunk {
  type: string;
  /** Offset of the payload. */
  at: number;
  size: number;
}

/** WebP chunk types that mean a feature a carried image may not have. */
const WEBP_FEATURE_CHUNKS = new Set(["ANIM", "ANMF", "ICCP", "EXIF", "XMP "]);

/** VP8X flag bits: reserved (0xC1 of the first byte), ICC, alpha, EXIF, XMP, animation. */
const VP8X_ALPHA = 0x10;
const VP8X_RESERVED = 0xc1;

/** A lossy keyframe header: frame tag, start code, 14-bit sizes with no upscaling. */
function vp8Size(bytes: Uint8Array, chunk: RiffChunk): ImageSize | PackImageRejection {
  if (chunk.size < 10) return "bitstream";
  const tag = le24(bytes, chunk.at);
  const keyframe = (tag & 0x01) === 0;
  const version = (tag >>> 1) & 0x07;
  const shown = (tag >>> 4) & 0x01;
  const firstPartition = tag >>> 5;
  if (!keyframe || version > 3 || shown !== 1 || firstPartition > chunk.size - 10) return "bitstream";
  if (!startsWith(bytes, chunk.at + 3, [0x9d, 0x01, 0x2a])) return "bitstream";
  const width = le16(bytes, chunk.at + 6);
  const height = le16(bytes, chunk.at + 8);
  // The top two bits ask the decoder to upscale; an encoder never sets them for a still image.
  if (width >> 14 !== 0 || height >> 14 !== 0) return "bitstream";
  return { width, height };
}

/** A lossless header: signature 0x2F, 14-bit sizes, alpha hint, version 0. */
function vp8lSize(bytes: Uint8Array, chunk: RiffChunk): ImageSize | PackImageRejection {
  if (chunk.size < 5 || bytes[chunk.at] !== 0x2f) return "bitstream";
  const packed = le32(bytes, chunk.at + 1);
  if (packed >>> 29 !== 0) return "bitstream";
  return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
}

/**
 * Checks that bytes are exactly one still WebP image in one of three layouts — a lone `VP8 `,
 * a lone `VP8L`, or `VP8X` (alpha flag only) + optional `ALPH` + `VP8 ` — with every length
 * exact, padding where the format puts it, and nothing before, between or after. Nothing is
 * decoded.
 */
export function inspectPackWebp(bytes: Uint8Array, limits: PackImageLimits = PACK_FIGURE_LIMITS): PackImageCheck {
  if (bytes.length > limits.maxBytes) return reject("too_large");
  if (bytes.length < 12) return reject("truncated");
  if (!startsWith(bytes, 0, ascii("RIFF")) || !startsWith(bytes, 8, ascii("WEBP"))) return reject("not_webp");
  if (le32(bytes, 4) + 8 !== bytes.length) return reject("container_size");

  const chunks: RiffChunk[] = [];
  let at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return reject("trailing_bytes");
    const type = fourcc(bytes, at);
    const size = le32(bytes, at + 4);
    const end = at + 8 + size;
    if (end > bytes.length) return reject("chunk_size");
    // Odd payloads are followed by one zero pad byte so the next chunk starts even.
    if (size % 2 === 1) {
      if (end >= bytes.length) return reject("chunk_size");
      if (bytes[end] !== 0) return reject("chunk_layout");
    }
    chunks.push({ type, at: at + 8, size });
    at = end + (size % 2);
  }

  const types = chunks.map((chunk) => chunk.type);
  if (types.some((type) => WEBP_FEATURE_CHUNKS.has(type))) return reject("unsupported_feature");
  const layout = types.join("|");

  if (layout === "VP8 " || layout === "VP8L") {
    const chunk = chunks[0] as RiffChunk;
    const size = layout === "VP8 " ? vp8Size(bytes, chunk) : vp8lSize(bytes, chunk);
    return typeof size === "string" ? reject(size) : withinLimits(size, limits);
  }

  if (layout === "VP8X|VP8 " || layout === "VP8X|ALPH|VP8 ") {
    const header = chunks[0] as RiffChunk;
    if (header.size !== 10) return reject("chunk_size");
    const flags = byte(bytes, header.at);
    if ((flags & VP8X_RESERVED) !== 0 || le24(bytes, header.at + 1) !== 0) return reject("chunk_layout");
    // Any flag but alpha announces animation, a colour profile or metadata.
    if ((flags & ~VP8X_ALPHA) !== 0) return reject("unsupported_feature");
    const hasAlpha = layout === "VP8X|ALPH|VP8 ";
    if (((flags & VP8X_ALPHA) !== 0) !== hasAlpha) return reject("chunk_layout");
    if (hasAlpha) {
      const alpha = chunks[1] as RiffChunk;
      const alphaHeader = byte(bytes, alpha.at);
      // Reserved (2 bits) zero, pre-processing 0–1, filtering any, compression 0–1.
      if (alpha.size < 1 || alphaHeader >> 6 !== 0 || ((alphaHeader >> 4) & 0x03) > 1 || (alphaHeader & 0x03) > 1) return reject("bitstream");
    }
    const canvas = { width: le24(bytes, header.at + 4) + 1, height: le24(bytes, header.at + 7) + 1 };
    const frame = vp8Size(bytes, chunks[chunks.length - 1] as RiffChunk);
    if (typeof frame === "string") return reject(frame);
    if (frame.width !== canvas.width || frame.height !== canvas.height) return reject("size_mismatch");
    return withinLimits(frame, limits);
  }

  return reject("chunk_layout");
}

/**
 * PNG chunks a carried avatar may hold: the image itself plus four fixed-size rendering hints
 * that encoders add routinely (pixel density, sRGB intent, gamma, chromaticities). Never text,
 * time, ICC profiles or other metadata.
 */
const PNG_ALLOWED_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "pHYs", "sRGB", "gAMA", "cHRM"]);

/** The exact data length of each fixed-size rendering hint chunk. */
const PNG_HINT_LENGTHS: Readonly<Record<string, number>> = { pHYs: 9, sRGB: 1, gAMA: 4, cHRM: 32 };

/** Bit depths each PNG colour type allows. */
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * A PNG as a strict chunk sequence: IHDR first, optional PLTE and tRNS before the image
 * data, one contiguous run of IDAT, IEND last with nothing after it; every CRC checked.
 */
function inspectPackPng(bytes: Uint8Array, limits: PackImageLimits): PackImageCheck {
  if (bytes.length > limits.maxBytes) return reject("too_large");
  if (!startsWith(bytes, 0, PNG_SIGNATURE)) return reject("not_png");
  let at = 8;
  let size: ImageSize | undefined;
  let colourType = -1;
  const seen: string[] = [];
  while (true) {
    if (at + 12 > bytes.length) return reject("truncated");
    const length = be32(bytes, at);
    const type = fourcc(bytes, at + 4);
    if (length > 0x7fffffff || at + 12 + length > bytes.length) return reject("chunk_size");
    if (!PNG_ALLOWED_CHUNKS.has(type)) return reject(/^[A-Za-z]{4}$/.test(type) ? "unsupported_feature" : "chunk_layout");
    const expected = be32(bytes, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== expected) return reject("checksum");
    const previous = seen[seen.length - 1];
    if (seen.length === 0 ? type !== "IHDR" : type === "IHDR") return reject("chunk_layout");
    if (type === "IHDR") {
      if (length !== 13) return reject("chunk_size");
      size = { width: be32(bytes, at + 8), height: be32(bytes, at + 12) };
      const depth = byte(bytes, at + 16);
      colourType = byte(bytes, at + 17);
      if (!(PNG_BIT_DEPTHS[colourType] ?? []).includes(depth)) return reject("bitstream");
      // Compression and filter method 0; interlace none or Adam7.
      if (byte(bytes, at + 18) !== 0 || byte(bytes, at + 19) !== 0 || byte(bytes, at + 20) > 1) return reject("bitstream");
    }
    if ((type === "PLTE" || type === "tRNS") && (seen.includes("IDAT") || seen.includes(type))) return reject("chunk_layout");
    if (type === "PLTE" && (seen.includes("tRNS") || length === 0 || length % 3 !== 0 || length > 768)) return reject("chunk_layout");
    if (type === "PLTE" && (colourType === 0 || colourType === 4)) return reject("chunk_layout");
    if (type === "IDAT" && seen.includes("IDAT") && previous !== "IDAT") return reject("chunk_layout");
    const hintLength = PNG_HINT_LENGTHS[type];
    if (hintLength !== undefined && (length !== hintLength || seen.includes(type) || seen.includes("IDAT"))) return reject("chunk_layout");
    seen.push(type);
    at += 12 + length;
    if (type === "IEND") {
      if (length !== 0 || !seen.includes("IDAT")) return reject("chunk_layout");
      if (colourType === 3 && !seen.includes("PLTE")) return reject("chunk_layout");
      if (at !== bytes.length) return reject("trailing_bytes");
      break;
    }
  }
  return size === undefined ? reject("truncated") : withinLimits(size, limits);
}

/**
 * Markers a carried JPEG avatar may hold: SOI, a JFIF APP0 without thumbnail, quantisation and
 * Huffman tables, restart interval, one baseline / extended / progressive frame, its scans and
 * EOI. No EXIF, XMP or ICC (APP1–APP15), no comments, nothing after EOI.
 */
function inspectPackJpeg(bytes: Uint8Array, limits: PackImageLimits): PackImageCheck {
  if (bytes.length > limits.maxBytes) return reject("too_large");
  if (!startsWith(bytes, 0, [0xff, 0xd8])) return reject("not_jpeg");
  let at = 2;
  let size: ImageSize | undefined;
  let scans = 0;
  let app0 = false;
  while (true) {
    if (at + 2 > bytes.length) return reject("truncated");
    if (bytes[at] !== 0xff) return reject("chunk_layout");
    const marker = byte(bytes, at + 1);
    at += 2;
    if (marker === 0xd9) {
      if (size === undefined || scans === 0) return reject("chunk_layout");
      if (at !== bytes.length) return reject("trailing_bytes");
      break;
    }
    if (marker === 0xff || marker === 0x00 || isStandaloneMarker(marker)) return reject("chunk_layout");
    if (at + 2 > bytes.length) return reject("truncated");
    const length = be16(bytes, at);
    if (length < 2 || at + length > bytes.length) return reject("chunk_size");
    const segment = bytes.subarray(at + 2, at + length);
    if (marker === 0xe0) {
      // JFIF identifier, version, units, density; no embedded thumbnail.
      if (app0 || size !== undefined || length !== 16 || !startsWith(segment, 0, [...ascii("JFIF"), 0]) || segment[12] !== 0 || segment[13] !== 0) {
        return reject(length !== 16 ? "unsupported_feature" : "chunk_layout");
      }
      app0 = true;
    } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      return reject("unsupported_feature");
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (size !== undefined || length < 8) return reject("chunk_layout");
      const components = byte(segment, 5);
      if (length !== 8 + 3 * components || (components !== 1 && components !== 3) || byte(segment, 0) !== 8) return reject("bitstream");
      size = { height: be16(segment, 1), width: be16(segment, 3) };
    } else if (marker === 0xda) {
      if (size === undefined) return reject("chunk_layout");
      scans += 1;
      at += length;
      // Entropy-coded data runs to the next marker other than a stuffed zero or a restart.
      while (true) {
        if (at + 1 >= bytes.length) return reject("truncated");
        if (bytes[at] === 0xff) {
          const next = byte(bytes, at + 1);
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            at += 2;
            continue;
          }
          break;
        }
        at += 1;
      }
      continue;
    } else if (marker !== 0xdb && marker !== 0xc4 && marker !== 0xdd) {
      // Arithmetic coding, lossless and hierarchical frames, and anything unknown.
      return reject("unsupported_feature");
    }
    at += length;
  }
  return size === undefined ? reject("truncated") : withinLimits(size, limits);
}

/**
 * Checks a speaker photo a content pack carries against the structural whitelist of its
 * declared type; the signature must agree with the declared type. Never decoded here.
 */
export function inspectPackAvatar(bytes: Uint8Array, mime: SpeakerAvatarMime, limits: PackImageLimits = PACK_AVATAR_LIMITS): PackImageCheck {
  if (mime === "image/webp") return inspectPackWebp(bytes, limits);
  if (mime === "image/png") return inspectPackPng(bytes, limits);
  return inspectPackJpeg(bytes, limits);
}
