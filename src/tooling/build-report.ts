import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_MANIFEST_URL } from "../shared/app-identity.ts";
import { findSignedInstaller, LATEST_JSON } from "./release-manifest.ts";
import { LEGAL_DIR, NOTICES_INCOMPLETE_MARKER, SIDECAR_DIR } from "./pack-sidecar.ts";
import { DEFAULT_ASSETS_DIR, RUNTIME_ASSETS_SUMS_SHA256, RUNTIME_ASSETS_VERSION, RUNTIME_MANIFEST_FILE, sha256, SHA256SUMS_FILE } from "./runtime-assets.ts";
import { MIRROR_INPUTS_FILE, MIRROR_SOURCE_FILE, type MirrorSource } from "./sync-mirror.ts";
import { CARGO_LOCK_ONLY_NOTE, NOTICES_FILE } from "./third-party-notices.ts";
import { UPDATER_CONFIG_FILE } from "./updater-config.ts";

/**
 * Writes `build-report.json` beside a signed build:
 *
 *   pnpm build:report -- --dir <artifact directory> --variant candidate|release
 *
 * It ties an installer to what it was built from: the mirror's source commit and whether the
 * tree was clean, the digest of the mirror's input list (`inputsDigest`, which names the exact
 * sources of a build from an uncommitted tree and which `pnpm verify:mirror` checks against a
 * commit), the build variant, the version, the lockfile and Runtime Assets digests, the
 * installer and signature digests, the updater public key id and the updater endpoint. The
 * report is a whitelist assembled field by field; it holds file names only, never absolute
 * paths, user names or environment variables. A variant whose updater configuration does not
 * match it (a release pointing at a test server, a candidate at the public feed) is refused,
 * so the two variants' artifacts cannot be mixed up. A release is also refused when its
 * Runtime Assets are not the pinned release (tag and `SHA256SUMS` digest), or when the
 * sidecar's third-party notices are incomplete (packed with `--allow-incomplete-cargo`); a
 * candidate records either fact and proceeds.
 */

export const BUILD_REPORT_FILE = "build-report.json";
export const BUILD_VARIANTS = ["candidate", "release"] as const;
export type BuildVariant = (typeof BUILD_VARIANTS)[number];

export interface BuildReport {
  generatedAt: string;
  variant: BuildVariant;
  version: string;
  source: { commit: string; dirty: boolean };
  /** SHA256 of the mirror's `mirror-inputs.json`. */
  inputsDigest: string;
  lockfileSha256: string;
  runtimeAssets: { version: string; manifestSha256: string; sha256SumsSha256: string; pinned: boolean };
  sidecar: { noticesComplete: boolean };
  installer: { file: string; sha256: string };
  signature: { file: string; sha256: string };
  latestJson: { file: string; sha256: string } | null;
  updater: { publicKeyId: string; endpoint: string; insecureTransport: boolean };
}

interface UpdaterOverlay {
  plugins?: { updater?: { endpoints?: unknown; dangerousInsecureTransportProtocol?: unknown } };
}

/** The minisign key id named in the public key's comment line, or a digest prefix when it has none. */
export function publicKeyIdOf(pubkeyBase64: string): string {
  const decoded = Buffer.from(pubkeyBase64, "base64").toString("utf8");
  const id = /minisign public key:\s*([0-9A-F]{16})/iu.exec(decoded)?.[1];
  return id === undefined ? `sha256:${sha256(Buffer.from(pubkeyBase64)).slice(0, 16)}` : id.toUpperCase();
}

/** The updater endpoint of the build, checked against its variant. */
export function updaterOf(overlay: UpdaterOverlay, variant: BuildVariant): { endpoint: string; insecureTransport: boolean } {
  const endpoints = overlay.plugins?.updater?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1 || typeof endpoints[0] !== "string") {
    throw new Error(`${UPDATER_CONFIG_FILE} must name exactly one updater endpoint`);
  }
  const endpoint = endpoints[0];
  const insecureTransport = overlay.plugins?.updater?.dangerousInsecureTransportProtocol === true;
  if (variant === "release" && (endpoint !== UPDATE_MANIFEST_URL || insecureTransport)) {
    throw new Error(`a release build must use the default updater feed ${UPDATE_MANIFEST_URL}; run \`pnpm updater:config\` without --local-test`);
  }
  if (variant === "candidate" && endpoint === UPDATE_MANIFEST_URL) {
    throw new Error("a candidate build must not use the public updater feed; run `pnpm updater:config -- --local-test <URL>`");
  }
  return { endpoint, insecureTransport };
}

function digestOf(path: string): string {
  return sha256(readFileSync(path));
}

/**
 * Whether the packed sidecar's notices are complete. The marker `pnpm pack:sidecar` leaves for
 * an incomplete build decides; the notices text is checked too, so deleting the marker by hand
 * does not turn a `Cargo.lock`-only crate list into a releasable one.
 */
export function sidecarNoticesComplete(root: string): boolean {
  const notices = join(root, SIDECAR_DIR, LEGAL_DIR, NOTICES_FILE);
  if (!existsSync(notices)) {
    throw new Error(`${SIDECAR_DIR}/${LEGAL_DIR}/${NOTICES_FILE} is missing; run \`pnpm pack:sidecar\` before building`);
  }
  return !existsSync(join(root, SIDECAR_DIR, NOTICES_INCOMPLETE_MARKER)) && !readFileSync(notices, "utf8").includes(CARGO_LOCK_ONLY_NOTE);
}

export interface BuildReportInput {
  root: string;
  dir: string;
  variant: BuildVariant;
  assetsDir?: string;
  /** The Runtime Assets release a release build must use; the compiled-in pin by default. */
  pinned?: { version: string; sumsSha256: string };
  now: Date;
}

export function buildReport(input: BuildReportInput): BuildReport {
  const { root, dir, variant } = input;
  const sourcePath = join(root, MIRROR_SOURCE_FILE);
  if (!existsSync(sourcePath)) {
    throw new Error(`${MIRROR_SOURCE_FILE} is missing; build from a mirror made by \`pnpm sync:mirror\``);
  }
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as MirrorSource;
  const inputsPath = join(root, MIRROR_INPUTS_FILE);
  if (!existsSync(inputsPath)) {
    throw new Error(`${MIRROR_INPUTS_FILE} is missing; build from a mirror made by \`pnpm sync:mirror\``);
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  if (source.version !== version) {
    throw new Error(`package.json version ${version} differs from ${MIRROR_SOURCE_FILE} version ${source.version}`);
  }
  const assetsDir = input.assetsDir ?? join(root, DEFAULT_ASSETS_DIR);
  const runtime = JSON.parse(readFileSync(join(assetsDir, RUNTIME_MANIFEST_FILE), "utf8")) as { version: string };
  const sumsSha256 = digestOf(join(assetsDir, SHA256SUMS_FILE));
  const pinned = input.pinned ?? { version: RUNTIME_ASSETS_VERSION, sumsSha256: RUNTIME_ASSETS_SUMS_SHA256 };
  const runtimePinned = runtime.version === pinned.version && sumsSha256 === pinned.sumsSha256;
  if (variant === "release" && !runtimePinned) {
    throw new Error(
      `a release build must use the pinned Runtime Assets ${pinned.version} (${SHA256SUMS_FILE} ${pinned.sumsSha256}); found ${runtime.version} (${SHA256SUMS_FILE} ${sumsSha256})`,
    );
  }
  const noticesComplete = sidecarNoticesComplete(root);
  if (variant === "release" && !noticesComplete) {
    throw new Error(
      `a release build needs complete third-party notices; ${SIDECAR_DIR} was packed without cargo metadata (--allow-incomplete-cargo), so rerun \`pnpm pack:sidecar\` on a host with Rust cargo`,
    );
  }
  const tauri = JSON.parse(readFileSync(join(root, "src/desktop/tauri.conf.json"), "utf8")) as { plugins: { updater: { pubkey: string } } };
  const overlay = JSON.parse(readFileSync(join(root, UPDATER_CONFIG_FILE), "utf8")) as UpdaterOverlay;
  const { installer, signature } = findSignedInstaller(dir);
  if (!installer.includes(`_${version}_`)) {
    throw new Error(`${installer} does not carry version ${version}`);
  }
  const latestPath = join(dir, LATEST_JSON);
  if (existsSync(latestPath)) {
    const latest = JSON.parse(readFileSync(latestPath, "utf8")) as { version?: unknown; platforms?: Record<string, { signature?: unknown }> };
    const signed = Object.values(latest.platforms ?? {})[0]?.signature;
    if (latest.version !== version || signed !== readFileSync(join(dir, signature), "utf8")) {
      throw new Error(`${LATEST_JSON} does not match this build's version and signature`);
    }
  }
  return {
    generatedAt: input.now.toISOString(),
    variant,
    version,
    source: { commit: source.sourceCommit, dirty: source.dirty },
    inputsDigest: digestOf(inputsPath),
    lockfileSha256: digestOf(join(root, "pnpm-lock.yaml")),
    runtimeAssets: { version: runtime.version, manifestSha256: digestOf(join(assetsDir, RUNTIME_MANIFEST_FILE)), sha256SumsSha256: sumsSha256, pinned: runtimePinned },
    sidecar: { noticesComplete },
    installer: { file: installer, sha256: digestOf(join(dir, installer)) },
    signature: { file: signature, sha256: digestOf(join(dir, signature)) },
    latestJson: existsSync(latestPath) ? { file: LATEST_JSON, sha256: digestOf(latestPath) } : null,
    updater: { publicKeyId: publicKeyIdOf(tauri.plugins.updater.pubkey), ...updaterOf(overlay, variant) },
  };
}

function parseArgs(argv: readonly string[]): { dir: string; variant: BuildVariant } {
  let dir: string | undefined;
  let variant: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dir") {
      dir = argv[++index];
    } else if (arg === "--variant") {
      variant = argv[++index];
    } else if (arg !== "--") {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (dir === undefined || !(BUILD_VARIANTS as readonly string[]).includes(variant ?? "")) {
    throw new Error("usage: pnpm build:report -- --dir <artifact directory> --variant candidate|release");
  }
  return { dir, variant: variant as BuildVariant };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const { dir, variant } = parseArgs(process.argv.slice(2));
  const report = buildReport({ root, dir: resolve(dir), variant, now: new Date() });
  writeFileSync(join(resolve(dir), BUILD_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${BUILD_REPORT_FILE}: ${report.variant} ${report.version} from ${report.source.commit}${report.source.dirty ? " (dirty)" : ""}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`build-report: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
