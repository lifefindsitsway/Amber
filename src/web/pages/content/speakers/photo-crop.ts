import { SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_PX } from "../../../../shared/defaults.ts";
import type { SpeakerAvatarMime } from "../../../../shared/dto/speaker.ts";

/** Largest source photo read into the browser; bigger files are refused before decoding. */
export const PHOTO_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
/** How far the crop can zoom in: the square covers a 1/this share of the short side. */
export const CROP_ZOOM_MAX = 4;
/** Quality of the WebP / JPEG encodings; a 256 px avatar stays far below the size limit. */
const ENCODE_QUALITY = 0.9;

/** A decoded source photo. */
export interface LoadedPhoto {
  /** What the crop view and the encoder draw from. */
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Frees the decoded pixels. */
  release: () => void;
}

/** Where the crop square sits: `zoom` 1 = the whole short side; `center` in source pixels. */
export interface CropState {
  zoom: number;
  centerX: number;
  centerY: number;
}

/** The crop square in source pixels. */
export interface CropSquare {
  x: number;
  y: number;
  side: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The first crop: the whole short side, centred. */
export function initialCrop(photo: { width: number; height: number }): CropState {
  return { zoom: 1, centerX: photo.width / 2, centerY: photo.height / 2 };
}

/** The square a crop state selects, kept wholly inside the photo. */
export function cropSquare(photo: { width: number; height: number }, crop: CropState): CropSquare {
  const zoom = clamp(crop.zoom, 1, CROP_ZOOM_MAX);
  const side = Math.min(photo.width, photo.height) / zoom;
  return {
    side,
    x: clamp(crop.centerX - side / 2, 0, photo.width - side),
    y: clamp(crop.centerY - side / 2, 0, photo.height - side),
  };
}

/** The crop state with the square moved so it stays inside the photo (after a zoom or a pan). */
export function normalizeCrop(photo: { width: number; height: number }, crop: CropState): CropState {
  const square = cropSquare(photo, crop);
  return { zoom: clamp(crop.zoom, 1, CROP_ZOOM_MAX), centerX: square.x + square.side / 2, centerY: square.y + square.side / 2 };
}

/**
 * Moves the square by a drag of `dx`, `dy` pixels on a view `viewPx` wide. Dragging moves the
 * photo under the circle, so the square moves the opposite way.
 */
export function panCrop(photo: { width: number; height: number }, crop: CropState, dx: number, dy: number, viewPx: number): CropState {
  const { side } = cropSquare(photo, crop);
  const scale = side / viewPx;
  return normalizeCrop(photo, { ...crop, centerX: crop.centerX - dx * scale, centerY: crop.centerY - dy * scale });
}

/** Reads a file as a data URL; the page's image policy admits `data:` but not `blob:` sources. */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new PhotoError("unreadable")));
    reader.onerror = () => reject(new PhotoError("unreadable"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => (image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve(image) : reject(new PhotoError("unreadable")));
    image.onerror = () => reject(new PhotoError("unreadable"));
    image.src = url;
  });
}

/** Longest side a decoded photo keeps: avatar size times the zoom limit, so a full zoom still has native pixels. */
export const PHOTO_DECODE_MAX_SIDE = SPEAKER_AVATAR_PX * CROP_ZOOM_MAX;
/** Width of the probe decode that reveals the photo's aspect ratio, after its orientation is applied. */
const PROBE_WIDTH = 64;

/**
 * Decodes a bitmap whose long side is at most `PHOTO_DECODE_MAX_SIDE`, so a huge photo never
 * allocates its full pixel count. The aspect ratio (as the photo is meant to be seen, EXIF
 * orientation applied) comes from a probe decoded at a fixed small width; the bounded decode
 * then names both sides. A browser that cannot resize while decoding throws, and the caller
 * falls back.
 */
async function decodeBounded(file: File): Promise<ImageBitmap> {
  const probe = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: PROBE_WIDTH });
  const ratio = probe.width / probe.height;
  probe.close();
  if (!Number.isFinite(ratio) || ratio <= 0) throw new PhotoError("unreadable");
  const landscape = ratio >= 1;
  const resizeWidth = Math.max(1, Math.round(landscape ? PHOTO_DECODE_MAX_SIDE : PHOTO_DECODE_MAX_SIDE * ratio));
  const resizeHeight = Math.max(1, Math.round(landscape ? PHOTO_DECODE_MAX_SIDE / ratio : PHOTO_DECODE_MAX_SIDE));
  return createImageBitmap(file, { imageOrientation: "from-image", resizeWidth, resizeHeight, resizeQuality: "high" });
}

/**
 * Decodes a chosen file with its EXIF orientation applied. Rejects when it is too large or
 * not an image the browser can draw. The file never becomes an object URL: the page's
 * image policy would refuse it, and a bitmap needs none. Where bounded decoding is not
 * available the file is decoded through an image element at its full size.
 */
export async function loadPhoto(file: File): Promise<LoadedPhoto> {
  if (file.size > PHOTO_SOURCE_MAX_BYTES) throw new PhotoError("too_large");
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await decodeBounded(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through: some formats decode through an image element but not as a bitmap.
    }
  }
  const image = await loadImageElement(await readDataUrl(file));
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => undefined };
}

/** Why a chosen photo could not be used. */
export class PhotoError extends Error {
  readonly reason: "too_large" | "unreadable" | "encode_failed";

  constructor(reason: PhotoError["reason"]) {
    super(reason);
    this.name = "PhotoError";
    this.reason = reason;
  }
}

/** Draws the crop square of a photo onto a canvas of any size; the view and the encoder share it. */
export function drawCrop(context: CanvasRenderingContext2D, photo: LoadedPhoto, crop: CropState, px: number): void {
  const square = cropSquare(photo, crop);
  context.clearRect(0, 0, px, px);
  context.imageSmoothingQuality = "high";
  context.drawImage(photo.source, square.x, square.y, square.side, square.side, 0, 0, px, px);
}

/** The photo as it is uploaded: base64 bytes with their type, and a local preview. */
export interface EncodedAvatar {
  data: string;
  mime: SpeakerAvatarMime;
  /** A data URL of the same bytes, for previews that need no object URL bookkeeping. */
  previewUrl: string;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Base64 of bytes, in chunks that keep `String.fromCharCode` within the argument limit. */
export function base64Of(bytes: Uint8Array): string {
  let text = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) text += String.fromCharCode(...bytes.subarray(at, at + chunk));
  return btoa(text);
}

/**
 * Crops and re-encodes the photo as a `SPEAKER_AVATAR_PX` square. Drawing onto a canvas
 * discards everything the file carried besides pixels (EXIF, GPS, thumbnails). WebP is
 * preferred; a browser that cannot encode it hands back PNG (and JPEG if even that is
 * too large), which the server accepts as well.
 */
export async function encodeAvatar(photo: LoadedPhoto, crop: CropState): Promise<EncodedAvatar> {
  const canvas = document.createElement("canvas");
  canvas.width = SPEAKER_AVATAR_PX;
  canvas.height = SPEAKER_AVATAR_PX;
  const context = canvas.getContext("2d");
  if (context === null) throw new PhotoError("encode_failed");
  drawCrop(context, photo, crop, SPEAKER_AVATAR_PX);
  const attempts: Array<[SpeakerAvatarMime, number | undefined]> = [
    ["image/webp", ENCODE_QUALITY],
    ["image/png", undefined],
    ["image/jpeg", ENCODE_QUALITY],
  ];
  for (const [mime, quality] of attempts) {
    const blob = await toBlob(canvas, mime, quality);
    // A browser without an encoder for the type answers with PNG instead.
    if (blob === null || blob.type !== mime || blob.size > SPEAKER_AVATAR_MAX_BYTES) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const data = base64Of(bytes);
    return { data, mime, previewUrl: `data:${mime};base64,${data}` };
  }
  throw new PhotoError("encode_failed");
}
