import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_ASSETS } from "../../src/tooling/runtime-assets.ts";
import {
  collectNpmPackages,
  complianceArtifactsOf,
  cratesFromMetadata,
  ffmpegProvenanceOf,
  ffmpegVersionOf,
  parseCargoLock,
  parseRuntimeManifest,
  renderSourceNotice,
  renderThirdPartyNotices,
  runtimeLicenseTexts,
  RUNTIME_LICENSES_ASSET,
} from "../../src/tooling/third-party-notices.ts";
import { makeZip } from "../tools/zip.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "amber-notices-"));
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

const MANIFEST = JSON.stringify({
  version: "runtime-assets-2026.10.21",
  assets: [
    { file: "node.zip", component: "node", version: "24.21.0", platform: "win-x64", sourceUrl: "https://nodejs.org/x", license: "MIT" },
    { file: "ffmpeg-linux.tar.xz", component: "ffmpeg", version: "n9.0.2-3-ga5923073bf", platform: "linux-x64", license: "GPL-3.0-or-later" },
    { file: "ffmpeg-win.zip", component: "ffmpeg", version: "n9.0.2-3-ga5923073bf", platform: "win-x64", license: "GPL-3.0-or-later" },
    { file: "ffmpeg-source.tar.xz", component: "ffmpeg-source", version: "a5923073bfd8f25b7300d93af3f8e690174ebd30", platform: "source", license: "GPL" },
    { file: "build-info.tar.xz", component: "ffmpeg-build-info", version: "3e6685eda92f9288c15ac320139622dcedca09a4", platform: "source", license: "MIT" },
    { file: "OFL|pipe.txt", component: "noto-sans-sc", version: "2.004", platform: "any", license: "OFL-1.1" },
  ],
  artifacts: [
    { file: "THIRD_PARTY_NOTICES.md", component: "third-party-notices", platform: "metadata", version: "v", license: null },
    { file: "ffmpeg-ccs-linux64.tar.xz", component: "ffmpeg-ccs", platform: "linux-x64", version: "n9.0.2-3-ga5923073bf", license: null },
    { file: "ffmpeg-ccs.tar.xz", component: "ffmpeg-ccs", platform: "win-x64", version: "n9.0.2-3-ga5923073bf", sha256: "f".repeat(64), sizeBytes: 12, description: "CCS", license: "GPL-3.0-or-later" },
    { file: "third-party-licenses.tar.xz", component: "third-party-licenses", platform: "win-x64", version: "n9.0.2-3-ga5923073bf", license: null },
  ],
});

/** The Runtime Assets the fixture installer ships. */
const SHIPPED = ["node.zip", "ffmpeg-win.zip", "OFL|pipe.txt"];

function licensesZip(entries: Record<string, string>): Buffer {
  return makeZip(Object.entries(entries).map(([name, text]) => ({ name, data: Buffer.from(text), method: 8 as const })));
}

describe("Runtime Assets manifest", () => {
  it("names the Windows FFmpeg build and its provenance", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    expect(ffmpegVersionOf(manifest)).toBe("n9.0.2-3-ga5923073bf");
    expect(ffmpegProvenanceOf(manifest)).toEqual({
      ffmpegSourceCommit: "a5923073bfd8f25b7300d93af3f8e690174ebd30",
      ffmpegBuildCommit: "3e6685eda92f9288c15ac320139622dcedca09a4",
    });
    expect(() => ffmpegVersionOf({ version: "v", assets: [], artifacts: [] })).toThrow(/ffmpeg/u);
    expect(() => parseRuntimeManifest('{"version":"v","assets":[{"file":"x"}]}')).toThrow(/component/u);
  });

  it("parses the optional artifacts list and tolerates its absence", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    expect(manifest.artifacts).toHaveLength(4);
    expect(manifest.artifacts[2]).toEqual({
      file: "ffmpeg-ccs.tar.xz",
      component: "ffmpeg-ccs",
      platform: "win-x64",
      version: "n9.0.2-3-ga5923073bf",
      sha256: "f".repeat(64),
      sizeBytes: 12,
      description: "CCS",
      license: "GPL-3.0-or-later",
    });
    expect(manifest.artifacts[0]?.license).toBeNull();
    expect(parseRuntimeManifest('{"version":"v","assets":[]}').artifacts).toEqual([]);
    expect(() => parseRuntimeManifest('{"version":"v","assets":[],"artifacts":{}}')).toThrow(/artifacts/u);
    expect(() => parseRuntimeManifest('{"version":"v","assets":[],"artifacts":[{"file":"x","component":"c","platform":"p"}]}')).toThrow(/artifact entry lacks version/u);
  });

  it("names the Windows compliance artifacts and refuses a manifest without either", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    expect(complianceArtifactsOf(manifest)).toEqual({ sourceArchive: "ffmpeg-ccs.tar.xz", licensesArchive: "third-party-licenses.tar.xz" });
    const without = (component: string) => ({ ...manifest, artifacts: manifest.artifacts.filter((artifact) => !(artifact.component === component && artifact.platform === "win-x64")) });
    expect(() => complianceArtifactsOf(without("ffmpeg-ccs"))).toThrow(/win-x64 ffmpeg-ccs artifact/u);
    expect(() => complianceArtifactsOf(without("third-party-licenses"))).toThrow(/win-x64 third-party-licenses artifact/u);
  });
});

describe("runtimeLicenseTexts", () => {
  it("groups the texts of runtime-licenses.zip by component, in file order", () => {
    expect(RUNTIME_LICENSES_ASSET).toBe("runtime-licenses.zip");
    const texts = runtimeLicenseTexts(licensesZip({ "yt-dlp/THIRD_PARTY_LICENSES.txt": "third", "yt-dlp/LICENSE": "unlicense", "node/LICENSE": "node" }));
    expect([...texts]).toEqual([
      [
        "yt-dlp",
        [
          { file: "LICENSE", text: "unlicense" },
          { file: "THIRD_PARTY_LICENSES.txt", text: "third" },
        ],
      ],
      ["node", [{ file: "LICENSE", text: "node" }]],
    ]);
  });

  it("refuses entries that are not <component>/<file>", () => {
    expect(() => runtimeLicenseTexts(licensesZip({ LICENSE: "x" }))).toThrow(/not <component>\/<file>/u);
    expect(() => runtimeLicenseTexts(licensesZip({ "a/b/LICENSE": "x" }))).toThrow(/not <component>\/<file>/u);
  });
});

describe("collectNpmPackages", () => {
  it("lists every installed package, scoped and nested, with its license texts", () => {
    const root = dir();
    write(root, "node_modules/a/package.json", '{"name":"a","version":"1.0.0","license":"MIT"}');
    write(root, "node_modules/a/LICENSE", "MIT text A");
    write(root, "node_modules/a/README.md", "not a license");
    write(root, "node_modules/@s/b/package.json", '{"name":"@s/b","version":"2.0.0","license":{"type":"ISC"}}');
    write(root, "node_modules/@s/b/license.md", "ISC text");
    write(root, "node_modules/a/node_modules/c/package.json", '{"name":"c","version":"0.1.0"}');
    write(root, "node_modules/.modules.yaml", "{}");
    expect(collectNpmPackages(join(root, "node_modules"))).toEqual([
      { name: "@s/b", version: "2.0.0", license: "ISC", texts: [{ file: "license.md", text: "ISC text" }] },
      { name: "a", version: "1.0.0", license: "MIT", texts: [{ file: "LICENSE", text: "MIT text A" }] },
      { name: "c", version: "0.1.0", license: null, texts: [] },
    ]);
  });
});

describe("Rust crates", () => {
  it("reads registry packages from Cargo.lock and skips the local shell", () => {
    const lock = '[[package]]\nname = "amber"\nversion = "0.0.0"\n\n[[package]]\nname = "zz"\nversion = "1.0.0"\nsource = "registry+x"\n\n[[package]]\nname = "aa"\nversion = "0.2.0"\nsource = "registry+x"\n';
    expect(parseCargoLock(lock)).toEqual([
      { name: "aa", version: "0.2.0" },
      { name: "zz", version: "1.0.0" },
    ]);
  });

  it("keeps only crates reached through normal dependencies from cargo metadata", () => {
    const root = dir();
    write(root, "a/Cargo.toml", "");
    write(root, "a/LICENSE-MIT", "MIT for a");
    write(root, "b/Cargo.toml", "");
    write(root, "c/Cargo.toml", "");
    write(root, "c/COPYING", "custom for c");
    const pkg = (id: string, license: string | null, licenseFile: string | null = null) => ({
      id,
      name: id,
      version: "1.0.0",
      license,
      license_file: licenseFile,
      manifest_path: join(root, id === "root" ? "root" : id, "Cargo.toml"),
      source: id === "root" ? null : "registry+x",
    });
    const metadata = {
      packages: [pkg("root", null), pkg("a", "MIT OR Apache-2.0"), pkg("b", "MIT"), pkg("c", null, "COPYING")],
      resolve: {
        root: "root",
        nodes: [
          {
            id: "root",
            deps: [
              { pkg: "a", dep_kinds: [{ kind: null }] },
              { pkg: "b", dep_kinds: [{ kind: "build" }] },
            ],
          },
          { id: "a", deps: [{ pkg: "c", dep_kinds: [{ kind: null }] }] },
        ],
      },
    };
    expect(cratesFromMetadata(metadata)).toEqual([
      { name: "a", version: "1.0.0", license: "MIT OR Apache-2.0", texts: [{ file: "LICENSE-MIT", text: "MIT for a" }] },
      { name: "c", version: "1.0.0", license: "see COPYING", texts: [{ file: "COPYING", text: "custom for c" }] },
    ]);
  });
});

describe("renderThirdPartyNotices", () => {
  const TEXTS = runtimeLicenseTexts(
    licensesZip({ "node/LICENSE": "Node license", "ffmpeg/LICENSE.txt": "GPL text", "noto-sans-sc/OFL.txt": "OFL text", "deno/LICENSE.md": "Deno text (not shipped)" }),
  );

  it("lists only the shipped Runtime Assets and every package, and embeds each distinct license text once", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    const notices = renderThirdPartyNotices({
      amberVersion: "0.1.0",
      runtime: manifest,
      shippedAssets: SHIPPED,
      runtimeTexts: TEXTS,
      npm: [
        { name: "a", version: "1.0.0", license: "MIT", texts: [{ file: "LICENSE", text: "Shared MIT" }] },
        { name: "b", version: "1.0.0", license: "MIT", texts: [{ file: "LICENSE", text: "Shared MIT\n" }] },
      ],
      cargo: [{ name: "serde", version: "1.0.229", license: "MIT OR Apache-2.0", texts: [{ file: "LICENSE-MIT", text: "```fence``` inside" }] }],
      cargoComplete: true,
    });
    for (const file of SHIPPED) {
      expect(notices).toContain(file.replace("|", "\\|"));
    }
    // Files the installer does not carry stay out: other platforms, sources, artifacts.
    for (const file of ["ffmpeg-linux.tar.xz", "ffmpeg-source.tar.xz", "build-info.tar.xz", "| source |", "ffmpeg-ccs"]) {
      expect(notices).not.toContain(file);
    }
    expect(notices.match(/^\| ffmpeg \|/gmu)).toHaveLength(1);
    expect(notices).toContain("OFL text");
    expect(notices).not.toContain("Deno text (not shipped)");
    expect(notices).toContain("| a | 1.0.0 | MIT |");
    expect(notices).toContain("| serde | 1.0.229 | MIT OR Apache-2.0 |");
    expect(notices.match(/Shared MIT/gu)).toHaveLength(1);
    expect(notices).toContain("适用于：a@1.0.0（LICENSE）、b@1.0.0（LICENSE）");
    expect(notices).toContain("Node license");
    expect(notices).toContain("GPL text");
    expect(notices).toContain("````text\n```fence``` inside\n````");
    expect(notices).not.toContain("Cargo.lock");
  });

  it("says so when the crate list only came from Cargo.lock", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    const notices = renderThirdPartyNotices({ amberVersion: "0.1.0", runtime: manifest, shippedAssets: SHIPPED, runtimeTexts: TEXTS, npm: [], cargo: [], cargoComplete: false });
    expect(notices).toContain("取自 `Cargo.lock`");
  });

  it("refuses a shipped file that the manifest does not list", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    const render = () =>
      renderThirdPartyNotices({ amberVersion: "0.1.0", runtime: manifest, shippedAssets: [...SHIPPED, "yt-dlp.exe"], runtimeTexts: TEXTS, npm: [], cargo: [], cargoComplete: true });
    expect(render).toThrow(/shipped Runtime Assets missing from manifest\.json: yt-dlp\.exe/u);
  });

  it("refuses a shipped component without a license text, naming it", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    const texts = runtimeLicenseTexts(licensesZip({ "node/LICENSE": "Node license", "noto-sans-sc/OFL.txt": "OFL text" }));
    const render = () => renderThirdPartyNotices({ amberVersion: "0.1.0", runtime: manifest, shippedAssets: SHIPPED, runtimeTexts: texts, npm: [], cargo: [], cargoComplete: true });
    expect(render).toThrow(/no license text in runtime-licenses\.zip for shipped component\(s\): ffmpeg$/u);
  });
});

describe("renderThirdPartyNotices for the bundled fonts", () => {
  const FONT_MANIFEST = parseRuntimeManifest(
    JSON.stringify({
      version: "runtime-assets-test",
      assets: [
        { file: "18_NotoSansSC.zip", component: "noto-sans-sc", version: "Sans2.004", platform: "any", license: "OFL-1.1" },
        { file: "OFL.txt", component: "noto-sans-sc", version: "Sans2.004", platform: "any", license: "OFL-1.1" },
        { file: "NotoSerifSC-Regular.otf", component: "noto-serif-sc", version: "Serif2.003", platform: "any", license: "OFL-1.1" },
        { file: "LXGWWenKaiLite-Regular.ttf", component: "lxgw-wenkai-lite", version: "v1.530", platform: "any", license: "OFL-1.1" },
        { file: "LXGWWenKaiLite-OFL.txt", component: "lxgw-wenkai-lite", version: "v1.530", platform: "any", license: "OFL-1.1" },
      ],
    }),
  );
  // The two Noto fonts carry the same license text; LXGW WenKai Lite has its own.
  const FONT_LICENSES = {
    "noto-sans-sc/OFL.txt": "Noto OFL text",
    "noto-serif-sc/OFL.txt": "Noto OFL text",
    "lxgw-wenkai-lite/OFL.txt": "LXGW OFL text",
  };
  const render = (licenses: Record<string, string>) =>
    renderThirdPartyNotices({
      amberVersion: "0.1.0",
      runtime: FONT_MANIFEST,
      shippedAssets: FONT_ASSETS,
      runtimeTexts: runtimeLicenseTexts(licensesZip(licenses)),
      npm: [],
      cargo: [],
      cargoComplete: true,
    });

  it("lists all three fonts and embeds the shared Noto license text once", () => {
    const notices = render(FONT_LICENSES);
    expect(notices).toContain("| noto-sans-sc | 18_NotoSansSC.zip | Sans2.004 | any | OFL-1.1 |");
    expect(notices).toContain("| noto-serif-sc | NotoSerifSC-Regular.otf | Serif2.003 | any | OFL-1.1 |");
    expect(notices).toContain("| lxgw-wenkai-lite | LXGWWenKaiLite-Regular.ttf | v1.530 | any | OFL-1.1 |");
    expect(notices).toContain("| lxgw-wenkai-lite | LXGWWenKaiLite-OFL.txt | v1.530 | any | OFL-1.1 |");
    expect(notices.match(/Noto OFL text/gu)).toHaveLength(1);
    expect(notices).toContain("适用于：noto-sans-sc（OFL.txt）、noto-serif-sc（OFL.txt）");
    expect(notices).toContain("适用于：lxgw-wenkai-lite（OFL.txt）");
    expect(notices).toContain("LXGW OFL text");
  });

  it.each(["noto-serif-sc", "lxgw-wenkai-lite"])("refuses to render when %s has no license text", (component) => {
    const licenses = Object.fromEntries(Object.entries(FONT_LICENSES).filter(([name]) => !name.startsWith(`${component}/`)));
    expect(() => render(licenses)).toThrow(new RegExp(`no license text in runtime-licenses\\.zip for shipped component\\(s\\): ${component}$`, "u"));
  });
});

describe("renderSourceNotice", () => {
  it("points at the repository and at the compliance artifacts of the Runtime Assets release named by the manifest", () => {
    const manifest = parseRuntimeManifest(MANIFEST);
    const source = renderSourceNotice({
      amberVersion: "0.1.0",
      ffmpegVersion: ffmpegVersionOf(manifest),
      runtimeAssetsVersion: manifest.version,
      ...complianceArtifactsOf(manifest),
      ffmpegSourceCommit: "a592",
      ffmpegBuildCommit: "3e66",
    });
    expect(source).toContain("https://github.com/lifefindsitsway/Amber\n");
    expect(source).toContain(
      "https://github.com/lifefindsitsway/amber-runtime-assets/releases/download/runtime-assets-2026.10.21/ffmpeg-ccs.tar.xz",
    );
    expect(source).toContain(
      "https://github.com/lifefindsitsway/amber-runtime-assets/releases/download/runtime-assets-2026.10.21/third-party-licenses.tar.xz",
    );
    expect(source).not.toContain("linux64");
    expect(source).not.toContain("compliance-ffmpeg");
    expect(source).toContain("`n9.0.2-3-ga5923073bf`");
    expect(source).toContain("`a592`");
    expect(source).toContain("`3e66`");
  });
});
