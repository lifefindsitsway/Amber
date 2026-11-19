import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolPath } from "../tools.ts";

/**
 * Images and videos for figure tests, generated with ffmpeg into a test's temp directory so
 * no binary sample enters git, plus readers that decode what Amber wrote.
 */

export function ffmpeg(args: readonly string[]): void {
  const run = spawnSync(toolPath("ffmpeg"), ["-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`ffmpeg failed: ${run.stderr}`);
  }
}

/** Raw pixels of an image (or the first frame of a video) in `pixelFormat`, optionally scaled first. */
export function decodePixels(path: string, pixelFormat: "rgba" | "gray", scale?: string): Buffer {
  const run = spawnSync(
    toolPath("ffmpeg"),
    ["-nostdin", "-v", "error", "-i", `file:${path}`, "-vf", `${scale === undefined ? "" : `scale=${scale},`}format=${pixelFormat}`, "-f", "rawvideo", "-"],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    throw new Error(`ffmpeg could not decode ${path}: ${run.stderr.toString()}`);
  }
  return run.stdout;
}

/** Frames per second and length of `timedVideo`. */
export const TIMED_VIDEO_FPS = 10;
export const TIMED_VIDEO_MS = 10_000;

/**
 * A 10 s video at 10 fps whose every frame is one flat grey, brighter by frame number, so a
 * captured frame tells which frame it was. With an audio track, like a real recording.
 */
export function timedVideo(dir: string): string {
  const path = join(dir, "timed.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", `nullsrc=s=64x48:r=${TIMED_VIDEO_FPS}:d=${TIMED_VIDEO_MS / 1000},format=gray,geq=lum='20+2*N'`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${TIMED_VIDEO_MS / 1000}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", path,
  ]);
  return path;
}

/** The grey level of each frame of a video, decoded the same way as a capture is read. */
export function frameLevels(video: string): number[] {
  return [...decodePixels(video, "gray", "1:1")];
}

/** The frame whose level is nearest to `level`. */
export function nearestFrame(levels: readonly number[], level: number): number {
  let best = 0;
  levels.forEach((candidate, index) => {
    if (Math.abs(candidate - level) < Math.abs((levels[best] ?? 0) - level)) best = index;
  });
  return best;
}

/** An audio-only file. */
export function audioOnly(dir: string): string {
  const path = join(dir, "tone.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", path]);
  return path;
}

/** A marker that must not survive normalization. */
export const METADATA_MARK = "AMBERSECRETMARK";

/**
 * An 80×40 JPEG (red left half, blue right half) carrying EXIF orientation 6 (turn 90° clockwise to
 * view), an EXIF Artist and a comment, both holding `METADATA_MARK`.
 */
export function orientedJpeg(dir: string): string {
  const base = join(dir, "base.jpg");
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=40x40[a];color=c=blue:s=40x40[b];[a][b]hstack,format=yuvj444p", "-frames:v", "1", base]);
  const jpeg = readFileSync(base);
  const artist = Buffer.from(`${METADATA_MARK}\0`, "latin1");
  const entries = 2;
  const dataAt = 8 + 2 + entries * 12 + 4;
  const tiff = Buffer.alloc(dataAt + artist.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(entries, 8);
  // Orientation (0x0112), SHORT, 1 value: 6.
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  // Artist (0x013B), ASCII, stored after the directory.
  tiff.writeUInt16LE(0x013b, 22);
  tiff.writeUInt16LE(2, 24);
  tiff.writeUInt32LE(artist.length, 26);
  tiff.writeUInt32LE(dataAt, 30);
  artist.copy(tiff, dataAt);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]);
  const comment = Buffer.from(METADATA_MARK, "latin1");
  const com = Buffer.from([0xff, 0xfe, (comment.length + 2) >> 8, (comment.length + 2) & 0xff]);
  const path = join(dir, "oriented.jpg");
  writeFileSync(path, Buffer.concat([jpeg.subarray(0, 2), app1, exif, com, comment, jpeg.subarray(2)]));
  return path;
}

/** A 100×50 PNG whose left half is fully transparent and right half opaque red. */
export function transparentPng(dir: string): string {
  const path = join(dir, "alpha.png");
  ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=100x50,format=rgba,geq=r=255:g=0:b=0:a='if(lt(X,50),0,255)'", "-frames:v", "1", path]);
  return path;
}

const THREE_COLOURS = "color=c=black:s=40x30:r=2:d=1.5,format=rgb24,geq=r='if(eq(N,0),255,0)':g='if(eq(N,1),255,0)':b='if(eq(N,2),255,0)'";

/** An animated PNG of three frames: red, green, blue. */
export function animatedPng(dir: string): string {
  const path = join(dir, "anim.png");
  ffmpeg(["-f", "lavfi", "-i", THREE_COLOURS, "-plays", "0", "-f", "apng", path]);
  return path;
}

/** An animated WebP of three frames: red, green, blue. */
export function animatedWebp(dir: string): string {
  const path = join(dir, "anim.webp");
  ffmpeg(["-f", "lavfi", "-i", THREE_COLOURS, "-c:v", "libwebp_anim", "-loop", "0", "-f", "webp", path]);
  return path;
}

/** A detailed 640×480 JPEG cut off inside its image data. */
export function truncatedJpeg(dir: string): string {
  const whole = join(dir, "whole.jpg");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x480,format=yuvj420p", "-frames:v", "1", whole]);
  const bytes = readFileSync(whole);
  const path = join(dir, "truncated.jpg");
  writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length * 0.7)));
  return path;
}

/** A PNG with a test pattern; the pattern source only makes even sizes, so pass even ones. */
export function patternPng(dir: string, width: number, height: number, name = `pattern-${width}x${height}.png`): string {
  const path = join(dir, name);
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${width}x${height}`, "-frames:v", "1", "-c:v", "png", "-f", "image2", path]);
  return path;
}

/** A PNG signature and header declaring `width`×`height`, with no image data behind it. */
export function headerOnlyPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}
