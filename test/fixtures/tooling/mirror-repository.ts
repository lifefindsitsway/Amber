import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ASSETS_DIR, RUNTIME_MANIFEST_FILE, SHA256SUMS_FILE } from "../../../src/tooling/runtime-assets.ts";
import { ASSET_INPUTS, ROOT_INPUTS } from "../../../src/tooling/sync-mirror.ts";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export const asset = (file: string): string => `${DEFAULT_ASSETS_DIR}/${file}`;

export interface MirrorRepository {
  root: string;
  dest: string;
  /** SHA256 of the fixture's `SHA256SUMS`, standing in for the compiled-in pin. */
  pinnedSumsSha256: string;
  /** Repository-relative path → content of every file written, committed or not. */
  files: Map<string, string>;
}

/**
 * A committed repository holding every mirror input: the root configuration, two sources,
 * the shipped documents, an ignored changelog and a fake Runtime Assets release whose
 * `SHA256SUMS` lists the other assets; plus an empty mirror directory beside it.
 */
export function mirrorRepository(): MirrorRepository {
  const root = mkdtempSync(join(tmpdir(), "amber-mirror-repo-"));
  const dest = mkdtempSync(join(tmpdir(), "amber-mirror-dest-"));
  const files = new Map<string, string>();
  const write = (path: string, content: string): void => {
    put(root, path, content);
    files.set(path, content);
  };
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  write(".gitignore", "/amber-runtime-assets/\n/CHANGELOG.md\n");
  for (const path of ROOT_INPUTS) {
    write(path, path === "package.json" ? '{"name":"amber","version":"0.3.0-rc.1"}\n' : `${path}\n`);
  }
  write("src/a.ts", "export const a = 1;\n");
  write("src/nested/b.ts", "export const b = 2;\n");
  write("README.md", "readme\n");
  write("LICENSE", "license\n");
  write("CHANGELOG.md", "# changelog\n");
  const listed = ASSET_INPUTS.filter((file) => file !== SHA256SUMS_FILE);
  for (const file of listed) {
    write(asset(file), file === RUNTIME_MANIFEST_FILE ? '{"version":"runtime-assets-test"}\n' : `asset ${file}\n`);
  }
  const sums = listed.map((file) => `${sha(files.get(asset(file)) ?? "")}  ${file}\n`).join("");
  write(asset(SHA256SUMS_FILE), sums);
  git(root, "add", ".gitignore", ...ROOT_INPUTS, "src", "README.md", "LICENSE");
  git(root, "commit", "-q", "-m", "init");
  return { root, dest, pinnedSumsSha256: sha(sums), files };
}
