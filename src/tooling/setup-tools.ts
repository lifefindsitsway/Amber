import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ASSETS_DIR, FONT_ASSETS, FONT_OUTPUTS, FONTS_DIR, placeFonts, readPinnedSums, RUNTIME_ASSETS_SUMS_SHA256, sha256 } from "./runtime-assets.ts";
import { readZip } from "./zip-reader.ts";

/**
 * Installs the external tools the tests and `pnpm dev` run into `.amber-tools/bin/`, and
 * the bundled fonts (burn-in and reading) into `.amber-tools/fonts/` beside it, from the
 * Amber Runtime Assets working copy or from a directory the CI binaries job downloaded the
 * same release into.
 * A test that misses a tool fails rather than being skipped. The directory's `SHA256SUMS` must
 * be the pinned one (its own SHA256 is compiled in), and every archive is checked against it
 * before extraction; nothing comes from the system package manager.
 *
 *   pnpm setup:tools [--assets <dir>]
 */

export const TOOLS_DIR = ".amber-tools";
export const TOOLS_BIN_DIR = `${TOOLS_DIR}/bin`;
export const TOOLS_FONTS_DIR = `${TOOLS_DIR}/${FONTS_DIR}`;
const STAMP_FILE = "installed.json";

interface ToolArchive {
  archive: string;
  /** `raw`: the asset is the executable itself; its single member key is the asset name. */
  format: "tar.xz" | "zip" | "raw";
  /** Archive member → file name under `bin/`. */
  members: Readonly<Record<string, string>>;
}

const FFMPEG_LINUX = "ffmpeg-n9.0.2-3-ga5923073bf-linux64-gpl-9.0";
const FFMPEG_WINDOWS = "ffmpeg-n9.0.2-3-ga5923073bf-win64-gpl-9.0";

/** Tools per host platform, at their pinned versions. */
export const TOOL_ARCHIVES: Readonly<Partial<Record<NodeJS.Platform, readonly ToolArchive[]>>> = {
  linux: [
    {
      archive: `${FFMPEG_LINUX}.tar.xz`,
      format: "tar.xz",
      members: { [`${FFMPEG_LINUX}/bin/ffmpeg`]: "ffmpeg", [`${FFMPEG_LINUX}/bin/ffprobe`]: "ffprobe" },
    },
    { archive: "yt-dlp_linux", format: "raw", members: { "yt-dlp_linux": "yt-dlp" } },
    { archive: "deno-x86_64-unknown-linux-gnu.zip", format: "zip", members: { deno: "deno" } },
  ],
  win32: [
    {
      archive: `${FFMPEG_WINDOWS}.zip`,
      format: "zip",
      members: { [`${FFMPEG_WINDOWS}/bin/ffmpeg.exe`]: "ffmpeg.exe", [`${FFMPEG_WINDOWS}/bin/ffprobe.exe`]: "ffprobe.exe" },
    },
    { archive: "yt-dlp.exe", format: "raw", members: { "yt-dlp.exe": "yt-dlp.exe" } },
    { archive: "deno-x86_64-pc-windows-msvc.zip", format: "zip", members: { "deno.exe": "deno.exe" } },
  ],
};

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): { assetsDir: string } {
  let assetsDir = DEFAULT_ASSETS_DIR;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--assets") {
      assetsDir = argv[++index] ?? fail("--assets needs a directory");
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return { assetsDir };
}

/**
 * Extracts the listed members into `outDir`; a raw asset is copied as is. Node has no xz
 * decoder, so tar archives go through the host `tar` (GNU tar with xz on Linux runners and
 * WSL), started without a shell; zip archives use the in-repo reader.
 */
function extract(spec: ToolArchive, data: Buffer, archivePath: string, outDir: string): void {
  if (spec.format === "raw") {
    for (const output of Object.values(spec.members)) {
      writeFileSync(join(outDir, output), data);
    }
    return;
  }
  if (spec.format === "zip") {
    const zip = readZip(data);
    for (const [member, output] of Object.entries(spec.members)) {
      const entry = zip.find((item) => item.name === member) ?? fail(`${member} not found in ${spec.archive}`);
      writeFileSync(join(outDir, output), entry.read());
    }
    return;
  }
  const staging = mkdtempSync(join(outDir, ".extract-"));
  try {
    const members = Object.keys(spec.members);
    const result = spawnSync("tar", ["-xJf", archivePath, "-C", staging, ...members], { stdio: "inherit" });
    if (result.status !== 0) {
      fail(`tar exited with ${result.status ?? result.signal} for ${spec.archive}`);
    }
    for (const [member, output] of Object.entries(spec.members)) {
      renameSync(join(staging, member), join(outDir, output));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function setupTools(
  root: string,
  assetsDir: string,
  platform: NodeJS.Platform = process.platform,
  expectedSumsSha256: string = RUNTIME_ASSETS_SUMS_SHA256,
): string[] {
  const archives = TOOL_ARCHIVES[platform] ?? fail(`no tool archives for platform ${platform}`);
  const sourceDir = resolve(root, assetsDir);
  // Checked before the up-to-date shortcut too: a stamp proves nothing about a foreign list.
  const sums = readPinnedSums(sourceDir, expectedSumsSha256);
  const binDir = join(root, TOOLS_BIN_DIR);
  const stampPath = join(root, TOOLS_DIR, STAMP_FILE);
  mkdirSync(binDir, { recursive: true });
  const stamp = existsSync(stampPath) ? (JSON.parse(readFileSync(stampPath, "utf8")) as Record<string, string>) : {};
  const installed: string[] = [];
  for (const spec of archives) {
    const expected = sums.get(spec.archive) ?? fail(`${spec.archive} is not listed in SHA256SUMS`);
    const outputs = Object.values(spec.members);
    if (stamp[spec.archive] === expected && outputs.every((output) => existsSync(join(binDir, output)))) {
      console.log(`up to date       ${expected}  ${spec.archive}`);
      installed.push(...outputs);
      continue;
    }
    const archivePath = join(sourceDir, spec.archive);
    const data = readFileSync(archivePath);
    const actual = sha256(data);
    if (actual !== expected) {
      fail(`SHA256 mismatch for ${spec.archive}: expected ${expected}, got ${actual}`);
    }
    console.log(`sha256 ok        ${actual}  ${spec.archive}`);
    extract(spec, data, archivePath, binDir);
    for (const output of outputs) {
      chmodSync(join(binDir, output), 0o755);
      console.log(`placed           ${TOOLS_BIN_DIR}/${output}`);
    }
    stamp[spec.archive] = expected;
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    installed.push(...outputs);
  }
  installFonts(root, sourceDir, sums, stamp, stampPath);
  return installed;
}

/**
 * The fonts do not depend on the host platform. The stamp records the digest of every font
 * asset, so they are all re-placed when any of them changes or a font asset is added.
 */
function installFonts(root: string, sourceDir: string, sums: Map<string, string>, stamp: Record<string, string>, stampPath: string): void {
  const fontsDir = join(root, TOOLS_FONTS_DIR);
  const expected = FONT_ASSETS.map((file) => sums.get(file) ?? fail(`${file} is not listed in SHA256SUMS`)).join(" ");
  if (stamp[FONTS_DIR] === expected && FONT_OUTPUTS.every((file) => existsSync(join(fontsDir, file)))) {
    console.log(`up to date       ${FONT_ASSETS.join(", ")}`);
    return;
  }
  for (const { file, sha256: digest } of placeFonts(sourceDir, sums, fontsDir)) {
    console.log(`placed           ${digest}  ${TOOLS_FONTS_DIR}/${file}`);
  }
  stamp[FONTS_DIR] = expected;
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { assetsDir } = parseArgs(process.argv.slice(2));
    setupTools(process.cwd(), assetsDir);
  } catch (error) {
    console.error(`setup-tools: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
