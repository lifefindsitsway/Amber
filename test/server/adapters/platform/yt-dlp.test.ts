import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeProcessRunner, ProcessRunError } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { downloadAudio } from "../../../../src/server/adapters/platform/shared.ts";
import {
  baseArgs,
  classifyYtDlpFailure,
  COOKIES_DIR,
  redactUpstream,
  YTDLP_CACHE_DIR,
  YTDLP_ERROR_PATTERNS,
  YtDlp,
} from "../../../../src/server/adapters/platform/yt-dlp.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import type { AppError } from "../../../../src/shared/errors.ts";
import { RETRY_BASE_MS, RETRY_MAX, YTDLP_SOCKET_TIMEOUT_S } from "../../../../src/shared/defaults.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import { argAfter, BIN_DIR, scriptedYtDlp, signal, type ScriptedProcess } from "../../../fixtures/platform/scripted-io.ts";
import { toolsBinDir } from "../../../fixtures/tools.ts";

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

const COOKIES = "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tsession\t<placeholder>\n";

describe("baseArgs", () => {
  it("pins config, tool locations, cache, extractors, socket timeout and one retry policy", () => {
    const start = RETRY_BASE_MS / 1000;
    expect(baseArgs({ binDir: "/b", dataDir: "/d" }, ["bilibili", "bilibilicollectionlist"])).toEqual([
      "--no-config",
      "--ffmpeg-location",
      "/b",
      "--js-runtimes",
      `deno:${join("/b", process.platform === "win32" ? "deno.exe" : "deno")}`,
      "--cache-dir",
      join("/d", YTDLP_CACHE_DIR),
      "--use-extractors",
      "bilibili,bilibilicollectionlist",
      "--socket-timeout",
      String(YTDLP_SOCKET_TIMEOUT_S),
      "--retries",
      String(RETRY_MAX),
      "--fragment-retries",
      String(RETRY_MAX),
      "--extractor-retries",
      String(RETRY_MAX),
      "--retry-sleep",
      `exp=${start}:${start * 2 ** (RETRY_MAX - 1)}`,
    ]);
  });
});

describe("YtDlp.run", () => {
  it("starts yt-dlp by absolute path with the given environment, base args first and the call's args last", async () => {
    const { ytDlp, runner, dataDir } = scriptedYtDlp();
    await ytDlp.run({ args: ["--dump-single-json", "https://www.bilibili.com/video/BV1xx411c7mD"], extractors: ["bilibili"], signal: signal(), timeoutMs: 1234 });
    const [spec] = runner.specs;
    expect(spec?.command).toBe(join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"));
    expect(spec?.env).toEqual({ LANG: "C.UTF-8" });
    expect(spec?.timeoutMs).toBe(1234);
    expect(spec?.args).toEqual([...baseArgs({ binDir: BIN_DIR, dataDir }, ["bilibili"]), "--dump-single-json", "https://www.bilibili.com/video/BV1xx411c7mD"]);
    expect(spec?.args).not.toContain("--cookies");
  });

  describe("cookie file", () => {
    function observingCookies(answer: () => ScriptedProcess | Promise<ScriptedProcess>) {
      const seen: Array<{ path: string; fileMode: number; dirMode: number; text: string }> = [];
      const setup = scriptedYtDlp((spec) => {
        const path = argAfter(spec.args, "--cookies") as string;
        seen.push({
          path,
          fileMode: statSync(path).mode & 0o777,
          dirMode: statSync(join(path, "..")).mode & 0o777,
          text: readFileSync(path, "utf8"),
        });
        return answer();
      });
      return { ...setup, seen };
    }

    const outcomes: Array<[string, () => ScriptedProcess | Promise<ScriptedProcess>]> = [
      ["success", () => ({ stdout: "{}" })],
      ["failure", () => ({ exitCode: 1, stderr: "ERROR: [BiliBili] x: HTTP Error 404: Not Found" })],
      ["timeout", () => Promise.reject(new ProcessRunError("timeout", "timed out"))],
      ["spawn failure", () => Promise.reject(new ProcessRunError("spawn_failed", "no such file"))],
    ];

    for (const [name, answer] of outcomes) {
      it(`exists privately under tmp/cookies only while yt-dlp runs (${name})`, async () => {
        const { ytDlp, dataDir, seen } = observingCookies(answer);
        await ytDlp.run({ args: [], extractors: ["bilibili"], cookies: COOKIES, signal: signal() }).catch(() => undefined);
        expect(seen).toHaveLength(1);
        const [file] = seen;
        expect(file?.path.startsWith(join(dataDir, COOKIES_DIR))).toBe(true);
        expect(file?.path).toMatch(/[0-9A-HJKMNP-TV-Z]{26}\.txt$/);
        expect(file?.fileMode).toBe(0o600);
        expect(file?.dirMode).toBe(0o700);
        expect(file?.text).toBe(COOKIES);
        expect(existsSync(file?.path as string)).toBe(false);
        expect(readdirSync(join(dataDir, COOKIES_DIR))).toEqual([]);
      });
    }

    it("is removed when the run is aborted", async () => {
      const controller = new AbortController();
      const { ytDlp, dataDir, seen } = observingCookies(() => {
        controller.abort();
        return Promise.reject(new ProcessRunError("aborted", "aborted"));
      });
      await expect(ytDlp.run({ args: [], extractors: ["bilibili"], cookies: COOKIES, signal: controller.signal })).rejects.toBeInstanceOf(ProcessRunError);
      expect(seen).toHaveLength(1);
      expect(readdirSync(join(dataDir, COOKIES_DIR))).toEqual([]);
    });
  });

  it("maps a timeout to source_unreachable and a spawn failure to internal.tool_failed", async () => {
    const timeout = scriptedYtDlp(() => Promise.reject(new ProcessRunError("timeout", "timed out")));
    expect((await errorOf(timeout.ytDlp.run({ args: [], extractors: ["youtube"], signal: signal() }))).code).toBe("source_unreachable");
    const spawn = scriptedYtDlp(() => Promise.reject(new ProcessRunError("spawn_failed", "ENOENT")));
    expect((await errorOf(spawn.ytDlp.run({ args: [], extractors: ["youtube"], signal: signal() }))).code).toBe("internal.tool_failed");
  });

  it("classifies a non-zero exit and parses JSON output", async () => {
    const failed = scriptedYtDlp(() => ({ exitCode: 1, stderr: "ERROR: [youtube] abc: Private video. Sign in if you've been granted access" }));
    expect((await errorOf(failed.ytDlp.run({ args: [], extractors: ["youtube"], signal: signal() }))).class).toBe("source_unreachable");
    const json = scriptedYtDlp(() => ({ stdout: '{"title":"t"}' }));
    expect(await json.ytDlp.json({ args: [], extractors: ["youtube"], signal: signal() })).toEqual({ title: "t" });
    const html = scriptedYtDlp(() => ({ stdout: "<html>" }));
    expect((await errorOf(html.ytDlp.json({ args: [], extractors: ["youtube"], signal: signal() }))).class).toBe("source_html_error_page");
  });

  it("reads a JSON document larger than the runner's output tail", async () => {
    // A stand-in yt-dlp printing a 2 MiB info document, run by the real runner.
    const binDir = mkdtempSync(join(tmpdir(), "amber-ytdlp-bin-"));
    const script = `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ title: "中文标题", pad: "x".repeat(2 * 1024 * 1024) }) + "\\n");\n`;
    writeFileSync(join(binDir, "yt-dlp"), script, { mode: 0o755 });
    const ytDlp = new YtDlp({ runner: new NodeProcessRunner(), binDir, dataDir: mkdtempSync(join(tmpdir(), "amber-ytdlp-")), env: {} });
    const info = await ytDlp.json<{ title: string; pad: string }>({ args: [], extractors: ["youtube"], signal: signal() });
    expect(info.title).toBe("中文标题");
    expect(info.pad).toHaveLength(2 * 1024 * 1024);
  });
});

describe("classifyYtDlpFailure", () => {
  // One stderr line per pattern, in the table's order, taken from the pinned release's messages.
  const SAMPLES: Array<[string, string]> = [
    ["disk_low", "ERROR: unable to write data: [Errno 28] No space left on device"],
    ["disk_low", "ERROR: Postprocessing: Conversion failed! ENOSPC"],
    ["paid_content", "ERROR: [youtube] abc: This video is only available to Music Premium members"],
    ["paid_content", "ERROR: [BiliBili] BV1: This video is for premium members only"],
    ["auth_required", "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."],
    ["auth_required", "ERROR: [BiliBili] BV1: This video is only available for registered users"],
    ["platform_blocked", "ERROR: [BiliBili] BV1: Unable to download JSON metadata: HTTP Error 412: Precondition Failed"],
    ["platform_blocked", "ERROR: [youtube] abc: HTTP Error 429: Too Many Requests"],
    ["platform_blocked", "ERROR: [BiliBili] BV1: Request is rejected by server (352)"],
    ["source_html_error_page", "ERROR: [BiliBili] BV1: Unable to extract initial state; please report this issue"],
    ["source_unreachable", "ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader"],
    ["source_unreachable", "ERROR: [BiliBili] BV1: HTTP Error 404: Not Found"],
    ["source_unreachable", "ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>"],
  ];

  it("maps each pattern of the table to its class", () => {
    for (const [expected, line] of SAMPLES) {
      expect(classifyYtDlpFailure({ exitCode: 1, stderr: `[debug] noise\n${line}\n` }).appError.class, line).toBe(expected);
    }
    for (const entry of YTDLP_ERROR_PATTERNS) {
      expect(SAMPLES.some(([errorClass, line]) => errorClass === entry.errorClass && entry.pattern.test(line)), String(entry.pattern)).toBe(true);
    }
  });

  it("reads ERROR lines only, treats exit code 2 as our option error and anything unmatched as unknown", () => {
    expect(classifyYtDlpFailure({ exitCode: 1, stderr: "WARNING: [youtube] use --cookies for the authentication\nERROR: something odd" }).appError.class).toBe(
      "unknown",
    );
    expect(classifyYtDlpFailure({ exitCode: 2, stderr: "yt-dlp: error: no such option: --bogus" }).appError.code).toBe("internal.tool_failed");
  });

  it("keeps the last ERROR line as upstream message with signed query strings removed", () => {
    const error = classifyYtDlpFailure({
      exitCode: 1,
      stderr: "ERROR: [BiliBili] BV1: Unable to download https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1?auth_key=<placeholder>&e=1: HTTP Error 404",
    });
    expect(error.appError.upstreamMessage).toBe("ERROR: [BiliBili] BV1: Unable to download https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1?… HTTP Error 404");
    expect(JSON.stringify(error.appError)).not.toContain("auth_key");
  });

  it("caps an upstream line", () => {
    expect(redactUpstream("x".repeat(2000))).toHaveLength(500);
    expect(redactUpstream("see http://a.example/p?token=<placeholder> and https://b.example/q#f")).toBe("see http://a.example/p?… and https://b.example/q#f");
  });
});

describe("the pinned yt-dlp binary", () => {
  // Every option Amber passes, in any adapter call.
  const OPTIONS = [
    "--no-config",
    "--ffmpeg-location",
    "--js-runtimes",
    "--cache-dir",
    "--use-extractors",
    "--socket-timeout",
    "--retries",
    "--fragment-retries",
    "--extractor-retries",
    "--retry-sleep",
    "--cookies",
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--flat-playlist",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "--sub-format",
    "--format",
    "--no-part",
    "--force-overwrites",
    "--newline",
    "--progress-template",
    "--output",
  ];

  /** The child environment without proxies, so loopback requests stay local. */
  const localEnv = () => Object.fromEntries(Object.entries(childProcessEnv(process.env)).filter(([name]) => !/proxy/i.test(name)));

  // Two cold starts of the self-extracting binary; under a loaded full run they can take
  // longer than the default test timeout.
  it("is the pinned version and knows every option Amber passes", { timeout: 30_000 }, () => {
    const binDir = toolsBinDir(["yt-dlp", "deno"]);
    const ytDlp = join(binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    const version = spawnSync(ytDlp, ["--version"], { encoding: "utf8", env: localEnv() });
    expect(version.stdout.trim()).toBe("2026.08.19");
    const help = spawnSync(ytDlp, ["--help"], { encoding: "utf8", env: localEnv() }).stdout;
    const known = new Set(help.match(/--[a-z][a-z-]*/g));
    expect(OPTIONS.filter((option) => !known.has(option))).toEqual([]);
  });

  describe("downloading from a loopback server", () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      const audio = readFileSync(mediaFixtures().audioOnly.path);
      server = createServer((request, response) => {
        if (request.url !== "/lecture.mp3") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(audio.length) });
        response.end(request.method === "HEAD" ? undefined : audio);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("writes the audio to exactly the given path and reports progress", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "amber-ytdlp-real-"));
      const ytDlp = new YtDlp({ runner: new NodeProcessRunner(), binDir: toolsBinDir(["yt-dlp", "deno", "ffmpeg"]), dataDir, env: localEnv() });
      const output = join(dataDir, "audio.partial");
      const progress: number[] = [];
      // `generic` handles a direct media URL; adapters never allow it.
      const result = await downloadAudio(ytDlp, {
        url: `${base}/lecture.mp3`,
        extractors: ["generic"],
        output: { path: output },
        onProgress: (value) => progress.push(value),
        signal: signal(),
      });
      const expected = readFileSync(mediaFixtures().audioOnly.path);
      expect(result.sizeBytes).toBe(expected.length);
      expect(readFileSync(output).equals(expected)).toBe(true);
      expect(readdirSync(dataDir).filter((name) => name !== "tmp")).toEqual(["audio.partial"]);
      expect(progress.at(-1)).toBe(1);
    }, 60_000);
  });
});
