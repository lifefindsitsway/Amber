import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ASSETS_DIR } from "../../src/tooling/runtime-assets.ts";
import { SHIPPED_ASSETS } from "../../src/tooling/pack-sidecar.ts";
import { ASSET_INPUTS, DOC_INPUTS, ROOT_INPUTS, buildInputs, mirrorArguments, mirrorSource } from "../../src/tooling/sync-mirror.ts";

const REPO_ROOT = join(import.meta.dirname, "../..");

describe("buildInputs", () => {
  it("contains only root build configuration, src/ and the Windows runtime assets", () => {
    const inputs = buildInputs(REPO_ROOT);
    const allowed = (path: string): boolean =>
      (ROOT_INPUTS as readonly string[]).includes(path) ||
      (DOC_INPUTS as readonly string[]).includes(path) ||
      path.startsWith("src/") ||
      ASSET_INPUTS.some((file) => path === `${DEFAULT_ASSETS_DIR}/${file}`);
    expect(inputs.filter((path) => !allowed(path))).toEqual([]);
    expect(inputs).toContain("src/server/main.ts");
    // The notices read the Runtime Assets manifest and the components' license texts, all from the pinned release.
    expect(inputs).toEqual(
      expect.arrayContaining([`${DEFAULT_ASSETS_DIR}/SHA256SUMS`, `${DEFAULT_ASSETS_DIR}/manifest.json`, `${DEFAULT_ASSETS_DIR}/runtime-licenses.zip`]),
    );
    expect(inputs.some((path) => path.startsWith("amber-runtime-assets/licenses/"))).toBe(false);
    expect(inputs.filter((path) => path.startsWith("amber-runtime-assets/")).every((path) => path.startsWith(`${DEFAULT_ASSETS_DIR}/`))).toBe(true);
    // The sidecar packs the burn-in font and its licence.
    expect(inputs).toEqual(expect.arrayContaining([expect.stringMatching(/\/18_NotoSansSC\.zip$/), expect.stringMatching(/\/OFL\.txt$/)]));
    // The Windows build runs `vite build`, which needs the whole TypeScript configuration.
    expect(inputs).toEqual(expect.arrayContaining(["tsconfig.json", "tsconfig.base.json", "tsconfig.server.json", "tsconfig.web.json"]));
    // Of the root Markdown files, only the shipped ones. The changelog is copied only while git
    // tracks it, so this repository-state check does not require it.
    expect(inputs).toContain("README.md");
    const docs: readonly string[] = DOC_INPUTS;
    expect(inputs.filter((path) => !path.includes("/") && path.endsWith(".md")).every((path) => docs.includes(path))).toBe(true);
    expect(inputs.some((path) => path.startsWith("test/"))).toBe(false);
    expect(inputs.some((path) => path.startsWith("src/desktop/gen/"))).toBe(false);
    // The pinned upstream installer template reaches the host; the patched copy is generated there.
    expect(inputs).toEqual(expect.arrayContaining(["src/desktop/nsis/installer.upstream.nsi", "src/desktop/nsis/LICENSE-MIT"]));
  });
});

describe("ASSET_INPUTS", () => {
  it("carries every file the sidecar ships plus the pinned list, the manifest and the runtime license texts", () => {
    expect([...ASSET_INPUTS].sort()).toEqual([...SHIPPED_ASSETS, "SHA256SUMS", "manifest.json", "runtime-licenses.zip"].sort());
  });
});

describe("mirrorArguments", () => {
  it("takes only the mirror directory, with or without the pnpm separator", () => {
    expect(mirrorArguments(["--dest", "/mnt/g/mirror"])).toEqual({ dest: "/mnt/g/mirror" });
    expect(mirrorArguments(["--", "--dest", "/mnt/g/mirror"])).toEqual({ dest: "/mnt/g/mirror" });
  });

  it("refuses a mirror-only version, so the repository's package.json stays the version source", () => {
    expect(() => mirrorArguments(["--dest", "/mnt/g/mirror", "--version", "0.2.0-rc.7"])).toThrow(/--version is not supported/);
    expect(() => mirrorArguments(["--", "--version", "0.2.0-rc.7", "--dest", "/mnt/g/mirror"])).toThrow(/--version is not supported/);
  });

  it("refuses a missing directory and unknown arguments", () => {
    expect(() => mirrorArguments([])).toThrow(/usage/);
    expect(() => mirrorArguments(["--dest"])).toThrow(/usage/);
    expect(() => mirrorArguments(["--dest", "--force"])).toThrow(/usage/);
    expect(() => mirrorArguments(["--dest", "/mnt/g/mirror", "--force"])).toThrow(/usage/);
  });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "amber-mirror-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  writeFileSync(join(root, "package.json"), '{"name":"amber","version":"0.2.0-rc.6"}\n');
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export {};\n");
  git(root, "add", ".gitignore", "package.json", "pnpm-lock.yaml", "src/a.ts");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

describe("mirrorSource", () => {
  it("records the commit, the lockfile digest, the repository's version, and whether the tree was clean", () => {
    const root = repository();
    const head = git(root, "rev-parse", "HEAD");
    const digest = createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex");
    expect(mirrorSource(root)).toEqual({ sourceCommit: head, dirty: false, lockfileSha256: digest, version: "0.2.0-rc.6" });
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored/x"), "x");
    expect(mirrorSource(root).dirty).toBe(false);
    writeFileSync(join(root, "src/a.ts"), "export const changed = 1;\n");
    expect(mirrorSource(root).dirty).toBe(true);
  });

  it("takes the version from the repository's package.json, so a raised but uncommitted version shows as dirty", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), '{"name":"amber","version":"0.2.0-rc.7"}\n');
    expect(mirrorSource(root)).toMatchObject({ version: "0.2.0-rc.7", dirty: true });
  });

  it("copies the shipped documents that git tracks or would track, and nothing else from the root", () => {
    const root = repository();
    writeFileSync(join(root, "LICENSE"), "license\n");
    writeFileSync(join(root, "README.md"), "readme\n");
    writeFileSync(join(root, "CHANGELOG.md"), "changelog\n");
    // Markdown outside DOC_INPUTS stays out of the mirror.
    writeFileSync(join(root, "NOTES.md"), "notes\n");
    const inputs = buildInputs(root);
    expect(inputs).toEqual(expect.arrayContaining(["LICENSE", "README.md", "CHANGELOG.md", "src/a.ts"]));
    expect(inputs).not.toContain("NOTES.md");
  });
});
