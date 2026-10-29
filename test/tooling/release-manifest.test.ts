import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogSection, findSignedInstaller, renderLatestJson, rfc3339 } from "../../src/tooling/release-manifest.ts";

const REPO_ROOT = join(import.meta.dirname, "../..");
const CHANGELOG = "# 变更日志\n\n## [Unreleased]\n\n- 未发布\n\n## [0.1.0] - 2026-11-01\n\n### 新增\n\n- 首个公开版本\n\n## [0.0.9]\n\n- 旧\n";
const SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK";

function artifacts(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "amber-release-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("release manifest", () => {
  it("takes the changelog section of the release version only", () => {
    expect(changelogSection(CHANGELOG, "0.1.0")).toBe("### 新增\n\n- 首个公开版本");
    expect(changelogSection(CHANGELOG, "0.2.0")).toBe("");
  });

  it("writes the .sig content, the package version, an RFC 3339 date and the GitHub Release asset URL", () => {
    const latest = renderLatestJson({
      version: "0.1.0",
      changelog: CHANGELOG,
      installer: "Amber_0.1.0_x64-setup.exe",
      signature: SIG,
      now: new Date("2026-11-01T08:09:10.123Z"),
    });
    expect(latest).toEqual({
      version: "0.1.0",
      notes: "### 新增\n\n- 首个公开版本",
      pub_date: "2026-11-01T08:09:10Z",
      platforms: {
        "windows-x86_64": {
          signature: SIG,
          url: "https://github.com/lifefindsitsway/Amber/releases/download/v0.1.0/Amber_0.1.0_x64-setup.exe",
        },
      },
    });
    expect(rfc3339(new Date(0))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it("files a pre-release's notes under its release version and can point at a loopback test server only", () => {
    const local = renderLatestJson({
      version: "0.1.0-rc.2",
      changelog: CHANGELOG,
      installer: "Amber_0.1.0-rc.2_x64-setup.exe",
      signature: SIG,
      now: new Date(0),
      localTest: "http://127.0.0.1:8787/rc2",
    });
    expect(local.notes).toBe("### 新增\n\n- 首个公开版本");
    expect(local.platforms["windows-x86_64"]?.url).toBe("http://127.0.0.1:8787/rc2/Amber_0.1.0-rc.2_x64-setup.exe");
    expect(() =>
      renderLatestJson({ version: "0.1.0", changelog: "", installer: "a-setup.exe", signature: SIG, now: new Date(0), localTest: "http://10.0.0.2/" }),
    ).toThrow(/--local-test/u);
  });

  it("uses given release notes, trimmed, in place of the changelog section and refuses blank ones", () => {
    const base = { version: "0.1.0", changelog: CHANGELOG, installer: "Amber_0.1.0_x64-setup.exe", signature: SIG, now: new Date(0) };
    expect(renderLatestJson({ ...base, notes: "\n公开说明\n\n- 重点\n\n" }).notes).toBe("公开说明\n\n- 重点");
    expect(renderLatestJson(base).notes).toBe("### 新增\n\n- 首个公开版本");
    expect(() => renderLatestJson({ ...base, notes: " \n\t\n" })).toThrow(/--notes-file is empty/u);
  });

  it("needs exactly one installer with its signature", () => {
    expect(findSignedInstaller(artifacts({ "Amber_0.1.0_x64-setup.exe": "x", "Amber_0.1.0_x64-setup.exe.sig": SIG }))).toEqual({
      installer: "Amber_0.1.0_x64-setup.exe",
      signature: "Amber_0.1.0_x64-setup.exe.sig",
    });
    expect(() => findSignedInstaller(artifacts({ "Amber_0.1.0_x64-setup.exe": "x" }))).toThrow(/\.sig is missing/u);
    expect(() => findSignedInstaller(artifacts({ "a-setup.exe": "x", "b-setup.exe": "y" }))).toThrow(/exactly one/u);
  });

  it("writes latest.json from the command line with the .sig content verbatim", () => {
    const dir = artifacts({ "Amber_0.0.22_x64-setup.exe": "x", "Amber_0.0.22_x64-setup.exe.sig": SIG });
    const result = spawnSync(process.execPath, ["src/tooling/release-manifest.ts", "--", "--dir", dir], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as { version: string; platforms: Record<string, { signature: string }> };
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(latest.version).toBe(version);
    expect(latest.platforms["windows-x86_64"]?.signature).toBe(SIG);
  });

  it("takes the notes from --notes-file on the command line and writes nothing when the file is missing or empty", () => {
    const run = (dir: string, notesFile: string) =>
      spawnSync(process.execPath, ["src/tooling/release-manifest.ts", "--", "--dir", dir, "--notes-file", notesFile], { cwd: REPO_ROOT, encoding: "utf8" });
    const dir = artifacts({ "Amber_0.0.22_x64-setup.exe": "x", "Amber_0.0.22_x64-setup.exe.sig": SIG, "notes.md": "本次更新重点。\n\n### 新增\n\n- 一项\n" });
    const ok = run(dir, join(dir, "notes.md"));
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect((JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as { notes: string }).notes).toBe("本次更新重点。\n\n### 新增\n\n- 一项");

    const missing = artifacts({ "Amber_0.0.22_x64-setup.exe": "x", "Amber_0.0.22_x64-setup.exe.sig": SIG });
    expect(run(missing, join(missing, "absent.md")).status).toBe(1);
    expect(existsSync(join(missing, "latest.json"))).toBe(false);

    const blank = artifacts({ "Amber_0.0.22_x64-setup.exe": "x", "Amber_0.0.22_x64-setup.exe.sig": SIG, "notes.md": "\n  \n" });
    const refused = run(blank, join(blank, "notes.md"));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/--notes-file is empty/u);
    expect(existsSync(join(blank, "latest.json"))).toBe(false);
  });
});
