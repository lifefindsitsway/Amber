import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIRROR_INPUTS_FILE, syncMirror } from "../../src/tooling/sync-mirror.ts";
import { mirrorMatches, verifyArguments, verifyMirror, type MirrorVerification } from "../../src/tooling/verify-mirror.ts";
import { asset, git, mirrorRepository, put, sha } from "../fixtures/tooling/mirror-repository.ts";

const NONE = { missing: [], extra: [], changed: [] };

/** A repository mirrored once, with a verifier bound to its fixture pin. */
function synced() {
  const repo = mirrorRepository();
  syncMirror(repo.root, repo.dest);
  const verify = (ref?: string): MirrorVerification =>
    verifyMirror({ root: repo.root, dest: repo.dest, pinnedSumsSha256: repo.pinnedSumsSha256, ...(ref === undefined ? {} : { ref }) });
  return { ...repo, verify };
}

describe("verifyMirror", () => {
  it("matches a fresh mirror against the working tree and against HEAD, and reports the input list's digest", () => {
    const { root, dest, verify } = synced();
    const head = git(root, "rev-parse", "HEAD");
    for (const [result, against] of [
      [verify(), "working tree"],
      [verify("HEAD"), `HEAD (${head})`],
    ] as const) {
      expect(result).toEqual({
        against,
        inputsDigest: sha(readFileSync(join(dest, MIRROR_INPUTS_FILE), "utf8")),
        tracked: NONE,
        local: NONE,
        unpinned: [],
      });
      expect(mirrorMatches(result)).toBe(true);
    }
  });

  it("reports a source changed, added or deleted after the mirror was taken, against the working tree", () => {
    const { root, verify } = synced();
    put(root, "src/a.ts", "export const a = 2;\n");
    put(root, "src/c.ts", "export {};\n");
    rmSync(join(root, "src/nested/b.ts"));
    const result = verify();
    expect(result.tracked).toEqual({ missing: ["src/c.ts"], extra: ["src/nested/b.ts"], changed: ["src/a.ts"] });
    expect(mirrorMatches(result)).toBe(false);
    // The commit still holds what was mirrored.
    expect(mirrorMatches(verify("HEAD"))).toBe(true);
  });

  it("checks a mirror of an uncommitted tree against the commit made afterwards", () => {
    const { root, dest, verify, pinnedSumsSha256 } = synced();
    const before = git(root, "rev-parse", "HEAD");
    // The candidate is mirrored and tested from these uncommitted changes.
    put(root, "src/a.ts", "export const a = 22;\n");
    put(root, "src/c.ts", "export {};\n");
    syncMirror(root, dest);
    expect(verify("HEAD").tracked).toEqual({ missing: [], extra: ["src/c.ts"], changed: ["src/a.ts"] });
    // Committing only part of it leaves the new file out of the commit.
    git(root, "add", "src/a.ts");
    git(root, "commit", "-q", "-m", "a");
    expect(verify("HEAD").tracked).toEqual({ missing: [], extra: ["src/c.ts"], changed: [] });
    git(root, "add", "src/c.ts");
    git(root, "commit", "-q", "-m", "c");
    expect(mirrorMatches(verify("HEAD"))).toBe(true);
    // An earlier commit, named by its id, is a different tree.
    expect(verifyMirror({ root, dest, ref: before, pinnedSumsSha256 }).tracked).toEqual({ missing: [], extra: ["src/c.ts"], changed: ["src/a.ts"] });
    // A commit that deleted a source the mirror still lists.
    git(root, "rm", "-q", "src/nested/b.ts");
    git(root, "commit", "-q", "-m", "drop b");
    expect(verify("HEAD").tracked).toEqual({ missing: [], extra: ["src/nested/b.ts"], changed: [] });
  });

  it("catches an edit the copy skipped because the size and second-rounded time still matched", () => {
    const { root, dest, verify } = synced();
    const { atime, mtime } = statSync(join(root, "src/a.ts"));
    put(root, "src/a.ts", "export const a = 3;\n");
    utimesSync(join(root, "src/a.ts"), atime, mtime);
    syncMirror(root, dest);
    expect(readFileSync(join(dest, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(verify().tracked).toEqual({ missing: [], extra: [], changed: ["src/a.ts"] });
  });

  it("compares the ignored local inputs only with the mirror's files and the pinned checksums", () => {
    const { root, dest, verify } = synced();
    // The repository's own copies of ignored inputs are no reference: no commit holds them.
    put(root, asset("yt-dlp.exe"), "a different download\n");
    put(root, "CHANGELOG.md", "# rewritten\n");
    expect(mirrorMatches(verify())).toBe(true);
    expect(mirrorMatches(verify("HEAD"))).toBe(true);

    // An asset replaced in the mirror after the list was written: unlike the record, and not as pinned once re-recorded.
    put(dest, asset("yt-dlp.exe"), "tampered\n");
    expect(verify("HEAD").local).toEqual({ missing: [], extra: [], changed: [asset("yt-dlp.exe")] });
    const inputsPath = join(dest, MIRROR_INPUTS_FILE);
    const recorded = JSON.parse(readFileSync(inputsPath, "utf8")) as { local: Record<string, string> };
    recorded.local[asset("yt-dlp.exe")] = sha("tampered\n");
    writeFileSync(inputsPath, JSON.stringify(recorded));
    const rerecorded = verify("HEAD");
    expect([rerecorded.local, rerecorded.unpinned]).toEqual([NONE, [asset("yt-dlp.exe")]]);

    // A mirror whose checksum list is not the pinned one vouches for none of its assets.
    rmSync(join(dest, asset("SHA256SUMS")));
    const unlisted = verify("HEAD");
    expect(unlisted.local.missing).toEqual([asset("SHA256SUMS")]);
    expect(unlisted.unpinned).toEqual([asset("SHA256SUMS")]);
    expect(mirrorMatches(unlisted)).toBe(false);
  });

  it("reports a local input the record lacks or one it should not have", () => {
    const { dest, verify } = synced();
    const inputsPath = join(dest, MIRROR_INPUTS_FILE);
    const recorded = JSON.parse(readFileSync(inputsPath, "utf8")) as { local: Record<string, string>; assetsManifest: string };
    const { [asset("OFL.txt")]: _dropped, ...rest } = recorded.local;
    recorded.local = { ...rest, "notes/private.md": sha("x") };
    put(dest, "notes/private.md", "x");
    recorded.assetsManifest = sha("other manifest");
    writeFileSync(inputsPath, JSON.stringify(recorded));
    const result = verify();
    expect(result.local).toEqual({ missing: [asset("OFL.txt")], extra: ["notes/private.md"], changed: [] });
    expect(result.unpinned).toEqual([expect.stringMatching(/^assetsManifest /u)]);
  });

  it("refuses an unknown ref and a mirror without an input list", () => {
    const { root, dest, verify, pinnedSumsSha256 } = synced();
    expect(() => verify("no-such-branch")).toThrow(/does not name a commit/u);
    rmSync(join(dest, MIRROR_INPUTS_FILE));
    expect(() => verifyMirror({ root, dest, pinnedSumsSha256 })).toThrow(/mirror-inputs\.json is missing/u);
    writeFileSync(join(dest, MIRROR_INPUTS_FILE), JSON.stringify({ tracked: {} }));
    expect(() => verifyMirror({ root, dest, pinnedSumsSha256 })).toThrow(/not a mirror input list/u);
  });
});

describe("verifyArguments", () => {
  it("takes the mirror directory and an optional ref, in either order, with or without the pnpm separator", () => {
    expect(verifyArguments(["--dest", "/mnt/g/mirror"])).toEqual({ dest: "/mnt/g/mirror" });
    expect(verifyArguments(["--", "--dest", "/mnt/g/mirror", "--ref", "HEAD"])).toEqual({ dest: "/mnt/g/mirror", ref: "HEAD" });
    expect(verifyArguments(["--ref", "v0.3.0", "--dest", "/mnt/g/mirror"])).toEqual({ dest: "/mnt/g/mirror", ref: "v0.3.0" });
  });

  it("refuses a missing directory, a flag without a value, repeats and unknown arguments", () => {
    for (const args of [[], ["--ref", "HEAD"], ["--dest"], ["--dest", "--ref", "HEAD"], ["--dest", "a", "--dest", "b"], ["--dest", "a", "--force"], ["--dest", "a", "--ref"], ["--dest", ""]]) {
      expect(() => verifyArguments(args)).toThrow(/usage: pnpm verify:mirror/u);
    }
  });

  it("exits with 1 and the usage line when run without arguments", () => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../../src/tooling/verify-mirror.ts")], { encoding: "utf8" });
    expect([result.status, result.stderr]).toEqual([1, expect.stringContaining("usage: pnpm verify:mirror")]);
  });
});
