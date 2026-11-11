import { SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_MAX_PX } from "../../shared/defaults.ts";
import type { SpeakerAvatarMime } from "../../shared/dto/speaker.ts";

/** Why bytes cannot be a speaker photo. */
export type SpeakerAvatarRejection = "empty" | "too_large" | "unsupported" | "malformed" | "dimensions";

export type SpeakerAvatarCheck =
  | { ok: true; mime: SpeakerAvatarMime; width: number; height: number }
  | { ok: false; reason: SpeakerAvatarRejection };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Signature (8), IHDR chunk length (4), `IHDR` (4), width (4), height (4). */
const PNG_HEADER_BYTES = 24;
/** Length 0, `IEND`, and its fixed CRC: the last 12 bytes of every complete PNG. */
const PNG_TRAILER = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
/** `RIFF`, size, `WEBP`, then the first chunk's fourcc and size. */
const WEBP_HEADER_BYTES = 20;

function startsWith(bytes: Uint8Array, at: number, expected: ArrayLike<number>): boolean {
  if (at + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[at + index] !== expected[index]) return false;
  }
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

const be16 = (bytes: Uint8Array, at: number): number => ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
const be32 = (bytes: Uint8Array, at: number): number => (be16(bytes, at) * 0x10000) + be16(bytes, at + 2);
const le16 = (bytes: Uint8Array, at: number): number => (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
const le24 = (bytes: Uint8Array, at: number): number => le16(bytes, at) | ((bytes[at + 2] as number) << 16);
const le32 = (bytes: Uint8Array, at: number): number => le16(bytes, at) + le16(bytes, at + 2) * 0x10000;

type Dimensions = { width: number; height: number } | "malformed";

function pngDimensions(bytes: Uint8Array): Dimensions {
  if (bytes.length < PNG_HEADER_BYTES || !startsWith(bytes, 12, ascii("IHDR"))) return "malformed";
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/** Marker bytes that stand alone, without a length: TEM, the restarts and SOI. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

/** Start-of-frame markers: C0–CF without the table, lossless-extension and arithmetic-conditioning ones. */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Walks the marker segments after SOI up to the first frame header. Anything that would end
 * the headers first (scan data, end of image, a stuffed byte outside scan data) or run past
 * the bytes is malformed.
 */
function jpegDimensions(bytes: Uint8Array): Dimensions {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return "malformed";
    // Any number of 0xFF fill bytes may precede a marker.
    while (bytes[at] === 0xff) at += 1;
    const marker = bytes[at];
    if (marker === undefined || marker === 0x00) return "malformed";
    at += 1;
    if (isStandaloneMarker(marker)) continue;
    // EOI or SOS before any frame header: no dimensions to read.
    if (marker === 0xd9 || marker === 0xda) return "malformed";
    if (at + 2 > bytes.length) return "malformed";
    const length = be16(bytes, at);
    if (length < 2 || at + length > bytes.length) return "malformed";
    if (isFrameMarker(marker)) {
      // Length, precision, height, width, component count.
      if (length < 8) return "malformed";
      return { height: be16(bytes, at + 3), width: be16(bytes, at + 5) };
    }
    at += length;
  }
  return "malformed";
}

function webpDimensions(bytes: Uint8Array): Dimensions {
  if (bytes.length < WEBP_HEADER_BYTES) return "malformed";
  // The RIFF size counts everything after its own field; less data than that is truncated.
  if (le32(bytes, 4) + 8 > bytes.length) return "malformed";
  if (startsWith(bytes, 12, ascii("VP8 "))) {
    // Frame tag (3), start code (3), then 14-bit width and height.
    if (bytes.length < 30 || !startsWith(bytes, 23, [0x9d, 0x01, 0x2a])) return "malformed";
    return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
  }
  if (startsWith(bytes, 12, ascii("VP8L"))) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return "malformed";
    const packed = le32(bytes, 21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(bytes, 12, ascii("VP8X"))) {
    // Flags and reserved (4), then 24-bit canvas width − 1 and height − 1.
    if (bytes.length < 30) return "malformed";
    return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
  }
  return "malformed";
}

/**
 * Decides whether bytes are an acceptable speaker photo from the bytes alone: the type comes
 * from the file signature (PNG, JPEG, WebP; never from a name or a client-declared type),
 * and the pixel size from the image header. Pixels are never decoded, so a hostile file
 * costs a few byte reads. Anything else (SVG, GIF, text, data cut short) is rejected.
 */
export function inspectSpeakerAvatar(bytes: Uint8Array): SpeakerAvatarCheck {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > SPEAKER_AVATAR_MAX_BYTES) return { ok: false, reason: "too_large" };
  let mime: SpeakerAvatarMime;
  let size: Dimensions;
  if (startsWith(bytes, 0, PNG_SIGNATURE)) {
    mime = "image/png";
    size = pngDimensions(bytes);
  } else if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) {
    mime = "image/jpeg";
    size = jpegDimensions(bytes);
  } else if (startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) {
    mime = "image/webp";
    size = webpDimensions(bytes);
  } else {
    return { ok: false, reason: "unsupported" };
  }
  if (size === "malformed") return { ok: false, reason: "malformed" };
  const { width, height } = size;
  if (width < 1 || height < 1 || width > SPEAKER_AVATAR_MAX_PX || height > SPEAKER_AVATAR_MAX_PX) {
    return { ok: false, reason: "dimensions" };
  }
  // A header alone proves little: data cut short after it would still pass, so the end
  // marker of the format must be there too (WebP's RIFF size was checked with its header).
  if (mime === "image/png" && !startsWith(bytes, bytes.length - PNG_TRAILER.length, PNG_TRAILER)) return { ok: false, reason: "malformed" };
  if (mime === "image/jpeg" && !startsWith(bytes, bytes.length - 2, [0xff, 0xd9])) return { ok: false, reason: "malformed" };
  return { ok: true, mime, width, height };
}
