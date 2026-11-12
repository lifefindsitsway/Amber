import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupTools, TOOL_ARCHIVES, TOOLS_BIN_DIR, TOOLS_FONTS_DIR } from "../../src/tooling/setup-tools.ts";
import { makeZip } from "../tools/zip.ts";

const hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The reading fonts and their licence, loose files of the release beside the burn-in font archive. */
const READER_FILES: Record<string, Buffer> = {
  "NotoSerifSC-Regular.otf": Buffer.from("serif"),
  "LXGWWenKaiLite-Regular.ttf": Buffer.from("wenkai"),
  "LXGWWenKaiLite-OFL.txt": Buffer.from("SIL Open Font License 1.1 (LXGW)\n"),
};

/** A fake release directory holding a tar.xz with the linux ffmpeg layout. */
function fakeRelease(content: { ffmpeg: string; ffprobe: string }) {
  const spec = TOOL_ARCHIVES.linux?.[0];
  if (spec === undefined) throw new Error("no linux archive");
  const work = mkdtempSync(join(tmpdir(), "amber-setup-"));
  const top = spec.archive.replace(/\.tar\.xz$/, "");
  mkdirSync(join(work, "src", top, "bin"), { recursive: true });
  writeFileSync(join(work, "src", top, "bin", "ffmpeg"), content.ffmpeg);
  writeFileSync(join(work, "src", top, "bin", "ffprobe"), content.ffprobe);
  const assets = join(work, "assets");
  mkdirSync(assets);
  const archive = join(assets, spec.archive);
  expect(spawnSync("tar", ["-cJf", archive, "-C", join(work, "src"), top]).status).toBe(0);
  const ytDlp = Buffer.from("#!/bin/sh\necho yt-dlp\n");
  writeFileSync(join(assets, "yt-dlp_linux"), ytDlp);
  const deno = makeZip([{ name: "deno", data: Buffer.from("#!/bin/sh\necho deno\n"), method: 8 }]);
  writeFileSync(join(assets, "deno-x86_64-unknown-linux-gnu.zip"), deno);
  const fonts = makeZip([
    { name: "NotoSansSC-Regular.otf", data: Buffer.from("regular"), method: 8 },
    { name: "NotoSansSC-Bold.otf", data: Buffer.from("bold"), method: 8 },
  ]);
  writeFileSync(join(assets, "18_NotoSansSC.zip"), fonts);
  const licence = Buffer.from("SIL Open Font License 1.1\n");
  writeFileSync(join(assets, "OFL.txt"), licence);
  for (const [file, data] of Object.entries(READER_FILES)) {
    writeFileSync(join(assets, file), data);
  }
  const sums = Buffer.from(
    [
      `${hex(readFileSync(archive))}  ${spec.archive}`,
      `${hex(ytDlp)}  yt-dlp_linux`,
      `${hex(deno)}  deno-x86_64-unknown-linux-gnu.zip`,
      `${hex(fonts)}  18_NotoSansSC.zip`,
      `${hex(licence)}  OFL.txt`,
      ...Object.entries(READER_FILES).map(([file, data]) => `${hex(data)}  ${file}`),
      "",
    ].join("\n"),
  );
  writeFileSync(join(assets, "SHA256SUMS"), sums);
  return { root: join(work, "repo"), assets, archive, pin: hex(sums) };
}

describe("setupTools", () => {
  it("verifies the archive, installs the tools executable and skips an unchanged archive", () => {
    const { root, assets, pin } = fakeRelease({ ffmpeg: "#!/bin/sh\necho ffmpeg\n", ffprobe: "#!/bin/sh\necho ffprobe\n" });
    mkdirSync(root);
    const tools = ["ffmpeg", "ffprobe", "yt-dlp", "deno"];
    expect(setupTools(root, assets, "linux", pin)).toEqual(tools);
    for (const tool of tools) {
      const path = join(root, TOOLS_BIN_DIR, tool);
      expect(readFileSync(path, "utf8")).toContain(`echo ${tool}`);
      expect(statSync(path).mode & 0o111).not.toBe(0);
    }
    expect(readdirSync(join(root, TOOLS_FONTS_DIR)).sort()).toEqual(
      ["LXGWWenKaiLite-OFL.txt", "LXGWWenKaiLite-Regular.ttf", "NotoSansSC-Regular.otf", "NotoSerifSC-Regular.otf", "OFL.txt"].sort(),
    );
    expect(readFileSync(join(root, TOOLS_FONTS_DIR, "NotoSansSC-Regular.otf"), "utf8")).toBe("regular");
    for (const [file, data] of Object.entries(READER_FILES)) {
      expect(readFileSync(join(root, TOOLS_FONTS_DIR, file))).toEqual(data);
    }
    expect(setupTools(root, assets, "linux", pin)).toEqual(tools);
  });

  it("re-places the fonts when a reading font is missing from an otherwise installed tree", () => {
    const { root, assets, pin } = fakeRelease({ ffmpeg: "#!/bin/sh\necho ffmpeg\n", ffprobe: "#!/bin/sh\necho ffprobe\n" });
    mkdirSync(root);
    setupTools(root, assets, "linux", pin);
    rmSync(join(root, TOOLS_FONTS_DIR, "LXGWWenKaiLite-Regular.ttf"));
    setupTools(root, assets, "linux", pin);
    expect(readFileSync(join(root, TOOLS_FONTS_DIR, "LXGWWenKaiLite-Regular.ttf"), "utf8")).toBe("wenkai");
  });

  it("refuses a tampered reading font", () => {
    const { root, assets, pin } = fakeRelease({ ffmpeg: "a", ffprobe: "b" });
    mkdirSync(root);
    writeFileSync(join(assets, "NotoSerifSC-Regular.otf"), "tampered");
    expect(() => setupTools(root, assets, "linux", pin)).toThrow("SHA256 mismatch for NotoSerifSC-Regular.otf:");
    expect(existsSync(join(root, TOOLS_FONTS_DIR))).toBe(false);
  });

  it("refuses a release that lists a reading font but lacks it", () => {
    const { root, assets, pin } = fakeRelease({ ffmpeg: "a", ffprobe: "b" });
    mkdirSync(root);
    rmSync(join(assets, "LXGWWenKaiLite-Regular.ttf"));
    expect(() => setupTools(root, assets, "linux", pin)).toThrow("LXGWWenKaiLite-Regular.ttf is listed in SHA256SUMS but missing from");
    expect(existsSync(join(root, TOOLS_FONTS_DIR))).toBe(false);
  });

  it("refuses an archive whose digest does not match SHA256SUMS", () => {
    const { root, assets, archive } = fakeRelease({ ffmpeg: "a", ffprobe: "b" });
    mkdirSync(root);
    const forged = Buffer.from(`${"0".repeat(64)}  ${archive.split("/").at(-1)}\n`);
    writeFileSync(join(assets, "SHA256SUMS"), forged);
    expect(() => setupTools(root, assets, "linux", hex(forged))).toThrow(/SHA256 mismatch/);
    expect(existsSync(join(root, TOOLS_BIN_DIR, "ffmpeg"))).toBe(false);
  });

  it("refuses a SHA256SUMS that is not the pinned one before trusting any hash in it", () => {
    const { root, assets, pin } = fakeRelease({ ffmpeg: "a", ffprobe: "b" });
    mkdirSync(root);
    // Self-consistent but not pinned: every listed hash matches its file.
    expect(() => setupTools(root, assets, "linux", "1".repeat(64))).toThrow(/not the pinned Runtime Assets checksum list/);
    // The compiled-in pin applies when none is passed.
    expect(() => setupTools(root, assets, "linux")).toThrow(/not the pinned Runtime Assets checksum list/);
    expect(existsSync(join(root, TOOLS_BIN_DIR, "ffmpeg"))).toBe(false);
    // An installed tree is no excuse either: the up-to-date shortcut comes after the check.
    setupTools(root, assets, "linux", pin);
    writeFileSync(join(assets, "SHA256SUMS"), `${readFileSync(join(assets, "SHA256SUMS"), "utf8")}\n`);
    expect(() => setupTools(root, assets, "linux", pin)).toThrow(/not the pinned Runtime Assets checksum list/);
  });
});
