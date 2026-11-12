import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENCODER_ORDER,
  ENCODER_PROFILES,
  escapeFilterValue,
  FfmpegVideoBurner,
  listedEncoders,
} from "../../../../src/server/adapters/media-ingest/ffmpeg-burner.ts";
import { NodeProcessRunner } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { styledAssDocument } from "../../../../src/server/domain/export/ass.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../../src/shared/subtitle-style.ts";
import { argAfter, ScriptedRunner } from "../../../fixtures/platform/scripted-io.ts";
import { toolPath, toolsBinDir } from "../../../fixtures/tools.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const signal = (): AbortSignal => new AbortController().signal;

/** A port of FFmpeg's `av_get_token` (libavutil/avstring.c), to decode what the escaping produced. */
function avGetToken(buf: string, term: string): { token: string; rest: string } {
  let p = 0;
  while (p < buf.length && " \n\t\r".includes(buf[p] as string)) p++;
  let out = "";
  let end = 0;
  while (p < buf.length && !term.includes(buf[p] as string)) {
    const c = buf[p++] as string;
    if (c === "\\" && p < buf.length) {
      out += buf[p++];
      end = out.length;
    } else if (c === "'") {
      while (p < buf.length && buf[p] !== "'") out += buf[p++];
      if (p < buf.length) {
        p++;
        end = out.length;
      }
    } else {
      out += c;
    }
  }
  while (out.length > end && " \n\t\r".includes(out.at(-1) as string)) out = out.slice(0, -1);
  return { token: out, rest: buf.slice(p) };
}

/** What ffmpeg sees as the value: graph level first (`[],;`), then the option level (`:`). */
function decode(escaped: string): string {
  const graph = avGetToken(escaped, "[],;");
  expect(graph.rest).toBe("");
  const option = avGetToken(graph.token, ":");
  expect(option.rest).toBe("");
  return option.token;
}

const ENCODER_LIST = [
  "Encoders:",
  " V..... = Video",
  " ------",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
  " A....D aac                  AAC (Advanced Audio Coding)",
].join("\n");

describe("escapeFilterValue", () => {
  it("survives both unescaping levels for Windows and POSIX paths with filter metacharacters", () => {
    for (const path of [
      "C:\\Users\\张三\\AppData\\Local\\Amber\\tmp\\tasks\\01J\\burn.ass",
      "C:\\Program Files\\Amber\\fonts",
      "/data/a b'c:d,e[f];g\\h=i.ass",
      " leading and trailing ",
    ]) {
      expect(decode(escapeFilterValue(path))).toBe(path);
    }
  });

  it("escapes the drive colon and backslashes of a Windows path", () => {
    expect(escapeFilterValue("C:\\a")).toBe("C\\\\:\\\\\\\\a");
  });
});

describe("listedEncoders", () => {
  it("reads video encoder names only", () => {
    expect([...listedEncoders(ENCODER_LIST)]).toEqual(["libx264", "h264_nvenc"]);
  });
});

describe("FfmpegVideoBurner with a scripted ffmpeg", () => {
  function setup(failing: ReadonlySet<string>) {
    const dir = tempDataDir("amber-burner-");
    const video = join(dir, "in.mp4");
    const subtitle = join(dir, "burn.ass");
    writeFileSync(video, "video");
    writeFileSync(subtitle, "[Script Info]\n");
    const runner = new ScriptedRunner((spec) => {
      if (spec.command.endsWith("ffprobe")) {
        return { stdout: "2.000000\n" };
      }
      if (spec.args.includes("-encoders")) {
        return { stdout: ENCODER_LIST };
      }
      const encoder = argAfter(spec.args, "-c:v") as string;
      if (failing.has(encoder)) {
        return { exitCode: 1, stderr: "Cannot load nvcuda.dll" };
      }
      writeFileSync((spec.args.at(-1) as string).replace(/^file:/, ""), "burned");
      return { stdoutLines: ["out_time_us=1000000", "out_time_ms=2000000", "progress=end"] };
    });
    const burner = new FfmpegVideoBurner({ runner, binDir: "/opt/amber/bin", fontsDir: "/opt/amber/fonts", env: {} });
    return { dir, video, subtitle, runner, burner };
  }

  it("falls back to the next listed encoder when one fails, in ENCODER_ORDER, and probes the list once", async () => {
    const { dir, video, subtitle, runner, burner } = setup(new Set(["h264_nvenc"]));
    const progress: number[] = [];
    const out = join(dir, "out.partial");
    const result = await burner.burn({ video, subtitle }, { path: out }, (value) => progress.push(value), signal());
    expect(result).toEqual({ sizeBytes: 6, encoder: "libx264" });
    const encodes = runner.specs.filter((spec) => spec.args.includes("-c:v"));
    expect(encodes.map((spec) => argAfter(spec.args, "-c:v"))).toEqual(["h264_nvenc", "libx264"]);
    const x264 = encodes[1]?.args ?? [];
    expect(x264.join(" ")).toContain("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a copy -movflags +faststart -f mp4");
    expect(argAfter(x264, "-i")).toBe(`file:${video}`);
    expect(argAfter(x264, "-vf")).toBe(`subtitles=filename=${escapeFilterValue(subtitle)}:fontsdir=${escapeFilterValue("/opt/amber/fonts")}:wrap_unicode=1:force_style=WrapStyle=1`);
    expect(progress).toEqual([0.5, 1, 1]);

    await burner.burn({ video, subtitle }, { path: out }, () => undefined, signal());
    expect(runner.specs.filter((spec) => spec.args.includes("-encoders"))).toHaveLength(1);
  });

  it("fails as a tool failure when every listed encoder fails, and media_missing without the input", async () => {
    const { dir, video, subtitle, burner } = setup(new Set(["h264_nvenc", "libx264"]));
    const failure = await burner.burn({ video, subtitle }, { path: join(dir, "out.partial") }, () => undefined, signal()).catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError.code).toBe("internal.tool_failed");
    const missing = await burner.burn({ video: join(dir, "gone.mp4"), subtitle }, { path: join(dir, "out.partial") }, () => undefined, signal()).catch((error: unknown) => error);
    expect(isAmberError(missing) && missing.appError.class).toBe("media_missing");
  });

  it("maps the first video and every audio stream, squares the pixels and re-encodes audio only where asked", async () => {
    const { dir, video, subtitle, runner, burner } = setup(new Set());
    const out = join(dir, "out.partial");
    await burner.burn({ video, subtitle }, { path: out }, () => undefined, signal(), {
      geometry: { sar: { num: 16, den: 11 }, displayWidth: 1049, displayHeight: 575 },
      audioCopy: [true, false],
    });
    const args = runner.specs.filter((spec) => spec.args.includes("-c:v")).at(-1)?.args ?? [];
    expect(args.join(" ")).toContain(`-i file:${video} -map 0:V:0 -map 0:a? -vf`);
    expect(argAfter(args, "-vf")).toBe(
      `scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,subtitles=filename=${escapeFilterValue(subtitle)}:fontsdir=${escapeFilterValue("/opt/amber/fonts")}:wrap_unicode=1:force_style=WrapStyle=1`,
    );
    expect(args.join(" ")).toContain("-pix_fmt yuv420p -c:a copy -c:a:0 copy -c:a:1 aac -b:a:1 192k -movflags +faststart -f mp4");

    // Square, even pixels need no scaling.
    await burner.burn({ video, subtitle }, { path: out }, () => undefined, signal(), { geometry: { sar: { num: 1, den: 1 }, displayWidth: 1280, displayHeight: 720 }, audioCopy: [] });
    const square = runner.specs.filter((spec) => spec.args.includes("-c:v")).at(-1)?.args ?? [];
    expect(argAfter(square, "-vf")?.startsWith("subtitles=")).toBe(true);
    // An odd dimension does.
    await burner.burn({ video, subtitle }, { path: out }, () => undefined, signal(), { geometry: { sar: { num: 1, den: 1 }, displayWidth: 1280, displayHeight: 721 } });
    const odd = runner.specs.filter((spec) => spec.args.includes("-c:v")).at(-1)?.args ?? [];
    expect(argAfter(odd, "-vf")?.startsWith("scale=")).toBe(true);
  });

  it("has a quality profile for every encoder of the order and keeps libx264 at veryfast / CRF 20", () => {
    expect(Object.keys(ENCODER_PROFILES).sort()).toEqual([...ENCODER_ORDER].sort());
    expect(ENCODER_PROFILES.libx264.args.slice(0, 4)).toEqual(["-preset", "veryfast", "-crf", "20"]);
  });
});

describe("FfmpegVideoBurner with the pinned ffmpeg", () => {
  it("burns an ASS file from a path full of filter metacharacters into a playable H.264 MP4", async () => {
    const dir = join(tempDataDir("amber-burner-real-"), "we'ird, [dir]; a:b");
    mkdirSync(dir, { recursive: true });
    const video = join(dir, "clip.mp4");
    const generated = spawnSync(
      toolPath("ffmpeg"),
      ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video],
      { encoding: "utf8" },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const subtitle = join(dir, "burn's.ass");
    writeFileSync(
      subtitle,
      [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Noto Sans SC,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,你好，Amber",
        "",
      ].join("\n"),
    );
    const binDir = toolsBinDir();
    const burner = new FfmpegVideoBurner({ runner: new NodeProcessRunner(), binDir, fontsDir: join(binDir, "..", "fonts"), env: childProcessEnv(process.env) });
    const out = join(dir, "out.partial");
    const progress: number[] = [];
    const result = await burner.burn({ video, subtitle }, { path: out }, (value) => progress.push(value), signal());
    expect(ENCODER_ORDER).toContain(result.encoder);
    expect(existsSync(out)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    const probe = spawnSync(toolPath("ffprobe"), ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", `file:${out}`], { encoding: "utf8" });
    expect(probe.stdout.trim().split("\n").sort()).toEqual(["aac,audio", "h264,video"]);
  }, 60_000);

  function styled(dir: string, playRes: { width: number; height: number }): string {
    const appearance = defaultSubtitleAppearance();
    const subtitle = join(dir, "styled.ass");
    writeFileSync(
      subtitle,
      styledAssDocument([{ startMs: 0, endMs: 2000, original: "你好，Amber", translation: "Hello" }], {
        style: { appearance: { ...appearance, background: { ...appearance.background, enabled: true } }, placement: defaultSubtitlePlacement() },
        mode: "bilingual",
        playRes,
        textOnly: false,
      }),
    );
    return subtitle;
  }

  function realBurner(): FfmpegVideoBurner {
    const binDir = toolsBinDir();
    return new FfmpegVideoBurner({ runner: new NodeProcessRunner(), binDir, fontsDir: join(binDir, "..", "fonts"), env: childProcessEnv(process.env) });
  }

  function videoStream(path: string): { width: number; height: number; sar: string; audio: string[] } {
    const probe = spawnSync(toolPath("ffprobe"), ["-v", "error", "-print_format", "json", "-show_streams", `file:${path}`], { encoding: "utf8" });
    const streams = (JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; sample_aspect_ratio?: string }> }).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    return {
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      sar: video?.sample_aspect_ratio ?? "",
      audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => stream.codec_name),
    };
  }

  it("squares a 721x575 picture with a 16:11 sample aspect ratio, draws a boxed subtitle and converts FLAC audio to AAC", async () => {
    const dir = tempDataDir("amber-burner-sar-");
    const video = join(dir, "anamorphic.mkv");
    const generated = spawnSync(
      toolPath("ffmpeg"),
      ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=721x575:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-vf", "setsar=16/11", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "flac", "-shortest", video],
      { encoding: "utf8" },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const out = join(dir, "out.partial");
    // 721 x 16 / 11 = 1048.7 wide on screen.
    await realBurner().burn({ video, subtitle: styled(dir, { width: Math.round((1080 * 1049) / 575), height: 1080 }) }, { path: out }, () => undefined, signal(), {
      geometry: { sar: { num: 16, den: 11 }, displayWidth: 1049, displayHeight: 575 },
      audioCopy: [false],
    });
    expect(videoStream(out)).toEqual({ width: 1048, height: 574, sar: "1:1", audio: ["aac"] });
    const frame = spawnSync(toolPath("ffmpeg"), ["-nostdin", "-v", "error", "-y", "-ss", "1", "-i", `file:${out}`, "-frames:v", "1", "-f", "image2", join(dir, "frame.png")], { encoding: "utf8" });
    expect(frame.status, frame.stderr).toBe(0);
  }, 60_000);

  /** Rows of a 1920 x 1080 RGB frame that hold at least a few pixels matching `match`. */
  function rowsWith(frame: Buffer, match: (r: number, g: number, b: number) => boolean): number[] {
    const rows: number[] = [];
    for (let y = 0; y < 1080; y++) {
      let count = 0;
      for (let x = 0; x < 1920; x++) {
        const at = (y * 1920 + x) * 3;
        if (match(frame[at] as number, frame[at + 1] as number, frame[at + 2] as number)) count++;
      }
      if (count >= 4) rows.push(y);
    }
    return rows;
  }

  it.each(["original_first", "translation_first"] as const)("boxes only the translation line of a bilingual cue, %s", async (bilingualOrder) => {
    const dir = tempDataDir("amber-burner-line-box-");
    const video = join(dir, "black.mp4");
    const generated = spawnSync(
      toolPath("ffmpeg"),
      ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:size=1920x1080:rate=5:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
      { encoding: "utf8" },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const appearance = defaultSubtitleAppearance();
    const subtitle = join(dir, "line.ass");
    writeFileSync(
      subtitle,
      styledAssDocument([{ startMs: 0, endMs: 1000, original: "你好，Amber", translation: "Hello" }], {
        style: {
          appearance: { ...appearance, bilingualOrder, background: { enabled: true, color: "#FF0000", opacityPct: 100, padding: 12, scope: "translation" } },
          placement: defaultSubtitlePlacement(),
        },
        mode: "bilingual",
        playRes: { width: 1920, height: 1080 },
        textOnly: false,
      }),
    );
    const out = join(dir, "out.partial");
    await realBurner().burn({ video, subtitle }, { path: out }, () => undefined, signal(), { geometry: { sar: { num: 1, den: 1 }, displayWidth: 1920, displayHeight: 1080 }, audioCopy: [] });
    const frame = spawnSync(toolPath("ffmpeg"), ["-nostdin", "-v", "error", "-ss", "0.5", "-i", `file:${out}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 16 * 1024 * 1024 });
    expect(frame.status, frame.stderr.toString()).toBe(0);
    // Rows holding white original text (`#FFFFFF`) and rows holding the red box.
    const white = rowsWith(frame.stdout, (r, g, b) => r > 200 && g > 200 && b > 200);
    const red = rowsWith(frame.stdout, (r, g, b) => r > 200 && g < 60 && b < 60);
    expect(white.length).toBeGreaterThan(0);
    // Bottom anchor at y 994; each line is as tall as its font size (48 / 44) and the box adds the 12 padding around the translation line only.
    const [top, bottom] = bilingualOrder === "original_first" ? [994 - 44 - 12, 994 + 12] : [994 - 48 - 44 - 12, 994 - 48 + 12];
    expect(Math.abs((red[0] as number) - top)).toBeLessThanOrEqual(2);
    expect(Math.abs((red.at(-1) as number) + 1 - bottom)).toBeLessThanOrEqual(2);
    expect(red.length).toBe((red.at(-1) as number) - (red[0] as number) + 1);
    // The padding may reach a few rows into the original glyphs, but most of the original line stays unboxed.
    expect(white.filter((y) => !red.includes(y)).length).toBeGreaterThan(white.length * 0.75);
  }, 60_000);

  it("burns a source rotated by 90 degrees upright", async () => {
    const dir = tempDataDir("amber-burner-rotated-");
    const plain = join(dir, "plain.mp4");
    const rotated = join(dir, "rotated.mp4");
    for (const args of [
      ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", plain],
      ["-display_rotation", "90", "-i", plain, "-c", "copy", rotated],
    ]) {
      const run = spawnSync(toolPath("ffmpeg"), ["-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
    }
    const out = join(dir, "out.partial");
    await realBurner().burn({ video: rotated, subtitle: styled(dir, { width: 608, height: 1080 }) }, { path: out }, () => undefined, signal(), {
      geometry: { sar: { num: 1, den: 1 }, displayWidth: 720, displayHeight: 1280 },
      audioCopy: [true],
    });
    expect(videoStream(out)).toMatchObject({ width: 720, height: 1280, audio: ["aac"] });
    // Turned upright once: no rotation left for a player to apply again.
    const sideData = spawnSync(toolPath("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "csv=p=0", `file:${out}`], { encoding: "utf8" });
    expect(sideData.stdout.trim().replace(/^0$/u, "")).toBe("");
  }, 60_000);
});
