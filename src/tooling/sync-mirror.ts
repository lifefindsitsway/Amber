import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ASSETS_DIR, FONT_ASSETS, RUNTIME_MANIFEST_FILE, SHA256SUMS_FILE } from "./runtime-assets.ts";
import { RUNTIME_LICENSES_ASSET } from "./third-party-notices.ts";

/**
 * Mirrors the build inputs into a directory on the Windows host so the installer is
 * built by native tools (Tauri does not recommend cross-compiling from Linux). Only an
 * allowlist is copied: root build configuration, the files under `src/` that git tracks
 * or would track, the documents the installer and the release carry (`CHANGELOG.md`,
 * `LICENSE`, `README.md`) and the Runtime Assets the Windows sidecar needs. Other documents,
 * tests, scratch files and review notes never reach the mirror.
 *
 * The mirror is never given a version of its own: package.json is the single version
 * source, so a candidate's version is raised and committed in the repository before the
 * mirror is taken, and a server built from the repository reports the same number.
 *
 * The mirror root gets `mirror-source.json`: the source commit, whether the working tree
 * was clean, the lockfile digest and the mirror's version, so the build report can name
 * what an installer was built from.
 */

export const ROOT_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.server.json",
  "tsconfig.web.json",
  "vite.config.ts",
] as const;
/** Documents shipped beside the build; each is copied when git tracks it or would track it. */
export const DOC_INPUTS = ["CHANGELOG.md", "LICENSE", "README.md"] as const;
export const MIRROR_SOURCE_FILE = "mirror-source.json";
/** The pinned list and manifest, the Windows binaries and fonts, and the runtime license texts the notices embed. */
export const ASSET_INPUTS = [
  SHA256SUMS_FILE,
  RUNTIME_MANIFEST_FILE,
  "node-v24.21.0-win-x64.zip",
  "deno-x86_64-pc-windows-msvc.zip",
  "ffmpeg-n9.0.2-3-ga5923073bf-win64-gpl-9.0.zip",
  "yt-dlp.exe",
  ...FONT_ASSETS,
  RUNTIME_LICENSES_ASSET,
] as const;

function git(root: string, args: readonly string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
  if (result.status !== 0 && !(args[0] === "check-ignore" && result.status === 1)) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Repository-relative paths (POSIX separators) that make up the build input. */
export function buildInputs(root: string): string[] {
  const sources = git(root, ["ls-files", "-co", "--exclude-standard", "--", "src"])
    .split("\n")
    .filter((path) => path !== "" && existsSync(join(root, path)));
  const docs = git(root, ["ls-files", "-co", "--exclude-standard", "--", ...DOC_INPUTS])
    .split("\n")
    .filter((path) => path !== "" && existsSync(join(root, path)));
  const assets = ASSET_INPUTS.map((file) => `${DEFAULT_ASSETS_DIR}/${file}`);
  return [...ROOT_INPUTS, ...sources, ...docs, ...assets].sort();
}

export interface MirrorSource {
  /** `git rev-parse HEAD` of the repository the mirror was taken from. */
  sourceCommit: string;
  /** Whether the working tree had uncommitted or untracked (not ignored) changes. */
  dirty: boolean;
  lockfileSha256: string;
  version: string;
}

/** What the mirror was taken from; `version` is the repository's package.json version, which the mirror copies unchanged. */
export function mirrorSource(root: string): MirrorSource {
  const sourceCommit = git(root, ["rev-parse", "HEAD"]).trim();
  const dirty = git(root, ["status", "--porcelain"]).trim() !== "";
  const lockfileSha256 = createHash("sha256").update(readFileSync(join(root, "pnpm-lock.yaml"))).digest("hex");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  return { sourceCommit, dirty, lockfileSha256, version };
}

/**
 * Skips files whose size and modification time already match, so the large assets copy
 * once. Times are compared in whole seconds: a Windows drive mounted into WSL keeps
 * modification times only to the second.
 */
function copyIfChanged(from: string, to: string): boolean {
  const source = statSync(from);
  if (existsSync(to)) {
    const target = statSync(to);
    if (target.size === source.size && Math.floor(target.mtimeMs / 1000) === Math.floor(source.mtimeMs / 1000)) {
      return false;
    }
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  utimesSync(to, source.atime, source.mtime);
  return true;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Removes mirror files under `src/` that are no longer build inputs. Paths the repository
 * ignores (generated files such as `src/desktop/gen/`) are left for the build to rewrite.
 */
function removeStale(root: string, dest: string, inputs: ReadonlySet<string>): string[] {
  const candidates = listFiles(join(dest, "src"))
    .map((path) => relative(dest, path).split(sep).join("/"))
    .filter((path) => !inputs.has(path));
  if (candidates.length === 0) {
    return [];
  }
  const ignored = new Set(git(root, ["check-ignore", "--no-index", "--stdin"], candidates.join("\n")).split("\n"));
  const stale = candidates.filter((path) => !ignored.has(path));
  for (const path of stale) {
    rmSync(join(dest, path));
  }
  return stale;
}

const USAGE = "usage: pnpm sync:mirror -- --dest <mirror directory>";

/**
 * The mirror directory from the command line. Anything else is refused, `--version` in
 * particular: a version set only in the mirror would differ from the repository's.
 */
export function mirrorArguments(args: readonly string[]): { dest: string } {
  const rest = args[0] === "--" ? args.slice(1) : args;
  if (rest.includes("--version")) {
    throw new Error("--version is not supported: raise the version in the repository's package.json and commit it before mirroring");
  }
  if (rest.length !== 2 || rest[0] !== "--dest" || rest[1] === undefined || rest[1].startsWith("--")) {
    throw new Error(USAGE);
  }
  return { dest: rest[1] };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const dest = resolve(mirrorArguments(process.argv.slice(2)).dest);
  if (dest === root || dest.startsWith(`${root}${sep}`)) {
    throw new Error("the mirror must live outside the repository");
  }
  const inputs = buildInputs(root);
  let copied = 0;
  for (const path of inputs) {
    if (copyIfChanged(join(root, path), join(dest, path))) {
      copied++;
    }
  }
  const stale = removeStale(root, dest, new Set(inputs));
  const source = mirrorSource(root);
  writeFileSync(join(dest, MIRROR_SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  console.log(`mirror ${dest}: ${inputs.length} inputs, ${copied} copied, ${stale.length} stale removed`);
  for (const path of stale) {
    console.log(`  removed ${path}`);
  }
  console.log(`  ${MIRROR_SOURCE_FILE}: ${source.sourceCommit}${source.dirty ? " (dirty)" : ""}, version ${source.version}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`sync-mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
