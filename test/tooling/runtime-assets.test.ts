import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSETS_DIR,
  FONT_ASSETS,
  FONT_OUTPUTS,
  parseSha256Sums,
  placeFonts,
  readPinnedSums,
  RUNTIME_ASSETS_SUMS_SHA256,
  RUNTIME_ASSETS_VERSION,
  READER_FONT_FILES,
  READER_FONT_LICENSES,
  sha256,
} from "../../src/tooling/runtime-assets.ts";
import { makeZip } from "../tools/zip.ts";

describe("parseSha256Sums", () => {
  it("reads sha256sum output, including binary-mode markers", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const sums = parseSha256Sums(`${a}  node.zip\n${b} *yt-dlp.exe\n\nnot a line\n`);
    expect([...sums]).toEqual([
      ["node.zip", a],
      ["yt-dlp.exe", b],
    ]);
  });
});

describe("the pinned Runtime Assets release", () => {
  it("is named by its tag and the SHA256 of its SHA256SUMS", () => {
    expect(RUNTIME_ASSETS_VERSION).toBe("runtime-assets-2026.11.11");
    expect(RUNTIME_ASSETS_SUMS_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(DEFAULT_ASSETS_DIR).toBe(`amber-runtime-assets/release/${RUNTIME_ASSETS_VERSION}`);
  });

  it("is the release CI downloads, from the public resource repository", () => {
    const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
    const downloads = [...workflow.matchAll(/gh release download (\S+) --repo (\S+)/gu)].map((match) => [match[1], match[2]]);
    expect(downloads).toEqual([[RUNTIME_ASSETS_VERSION, "lifefindsitsway/amber-runtime-assets"]]);
  });

  it("is downloaded in CI with every font asset setup:tools places", () => {
    const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
    const patterns = new Set([...workflow.matchAll(/--pattern (\S+)/gu)].map((match) => match[1]));
    expect(FONT_ASSETS.filter((file) => !patterns.has(file))).toEqual([]);
  });
});

describe("readPinnedSums", () => {
  it("parses SHA256SUMS only when its own digest is the pinned one", () => {
    const assets = mkdtempSync(join(tmpdir(), "amber-pinned-"));
    const text = `${"a".repeat(64)}  node.zip\n`;
    writeFileSync(join(assets, "SHA256SUMS"), text);
    expect([...readPinnedSums(assets, sha256(Buffer.from(text)))]).toEqual([["node.zip", "a".repeat(64)]]);
    expect(() => readPinnedSums(assets, "b".repeat(64))).toThrow(/not the pinned Runtime Assets checksum list: expected SHA256 b{64}, got [0-9a-f]{64}/u);
    // Whitespace counts: the pin is over the exact bytes.
    writeFileSync(join(assets, "SHA256SUMS"), `${text}\n`);
    expect(() => readPinnedSums(assets, sha256(Buffer.from(text)))).toThrow(/not the pinned/u);
  });
});

describe("sha256", () => {
  it("hashes bytes as lowercase hex", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("placeFonts", () => {
  const READER_FILES: Record<string, Buffer> = {
    "NotoSerifSC-Regular.otf": Buffer.from("serif regular"),
    "LXGWWenKaiLite-Regular.ttf": Buffer.from("wenkai regular"),
    "LXGWWenKaiLite-OFL.txt": Buffer.from("SIL OPEN FONT LICENSE Version 1.1 (LXGW)\n"),
  };

  function release(members: Array<{ name: string; data: Buffer }>) {
    const assets = mkdtempSync(join(tmpdir(), "amber-fonts-"));
    const zip = makeZip(members.map((member) => ({ ...member, method: 8 as const })));
    const licence = Buffer.from("SIL OPEN FONT LICENSE Version 1.1\n");
    writeFileSync(join(assets, "18_NotoSansSC.zip"), zip);
    writeFileSync(join(assets, "OFL.txt"), licence);
    const sums = new Map([
      ["18_NotoSansSC.zip", sha256(zip)],
      ["OFL.txt", sha256(licence)],
    ]);
    for (const [file, data] of Object.entries(READER_FILES)) {
      writeFileSync(join(assets, file), data);
      sums.set(file, sha256(data));
    }
    return { assets, sums, out: join(assets, "out", "fonts") };
  }

  it("verifies every asset and places the burn-in font, the reading fonts and their licences", () => {
    expect(READER_FONT_FILES).toEqual(["NotoSerifSC-Regular.otf", "LXGWWenKaiLite-Regular.ttf"]);
    expect(READER_FONT_LICENSES).toEqual(["LXGWWenKaiLite-OFL.txt"]);
    expect(FONT_ASSETS).toEqual(["18_NotoSansSC.zip", "OFL.txt", "NotoSerifSC-Regular.otf", "LXGWWenKaiLite-Regular.ttf", "LXGWWenKaiLite-OFL.txt"]);
    const { assets, sums, out } = release([
      { name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") },
      { name: "NotoSansSC-Bold.otf", data: Buffer.from("bold") },
      { name: "LICENSE", data: Buffer.from("licence") },
    ]);
    const placed = placeFonts(assets, sums, out);
    expect(placed).toEqual([
      { file: "NotoSansSC-Regular.otf", sha256: sha256(Buffer.from("regular")) },
      { file: "OFL.txt", sha256: sha256(readFileSync(join(assets, "OFL.txt"))) },
      ...Object.entries(READER_FILES).map(([file, data]) => ({ file, sha256: sha256(data) })),
    ]);
    // The loose files are copied byte for byte; Noto Serif SC has no licence file of its own.
    for (const [file, data] of Object.entries(READER_FILES)) {
      expect(readFileSync(join(out, file))).toEqual(data);
    }
    expect(readdirSync(out).sort()).toEqual([...FONT_OUTPUTS].sort());
    expect([...FONT_OUTPUTS].sort()).toEqual(
      ["LXGWWenKaiLite-OFL.txt", "LXGWWenKaiLite-Regular.ttf", "NotoSansSC-Regular.otf", "NotoSerifSC-Regular.otf", "OFL.txt"].sort(),
    );
  });

  it("refuses a tampered archive or one without the font", () => {
    const tampered = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
    tampered.sums.set("18_NotoSansSC.zip", "0".repeat(64));
    expect(() => placeFonts(tampered.assets, tampered.sums, tampered.out)).toThrow(/SHA256 mismatch for 18_NotoSansSC.zip/);
    const empty = release([{ name: "LICENSE", data: Buffer.from("licence") }]);
    expect(() => placeFonts(empty.assets, empty.sums, empty.out)).toThrow(/NotoSansSC-Regular.otf not found/);
    const unlisted = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
    unlisted.sums.delete("OFL.txt");
    expect(() => placeFonts(unlisted.assets, unlisted.sums, unlisted.out)).toThrow(/OFL.txt is not listed/);
  });

  it.each(["NotoSerifSC-Regular.otf", "LXGWWenKaiLite-Regular.ttf", "LXGWWenKaiLite-OFL.txt"])("refuses a tampered or unlisted %s and writes nothing", (file) => {
    const tampered = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
    writeFileSync(join(tampered.assets, file), "tampered");
    expect(() => placeFonts(tampered.assets, tampered.sums, tampered.out)).toThrow(`SHA256 mismatch for ${file}:`);
    expect(existsSync(tampered.out)).toBe(false);
    const unlisted = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
    unlisted.sums.delete(file);
    expect(() => placeFonts(unlisted.assets, unlisted.sums, unlisted.out)).toThrow(`${file} is not listed in SHA256SUMS`);
    expect(existsSync(unlisted.out)).toBe(false);
  });

  it.each(["18_NotoSansSC.zip", "OFL.txt", "NotoSerifSC-Regular.otf", "LXGWWenKaiLite-Regular.ttf", "LXGWWenKaiLite-OFL.txt"])(
    "refuses a release that lists %s but lacks it, and writes nothing",
    (file) => {
      const missing = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
      rmSync(join(missing.assets, file));
      expect(missing.sums.has(file)).toBe(true);
      expect(() => placeFonts(missing.assets, missing.sums, missing.out)).toThrow(`${file} is listed in SHA256SUMS but missing from ${missing.assets}`);
      expect(existsSync(missing.out)).toBe(false);
    },
  );
});
