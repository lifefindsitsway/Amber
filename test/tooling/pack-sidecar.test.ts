import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findLinks,
  NOTICES_INCOMPLETE_MARKER,
  openRuntimeAssets,
  parseArgs,
  pruneNonRuntimeDirs,
  SHIPPED_ASSETS,
  writeLegalFiles,
  type LegalFilesInput,
} from "../../src/tooling/pack-sidecar.ts";
import { CARGO_LOCK_ONLY_NOTE } from "../../src/tooling/third-party-notices.ts";
import { makeZip } from "../tools/zip.ts";

describe("findLinks", () => {
  it("reports links at any depth and ignores regular files", () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-links-"));
    mkdirSync(join(dir, "pkg/lib"), { recursive: true });
    writeFileSync(join(dir, "pkg/lib/index.js"), "");
    symlinkSync(join(dir, "pkg/lib/index.js"), join(dir, "pkg/lib/alias.js"));
    expect(findLinks(dir)).toEqual([join("pkg", "lib", "alias.js")]);
  });
});

describe("pruneNonRuntimeDirs", () => {
  it("removes test, example and benchmark directories at each package root, nested packages included", () => {
    const dir = mkdtempSync(join(tmpdir(), "amber-prune-"));
    const files = [
      "plain/package.json",
      "plain/LICENSE",
      "plain/index.js",
      "plain/test/index.test.js",
      "plain/examples/demo.jpg",
      "plain/benchmarks/run.js",
      "plain/lib/test/helper.js",
      "plain/test.js",
      "@scope/pkg/package.json",
      "@scope/pkg/__tests__/a.test.js",
      "@scope/pkg/example/public/sample.jpg",
      "@scope/pkg/node_modules/inner/package.json",
      "@scope/pkg/node_modules/inner/tests/b.js",
      "@scope/pkg/node_modules/inner/bench/c.js",
      "@scope/pkg/node_modules/inner/main.js",
      "not-a-package/test/kept.js",
    ];
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "");
    }

    expect(pruneNonRuntimeDirs(dir).sort()).toEqual(
      [
        join("@scope", "pkg", "__tests__"),
        join("@scope", "pkg", "example"),
        join("@scope", "pkg", "node_modules", "inner", "bench"),
        join("@scope", "pkg", "node_modules", "inner", "tests"),
        join("plain", "benchmarks"),
        join("plain", "examples"),
        join("plain", "test"),
      ].sort(),
    );
    const kept = files.filter((file) => existsSync(join(dir, file)));
    expect(kept).toEqual([
      "plain/package.json",
      "plain/LICENSE",
      "plain/index.js",
      "plain/lib/test/helper.js",
      "plain/test.js",
      "@scope/pkg/package.json",
      "@scope/pkg/node_modules/inner/package.json",
      "@scope/pkg/node_modules/inner/main.js",
      "not-a-package/test/kept.js",
    ]);
  });
});

describe("SHIPPED_ASSETS", () => {
  it("names exactly the Runtime Assets files the Windows sidecar carries", () => {
    expect([...SHIPPED_ASSETS].sort()).toEqual([
      "18_NotoSansSC.zip",
      "LXGWWenKaiLite-OFL.txt",
      "LXGWWenKaiLite-Regular.ttf",
      "NotoSerifSC-Regular.otf",
      "OFL.txt",
      "deno-x86_64-pc-windows-msvc.zip",
      "ffmpeg-n9.0.2-3-ga5923073bf-win64-gpl-9.0.zip",
      "node-v24.21.0-win-x64.zip",
      "yt-dlp.exe",
    ]);
  });
});

describe("parseArgs", () => {
  it("reads --assets and --allow-incomplete-cargo and rejects anything else", () => {
    expect(parseArgs([])).toEqual({ assetsDir: undefined, allowIncompleteCargo: false });
    expect(parseArgs(["--", "--assets", "x", "--allow-incomplete-cargo"])).toEqual({ assetsDir: "x", allowIncompleteCargo: true });
    expect(() => parseArgs(["--licenses", "dir"])).toThrow(/unknown argument --licenses/u);
    expect(() => parseArgs(["--assets"])).toThrow(/needs a directory/u);
  });
});

const sha = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

const VERSION = "runtime-assets-test";
const SHIPPED = ["ffmpeg-win.zip", "deno.zip"];
const ASSETS = [
  { file: "ffmpeg-win.zip", component: "ffmpeg", version: "n9.0.2-3-ga5923073bf", platform: "win-x64", license: "GPL-3.0-or-later" },
  { file: "ffmpeg-linux.tar.xz", component: "ffmpeg", version: "n9.0.2-3-ga5923073bf", platform: "linux-x64", license: "GPL-3.0-or-later" },
  { file: "deno.zip", component: "deno", version: "2.9.7", platform: "win-x64", license: "MIT" },
];
const ARTIFACTS = [
  { file: "ffmpeg-ccs.tar.xz", component: "ffmpeg-ccs", platform: "win-x64", version: "n9.0.2-3-ga5923073bf", license: null },
  { file: "third-party-licenses.tar.xz", component: "third-party-licenses", platform: "win-x64", version: "n9.0.2-3-ga5923073bf", license: null },
  { file: "ffmpeg-ccs-linux64.tar.xz", component: "ffmpeg-ccs", platform: "linux-x64", version: "n9.0.2-3-ga5923073bf", license: null },
];
const LICENSES: Record<string, string> = { "deno/LICENSE.md": "Deno MIT text", "ffmpeg/LICENSE.txt": "FFmpeg GPL text" };

/** A repository root with a Runtime Assets directory whose SHA256SUMS lists every file. */
function fixture(options: { version?: string; artifacts?: unknown[]; licenses?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amber-legal-"));
  put(root, "LICENSE", "GNU AFFERO GENERAL PUBLIC LICENSE\n");
  put(root, "src/desktop/Cargo.lock", '[[package]]\nname = "serde"\nversion = "1.0.229"\nsource = "registry+x"\n');
  put(root, "server/node_modules/zod/package.json", '{"name":"zod","version":"4.6.5","license":"MIT"}');
  put(root, "server/node_modules/zod/LICENSE", "zod MIT text");
  const assetsDir = join(root, "assets");
  const manifest = JSON.stringify({ version: options.version ?? VERSION, assets: ASSETS, artifacts: options.artifacts ?? ARTIFACTS });
  const licenses = makeZip(Object.entries(options.licenses ?? LICENSES).map(([name, text]) => ({ name, data: Buffer.from(text), method: 8 as const })));
  put(assetsDir, "manifest.json", manifest);
  put(assetsDir, "runtime-licenses.zip", licenses);
  const sums = `${sha(licenses)}  runtime-licenses.zip\n${sha(manifest)}  manifest.json\n`;
  put(assetsDir, "SHA256SUMS", sums);
  return { root, assetsDir, pinned: { version: VERSION, sumsSha256: sha(sums) } };
}

const COMPLETE = () => ({ packages: [{ name: "serde", version: "1.0.229", license: "MIT OR Apache-2.0", texts: [{ file: "LICENSE-MIT", text: "serde MIT text" }] }], complete: true });
const LOCK_ONLY = () => ({ packages: [{ name: "serde", version: "1.0.229", license: null, texts: [] }], complete: false });

function legalInput(fx: ReturnType<typeof fixture>, extra: Partial<LegalFilesInput> = {}): LegalFilesInput {
  return {
    root: fx.root,
    assetsDir: fx.assetsDir,
    runtime: openRuntimeAssets(fx.assetsDir, fx.pinned),
    shippedAssets: SHIPPED,
    serverDir: join(fx.root, "server"),
    outDir: join(fx.root, "out"),
    version: "0.1.0-rc.1",
    allowIncompleteCargo: false,
    collectCargo: COMPLETE,
    ...extra,
  };
}

describe("openRuntimeAssets", () => {
  it("accepts the pinned SHA256SUMS and manifest version", () => {
    const fx = fixture();
    const { sums, manifest } = openRuntimeAssets(fx.assetsDir, fx.pinned);
    expect(manifest.version).toBe(VERSION);
    expect([...sums.keys()].sort()).toEqual(["manifest.json", "runtime-licenses.zip"]);
  });

  it("refuses a SHA256SUMS whose own digest is not the pinned one, even if it matches the files", () => {
    const fx = fixture();
    expect(() => openRuntimeAssets(fx.assetsDir, { ...fx.pinned, sumsSha256: "1".repeat(64) })).toThrow(/not the pinned Runtime Assets checksum list/u);
    // The compiled-in pin applies when nothing is injected.
    expect(() => openRuntimeAssets(fx.assetsDir)).toThrow(/not the pinned Runtime Assets checksum list/u);
  });

  it("refuses a manifest that names another release", () => {
    const fx = fixture({ version: "runtime-assets-other" });
    expect(() => openRuntimeAssets(fx.assetsDir, fx.pinned)).toThrow(/names Runtime Assets runtime-assets-other, expected runtime-assets-test/u);
  });

  it("refuses a manifest that does not match SHA256SUMS", () => {
    const fx = fixture();
    writeFileSync(join(fx.assetsDir, "manifest.json"), '{"version":"runtime-assets-test","assets":[]}');
    expect(() => openRuntimeAssets(fx.assetsDir, fx.pinned)).toThrow(/SHA256 mismatch for manifest.json/u);
  });
});

describe("writeLegalFiles", () => {
  it("writes LICENSE, THIRD_PARTY_NOTICES.md and SOURCE.md under legal/ listing only the shipped files", () => {
    const fx = fixture();
    const input = legalInput(fx);
    const result = writeLegalFiles(input);
    expect(result).toEqual({ cargoComplete: true, files: ["legal/LICENSE", "legal/THIRD_PARTY_NOTICES.md", "legal/SOURCE.md"] });
    expect(readdirSync(input.outDir).sort()).toEqual(["legal"]);
    expect(readFileSync(join(input.outDir, "legal/LICENSE"), "utf8")).toBe("GNU AFFERO GENERAL PUBLIC LICENSE\n");
    const notices = readFileSync(join(input.outDir, "legal/THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("| zod | 4.6.5 | MIT |");
    expect(notices).toContain("| serde | 1.0.229 | MIT OR Apache-2.0 |");
    expect(notices).toContain("ffmpeg-win.zip");
    expect(notices).not.toContain("ffmpeg-linux.tar.xz");
    expect(notices).toContain("Deno MIT text");
    expect(notices).toContain("FFmpeg GPL text");
    expect(notices).toContain("serde MIT text");
    expect(notices).not.toContain(CARGO_LOCK_ONLY_NOTE);
    const source = readFileSync(join(input.outDir, "legal/SOURCE.md"), "utf8");
    expect(source).toContain("https://github.com/lifefindsitsway/amber-runtime-assets/releases/download/runtime-assets-test/ffmpeg-ccs.tar.xz");
    expect(source).toContain("https://github.com/lifefindsitsway/amber-runtime-assets/releases/download/runtime-assets-test/third-party-licenses.tar.xz");
    expect(source).toContain("Amber 0.1.0-rc.1");
  });

  it("stops when cargo metadata is unavailable unless incomplete notices are allowed", () => {
    const fx = fixture();
    const input = legalInput(fx, { collectCargo: LOCK_ONLY });
    expect(() => writeLegalFiles(input)).toThrow(/cargo metadata is unavailable.*--allow-incomplete-cargo/u);
    expect(existsSync(input.outDir)).toBe(false);
  });

  it("with incomplete notices allowed, marks the sidecar outside the bundled directories", () => {
    const fx = fixture();
    const input = legalInput(fx, { collectCargo: LOCK_ONLY, allowIncompleteCargo: true });
    expect(writeLegalFiles(input).cargoComplete).toBe(false);
    expect(NOTICES_INCOMPLETE_MARKER).toBe("notices-incomplete.json");
    expect(readdirSync(input.outDir).sort()).toEqual(["legal", NOTICES_INCOMPLETE_MARKER]);
    expect(readdirSync(join(input.outDir, "legal")).sort()).toEqual(["LICENSE", "SOURCE.md", "THIRD_PARTY_NOTICES.md"]);
    expect(JSON.parse(readFileSync(join(input.outDir, NOTICES_INCOMPLETE_MARKER), "utf8"))).toMatchObject({ notices: "legal/THIRD_PARTY_NOTICES.md" });
    expect(readFileSync(join(input.outDir, "legal/THIRD_PARTY_NOTICES.md"), "utf8")).toContain(CARGO_LOCK_ONLY_NOTE);
    // A later complete pack into the same directory clears the marker.
    writeLegalFiles({ ...input, collectCargo: COMPLETE });
    expect(existsSync(join(input.outDir, NOTICES_INCOMPLETE_MARKER))).toBe(false);
  });

  it("refuses a shipped component without a license text in runtime-licenses.zip", () => {
    const fx = fixture({ licenses: { "ffmpeg/LICENSE.txt": "FFmpeg GPL text" } });
    expect(() => writeLegalFiles(legalInput(fx))).toThrow(/shipped component\(s\): deno/u);
  });

  it("refuses a runtime-licenses.zip that does not match SHA256SUMS", () => {
    const fx = fixture();
    const input = legalInput(fx);
    writeFileSync(join(fx.assetsDir, "runtime-licenses.zip"), makeZip([{ name: "deno/LICENSE.md", data: Buffer.from("swapped"), method: 0 }]));
    expect(() => writeLegalFiles(input)).toThrow(/SHA256 mismatch for runtime-licenses.zip/u);
  });

  it("refuses a manifest without the Windows compliance artifacts", () => {
    const fx = fixture({ artifacts: ARTIFACTS.filter((artifact) => artifact.component !== "third-party-licenses") });
    expect(() => writeLegalFiles(legalInput(fx))).toThrow(/no win-x64 third-party-licenses artifact/u);
  });

  it("refuses a missing LICENSE", () => {
    const fx = fixture();
    const bare = mkdtempSync(join(tmpdir(), "amber-legal-"));
    expect(() => writeLegalFiles(legalInput(fx, { root: bare }))).toThrow(/LICENSE is missing/u);
  });
});
