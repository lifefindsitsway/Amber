import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_ROOT_ENV, removeRunRoot } from "../../tools/temp-root.ts";
import { toolPath } from "../tools.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLIP = join(REPO_ROOT, "dist/e2e-media/local-player.webm");

/** Port of the clip server; the mock backend forwards `/api/media/<id>` here. */
/** `AMBER_E2E_CLIP_PORT` moves it, so separate checkouts can run their suites side by side. */
export const CLIP_SERVER_PORT = Number(process.env["AMBER_E2E_CLIP_PORT"] ?? 4174);

/**
 * Generates the clip the local `<video>` smoke plays — 130 s of VP8 test pattern with a
 * keyframe every second, made with the pinned ffmpeg (fixtures are generated, not
 * committed) — and serves it with single-range support, as `GET /api/media` does, since
 * Chromium cannot seek in media served without ranges. VP8 / WebM because Playwright's
 * Chromium has no proprietary codecs. The teardown also removes the run's temporary root
 * (test/tools/temp-root.ts).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(CLIP)) {
    mkdirSync(dirname(CLIP), { recursive: true });
    const result = spawnSync(
      toolPath("ffmpeg"),
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=130:size=160x90:rate=10", "-c:v", "libvpx", "-b:v", "60k", "-g", "10", "-an", "-y", CLIP],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error("ffmpeg could not generate the local player clip");
    }
  }
  const bytes = readFileSync(CLIP);
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const headers = { "content-type": "video/webm", "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    if (range === null) {
      response.writeHead(200, { ...headers, "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    const start = Number(range[1]);
    const end = range[2] === "" ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
    if (start >= bytes.length || start > end) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${bytes.length}` });
      response.end();
      return;
    }
    response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": end - start + 1 });
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>((done) => server.listen(CLIP_SERVER_PORT, "127.0.0.1", done));
  const runRoot = process.env[RUN_ROOT_ENV];
  return async () => {
    await new Promise<void>((done) => server.close(() => done()));
    if (runRoot !== undefined && runRoot !== "") {
      removeRunRoot(runRoot);
    }
  };
}
