import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_BUNDLE, UNINSTALL_DATA_BUNDLE } from "./build-server.ts";
import {
  DEFAULT_ASSETS_DIR,
  FONT_ASSETS,
  FONTS_DIR,
  placeFonts,
  readPinnedSums,
  readVerifiedAsset,
  RUNTIME_ASSETS_SUMS_SHA256,
  RUNTIME_ASSETS_VERSION,
  RUNTIME_MANIFEST_FILE,
  sha256,
} from "./runtime-assets.ts";
import {
  collectCargoPackages,
  collectNpmPackages,
  complianceArtifactsOf,
  ffmpegProvenanceOf,
  ffmpegVersionOf,
  LICENSE_FILE,
  NOTICES_FILE,
  type PackageNotice,
  parseRuntimeManifest,
  renderSourceNotice,
  renderThirdPartyNotices,
  RUNTIME_LICENSES_ASSET,
  type RuntimeManifest,
  runtimeLicenseTexts,
  SOURCE_FILE,
} from "./third-party-notices.ts";
import { readZip } from "./zip-reader.ts";

/**
 * Assembles the Windows sidecar under `dist/sidecar/`:
 * - `node-x86_64-pc-windows-msvc.exe`: bundled Node, handed to Tauri as `externalBin`;
 * - `server/`: the server bundle plus production dependencies installed into a clean
 *   directory from the lockfile, never a copy of the development `node_modules`, and the
 *   uninstaller's data remover `uninstall-data.js`;
 * - `bin/`: yt-dlp, ffmpeg, ffprobe and Deno for Windows;
 * - `fonts/`: the burn-in font, the two reading fonts and their licences, beside `bin/` where
 *   the server looks for them;
 * - `legal/`: Amber's `LICENSE`, `THIRD_PARTY_NOTICES.md` and `SOURCE.md`.
 * The Runtime Assets directory is used only when its `SHA256SUMS` is the pinned one and its
 * manifest names the pinned release; every upstream artifact is then checked against that
 * `SHA256SUMS` before use. The sidecar is always the Windows one; the host only runs the install.
 *
 *   pnpm pack:sidecar [--assets <dir>] [--allow-incomplete-cargo]
 *
 * Complete notices need the license texts of the shell's Rust crates, which only `cargo
 * metadata` provides. Without cargo the build stops, unless `--allow-incomplete-cargo` is
 * given for a development test build: it then proceeds with the crates listed from
 * `Cargo.lock` and leaves `NOTICES_INCOMPLETE_MARKER` beside the bundled directories, which
 * makes the build report refuse the release variant.
 */

export const SIDECAR_DIR = "dist/sidecar";
export const LEGAL_DIR = "legal";
/**
 * Written to the sidecar root (never into `server/`, `bin/`, `fonts/` or `legal/`, which the
 * installer bundles) when the notices lack the Rust crates' license texts.
 */
export const NOTICES_INCOMPLETE_MARKER = "notices-incomplete.json";
export const ALLOW_INCOMPLETE_CARGO_FLAG = "--allow-incomplete-cargo";
const WINDOWS_TRIPLE = "x86_64-pc-windows-msvc";
const PREBUILD = "node_modules/better-sqlite3/prebuilds/win32-x64.node";

interface ZipExtraction {
  archive: string;
  entries: readonly { entry: string; output: string }[];
}

/** Upstream artifacts at their pinned versions and where they land in the sidecar. */
const ZIP_EXTRACTIONS: readonly ZipExtraction[] = [
  {
    archive: "node-v24.21.0-win-x64.zip",
    entries: [{ entry: "node-v24.21.0-win-x64/node.exe", output: `node-${WINDOWS_TRIPLE}.exe` }],
  },
  { archive: "deno-x86_64-pc-windows-msvc.zip", entries: [{ entry: "deno.exe", output: "bin/deno.exe" }] },
  {
    archive: "ffmpeg-n9.0.2-3-ga5923073bf-win64-gpl-9.0.zip",
    entries: [
      { entry: "ffmpeg-n9.0.2-3-ga5923073bf-win64-gpl-9.0/bin/ffmpeg.exe", output: "bin/ffmpeg.exe" },
      { entry: "ffmpeg-n9.0.2-3-ga5923073bf-win64-gpl-9.0/bin/ffprobe.exe", output: "bin/ffprobe.exe" },
    ],
  },
];
const PLAIN_COPIES: readonly { file: string; output: string }[] = [{ file: "yt-dlp.exe", output: "bin/yt-dlp.exe" }];

/** Every Runtime Assets file whose content the installer carries; the notices list exactly these. */
export const SHIPPED_ASSETS: readonly string[] = [
  ...ZIP_EXTRACTIONS.map(({ archive }) => archive),
  ...PLAIN_COPIES.map(({ file }) => file),
  ...FONT_ASSETS,
];

/** Files the clean install needs: the manifest, the lockfile and the pnpm build policy. */
const INSTALL_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"] as const;

/** Paths under `dir` that are symbolic links or junctions; both break when copied into an installer. */
export function findLinks(dir: string): string[] {
  const links: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        links.push(relative(dir, path));
      } else if (stats.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(dir);
  return links;
}

/**
 * Directories that packages publish beside their code but never load at run time: test
 * suites, examples and benchmarks. Only a package's own top-level directory of that name is
 * removed; a file or a deeper directory with the same name may be real code.
 */
const NON_RUNTIME_DIRS: ReadonlySet<string> = new Set([
  "__tests__",
  "bench",
  "benchmark",
  "benchmarks",
  "example",
  "examples",
  "test",
  "tests",
]);

/**
 * Removes `NON_RUNTIME_DIRS` from every installed package, nested `node_modules` included,
 * and returns the removed paths relative to `nodeModulesDir`. Package manifests and license
 * files stay where they are, so the third-party notices are unaffected.
 */
export function pruneNonRuntimeDirs(nodeModulesDir: string): string[] {
  const removed: string[] = [];
  const visitPackage = (dir: string): void => {
    if (!existsSync(join(dir, "package.json"))) {
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (NON_RUNTIME_DIRS.has(name) && lstatSync(path).isDirectory()) {
        rmSync(path, { recursive: true, force: true });
        removed.push(relative(nodeModulesDir, path));
      }
    }
    visitModules(join(dir, "node_modules"));
  };
  const visitModules = (modules: string): void => {
    if (!existsSync(modules)) {
      return;
    }
    for (const name of readdirSync(modules).sort()) {
      const path = join(modules, name);
      if (name.startsWith(".") || !lstatSync(path).isDirectory()) {
        continue;
      }
      if (name.startsWith("@")) {
        for (const scoped of readdirSync(path).sort()) {
          visitPackage(join(path, scoped));
        }
      } else {
        visitPackage(path);
      }
    }
  };
  visitModules(nodeModulesDir);
  return removed;
}

function fail(message: string): never {
  throw new Error(message);
}

function verifiedAsset(assetsDir: string, sums: Map<string, string>, file: string): Buffer {
  const expected = sums.get(file) ?? fail(`${file} is not listed in SHA256SUMS`);
  const data = readFileSync(join(assetsDir, file));
  const actual = sha256(data);
  if (actual !== expected) {
    fail(`SHA256 mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  console.log(`sha256 ok        ${actual}  ${file}`);
  return data;
}

/** pnpm exposes its own executable to scripts; calling it directly avoids a shell and `.cmd` shims. */
function pnpmCommand(): { command: string; prefix: string[] } {
  const execPath = process.env["npm_execpath"] ?? fail("run this through `pnpm pack:sidecar` (npm_execpath is unset)");
  return /\.[cm]?js$/.test(execPath) ? { command: process.execPath, prefix: [execPath] } : { command: execPath, prefix: [] };
}

function installProductionDependencies(serverDir: string): void {
  const { command, prefix } = pnpmCommand();
  const args = [...prefix, "install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"];
  console.log(`$ pnpm ${args.slice(prefix.length).join(" ")}   (cwd ${SIDECAR_DIR}/server)`);
  const result = spawnSync(command, args, { cwd: serverDir, stdio: "inherit", env: { ...process.env, CI: "true" } });
  if (result.status !== 0) {
    fail(`pnpm install exited with ${result.status ?? result.signal}`);
  }
  // Command launchers for package CLIs (symlinks on POSIX, shims on Windows); the sidecar
  // only runs `node server.js`, and links do not survive being bundled into an installer.
  rmSync(join(serverDir, "node_modules/.bin"), { recursive: true, force: true });
  const pruned = pruneNonRuntimeDirs(join(serverDir, "node_modules"));
  console.log(`pruned           ${pruned.length} test, example and benchmark directories from node_modules`);
}

interface ModulesState {
  allowBuilds?: Record<string, boolean>;
  pendingBuilds?: unknown[];
}

function assertInstall(serverDir: string, devDependencies: readonly string[]): void {
  // better-sqlite3 is the only production dependency with an install script (node-gyp).
  // pnpm records the build policy it applied in node_modules/.modules.yaml (JSON content).
  const state = JSON.parse(readFileSync(join(serverDir, "node_modules/.modules.yaml"), "utf8")) as ModulesState;
  if (state.allowBuilds?.["better-sqlite3"] !== false || (state.pendingBuilds ?? []).length !== 0) {
    fail("pnpm did not record better-sqlite3 as denied with no pending builds");
  }
  if (existsSync(join(serverDir, "node_modules/better-sqlite3/build"))) {
    fail("better-sqlite3/build exists: an install script ran");
  }
  console.log(
    "assert ok        no build scripts executed (allowBuilds better-sqlite3=false, pendingBuilds=[], better-sqlite3/build absent)",
  );

  const prebuild = join(serverDir, PREBUILD);
  if (!existsSync(prebuild) || statSync(prebuild).size === 0) {
    fail(`missing prebuild ${PREBUILD}`);
  }
  console.log(`assert ok        prebuild present: ${PREBUILD} (${statSync(prebuild).size} bytes)`);

  const links = findLinks(join(serverDir, "node_modules"));
  if (links.length > 0) {
    fail(`node_modules contains links: ${links.slice(0, 5).join(", ")}`);
  }
  console.log("assert ok        node_modules has no symlinks or junctions");

  const leaked = devDependencies.filter((name) => existsSync(join(serverDir, "node_modules", name)));
  if (leaked.length > 0) {
    fail(`devDependencies installed: ${leaked.join(", ")}`);
  }
  console.log("assert ok        no devDependencies installed");
}

/** On Windows the bundled Node must load the prebuilt addon from the packed tree. */
function smokeLoadSqlite(outDir: string): void {
  if (process.platform !== "win32") {
    console.log("skip             better-sqlite3 load check (needs Windows; done on the Windows host and the VM)");
    return;
  }
  const script =
    "const Database = require('better-sqlite3'); const db = new Database(':memory:');" +
    "console.log(db.prepare('select sqlite_version() as v').get().v)";
  const result = spawnSync(join(outDir, `node-${WINDOWS_TRIPLE}.exe`), ["-e", script], {
    cwd: join(outDir, "server"),
    encoding: "utf8",
    env: { SystemRoot: process.env["SystemRoot"] ?? "" },
  });
  if (result.status !== 0) {
    fail(`bundled Node could not load better-sqlite3: ${result.stderr}`);
  }
  console.log(`assert ok        bundled Node loads better-sqlite3 (SQLite ${result.stdout.trim()})`);
}

/** The pinned Runtime Assets release, opened and checked. */
export interface RuntimeAssets {
  sums: Map<string, string>;
  manifest: RuntimeManifest;
}

/**
 * Opens a Runtime Assets directory: its `SHA256SUMS` must have the pinned digest before any
 * hash in it is trusted, and its verified manifest must name the pinned release, so a
 * directory of another release cannot reach the installer even with consistent checksums.
 */
export function openRuntimeAssets(
  assetsDir: string,
  pinned: { version: string; sumsSha256: string } = { version: RUNTIME_ASSETS_VERSION, sumsSha256: RUNTIME_ASSETS_SUMS_SHA256 },
): RuntimeAssets {
  const sums = readPinnedSums(assetsDir, pinned.sumsSha256);
  const manifest = parseRuntimeManifest(readVerifiedAsset(assetsDir, sums, RUNTIME_MANIFEST_FILE).toString("utf8"));
  if (manifest.version !== pinned.version) {
    fail(`${RUNTIME_MANIFEST_FILE} names Runtime Assets ${manifest.version}, expected ${pinned.version}`);
  }
  return { sums, manifest };
}

export interface LegalFilesInput {
  root: string;
  assetsDir: string;
  runtime: RuntimeAssets;
  /** File names of the Runtime Assets the sidecar carries. */
  shippedAssets: readonly string[];
  /** The installed `server/` directory whose `node_modules` the notices list. */
  serverDir: string;
  outDir: string;
  version: string;
  /** Proceed without the Rust crates' license texts and leave `NOTICES_INCOMPLETE_MARKER`. */
  allowIncompleteCargo: boolean;
  /** How the shell's crates are collected; `cargo metadata` with a `Cargo.lock` fallback by default. */
  collectCargo?: (desktopDir: string) => { packages: PackageNotice[]; complete: boolean };
}

/**
 * Writes `legal/LICENSE`, `legal/THIRD_PARTY_NOTICES.md` and `legal/SOURCE.md`. The compliance
 * download URLs come from the verified Runtime Assets manifest, so `SOURCE.md` is final before
 * the installer is signed. Fails before writing anything when the Rust crate list could only be
 * read from `Cargo.lock`, unless `allowIncompleteCargo` is set; then the marker is written.
 */
export function writeLegalFiles(input: LegalFilesInput): { cargoComplete: boolean; files: string[] } {
  const license = join(input.root, LICENSE_FILE);
  if (!existsSync(license)) {
    fail(`${LICENSE_FILE} is missing at the repository root`);
  }
  const { sums, manifest } = input.runtime;
  const cargo = (input.collectCargo ?? collectCargoPackages)(join(input.root, "src/desktop"));
  if (!cargo.complete && !input.allowIncompleteCargo) {
    fail(
      `cargo metadata is unavailable, so the Rust crates' license texts cannot be collected; build on a host with Rust cargo, or pass ${ALLOW_INCOMPLETE_CARGO_FLAG} for a development test build`,
    );
  }
  const notices = renderThirdPartyNotices({
    amberVersion: input.version,
    runtime: manifest,
    shippedAssets: input.shippedAssets,
    runtimeTexts: runtimeLicenseTexts(readVerifiedAsset(input.assetsDir, sums, RUNTIME_LICENSES_ASSET)),
    npm: collectNpmPackages(join(input.serverDir, "node_modules")),
    cargo: cargo.packages,
    cargoComplete: cargo.complete,
  });
  const source = renderSourceNotice({
    amberVersion: input.version,
    ffmpegVersion: ffmpegVersionOf(manifest),
    runtimeAssetsVersion: manifest.version,
    ...complianceArtifactsOf(manifest),
    ...ffmpegProvenanceOf(manifest),
  });
  const legalDir = join(input.outDir, LEGAL_DIR);
  mkdirSync(legalDir, { recursive: true });
  copyFileSync(license, join(legalDir, LICENSE_FILE));
  writeFileSync(join(legalDir, NOTICES_FILE), notices);
  writeFileSync(join(legalDir, SOURCE_FILE), source);
  const marker = join(input.outDir, NOTICES_INCOMPLETE_MARKER);
  if (cargo.complete) {
    rmSync(marker, { force: true });
  } else {
    const reason = "cargo metadata unavailable: Rust crates listed from Cargo.lock without license texts; for development testing only";
    writeFileSync(marker, `${JSON.stringify({ notices: `${LEGAL_DIR}/${NOTICES_FILE}`, reason }, null, 2)}\n`);
  }
  return { cargoComplete: cargo.complete, files: [LICENSE_FILE, NOTICES_FILE, SOURCE_FILE].map((file) => `${LEGAL_DIR}/${file}`) };
}

export function parseArgs(argv: readonly string[]): { assetsDir: string | undefined; allowIncompleteCargo: boolean } {
  let assetsDir: string | undefined;
  let allowIncompleteCargo = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--assets") {
      assetsDir = argv[++index] ?? fail("--assets needs a directory");
    } else if (arg === ALLOW_INCOMPLETE_CARGO_FLAG) {
      allowIncompleteCargo = true;
    } else if (arg !== "--") {
      fail(`unknown argument ${arg}`);
    }
  }
  return { assetsDir, allowIncompleteCargo };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const args = parseArgs(process.argv.slice(2));
  const assetsDir = resolve(root, args.assetsDir ?? DEFAULT_ASSETS_DIR);
  const outDir = join(root, SIDECAR_DIR);
  const bundle = join(root, SERVER_BUNDLE);
  const remover = join(root, UNINSTALL_DATA_BUNDLE);
  for (const [file, name] of [
    [bundle, SERVER_BUNDLE],
    [remover, UNINSTALL_DATA_BUNDLE],
  ] as const) {
    if (!existsSync(file)) {
      fail(`${name} is missing; run \`pnpm build\` first`);
    }
  }
  // Before the slow install: a foreign or stale Runtime Assets directory stops the build here.
  const runtime = openRuntimeAssets(assetsDir);
  const { sums } = runtime;
  console.log(`assert ok        Runtime Assets ${runtime.manifest.version} (pinned SHA256SUMS)`);
  // Also before the install, so a host without cargo learns at once that it needs the flag.
  const cargo = collectCargoPackages(join(root, "src/desktop"));
  if (!cargo.complete && !args.allowIncompleteCargo) {
    fail(`cargo metadata is unavailable; build on a host with Rust cargo, or pass ${ALLOW_INCOMPLETE_CARGO_FLAG} for a development test build`);
  }

  rmSync(outDir, { recursive: true, force: true });
  const serverDir = join(outDir, "server");
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(bundle, join(serverDir, "server.js"));
  copyFileSync(remover, join(serverDir, "uninstall-data.js"));
  for (const file of INSTALL_INPUTS) {
    copyFileSync(join(root, file), join(serverDir, file));
  }
  installProductionDependencies(serverDir);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
    devDependencies?: Record<string, string>;
  };
  assertInstall(serverDir, Object.keys(packageJson.devDependencies ?? {}));

  for (const { archive, entries } of ZIP_EXTRACTIONS) {
    const zip = readZip(verifiedAsset(assetsDir, sums, archive));
    for (const { entry, output } of entries) {
      const found = zip.find((item) => item.name === entry) ?? fail(`${entry} not found in ${archive}`);
      const target = join(outDir, output);
      mkdirSync(dirname(target), { recursive: true });
      const data = found.read();
      writeFileSync(target, data);
      console.log(`placed           ${sha256(data)}  ${output}`);
    }
  }
  for (const { file, output } of PLAIN_COPIES) {
    const data = verifiedAsset(assetsDir, sums, file);
    const target = join(outDir, output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    console.log(`placed           ${sha256(data)}  ${output}`);
  }
  for (const { file, sha256: digest } of placeFonts(assetsDir, sums, join(outDir, FONTS_DIR))) {
    console.log(`placed           ${digest}  ${FONTS_DIR}/${file}`);
  }
  const legal = writeLegalFiles({
    root,
    assetsDir,
    runtime,
    shippedAssets: SHIPPED_ASSETS,
    serverDir,
    outDir,
    version: packageJson.version,
    allowIncompleteCargo: args.allowIncompleteCargo,
    collectCargo: () => cargo,
  });
  for (const file of legal.files) {
    console.log(`placed           ${sha256(readFileSync(join(outDir, file)))}  ${file}`);
  }
  if (!legal.cargoComplete) {
    console.warn(
      `warn             ${ALLOW_INCOMPLETE_CARGO_FLAG}: Rust crates listed from Cargo.lock without license texts; this sidecar is for development testing only and must not be released (${SIDECAR_DIR}/${NOTICES_INCOMPLETE_MARKER} written)`,
    );
  }
  smokeLoadSqlite(outDir);
  console.log(`sidecar ready    ${SIDECAR_DIR}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`pack-sidecar: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
