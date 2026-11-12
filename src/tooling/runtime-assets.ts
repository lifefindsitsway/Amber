import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "./zip-reader.ts";

/**
 * The Amber Runtime Assets release this tree is built and tested with: its tag (also
 * `manifest.json` `version`) and the SHA256 of its `SHA256SUMS`. Pinning the digest of the
 * checksum list itself is what makes every per-file hash in it trustworthy: a directory
 * passed with `--assets`, wherever it came from, is used only when its `SHA256SUMS` is
 * byte-for-byte the pinned one.
 */
export const RUNTIME_ASSETS_VERSION = "runtime-assets-2026.11.11";
export const RUNTIME_ASSETS_SUMS_SHA256 = "abef5352d1b02f44f1ac493702d573d96db2e74c1c26ac087548c16409fc73b4";

/** Local working copy of the pinned Amber Runtime Assets release. */
export const DEFAULT_ASSETS_DIR = `amber-runtime-assets/release/${RUNTIME_ASSETS_VERSION}`;

export const SHA256SUMS_FILE = "SHA256SUMS";
export const RUNTIME_MANIFEST_FILE = "manifest.json";

export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sums.set(match[2], match[1]);
    }
  }
  return sums;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Reads `SHA256SUMS` from `assetsDir` and refuses it unless its own SHA256 is
 * `expectedSha256`, before any hash listed in it is trusted.
 */
export function readPinnedSums(assetsDir: string, expectedSha256: string = RUNTIME_ASSETS_SUMS_SHA256): Map<string, string> {
  const data = readFileSync(join(assetsDir, SHA256SUMS_FILE));
  const actual = sha256(data);
  if (actual !== expectedSha256) {
    throw new Error(
      `${SHA256SUMS_FILE} in ${assetsDir} is not the pinned Runtime Assets checksum list: expected SHA256 ${expectedSha256}, got ${actual}`,
    );
  }
  return parseSha256Sums(data.toString("utf8"));
}

/** Reads an asset of the release and checks it against `SHA256SUMS` before anything uses it. */
export function readVerifiedAsset(assetsDir: string, sums: Map<string, string>, file: string): Buffer {
  const expected = sums.get(file);
  if (expected === undefined) {
    throw new Error(`${file} is not listed in SHA256SUMS`);
  }
  // A listed asset the download left out names itself, rather than surfacing as a bare ENOENT.
  const path = join(assetsDir, file);
  if (!existsSync(path)) {
    throw new Error(`${file} is listed in SHA256SUMS but missing from ${assetsDir}`);
  }
  const data = readFileSync(path);
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  return data;
}

/**
 * Bundled fonts, each a single regular weight of the upstream file, unmodified and under the
 * SIL OFL 1.1:
 * - Noto Sans SC, the font the ASS styles name for burn-in and the player preview. The release
 *   carries it only inside the upstream family archive, so the regular weight is extracted.
 * - Noto Serif SC and LXGW WenKai Lite, the reading fonts. The release carries them as loose
 *   files, each listed in `SHA256SUMS` and checked on its own.
 * The two Noto fonts carry byte-identical license texts, so they share `OFL.txt`; LXGW WenKai
 * Lite ships its own. Everything goes to `fonts/` beside `bin/`, where the server looks for
 * them (`AMBER_BIN_DIR/../fonts`).
 */
export const FONTS_DIR = "fonts";
export const FONT_ARCHIVE = "18_NotoSansSC.zip";
export const FONT_LICENSE = "OFL.txt";
export const READER_FONT_FILES = ["NotoSerifSC-Regular.otf", "LXGWWenKaiLite-Regular.ttf"] as const;
export const READER_FONT_LICENSES = ["LXGWWenKaiLite-OFL.txt"] as const;
/** Runtime Assets files the fonts are taken from; each is verified against `SHA256SUMS`. */
export const FONT_ASSETS = [FONT_ARCHIVE, FONT_LICENSE, ...READER_FONT_FILES, ...READER_FONT_LICENSES] as const;
const FONT_MEMBERS = ["NotoSansSC-Regular.otf"] as const;
/** Loose release files copied to `fonts/` under their own names. */
const LOOSE_FONT_FILES = [FONT_LICENSE, ...READER_FONT_FILES, ...READER_FONT_LICENSES] as const;
/** File names `placeFonts` writes. */
export const FONT_OUTPUTS = [...FONT_MEMBERS, ...LOOSE_FONT_FILES] as const;

/** Writes the verified fonts and licences into `outDir`; returns what was placed with its SHA256. */
export function placeFonts(assetsDir: string, sums: Map<string, string>, outDir: string): Array<{ file: string; sha256: string }> {
  const zip = readZip(readVerifiedAsset(assetsDir, sums, FONT_ARCHIVE));
  const files: Array<{ file: string; data: Buffer }> = FONT_MEMBERS.map((member) => {
    const entry = zip.find((item) => item.name === member);
    if (entry === undefined) {
      throw new Error(`${member} not found in ${FONT_ARCHIVE}`);
    }
    return { file: member, data: entry.read() };
  });
  for (const file of LOOSE_FONT_FILES) {
    files.push({ file, data: readVerifiedAsset(assetsDir, sums, file) });
  }
  // Everything is verified before the first write, so a bad asset leaves `outDir` untouched.
  mkdirSync(outDir, { recursive: true });
  return files.map(({ file, data }) => {
    writeFileSync(join(outDir, file), data);
    return { file, sha256: sha256(data) };
  });
}
