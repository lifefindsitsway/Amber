import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableTiers,
  downloadAudio,
  downloadVideo,
  exactVideoFormat,
  inspectAudio,
  inspectVideo,
  languageTag,
  listVideoQualities,
  moveFile,
  parseFormatLine,
  pickTierFormat,
  secondsToMs,
  videoFormat,
} from "../../../../src/server/adapters/platform/shared.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { PLATFORM_METADATA_TIMEOUT_MS } from "../../../../src/shared/defaults.ts";
import type { ProcessRunOptions, ProcessSpec } from "../../../../src/server/ports/process-runner.ts";
import { argAfter, scriptedYtDlp, signal, type ScriptedProcess } from "../../../fixtures/platform/scripted-io.ts";

/** The error code `rename` fails with while set; `undefined` passes through to the real one. */
const renameFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameFailure.code !== undefined) {
        throw Object.assign(new Error(`${renameFailure.code}: rename`), { code: renameFailure.code });
      }
      return actual.rename(from, to);
    },
  };
});

afterEach(() => {
  renameFailure.code = undefined;
});

describe("secondsToMs", () => {
  it("rounds platform seconds to integer milliseconds and keeps NaN", () => {
    expect(secondsToMs(1.5)).toBe(1500);
    expect(secondsToMs(12.3456)).toBe(12346);
    expect(secondsToMs(0.0004)).toBe(0);
    expect(secondsToMs(Number.NaN)).toBeNaN();
  });
});

describe("languageTag", () => {
  it("canonicalizes BCP-47 tags", () => {
    expect(languageTag("zh-cn")).toBe("zh-CN");
    expect(languageTag("en")).toBe("en");
    expect(languageTag("zh-hans")).toBe("zh-Hans");
    expect(languageTag("pt_BR")).toBe("pt-BR");
  });

  it("drops platform ids appended to a code and falls back to und", () => {
    // YouTube keys titled tracks by vssId, e.g. `.en.eEY6OEpapPo` becomes `en-eEY6OEpapPo`.
    expect(languageTag("en-eEY6OEpapPo")).toBe("en");
    expect(languageTag("es-ES-y1SAwy5xd4g")).toBe("es-ES");
    expect(languageTag("not a tag")).toBe("und");
  });
});

describe("downloadAudio", () => {
  it("asks for the best audio-only stream at exactly the output path and reports byte progress", async () => {
    const progress: number[] = [];
    const { ytDlp, runner, dataDir } = scriptedYtDlp((spec) => {
      writeFileSync(argAfter(spec.args, "--output") as string, Buffer.alloc(40));
      return {
        stdoutLines: [
          "[download] Destination: somewhere",
          "amber-progress 25 100 NA",
          "amber-progress 10 NA 40",
          "amber-progress 5 NA NA",
          "amber-progress 120 100 NA",
        ],
      };
    });
    const output = join(dataDir, "audio.partial");
    const result = await downloadAudio(ytDlp, {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      extractors: ["youtube"],
      cookies: "# Netscape HTTP Cookie File\n",
      output: { path: output },
      onProgress: (value) => progress.push(value),
      signal: signal(),
    });
    expect(result).toEqual({ sizeBytes: 40 });
    expect(progress).toEqual([0.25, 0.25, 1]);
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(args.indexOf("--no-playlist"))).toEqual([
      "--no-playlist",
      "--format",
      "ba/b",
      "--no-part",
      "--force-overwrites",
      "--newline",
      "--progress-template",
      "download:amber-progress %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
      "--output",
      output,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
    expect(argAfter(args, "--use-extractors")).toBe("youtube");
    expect(args).toContain("--cookies");
  });
});

describe("videoFormat / parseFormatLine", () => {
  it("prefers container pairs WebView2 plays, then any height-capped pair or single file, then anything", () => {
    expect(videoFormat(720)).toBe("bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720][ext=webm]+ba[ext=webm]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b");
  });

  it("reads the pre-check line and yt-dlp's NA placeholder", () => {
    expect(parseFormatLine("amber-format 123456 720 mp4")).toEqual({ sizeBytes: 123456, height: 720, ext: "mp4" });
    expect(parseFormatLine("amber-format 123456 720 mp4 avc1.64001F")).toEqual({ sizeBytes: 123456, height: 720, ext: "mp4", vcodec: "avc1.64001F" });
    expect(parseFormatLine("amber-format NA NA webm NA")).toEqual({ ext: "webm" });
    expect(parseFormatLine("amber-format 99 NA m4a none")).toEqual({ sizeBytes: 99, ext: "m4a", vcodec: "none" });
    expect(parseFormatLine("amber-format 123456 714 mp4 avc1.64001F 1280")).toEqual({ sizeBytes: 123456, height: 714, ext: "mp4", vcodec: "avc1.64001F", width: 1280 });
    expect(parseFormatLine("amber-format NA 714 mp4 avc1 NA")).toEqual({ height: 714, ext: "mp4", vcodec: "avc1" });
    expect(parseFormatLine("[info] something")).toBeUndefined();
  });
});

describe("downloadVideo", () => {
  const URL = "https://www.bilibili.com/video/BV1xx411c7mD";

  /** Pre-check answers with `announce`; the download writes `video.<ext>` (and a leftover stream for merges) into the scratch directory. */
  function scripted(announce: string, ext = "mp4") {
    return scriptedYtDlp((spec: ProcessSpec): ScriptedProcess => {
      if (spec.args.includes("--print")) {
        return { stdoutLines: [announce] };
      }
      const template = argAfter(spec.args, "--output") as string;
      writeFileSync(template.replace("%(ext)s", ext), Buffer.alloc(140));
      return {
        stdoutLines: ["amber-progress 50 100 NA", "amber-progress 100 100 NA", "amber-progress 20 NA 40", "amber-progress 40 40 NA"],
      };
    });
  }

  /** The caller's scratch directory, next to the output as the cache's `.amber-tmp/<assetId>` is. */
  function scratchIn(dir: string): string {
    const scratchDir = join(dir, ".amber-tmp", "01ASSET");
    mkdirSync(scratchDir, { recursive: true });
    return scratchDir;
  }

  it("checks the selected format's size first, then downloads into a private directory inside the caller's scratch directory and moves the result into place", async () => {
    const { ytDlp, runner, dataDir } = scripted("amber-format 140 720 mp4");
    const progress: number[] = [];
    const output = join(dataDir, "video.partial");
    const scratchDir = scratchIn(dataDir);
    const result = await downloadVideo(ytDlp, {
      url: URL,
      extractors: ["bilibili"],
      cookies: "# Netscape HTTP Cookie File\n",
      target: { maxHeight: 720 },
      maxBytes: 1000,
      output: { path: output, scratchDir },
      onProgress: (value) => progress.push(value),
      signal: signal(),
    });
    expect(result).toEqual({ sizeBytes: 140, mimeType: "video/mp4", height: 720 });
    expect(readFileSync(output).length).toBe(140);
    expect(progress).toEqual([50 / 140, 100 / 140, 120 / 140, 1]);

    const [check, download] = runner.specs.map((spec) => spec.args.slice(spec.args.indexOf("--no-playlist")));
    const selection = ["--no-playlist", "--format", videoFormat(720), "--format-sort", "vcodec:h264,res,acodec:aac", "--merge-output-format", "mp4/webm"];
    expect(check).toEqual([...selection, "--print", "amber-format %(filesize,filesize_approx)s %(height)s %(ext)s %(vcodec)s %(width)s", URL]);
    const template = argAfter(download ?? [], "--output") as string;
    expect(download).toEqual([
      ...selection,
      "--no-part",
      "--force-overwrites",
      "--newline",
      "--progress-template",
      "download:amber-progress %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
      "--output",
      template,
      URL,
    ]);
    expect(template.startsWith(`${scratchDir}${sep}`)).toBe(true);
    expect(template.endsWith("video.%(ext)s")).toBe(true);
    expect(existsSync(join(dataDir, "tmp", "platform"))).toBe(false);
    expect(runner.specs.every((spec) => spec.args.includes("--cookies"))).toBe(true);
    // The run's own directory is gone; the caller's stays for the caller to remove.
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("refuses a format announced above the limit without downloading", async () => {
    const { ytDlp, runner, dataDir } = scripted("amber-format 5000 1080 mp4");
    const output = join(dataDir, "video.partial");
    const failure = await downloadVideo(ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 1080 }, maxBytes: 1000, output: { path: output, scratchDir: scratchIn(dataDir) }, onProgress: () => undefined, signal: signal() }).catch(
      (error: unknown) => error,
    );
    expect(isAmberError(failure) && failure.appError.class).toBe("media_too_large");
    expect(runner.specs).toHaveLength(1);
    expect(existsSync(output)).toBe(false);
  });

  it("downloads when the size is unknown, reports WebM, and refuses containers WebView2 cannot play", async () => {
    const webm = scripted("amber-format NA NA webm", "webm");
    const output = join(webm.dataDir, "video.partial");
    const result = await downloadVideo(webm.ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 480 }, maxBytes: 1000, output: { path: output, scratchDir: scratchIn(webm.dataDir) }, onProgress: () => undefined, signal: signal() });
    expect(result).toEqual({ sizeBytes: 140, mimeType: "video/webm" });
    expect(webm.runner.specs[0]?.args).not.toContain("--cookies");

    const flv = scripted("amber-format 10 360 flv", "flv");
    const flvScratch = scratchIn(flv.dataDir);
    const failure = await downloadVideo(flv.ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 360 }, maxBytes: 1000, output: { path: join(flv.dataDir, "v.partial"), scratchDir: flvScratch }, onProgress: () => undefined, signal: signal() }).catch(
      (error: unknown) => error,
    );
    expect(isAmberError(failure) && failure.appError.class).toBe("media_unsupported_type");
    expect(readdirSync(flvScratch)).toEqual([]);
  });

  it("stops as soon as the bytes of both streams pass the caller's budget, leaving nothing behind", async () => {
    const { ytDlp, dataDir } = scripted("amber-format NA 720 mp4");
    const output = join(dataDir, "video.partial");
    const failure = await downloadVideo(ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 720 }, maxBytes: 130, output: { path: output, scratchDir: scratchIn(dataDir) }, onProgress: () => undefined, signal: signal() }).catch(
      (error: unknown) => error,
    );
    expect(isAmberError(failure) && failure.appError.class).toBe("media_too_large");
    expect(existsSync(output)).toBe(false);
  });

  it("refuses a finished file larger than the budget even without progress", async () => {
    const { ytDlp, dataDir } = scriptedYtDlpQuiet();
    const output = join(dataDir, "video.partial");
    const failure = await downloadVideo(ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 720 }, maxBytes: 139, output: { path: output, scratchDir: scratchIn(dataDir) }, onProgress: () => undefined, signal: signal() }).catch(
      (error: unknown) => error,
    );
    expect(isAmberError(failure) && failure.appError.class).toBe("media_too_large");
    expect(existsSync(output)).toBe(false);
  });

  /** A download whose progress carries no numbers. */
  function scriptedYtDlpQuiet() {
    return scriptedYtDlp((spec: ProcessSpec): ScriptedProcess => {
      if (spec.args.includes("--print")) {
        return { stdoutLines: ["amber-format NA 720 mp4"] };
      }
      writeFileSync((argAfter(spec.args, "--output") as string).replace("%(ext)s", "mp4"), Buffer.alloc(140));
      return { stdoutLines: ["amber-progress NA NA NA"] };
    });
  }
});

describe("moveFile", () => {
  it("renames within a volume", async () => {
    const { dataDir } = scriptedYtDlp(() => ({}));
    writeFileSync(join(dataDir, "from.mp4"), "video");
    await moveFile(join(dataDir, "from.mp4"), join(dataDir, "to.mp4.partial"));
    expect(readFileSync(join(dataDir, "to.mp4.partial"), "utf8")).toBe("video");
    expect(existsSync(join(dataDir, "from.mp4"))).toBe(false);
  });

  it("copies and removes the source when the rename crosses volumes (EXDEV)", async () => {
    const { dataDir } = scriptedYtDlp(() => ({}));
    writeFileSync(join(dataDir, "from.mp4"), "video");
    renameFailure.code = "EXDEV";
    await moveFile(join(dataDir, "from.mp4"), join(dataDir, "to.mp4.partial"));
    expect(readFileSync(join(dataDir, "to.mp4.partial"), "utf8")).toBe("video");
    expect(existsSync(join(dataDir, "from.mp4"))).toBe(false);
  });

  it("passes any other rename failure on and leaves the source alone", async () => {
    const { dataDir } = scriptedYtDlp(() => ({}));
    writeFileSync(join(dataDir, "from.mp4"), "video");
    renameFailure.code = "EACCES";
    const failure = await moveFile(join(dataDir, "from.mp4"), join(dataDir, "to.mp4.partial")).catch((error: unknown) => error);
    expect((failure as NodeJS.ErrnoException).code).toBe("EACCES");
    expect(existsSync(join(dataDir, "from.mp4"))).toBe(true);
    expect(existsSync(join(dataDir, "to.mp4.partial"))).toBe(false);
  });
});

describe("downloadAudio with maxBytes", () => {
  const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  function scripted(lines: string[], bytes: number) {
    const seen: ProcessRunOptions[] = [];
    const io = scriptedYtDlp((spec, opts) => {
      seen.push(opts);
      writeFileSync(argAfter(spec.args, "--output") as string, Buffer.alloc(bytes));
      return { stdoutLines: lines };
    });
    return { ...io, seen };
  }

  it("downloads within the limit with a single run", async () => {
    const { ytDlp, runner, dataDir } = scripted(["amber-progress 50 100 NA", "amber-progress 100 100 NA"], 100);
    const output = join(dataDir, "audio.partial");
    const progress: number[] = [];
    const result = await downloadAudio(ytDlp, { url: URL, extractors: ["youtube"], output: { path: output }, onProgress: (value) => progress.push(value), signal: signal(), maxBytes: 100 });
    expect(result).toEqual({ sizeBytes: 100 });
    expect(progress).toEqual([0.5, 1]);
    expect(runner.specs).toHaveLength(1);
  });

  it("stops yt-dlp once it reports a total over the limit and removes what it wrote", async () => {
    const { ytDlp, dataDir, seen } = scripted(["amber-progress 10 5000 NA", "amber-progress 20 5000 NA"], 20);
    const output = join(dataDir, "audio.partial");
    const progress: number[] = [];
    const failure = await downloadAudio(ytDlp, { url: URL, extractors: ["youtube"], output: { path: output }, onProgress: (value) => progress.push(value), signal: signal(), maxBytes: 1000 }).catch(
      (error: unknown) => error,
    );
    expect(isAmberError(failure) && failure.appError.class).toBe("media_too_large");
    expect(seen[0]?.signal?.aborted).toBe(true);
    expect(progress).toEqual([]);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses a finished file over the limit when no total was announced", async () => {
    const { ytDlp, dataDir } = scripted(["amber-progress 10 NA NA"], 2000);
    const output = join(dataDir, "audio.partial");
    const failure = await downloadAudio(ytDlp, { url: URL, extractors: ["youtube"], output: { path: output }, onProgress: () => undefined, signal: signal(), maxBytes: 1000 }).catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError.class).toBe("media_too_large");
    expect(existsSync(output)).toBe(false);
  });

  it("lets a cancellation through as such", async () => {
    const controller = new AbortController();
    const io = scriptedYtDlp(() => {
      controller.abort(new Error("cancelled by the user"));
      throw new Error("killed");
    });
    const failure = await downloadAudio(io.ytDlp, { url: URL, extractors: ["youtube"], output: { path: join(io.dataDir, "a.partial") }, onProgress: () => undefined, signal: controller.signal, maxBytes: 10 }).catch(
      (error: unknown) => error,
    );
    expect(isAmberError(failure)).toBe(false);
    expect((failure as Error).message).toBe("killed");
  });
});

describe("inspectAudio", () => {
  it("prints the size of the ba/b selection without downloading", async () => {
    const { ytDlp, runner } = scriptedYtDlp(() => ({ stdoutLines: ["[info] noise", "amber-format 4096"] }));
    expect(await inspectAudio(ytDlp, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", extractors: ["youtube"], cookies: "# Netscape HTTP Cookie File\n", signal: signal() })).toEqual({ sizeBytes: 4096 });
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(args.indexOf("--no-playlist"))).toEqual(["--no-playlist", "--format", "ba/b", "--print", "amber-format %(filesize,filesize_approx)s", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(args).toContain("--cookies");
    expect(args).not.toContain("--output");

    const unknown = scriptedYtDlp(() => ({ stdoutLines: ["amber-format NA"] }));
    expect(await inspectAudio(unknown.ytDlp, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", extractors: ["youtube"], signal: signal() })).toEqual({});
  });
});

describe("inspectVideo", () => {
  const URL = "https://www.bilibili.com/video/BV1xx411c7mD";
  const inspect = (line: string) => {
    const io = scriptedYtDlp(() => ({ stdoutLines: [line] }));
    return { ...io, result: inspectVideo(io.ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 720 }, signal: signal() }) };
  };

  it("runs the download's selection once with the codec printed, and reports the container to expect", async () => {
    const { runner, result } = inspect("amber-format 1000 720 mp4 avc1.64001F");
    expect(await result).toEqual({ hasVideo: true, mimeType: "video/mp4", sizeBytes: 1000, height: 720 });
    expect(runner.specs).toHaveLength(1);
    const args = runner.specs[0]?.args ?? [];
    expect(args.slice(args.indexOf("--no-playlist"))).toEqual([
      "--no-playlist", "--format", videoFormat(720), "--format-sort", "vcodec:h264,res,acodec:aac", "--merge-output-format", "mp4/webm",
      "--print", "amber-format %(filesize,filesize_approx)s %(height)s %(ext)s %(vcodec)s %(width)s", URL,
    ]);
    expect(await inspect("amber-format NA 480 webm NA").result).toEqual({ hasVideo: true, mimeType: "video/webm", height: 480 });
    expect(await inspect("amber-format NA 1920 mp4 avc1 1080").result).toEqual({ hasVideo: true, mimeType: "video/mp4", height: 1920, width: 1080 });
  });

  it("reports no video for a codec of none, or neither codec nor height", async () => {
    expect(await inspect("amber-format 500 NA m4a none").result).toEqual({ hasVideo: false });
    expect(await inspect("amber-format 500 720 mp4 none").result).toEqual({ hasVideo: false });
    expect(await inspect("amber-format NA NA mp3 NA").result).toEqual({ hasVideo: false });
    expect(await inspect("nothing printed").result).toEqual({ hasVideo: false });
  });

  it("refuses a container WebView2 cannot play before anything is downloaded", async () => {
    const failure = await inspect("amber-format 10 360 flv h264").result.catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError.class).toBe("media_unsupported_type");
  });
});

/** yt-dlp's formats of a wide-screen bilibili lecture (640×206, 854×274, 1280×410), recorded as a guest. */
const ULTRAWIDE = (
  JSON.parse(readFileSync(new URL("../../../fixtures/platform/recorded/bilibili-ultrawide-formats.json", import.meta.url), "utf8")) as { formats: unknown[] }
).formats;

/** A video-only stream as yt-dlp lists it. */
const stream = (format_id: string, width: number | undefined, height: number | undefined, vcodec = "avc1.640028", ext = "mp4", tbr?: number) => ({
  format_id,
  ext,
  vcodec,
  acodec: "none",
  ...(width === undefined ? {} : { width }),
  ...(height === undefined ? {} : { height }),
  ...(tbr === undefined ? {} : { tbr }),
});

describe("pickTierFormat / availableTiers", () => {
  it("picks the H.264 stream of each tier of the recorded wide-screen sample, and lists exactly those", () => {
    expect(pickTierFormat(ULTRAWIDE, 360)).toEqual({ formatId: "30016", ext: "mp4", width: 640, height: 206 });
    expect(pickTierFormat(ULTRAWIDE, 480)).toEqual({ formatId: "30032", ext: "mp4", width: 854, height: 274 });
    expect(pickTierFormat(ULTRAWIDE, 720)).toEqual({ formatId: "30064", ext: "mp4", width: 1280, height: 410 });
    expect(pickTierFormat(ULTRAWIDE, 240)).toBeUndefined();
    expect(pickTierFormat(ULTRAWIDE, 1080)).toBeUndefined();
    const tiers = availableTiers(ULTRAWIDE);
    expect(tiers).toEqual([
      { tier: 360, width: 640, height: 206 },
      { tier: 480, width: 854, height: 274 },
      { tier: 720, width: 1280, height: 410 },
    ]);
    for (const { tier, width, height } of tiers) {
      expect(pickTierFormat(ULTRAWIDE, tier)).toMatchObject({ width, height });
    }
  });

  it("places 16:9, portrait and slightly short pictures in their tiers", () => {
    const formats = [stream("1", 640, 360), stream("2", 1280, 720), stream("3", 1920, 1080)];
    expect(pickTierFormat(formats, 360)?.formatId).toBe("1");
    expect(pickTierFormat(formats, 720)?.formatId).toBe("2");
    expect(pickTierFormat(formats, 1080)?.formatId).toBe("3");
    expect(availableTiers(formats).map((quality) => quality.tier)).toEqual([360, 720, 1080]);
    expect(pickTierFormat([stream("p", 1080, 1920)], 1080)?.formatId).toBe("p");
    expect(pickTierFormat([stream("s", 1920, 1072)], 1080)?.formatId).toBe("s");
    expect(availableTiers([stream("p", 1080, 1920)])).toEqual([{ tier: 1080, width: 1080, height: 1920 }]);
  });

  it("prefers H.264, then the larger picture, then MP4, then the higher bitrate, then the later entry", () => {
    expect(pickTierFormat([stream("hevc", 1280, 720, "hvc1.1.6.L120.90"), stream("avc", 1280, 720, "avc1.64001F"), stream("av1", 1280, 720, "av01.0.08M.08")], 720)?.formatId).toBe("avc");
    expect(pickTierFormat([stream("av1", 1280, 720, "av01.0.08M.08"), stream("h264", 1280, 720, "h264")], 720)?.formatId).toBe("h264");
    expect(pickTierFormat([stream("av1", 1280, 720, "av01.0.08M.08")], 720)?.formatId).toBe("av1");
    // H.264 wins over a larger picture of another codec within the tier.
    expect(pickTierFormat([stream("avc", 960, 540), stream("vp9", 1280, 720, "vp09.00.40.08", "webm")], 720)?.formatId).toBe("avc");
    expect(pickTierFormat([stream("big", 1280, 720), stream("small", 960, 540)], 720)?.formatId).toBe("big");
    expect(pickTierFormat([stream("webm", 1280, 720, "vp09.00.40.08", "webm"), stream("mp4", 1280, 720, "av01.0.08M.08")], 720)).toEqual({ formatId: "mp4", ext: "mp4", width: 1280, height: 720 });
    expect(pickTierFormat([stream("fast", 1280, 720, "avc1", "mp4", 3000), stream("slow", 1280, 720, "avc1", "mp4", 1000), stream("none", 1280, 720)], 720)?.formatId).toBe("fast");
    expect(pickTierFormat([stream("first", 1280, 720), stream("last", 1280, 720)], 720)?.formatId).toBe("last");
    expect(pickTierFormat([stream("vp9", 1280, 720, "vp09.00.40.08", "WEBM")], 720)).toEqual({ formatId: "vp9", ext: "webm", width: 1280, height: 720 });
  });

  it("leaves out containers WebView2 cannot play, audio, streams without a width or height, and format ids unsafe in an expression", () => {
    const excluded = [
      stream("flv", 1280, 720, "avc1", "flv"),
      stream("audio", 1280, 720, "none"),
      { format_id: "nocodec", ext: "mp4", width: 1280, height: 720 },
      stream("empty", 1280, 720, ""),
      stream("nowidth", undefined, 720),
      stream("noheight", 1280, undefined),
      stream("zero", 0, 720),
      stream("fraction", 1280, 719.5),
      { ...stream("text", 1280, 720), height: "720" },
      stream("a b", 1280, 720),
      stream("1+2", 1280, 720),
      stream("x/y", 1280, 720),
      stream("v[height<=720]", 1280, 720),
      { ...stream("", 1280, 720) },
      { ext: "mp4", vcodec: "avc1", width: 1280, height: 720 },
      { ...stream("proto", 1280, 720), ext: "constructor" },
      null,
      "720",
    ];
    for (const format of excluded) {
      expect(pickTierFormat([format], 720)).toBeUndefined();
    }
    expect(availableTiers(excluded)).toEqual([]);
    expect(availableTiers([])).toEqual([]);
    expect(pickTierFormat([stream("dash-1_v.2", 1280, 720)], 720)?.formatId).toBe("dash-1_v.2");
  });
});

describe("exactVideoFormat", () => {
  it("names the stream with audio of its own container first, then any audio, then the stream alone", () => {
    expect(exactVideoFormat({ formatId: "30064", ext: "mp4" })).toBe("30064+ba[ext=m4a]/30064+ba/30064");
    expect(exactVideoFormat({ formatId: "248", ext: "webm" })).toBe("248+ba[ext=webm]/248+ba/248");
  });
});

describe("inspectVideo / downloadVideo for a tier", () => {
  const URL = "https://www.bilibili.com/video/BV1CQt365EzW";
  const EXACT_480 = "30032+ba[ext=m4a]/30032+ba/30032";
  const PRINT = "amber-format %(filesize,filesize_approx)s %(height)s %(ext)s %(vcodec)s %(width)s";
  const selection = (format: string) => ["--no-playlist", "--format", format, "--format-sort", "vcodec:h264,res,acodec:aac", "--merge-output-format", "mp4/webm"];
  const NOT_AVAILABLE = "ERROR: [BiliBili] 1CQt365EzW: Requested format is not available. Use --list-formats for a list of available formats";

  /** Metadata from the recorded sample, a format check announcing 854×274, and a download writing `video.mp4` unless `download` says otherwise. */
  function scripted(options: { formats?: unknown; download?: ScriptedProcess } = {}) {
    return scriptedYtDlp((spec: ProcessSpec): ScriptedProcess => {
      if (spec.args.includes("--dump-single-json")) {
        return { stdout: `${JSON.stringify({ id: "BV1CQt365EzW", formats: options.formats ?? ULTRAWIDE })}\n` };
      }
      if (spec.args.includes("--print")) {
        return { stdoutLines: ["amber-format 140 274 mp4 avc1.640033 854"] };
      }
      if (options.download !== undefined) {
        return options.download;
      }
      writeFileSync((argAfter(spec.args, "--output") as string).replace("%(ext)s", "mp4"), Buffer.alloc(140));
      return { stdoutLines: ["amber-progress 140 140 NA"] };
    });
  }

  const scratchIn = (dir: string) => {
    const scratchDir = join(dir, ".amber-tmp", "01ASSET");
    mkdirSync(scratchDir, { recursive: true });
    return scratchDir;
  };
  const download = (io: ReturnType<typeof scripted>, tier: number) =>
    downloadVideo(io.ytDlp, {
      url: URL,
      extractors: ["bilibili"],
      cookies: "# Netscape HTTP Cookie File\n",
      target: { tier },
      maxBytes: 1000,
      output: { path: join(io.dataDir, "video.partial"), scratchDir: scratchIn(io.dataDir) },
      onProgress: () => undefined,
      signal: signal(),
    });
  const quality = (error: unknown) => (isAmberError(error) ? error.appError : undefined);

  it("inspects the exact stream of the tier: metadata first, then the format check naming its format id", async () => {
    const io = scripted();
    const result = await inspectVideo(io.ytDlp, { url: URL, extractors: ["bilibili"], cookies: "# Netscape HTTP Cookie File\n", target: { tier: 480 }, signal: signal() });
    expect(result).toEqual({ hasVideo: true, mimeType: "video/mp4", sizeBytes: 140, height: 274, width: 854 });
    expect(io.runner.specs).toHaveLength(2);
    const [dump, check] = io.runner.specs;
    expect(dump?.args.slice(dump.args.indexOf("--dump-single-json"))).toEqual(["--dump-single-json", "--skip-download", "--no-playlist", URL]);
    expect(dump?.timeoutMs).toBe(PLATFORM_METADATA_TIMEOUT_MS);
    expect(check?.args.slice(check.args.indexOf("--no-playlist"))).toEqual([...selection(EXACT_480), "--print", PRINT, URL]);
    expect(io.runner.specs.every((spec) => spec.args.includes("--cookies"))).toBe(true);
  });

  it("fails a tier the source does not offer after the metadata alone", async () => {
    for (const formats of [ULTRAWIDE, null, []]) {
      const io = scripted({ formats });
      const failure = await inspectVideo(io.ytDlp, { url: URL, extractors: ["bilibili"], target: { tier: 1080 }, signal: signal() }).catch((error: unknown) => error);
      expect(quality(failure)).toMatchObject({ class: "invalid_request", code: "invalid_request.cache_quality_unavailable" });
      expect(quality(failure)?.userMessage).toContain("1080P");
      expect(io.runner.specs).toHaveLength(1);
    }
    const io = scripted();
    const failure = await download(io, 1080).catch((error: unknown) => error);
    expect(quality(failure)?.code).toBe("invalid_request.cache_quality_unavailable");
    expect(io.runner.specs).toHaveLength(1);
    expect(readdirSync(join(io.dataDir, ".amber-tmp", "01ASSET"))).toEqual([]);
  });

  it("downloads with the same exact selection the format check used", async () => {
    const io = scripted();
    const output = join(io.dataDir, "video.partial");
    expect(await download(io, 480)).toEqual({ sizeBytes: 140, mimeType: "video/mp4", height: 274 });
    expect(readFileSync(output).length).toBe(140);
    expect(io.runner.specs).toHaveLength(3);
    const [dump, check, run] = io.runner.specs.map((spec) => spec.args);
    expect(dump).toContain("--dump-single-json");
    expect(check?.slice(check.indexOf("--no-playlist"))).toEqual([...selection(EXACT_480), "--print", PRINT, URL]);
    expect(run?.slice(run.indexOf("--no-playlist"), run.indexOf("--no-part"))).toEqual(selection(EXACT_480));
    expect(argAfter(run ?? [], "--format")).toBe(argAfter(check ?? [], "--format"));
  });

  it("turns a stream gone by the time yt-dlp selects it into an unavailable tier, and passes other failures on", async () => {
    const gone = scripted({ download: { exitCode: 1, stderr: NOT_AVAILABLE } });
    const failure = await download(gone, 720).catch((error: unknown) => error);
    expect(quality(failure)).toMatchObject({ code: "invalid_request.cache_quality_unavailable" });
    expect(quality(failure)?.userMessage).toContain("720P");
    expect(argAfter(gone.runner.specs[2]?.args ?? [], "--format")).toBe("30064+ba[ext=m4a]/30064+ba/30064");

    const checkGone = scriptedYtDlp((spec) =>
      spec.args.includes("--dump-single-json") ? { stdout: `${JSON.stringify({ formats: ULTRAWIDE })}\n` } : { exitCode: 1, stderr: "ERROR: [BiliBili] 1CQt365EzW: requested format is NOT available" },
    );
    const inspected = await inspectVideo(checkGone.ytDlp, { url: URL, extractors: ["bilibili"], target: { tier: 360 }, signal: signal() }).catch((error: unknown) => error);
    expect(quality(inspected)?.code).toBe("invalid_request.cache_quality_unavailable");

    const blocked = scripted({ download: { exitCode: 1, stderr: "ERROR: [BiliBili] 1CQt365EzW: HTTP Error 412: Precondition Failed" } });
    expect(quality(await download(blocked, 480).catch((error: unknown) => error))?.class).toBe("platform_blocked");

    // A height cap keeps yt-dlp's own failure: its selection falls back to any format.
    const capped = scriptedYtDlp(() => ({ exitCode: 1, stderr: NOT_AVAILABLE }));
    const cappedFailure = await inspectVideo(capped.ytDlp, { url: URL, extractors: ["bilibili"], target: { maxHeight: 720 }, signal: signal() }).catch((error: unknown) => error);
    expect(quality(cappedFailure)?.code).not.toBe("invalid_request.cache_quality_unavailable");
    expect(capped.runner.specs).toHaveLength(1);
  });
});

describe("listVideoQualities", () => {
  const URL = "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
  const list = (document: unknown, cookies?: string) => {
    const io = scriptedYtDlp(() => ({ stdout: `${JSON.stringify(document)}\n` }));
    return { ...io, result: listVideoQualities(io.ytDlp, { url: URL, extractors: ["bilibili"], ...(cookies === undefined ? {} : { cookies }), signal: signal() }) };
  };

  it("dumps the metadata once without downloading, within the metadata timeout and with the given login", async () => {
    const { runner, result } = list({ formats: [] }, "# Netscape HTTP Cookie File\n");
    expect(await result).toEqual([]);
    expect(runner.specs).toHaveLength(1);
    const spec = runner.specs[0]!;
    expect(spec.args.slice(spec.args.indexOf("--dump-single-json"))).toEqual(["--dump-single-json", "--skip-download", "--no-playlist", URL]);
    expect(spec.args).toContain("--cookies");
    expect(spec.args).not.toContain("--format");
    expect(spec.timeoutMs).toBe(PLATFORM_METADATA_TIMEOUT_MS);
    const guest = list({ formats: [] });
    await guest.result;
    expect(guest.runner.specs[0]?.args).not.toContain("--cookies");
  });

  it("lists each tier with the picture size of the stream a cache of it downloads", async () => {
    expect(await list({ formats: ULTRAWIDE }).result).toEqual(availableTiers(ULTRAWIDE));
    expect(await list({ formats: [stream("hi", 1920, 1080), stream("lo", 640, 360), stream("flv", 1280, 720, "avc1", "flv")] }).result).toEqual([
      { tier: 360, width: 640, height: 360 },
      { tier: 1080, width: 1920, height: 1080 },
    ]);
  });

  it("tells a document without a format list apart from one without video streams", async () => {
    expect(await list({ id: "BV1xx411c7mD" }).result).toBeUndefined();
    expect(await list({ formats: null }).result).toBeUndefined();
    expect(await list({ formats: "none" }).result).toBeUndefined();
    expect(await list(null).result).toBeUndefined();
    expect(await list({ formats: [{ format_id: "30216", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2" }] }).result).toEqual([]);
  });

  it("passes a yt-dlp failure on", async () => {
    const io = scriptedYtDlp(() => ({ exitCode: 1, stderr: "ERROR: [BiliBili] unable to download JSON metadata" }));
    const failure = await listVideoQualities(io.ytDlp, { url: URL, extractors: ["bilibili"], signal: signal() }).catch((error: unknown) => error);
    expect(isAmberError(failure)).toBe(true);
  });
});
