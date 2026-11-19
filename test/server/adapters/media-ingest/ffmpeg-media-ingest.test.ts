import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FIGURE_LONG_EDGE_MAX_PX, FIGURE_PIXELS_MAX, FIGURE_WEBP_QUALITY } from "../../../../src/shared/defaults.ts";
import { FfmpegMediaIngest } from "../../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { inspectPackWebp } from "../../../../src/server/domain/figure-image.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import {
  animatedPng,
  animatedWebp,
  audioOnly,
  decodePixels,
  ffmpeg,
  frameLevels,
  METADATA_MARK,
  nearestFrame,
  orientedJpeg,
  patternPng,
  TIMED_VIDEO_FPS,
  TIMED_VIDEO_MS,
  timedVideo,
  transparentPng,
  truncatedJpeg,
} from "../../../fixtures/media/figure-images.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import { toolPath, toolsBinDir } from "../../../fixtures/tools.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const ingest = (): FfmpegMediaIngest =>
  new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) });
const signal = (): AbortSignal => new AbortController().signal;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("FfmpegMediaIngest", () => {
  it("probes duration, audio track, container and fingerprint of each fixture", async () => {
    for (const [name, fixture] of Object.entries(mediaFixtures())) {
      const probe = await ingest().probe(fixture.path, signal());
      expect(Math.abs(probe.durationMs - fixture.meta.durationMs), name).toBeLessThanOrEqual(100);
      expect(probe.hasAudio, name).toBe(fixture.meta.hasAudio);
      expect(probe.mimeType, name).toBe(fixture.meta.mimeType);
      expect(probe.fingerprint).toBe(`sha256:${createHash("sha256").update(readFileSync(fixture.path)).digest("hex")}`);
    }
  });

  it("rejects a text file whatever its extension", async () => {
    const path = join(tempDataDir("amber-ingest-"), "notes.mp4");
    writeFileSync(path, "this is plain text pretending to be a video\n".repeat(20));
    expect(await codeOf(ingest().probe(path, signal()))).toBe("media_unsupported_type");
  });

  it("rejects a file whose leading bytes pass but ffprobe cannot parse", async () => {
    const path = join(tempDataDir("amber-ingest-"), "broken.flac");
    writeFileSync(path, Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(64)]));
    expect(await codeOf(ingest().probe(path, signal()))).toBe("media_unsupported_type");
  });

  it("extracts mono 16 kHz FLAC that ffprobe recognizes", async () => {
    const { withAudio } = mediaFixtures();
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    const result = await ingest().extractAudio({ path: withAudio.path }, { path: output }, signal());
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(Math.abs(result.durationMs - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
    const probed = spawnSync(
      toolPath("ffprobe"),
      ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name:stream=codec_name,channels,sample_rate", "-i", `file:${output}`],
      { encoding: "utf8" },
    );
    const json = JSON.parse(probed.stdout) as { format: { format_name: string }; streams: Array<{ codec_name: string; channels: number; sample_rate: string }> };
    expect(json.format.format_name).toBe("flac");
    expect(json.streams).toEqual([{ codec_name: "flac", channels: 1, sample_rate: "16000" }]);
  });

  it("reports extraction progress against the duration hint from ffmpeg's out_time, ending at 1", async () => {
    const { withAudio } = mediaFixtures();
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    const progress: number[] = [];
    // Twice the real duration: what ffmpeg wrote can only reach about half of it, so a value
    // near 0.5 proves `out_time_us` was parsed rather than only the final report.
    await ingest().extractAudio({ path: withAudio.path }, { path: output }, signal(), {
      durationMs: withAudio.meta.durationMs * 2,
      onProgress: (value) => progress.push(value),
    });
    expect(progress.some((value) => value > 0.4 && value < 0.6)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("reports only completion when extraction has no duration hint", async () => {
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    const progress: number[] = [];
    await ingest().extractAudio({ path: mediaFixtures().withAudio.path }, { path: output }, signal(), { onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([1]);
  });

  it("fails extraction of a file without audio with media_no_audio", async () => {
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    expect(await codeOf(ingest().extractAudio({ path: mediaFixtures().noAudio.path }, { path: output }, signal()))).toBe("media_no_audio");
  });

  describe("clipAudio", () => {
    const extracted = async (): Promise<string> => {
      const path = join(tempDataDir("amber-ingest-"), "audio.flac");
      await ingest().extractAudio({ path: mediaFixtures().withAudio.path }, { path }, signal());
      return path;
    };
    const probeClip = (path: string) => {
      const probed = spawnSync(
        toolPath("ffprobe"),
        ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name,duration:stream=codec_name,channels,sample_rate", "-i", `file:${path}`],
        { encoding: "utf8" },
      );
      return JSON.parse(probed.stdout) as {
        format: { format_name: string; duration: string };
        streams: Array<{ codec_name: string; channels: number; sample_rate: string }>;
      };
    };

    it("cuts the range as mono 16 kHz PCM WAV, written to a path without an extension", async () => {
      const output = join(tempDataDir("amber-ingest-"), "clip.partial");
      const result = await ingest().clipAudio({ path: await extracted() }, { path: output }, { startMs: 500, endMs: 2000 }, "audio/wav", signal());
      const json = probeClip(output);
      expect(json.format.format_name).toBe("wav");
      expect(json.streams).toEqual([{ codec_name: "pcm_s16le", channels: 1, sample_rate: "16000" }]);
      expect(Math.abs(Number(json.format.duration) * 1000 - 1500)).toBeLessThanOrEqual(20);
      expect(result.sizeBytes).toBe(readFileSync(output).length);
    });

    it("cuts the range as mono MP3", async () => {
      const output = join(tempDataDir("amber-ingest-"), "clip.partial");
      await ingest().clipAudio({ path: await extracted() }, { path: output }, { startMs: 1000, endMs: 2500 }, "audio/mpeg", signal());
      const json = probeClip(output);
      expect(json.format.format_name).toBe("mp3");
      expect(json.streams).toEqual([{ codec_name: "mp3", channels: 1, sample_rate: "16000" }]);
      // MP3 frames and encoder padding blur the edges by a few tens of milliseconds.
      expect(Math.abs(Number(json.format.duration) * 1000 - 1500)).toBeLessThanOrEqual(100);
    });

    it("refuses formats it cannot produce with llm_capability, and invalid ranges", async () => {
      const input = { path: await extracted() };
      const output = { path: join(tempDataDir("amber-ingest-"), "clip.partial") };
      expect(await codeOf(ingest().clipAudio(input, output, { startMs: 0, endMs: 1000 }, "audio/ogg", signal()))).toBe("llm_capability");
      await expect(ingest().clipAudio(input, output, { startMs: 1000, endMs: 1000 }, "audio/wav", signal())).rejects.toThrow(TypeError);
      await expect(ingest().clipAudio(input, output, { startMs: -1, endMs: 1000 }, "audio/wav", signal())).rejects.toThrow(TypeError);
    });

    it("stops when cancelled", async () => {
      const input = { path: await extracted() };
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      const output = { path: join(tempDataDir("amber-ingest-"), "clip.partial") };
      const outcome = await ingest().clipAudio(input, output, { startMs: 0, endMs: 1000 }, "audio/wav", controller.signal).then(
        () => "resolved",
        (error: unknown) => (isAmberError(error) ? error.appError.code : "aborted"),
      );
      expect(outcome).toBe("aborted");
    });
  });

  describe("transcodeAudio", () => {
    const probeMp3 = (path: string) => {
      const probed = spawnSync(
        toolPath("ffprobe"),
        ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name,duration,bit_rate:stream=codec_type,codec_name", "-i", `file:${path}`],
        { encoding: "utf8" },
      );
      return JSON.parse(probed.stdout) as { format: { format_name: string; duration: string; bit_rate: string }; streams: Array<{ codec_type: string; codec_name: string }> };
    };

    it("re-encodes the audio of a video as constant-bitrate MP3 to a path without an extension, with rising progress", async () => {
      const { withAudio } = mediaFixtures();
      const output = join(tempDataDir("amber-ingest-"), "第 1 讲.mp3.partial");
      const progress: number[] = [];
      const result = await ingest().transcodeAudio({ path: withAudio.path }, { path: output }, { bitrateKbps: 128 }, (value) => progress.push(value), signal());
      const json = probeMp3(output);
      expect(json.format.format_name).toBe("mp3");
      expect(json.streams).toEqual([{ codec_type: "audio", codec_name: "mp3" }]);
      expect(Math.abs(Number(json.format.bit_rate) / 1000 - 128)).toBeLessThanOrEqual(8);
      expect(Math.abs(Number(json.format.duration) * 1000 - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
      expect(result.sizeBytes).toBe(readFileSync(output).length);
      expect(Math.abs((result.durationMs ?? 0) - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
      expect(progress.at(-1)).toBe(1);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
      expect(progress.every((value) => value > 0 && value <= 1)).toBe(true);
    });

    it("transcodes an audio-only input too", async () => {
      const output = join(tempDataDir("amber-ingest-"), "audio.partial");
      await ingest().transcodeAudio({ path: mediaFixtures().audioOnly.path }, { path: output }, { bitrateKbps: 128 }, () => undefined, signal());
      expect(probeMp3(output).format.format_name).toBe("mp3");
    });

    it("fails a video without audio with media_no_audio and refuses a bitrate that is not a positive integer", async () => {
      const output = { path: join(tempDataDir("amber-ingest-"), "audio.partial") };
      expect(await codeOf(ingest().transcodeAudio({ path: mediaFixtures().noAudio.path }, output, { bitrateKbps: 128 }, () => undefined, signal()))).toBe("media_no_audio");
      for (const bitrateKbps of [0, -1, 1.5]) {
        await expect(ingest().transcodeAudio({ path: mediaFixtures().withAudio.path }, output, { bitrateKbps }, () => undefined, signal())).rejects.toThrow(TypeError);
      }
    });

    it("stops when cancelled", async () => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      const output = { path: join(tempDataDir("amber-ingest-"), "audio.partial") };
      const outcome = await ingest().transcodeAudio({ path: mediaFixtures().withAudio.path }, output, { bitrateKbps: 128 }, () => undefined, controller.signal).then(
        () => "resolved",
        (error: unknown) => (isAmberError(error) ? error.appError.code : "aborted"),
      );
      expect(outcome).toBe("aborted");
    });
  });

  it("reports a tool that cannot start as internal.tool_failed", async () => {
    const broken = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: tempDataDir("amber-nobin-"), env: {} });
    expect(await codeOf(broken.probe(mediaFixtures().withAudio.path, signal()))).toBe("internal.tool_failed");
  });
});

describe("FfmpegMediaIngest figures", () => {
  const encoding = { maxLongEdge: FIGURE_LONG_EDGE_MAX_PX, quality: FIGURE_WEBP_QUALITY };

  async function detailsOf(promise: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
    try {
      await promise;
    } catch (error) {
      if (isAmberError(error)) return { code: error.appError.code, reason: error.appError.details?.["reason"] };
      throw error;
    }
    throw new Error("expected a rejection");
  }

  describe("captureFrame", () => {
    let dir: string;
    let video: string;
    let levels: number[];
    beforeAll(() => {
      dir = tempDataDir("amber-capture-");
      video = timedVideo(dir);
      levels = frameLevels(video);
    });

    it("captures the frame at the requested time, within one frame, as a WebP that passes the carried-image check", async () => {
      for (const atMs of [0, 1250, 5550, 9850]) {
        const output = join(dir, `frame-${atMs}.webp`);
        const result = await ingest().captureFrame({ path: video, atMs }, { path: output }, encoding, signal());
        const bytes = readFileSync(output);
        expect(result).toEqual({ width: 64, height: 48, bytes: bytes.length });
        expect(inspectPackWebp(bytes)).toEqual({ ok: true, width: 64, height: 48 });
        const frame = nearestFrame(levels, decodePixels(output, "gray", "1:1")[0] ?? -1);
        expect(Math.abs(frame - Math.floor((atMs * TIMED_VIDEO_FPS) / 1000)), `at ${atMs} ms`).toBeLessThanOrEqual(1);
      }
    });

    it("scales the longer edge down to the limit", async () => {
      const wide = join(dir, "wide.mp4");
      ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=5:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", wide]);
      const output = join(dir, "wide.webp");
      expect(await ingest().captureFrame({ path: wide, atMs: 0 }, { path: output }, { maxLongEdge: 320, quality: 82 }, signal())).toMatchObject({ width: 320, height: 180 });
    });

    it("takes the last frame for a time at or past it, such as the media's length", async () => {
      for (const atMs of [9_960, TIMED_VIDEO_MS, TIMED_VIDEO_MS + 5_000]) {
        const output = join(dir, `end-${atMs}.webp`);
        expect(await ingest().captureFrame({ path: video, atMs }, { path: output }, encoding, signal())).toMatchObject({ width: 64, height: 48 });
        expect(inspectPackWebp(readFileSync(output))).toMatchObject({ ok: true });
        expect([atMs, nearestFrame(levels, decodePixels(output, "gray", "1:1")[0] ?? -1)]).toEqual([atMs, levels.length - 1]);
      }
    });

    it("fails with past_end only when the end shows no picture either, leaving no output", async () => {
      // One second of picture under five seconds of sound: past 1 s there is no frame to show.
      const short = join(dir, "short-picture.mp4");
      ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=1", "-f", "lavfi", "-i", "sine=duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", short]);
      const output = join(dir, "past.webp");
      expect(await detailsOf(ingest().captureFrame({ path: short, atMs: 4_000 }, { path: output }, encoding, signal()))).toEqual({
        code: "invalid_request.figure_frame",
        reason: "past_end",
      });
      expect(existsSync(output)).toBe(false);
    });

    it("opens a file only as the container its bytes claim: a playlist posing as a video is refused", async () => {
      const playlist = join(dir, "carried.mp4");
      writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:${video}\n#EXT-X-ENDLIST\n`);
      const output = join(dir, "playlist.webp");
      expect(await detailsOf(ingest().captureFrame({ path: playlist, atMs: 0 }, { path: output }, encoding, signal()))).toEqual({
        code: "invalid_request.figure_frame",
        reason: "failed",
      });
      expect(existsSync(output)).toBe(false);
      // Refused by its bytes before any tool runs: without ffmpeg at all the answer is the same.
      const toolless = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: tempDataDir("amber-nobin-"), env: {} });
      expect(await detailsOf(toolless.captureFrame({ path: playlist, atMs: 0 }, { path: output }, encoding, signal()))).toEqual({
        code: "invalid_request.figure_frame",
        reason: "failed",
      });
    });

    it("fails on a file without a picture with no_video, cover art included", async () => {
      const output = join(dir, "audio.webp");
      expect(await detailsOf(ingest().captureFrame({ path: audioOnly(dir), atMs: 0 }, { path: output }, encoding, signal()))).toEqual({
        code: "invalid_request.figure_frame",
        reason: "no_video",
      });
      const withCover = join(dir, "cover.mp3");
      ffmpeg(["-f", "lavfi", "-i", "sine=duration=1", "-f", "lavfi", "-i", "color=c=red:s=32x32", "-map", "0", "-map", "1", "-frames:v", "1", "-c:v", "mjpeg", "-disposition:v", "attached_pic", withCover]);
      expect(await detailsOf(ingest().captureFrame({ path: withCover, atMs: 0 }, { path: output }, encoding, signal()))).toMatchObject({ reason: "no_video" });
      expect(existsSync(output)).toBe(false);
    });

    it("reports a vanished input as media_missing", async () => {
      expect(await codeOf(ingest().captureFrame({ path: join(dir, "gone.mp4"), atMs: 0 }, { path: join(dir, "x.webp") }, encoding, signal()))).toBe("media_missing");
    });
  });

  describe("normalizeImage", () => {
    let dir: string;
    beforeAll(() => {
      dir = tempDataDir("amber-normalize-");
    });
    const normalize = (input: string, name: string) => {
      const output = join(dir, name);
      return { output, run: ingest().normalizeImage({ path: input }, { path: output }, encoding, signal()) };
    };

    it("turns an oriented JPEG upright and drops every metadata", async () => {
      const { output, run } = normalize(orientedJpeg(dir), "oriented.webp");
      expect(await run).toMatchObject({ width: 40, height: 80 });
      const bytes = readFileSync(output);
      expect(bytes.includes(METADATA_MARK)).toBe(false);
      // A plain VP8 / VP8L / VP8X+ALPH layout: no EXIF, XMP or ICC chunk.
      expect(inspectPackWebp(bytes)).toEqual({ ok: true, width: 40, height: 80 });
      const pixels = decodePixels(output, "rgba");
      // The red left half of the stored picture is on top once turned.
      expect([pixels[(5 * 40 + 20) * 4], pixels[(5 * 40 + 20) * 4 + 2]]).toEqual([expect.toSatisfy((v: number) => v > 200), expect.toSatisfy((v: number) => v < 60)]);
      expect([pixels[(75 * 40 + 20) * 4], pixels[(75 * 40 + 20) * 4 + 2]]).toEqual([expect.toSatisfy((v: number) => v < 60), expect.toSatisfy((v: number) => v > 200)]);
    });

    it("keeps transparency", async () => {
      const { output, run } = normalize(transparentPng(dir), "alpha.webp");
      expect(await run).toMatchObject({ width: 100, height: 50 });
      const pixels = decodePixels(output, "rgba");
      expect(pixels[(25 * 100 + 10) * 4 + 3]).toBe(0);
      expect(pixels[(25 * 100 + 90) * 4 + 3]).toBe(255);
    });

    it("keeps only the first frame of an animated PNG or WebP", async () => {
      for (const [input, name] of [[animatedPng(dir), "apng.webp"], [animatedWebp(dir), "awebp.webp"]] as const) {
        const { output, run } = normalize(input, name);
        expect(await run, name).toMatchObject({ width: 40, height: 30 });
        const bytes = readFileSync(output);
        expect(inspectPackWebp(bytes), name).toMatchObject({ ok: true });
        const [r, g, b] = decodePixels(output, "rgba");
        expect([name, (r ?? 0) > 200, (g ?? 255) < 60, (b ?? 255) < 60]).toEqual([name, true, true, true]);
      }
    });

    it("scales the longer edge down to the limit and never up", async () => {
      expect(await normalize(patternPng(dir, 3000, 1000), "wide.webp").run).toMatchObject({ width: FIGURE_LONG_EDGE_MAX_PX, height: 853 });
      expect(await normalize(patternPng(dir, 1000, 3000), "tall.webp").run).toMatchObject({ width: 853, height: FIGURE_LONG_EDGE_MAX_PX });
      expect(await normalize(patternPng(dir, 200, 100), "small.webp").run).toMatchObject({ width: 200, height: 100 });
      // An extreme aspect ratio still keeps one pixel on its short edge.
      expect(await normalize(patternPng(dir, 6000, 2), "thin.webp").run).toMatchObject({ width: FIGURE_LONG_EDGE_MAX_PX, height: 1 });
    });

    it("refuses to decode a picture over the pixel limit whatever the header in front of it said", async () => {
      // Over the limit in fact (7000×6000), as the decoder sees it.
      const huge = join(dir, "huge.png");
      ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=7000x6000,format=gray", "-frames:v", "1", "-c:v", "png", "-f", "image2", huge]);
      expect(7000 * 6000).toBeGreaterThan(FIGURE_PIXELS_MAX);
      const first = normalize(huge, "huge.webp");
      expect(await detailsOf(first.run)).toEqual({ code: "invalid_request.figure_image", reason: "corrupt" });
      expect(existsSync(first.output)).toBe(false);
      // A small image with the huge one appended: the header in front says 16×16.
      const appended = join(dir, "appended.png");
      writeFileSync(appended, Buffer.concat([readFileSync(patternPng(dir, 16, 16)), readFileSync(huge)]));
      const second = normalize(appended, "appended.webp");
      expect(await detailsOf(second.run)).toEqual({ code: "invalid_request.figure_image", reason: "corrupt" });
      expect(existsSync(second.output)).toBe(false);
    });

    it("refuses a truncated JPEG as corrupt and leaves no output", async () => {
      const { output, run } = normalize(truncatedJpeg(dir), "truncated.webp");
      expect(await detailsOf(run)).toEqual({ code: "invalid_request.figure_image", reason: "corrupt" });
      expect(existsSync(output)).toBe(false);
    });

    it("goes by the signature: a PNG named .jpg is read, text named .png is refused as unsupported", async () => {
      const disguised = join(dir, "photo.jpg");
      copyFileSync(patternPng(dir, 32, 16), disguised);
      expect(await normalize(disguised, "disguised.webp").run).toMatchObject({ width: 32, height: 16 });
      const text = join(dir, "notes.png");
      writeFileSync(text, "not an image at all\n".repeat(20));
      const { output, run } = normalize(text, "text.webp");
      expect(await detailsOf(run)).toEqual({ code: "invalid_request.figure_image", reason: "unsupported" });
      expect(existsSync(output)).toBe(false);
    });
  });

  // A stand-in ffmpeg that writes part of its output, starts a grandchild and hangs, so the
  // test can see the whole tree die and the output go when the deadline passes or the caller aborts.
  describe.skipIf(process.platform === "win32")("deadline and cancellation", () => {
    function hangingTool(): { binDir: string; pidFile: string } {
      const binDir = tempDataDir("amber-hang-");
      const pidFile = join(binDir, "grandchild.pid");
      const script = [
        "#!/bin/sh",
        'for last; do :; done',
        'out="${last#file:}"',
        'printf partial > "$out"',
        "sleep 60 &",
        `echo $! > "${pidFile}"`,
        "wait",
      ].join("\n");
      writeFileSync(join(binDir, "ffmpeg"), `${script}\n`);
      chmodSync(join(binDir, "ffmpeg"), 0o755);
      return { binDir, pidFile };
    }
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    async function settle(pidFile: string): Promise<number> {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return pid;
    }
    async function started(pidFile: string): Promise<void> {
      for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it("kills the process tree at the deadline, removes the output and fails the image as corrupt", async () => {
      const { binDir, pidFile } = hangingTool();
      const tool = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir, env: {}, figureTimeoutMs: 300 });
      const input = patternPng(binDir, 16, 16);
      const output = join(binDir, "out.webp");
      expect(await detailsOf(tool.normalizeImage({ path: input }, { path: output }, encoding, signal()))).toEqual({ code: "invalid_request.figure_image", reason: "corrupt" });
      expect(alive(await settle(pidFile))).toBe(false);
      expect(existsSync(output)).toBe(false);
    });

    it("fails a capture at the deadline as figure_frame failed", async () => {
      const { binDir, pidFile } = hangingTool();
      const tool = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir, env: {}, figureTimeoutMs: 300 });
      const output = join(binDir, "frame.webp");
      expect(await detailsOf(tool.captureFrame({ path: mediaFixtures().noAudio.path, atMs: 0 }, { path: output }, encoding, signal()))).toEqual({
        code: "invalid_request.figure_frame",
        reason: "failed",
      });
      expect(alive(await settle(pidFile))).toBe(false);
      expect(existsSync(output)).toBe(false);
    });

    it("kills the process tree and removes the output when the caller aborts", async () => {
      const { binDir, pidFile } = hangingTool();
      const tool = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir, env: {} });
      const controller = new AbortController();
      const output = join(binDir, "out.webp");
      const running = tool.normalizeImage({ path: patternPng(binDir, 16, 16) }, { path: output }, encoding, controller.signal);
      await started(pidFile);
      controller.abort();
      const outcome = await running.then(
        () => "resolved",
        (error: unknown) => (isAmberError(error) ? error.appError.code : "aborted"),
      );
      expect(outcome).toBe("aborted");
      expect(alive(await settle(pidFile))).toBe(false);
      expect(existsSync(output)).toBe(false);
    });
  });
});
