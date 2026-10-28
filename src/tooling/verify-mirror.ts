import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ASSETS_DIR, parseSha256Sums, RUNTIME_ASSETS_SUMS_SHA256, RUNTIME_MANIFEST_FILE, SHA256SUMS_FILE } from "./runtime-assets.ts";
import { buildInputs, DOC_INPUTS, fileSha256, ignoredInputs, MIRROR_INPUTS_FILE, ROOT_INPUTS, type InputDigests, type MirrorInputs } from "./sync-mirror.ts";

/**
 * Checks a mirror's recorded inputs against the sources they should have come from:
 *
 *   pnpm verify:mirror -- --dest <mirror directory> [--ref <git ref>]
 *
 * A candidate is built and tested from a mirror of a possibly uncommitted tree; once the
 * work is committed, `--ref HEAD` shows whether that commit holds exactly the sources the
 * tested build was made from, before anything is pushed. The `tracked` inputs are compared
 * file by file with the working tree (by default) or with the tree of the given commit. The
 * ignored `local` inputs exist in no commit, so they are compared with the mirror's current
 * files, and the Runtime Assets also with the pinned `SHA256SUMS`. Every missing, extra or
 * changed file is listed; the exit code is 0 only when everything matches.
 */

export interface InputDifferences {
  /** Expected by the reference but not recorded, or recorded but gone from the mirror. */
  missing: string[];
  /** Recorded but not expected by the reference. */
  extra: string[];
  /** Recorded with another SHA256 than the reference. */
  changed: string[];
}

export interface MirrorVerification {
  /** `working tree`, or the ref with the commit it named. */
  against: string;
  /** SHA256 of `mirror-inputs.json`, the `inputsDigest` a build report of this mirror carries. */
  inputsDigest: string;
  tracked: InputDifferences;
  local: InputDifferences;
  /** Runtime Assets whose recorded SHA256 is not the one the pinned `SHA256SUMS` lists. */
  unpinned: string[];
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** What `reference` has that `recorded` lacks, the reverse, and the paths whose digests differ. */
export function compareDigests(reference: InputDigests, recorded: InputDigests): InputDifferences {
  const missing = Object.keys(reference).filter((path) => !(path in recorded));
  const extra = Object.keys(recorded).filter((path) => !(path in reference));
  const changed = Object.keys(recorded).filter((path) => path in reference && reference[path] !== recorded[path]);
  return { missing: missing.sort(), extra: extra.sort(), changed: changed.sort() };
}

/** The tracked inputs the working tree would mirror now, hashed in place. */
export function workingTreeDigests(root: string): InputDigests {
  const inputs = buildInputs(root);
  const ignored = ignoredInputs(root, inputs);
  const digests: InputDigests = {};
  for (const path of inputs) {
    if (!ignored.has(path)) {
      digests[path] = fileSha256(join(root, path));
    }
  }
  return digests;
}

/** The full commit id `ref` names; an unknown ref is an error rather than an empty tree. */
export function commitOf(root: string, ref: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${ref} does not name a commit`);
  }
  return result.stdout.trim();
}

/**
 * The inputs a checkout of `commit` would mirror, hashed from their blobs. All blobs are read
 * through one `git cat-file --batch`. Blobs are hashed as stored, without checkout filters:
 * a line-ending conversion would show up as a change rather than be hidden.
 */
export function commitDigests(root: string, commit: string): InputDigests {
  const listing = git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", "src", ...ROOT_INPUTS, ...DOC_INPUTS]);
  const entries: Array<{ oid: string; path: string }> = [];
  for (const record of listing.split("\0")) {
    // `<mode> <type> <oid>\t<path>`; links and submodules are not files a mirror copies.
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/su.exec(record);
    if (match?.[2] !== undefined && match[3] !== undefined) {
      entries.push({ oid: match[2], path: match[3] });
    }
  }
  if (entries.length === 0) {
    return {};
  }
  const result = spawnSync("git", ["cat-file", "--batch"], { cwd: root, input: `${entries.map((entry) => entry.oid).join("\n")}\n`, maxBuffer: 2 ** 31 - 1 });
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${result.stderr.toString("utf8")}`);
  }
  const output = result.stdout;
  const digests: InputDigests = {};
  let offset = 0;
  for (const entry of entries) {
    const end = output.indexOf(0x0a, offset);
    const header = /^([0-9a-f]+) blob (\d+)$/u.exec(output.subarray(offset, end).toString("utf8"));
    if (end < 0 || header?.[1] !== entry.oid || header[2] === undefined) {
      throw new Error(`git cat-file --batch gave no blob for ${entry.path}`);
    }
    const size = Number(header[2]);
    digests[entry.path] = sha256(output.subarray(end + 1, end + 1 + size));
    // The content is followed by a newline of its own.
    offset = end + 1 + size + 1;
  }
  return digests;
}

function isDigests(value: unknown): value is InputDigests {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((digest) => typeof digest === "string");
}

/** The mirror's `mirror-inputs.json` and its own SHA256. */
export function readMirrorInputs(dest: string): { inputs: MirrorInputs; digest: string } {
  const path = join(dest, MIRROR_INPUTS_FILE);
  if (!existsSync(path)) {
    throw new Error(`${MIRROR_INPUTS_FILE} is missing in ${dest}; run \`pnpm sync:mirror\` first`);
  }
  const data = readFileSync(path);
  const parsed = JSON.parse(data.toString("utf8")) as Partial<MirrorInputs>;
  if (!isDigests(parsed.tracked) || !isDigests(parsed.local) || typeof parsed.assetsManifest !== "string") {
    throw new Error(`${MIRROR_INPUTS_FILE} in ${dest} is not a mirror input list`);
  }
  return { inputs: { tracked: parsed.tracked, local: parsed.local, assetsManifest: parsed.assetsManifest }, digest: sha256(data) };
}

/**
 * The recorded local inputs against the mirror's current files and the paths the repository
 * expects to be local; the Runtime Assets among them also against the pinned checksum list.
 * The mirror's `SHA256SUMS` is only trusted once its own SHA256 is the pinned one.
 */
export function verifyLocal(
  dest: string,
  recorded: MirrorInputs,
  expected: readonly string[],
  pinnedSumsSha256: string,
): { local: InputDifferences; unpinned: string[] } {
  const current: InputDigests = {};
  for (const path of Object.keys(recorded.local)) {
    if (existsSync(join(dest, path))) {
      current[path] = fileSha256(join(dest, path));
    }
  }
  const versusMirror = compareDigests(current, recorded.local);
  const missing = new Set([...versusMirror.extra, ...expected.filter((path) => !(path in recorded.local))]);
  const wanted = new Set(expected);
  const local = { missing: [...missing].sort(), extra: Object.keys(recorded.local).filter((path) => !wanted.has(path)).sort(), changed: versusMirror.changed };

  const sumsPath = `${DEFAULT_ASSETS_DIR}/${SHA256SUMS_FILE}`;
  const unpinned: string[] = [];
  if (recorded.local[sumsPath] !== pinnedSumsSha256 || current[sumsPath] !== pinnedSumsSha256) {
    unpinned.push(sumsPath);
  } else {
    const sums = parseSha256Sums(readFileSync(join(dest, sumsPath), "utf8"));
    for (const [path, digest] of Object.entries(recorded.local)) {
      if (path !== sumsPath && path.startsWith(`${DEFAULT_ASSETS_DIR}/`) && sums.get(path.slice(DEFAULT_ASSETS_DIR.length + 1)) !== digest) {
        unpinned.push(path);
      }
    }
    if (sums.get(RUNTIME_MANIFEST_FILE) !== recorded.assetsManifest) {
      unpinned.push(`assetsManifest (${DEFAULT_ASSETS_DIR}/${RUNTIME_MANIFEST_FILE})`);
    }
  }
  return { local, unpinned: unpinned.sort() };
}

export interface VerifyInput {
  root: string;
  dest: string;
  /** A commit to compare the tracked inputs with; the working tree when absent. */
  ref?: string;
  /** SHA256 of the pinned `SHA256SUMS`; the compiled-in pin by default. */
  pinnedSumsSha256?: string;
}

export function verifyMirror(input: VerifyInput): MirrorVerification {
  const { root, dest } = input;
  const { inputs, digest } = readMirrorInputs(dest);
  let reference: InputDigests;
  let against = "working tree";
  if (input.ref === undefined) {
    reference = workingTreeDigests(root);
  } else {
    const commit = commitOf(root, input.ref);
    reference = commitDigests(root, commit);
    against = `${input.ref} (${commit})`;
  }
  const all = buildInputs(root);
  const expectedLocal = [...ignoredInputs(root, all)].sort();
  const { local, unpinned } = verifyLocal(dest, inputs, expectedLocal, input.pinnedSumsSha256 ?? RUNTIME_ASSETS_SUMS_SHA256);
  return { against, inputsDigest: digest, tracked: compareDigests(reference, inputs.tracked), local, unpinned };
}

export function mirrorMatches(result: MirrorVerification): boolean {
  const empty = (differences: InputDifferences): boolean => differences.missing.length + differences.extra.length + differences.changed.length === 0;
  return empty(result.tracked) && empty(result.local) && result.unpinned.length === 0;
}

const USAGE = "usage: pnpm verify:mirror -- --dest <mirror directory> [--ref <git ref>]";

export function verifyArguments(args: readonly string[]): { dest: string; ref?: string } {
  const rest = args[0] === "--" ? args.slice(1) : args;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if ((flag !== "--dest" && flag !== "--ref") || values.has(flag) || value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const dest = values.get("--dest");
  const ref = values.get("--ref");
  if (dest === undefined) {
    throw new Error(USAGE);
  }
  return { dest, ...(ref === undefined ? {} : { ref }) };
}

function report(result: MirrorVerification, dest: string): string[] {
  const lines = [`mirror ${dest} against ${result.against}`, `  inputsDigest ${result.inputsDigest}`];
  for (const [name, differences] of [
    ["tracked", result.tracked],
    ["local", result.local],
  ] as const) {
    lines.push(`  ${name}: ${differences.missing.length} missing, ${differences.extra.length} extra, ${differences.changed.length} changed`);
    for (const kind of ["missing", "extra", "changed"] as const) {
      lines.push(...differences[kind].map((path) => `    ${kind} ${path}`));
    }
  }
  lines.push(`  pinned Runtime Assets: ${result.unpinned.length === 0 ? "match" : `${result.unpinned.length} not as pinned`}`);
  lines.push(...result.unpinned.map((path) => `    unpinned ${path}`));
  lines.push(mirrorMatches(result) ? "mirror matches" : "mirror differs");
  return lines;
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const args = verifyArguments(process.argv.slice(2));
  const dest = resolve(args.dest);
  const result = verifyMirror({ root, dest, ...(args.ref === undefined ? {} : { ref: args.ref }) });
  for (const line of report(result, dest)) {
    console.log(line);
  }
  process.exitCode = mirrorMatches(result) ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`verify-mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
