import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, publicKeyIdOf, updaterOf } from "../../src/tooling/build-report.ts";
import { DEFAULT_ASSETS_DIR, RUNTIME_ASSETS_VERSION } from "../../src/tooling/runtime-assets.ts";
import { CARGO_LOCK_ONLY_NOTE } from "../../src/tooling/third-party-notices.ts";

const PUBKEY = Buffer.from("untrusted comment: minisign public key: 3A40D99388CBD0AB\nRWSr0MuIk9lAOjkKZYFVYUk2OLV+Xox5HG//dOUuere+WyfIK6d1cdzT\n").toString("base64");
const FEED = "https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json";
const SIG = "c2lnbmF0dXJl";

function put(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const MANIFEST = `{"version":"${RUNTIME_ASSETS_VERSION}","assets":[]}`;
const INPUTS = `${JSON.stringify({ tracked: { "src/a.ts": "0".repeat(64) }, local: {}, assetsManifest: "1".repeat(64) }, null, 2)}\n`;
/** The fixture's stand-in for the compiled-in pin. */
const PINNED = { version: RUNTIME_ASSETS_VERSION, sumsSha256: sha("sums\n") };

function mirror(
  options: { version?: string; endpoint?: string; insecure?: boolean; latest?: string; notices?: string; incompleteMarker?: boolean; inputs?: boolean } = {},
): { root: string; dir: string; pinned: typeof PINNED } {
  const version = options.version ?? "0.1.0";
  const root = mkdtempSync(join(tmpdir(), "amber-report-"));
  put(root, "package.json", JSON.stringify({ version }));
  put(root, "pnpm-lock.yaml", "lock\n");
  put(root, "mirror-source.json", JSON.stringify({ sourceCommit: "a".repeat(40), dirty: false, lockfileSha256: sha("lock\n"), version }));
  if (options.inputs !== false) put(root, "mirror-inputs.json", INPUTS);
  put(root, "src/desktop/tauri.conf.json", JSON.stringify({ plugins: { updater: { pubkey: PUBKEY } } }));
  put(
    root,
    "dist/desktop/updater.conf.json",
    JSON.stringify({ plugins: { updater: { endpoints: [options.endpoint ?? FEED], ...(options.insecure === true ? { dangerousInsecureTransportProtocol: true } : {}) } } }),
  );
  put(root, `${DEFAULT_ASSETS_DIR}/manifest.json`, MANIFEST);
  put(root, `${DEFAULT_ASSETS_DIR}/SHA256SUMS`, "sums\n");
  if (options.notices !== "") put(root, "dist/sidecar/legal/THIRD_PARTY_NOTICES.md", options.notices ?? "# notices\n");
  if (options.incompleteMarker === true) put(root, "dist/sidecar/notices-incomplete.json", "{}\n");
  const dir = join(root, "out");
  put(dir, `Amber_${version}_x64-setup.exe`, "installer");
  put(dir, `Amber_${version}_x64-setup.exe.sig`, SIG);
  if (options.latest !== undefined) put(dir, "latest.json", options.latest);
  return { root, dir, pinned: PINNED };
}

describe("buildReport", () => {
  it("records the whitelisted fields, with file names only", () => {
    const { root, dir, pinned } = mirror({ latest: JSON.stringify({ version: "0.1.0", platforms: { "windows-x86_64": { signature: SIG, url: "u" } } }) });
    const report = buildReport({ root, dir, variant: "release", pinned, now: new Date("2026-11-01T00:00:00Z") });
    expect(report).toEqual({
      generatedAt: "2026-11-01T00:00:00.000Z",
      variant: "release",
      version: "0.1.0",
      source: { commit: "a".repeat(40), dirty: false },
      inputsDigest: sha(INPUTS),
      lockfileSha256: sha("lock\n"),
      runtimeAssets: {
        version: RUNTIME_ASSETS_VERSION,
        manifestSha256: sha(MANIFEST),
        sha256SumsSha256: sha("sums\n"),
        pinned: true,
      },
      sidecar: { noticesComplete: true },
      installer: { file: "Amber_0.1.0_x64-setup.exe", sha256: sha("installer") },
      signature: { file: "Amber_0.1.0_x64-setup.exe.sig", sha256: sha(SIG) },
      latestJson: { file: "latest.json", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      updater: { publicKeyId: "3A40D99388CBD0AB", endpoint: FEED, insecureTransport: false },
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(root);
    expect(text).not.toContain(tmpdir());
    expect(text).not.toContain(`"${userInfo().username}"`);
    expect(text).not.toMatch(/[A-Za-z]:\\\\|"\/(?:home|tmp|Users)\//u);
  });

  it("records the candidate variant with its loopback feed", () => {
    const { root, dir, pinned } = mirror({ version: "0.1.0-rc.2", endpoint: "http://127.0.0.1:8787/latest.json", insecure: true });
    const report = buildReport({ root, dir, variant: "candidate", pinned, now: new Date(0) });
    expect(report.variant).toBe("candidate");
    expect(report.updater).toEqual({ publicKeyId: "3A40D99388CBD0AB", endpoint: "http://127.0.0.1:8787/latest.json", insecureTransport: true });
    expect(report.latestJson).toBeNull();
  });

  it("refuses a variant whose updater feed does not match it", () => {
    const candidateFeed = mirror({ endpoint: "http://127.0.0.1:8787/latest.json", insecure: true });
    expect(() => buildReport({ ...candidateFeed, variant: "release", now: new Date(0) })).toThrow(/default updater feed/u);
    const publicFeed = mirror({ version: "0.1.0-rc.2" });
    expect(() => buildReport({ ...publicFeed, variant: "candidate", now: new Date(0) })).toThrow(/public updater feed/u);
  });

  it("refuses a latest.json of another build", () => {
    const { root, dir, pinned } = mirror({ latest: JSON.stringify({ version: "0.1.0", platforms: { "windows-x86_64": { signature: "other", url: "u" } } }) });
    expect(() => buildReport({ root, dir, variant: "release", pinned, now: new Date(0) })).toThrow(/does not match/u);
  });

  it("refuses a release built from Runtime Assets other than the pinned ones; a candidate records it", () => {
    const fx = mirror();
    expect(() => buildReport({ ...fx, variant: "release", pinned: { ...PINNED, sumsSha256: "1".repeat(64) }, now: new Date(0) })).toThrow(
      /pinned Runtime Assets .*found runtime-assets-2026\.10\.21 \(SHA256SUMS [0-9a-f]{64}\)/u,
    );
    expect(() => buildReport({ ...fx, variant: "release", pinned: { ...PINNED, version: "runtime-assets-other" }, now: new Date(0) })).toThrow(/pinned Runtime Assets runtime-assets-other/u);
    // The compiled-in pin applies when none is injected.
    expect(() => buildReport({ root: fx.root, dir: fx.dir, variant: "release", now: new Date(0) })).toThrow(/pinned Runtime Assets/u);
    const candidate = mirror({ version: "0.1.0-rc.2", endpoint: "http://127.0.0.1:8787/latest.json", insecure: true });
    const report = buildReport({ ...candidate, variant: "candidate", pinned: { ...PINNED, sumsSha256: "1".repeat(64) }, now: new Date(0) });
    expect(report.runtimeAssets.pinned).toBe(false);
  });

  it("refuses a release whose sidecar notices are incomplete; a candidate records it", () => {
    const marked = mirror({ incompleteMarker: true });
    expect(() => buildReport({ ...marked, variant: "release", now: new Date(0) })).toThrow(/complete third-party notices/u);
    // Without the marker, the Cargo.lock-only notices still give it away.
    const unmarked = mirror({ notices: `# notices\n\n${CARGO_LOCK_ONLY_NOTE}\n` });
    expect(() => buildReport({ ...unmarked, variant: "release", now: new Date(0) })).toThrow(/complete third-party notices/u);
    const candidate = mirror({ version: "0.1.0-rc.2", endpoint: "http://127.0.0.1:8787/latest.json", insecure: true, incompleteMarker: true });
    expect(buildReport({ ...candidate, variant: "candidate", now: new Date(0) }).sidecar).toEqual({ noticesComplete: false });
  });

  it("refuses a mirror without its input list, so every build names the exact sources it was built from", () => {
    const fx = mirror({ version: "0.1.0-rc.2", endpoint: "http://127.0.0.1:8787/latest.json", insecure: true, inputs: false });
    expect(() => buildReport({ ...fx, variant: "candidate", now: new Date(0) })).toThrow(/mirror-inputs\.json is missing/u);
  });

  it("refuses a build without the packed sidecar notices", () => {
    const fx = mirror({ notices: "" });
    expect(() => buildReport({ ...fx, variant: "release", now: new Date(0) })).toThrow(/THIRD_PARTY_NOTICES\.md is missing/u);
  });

  it("reads the key id from the minisign comment", () => {
    expect(publicKeyIdOf(PUBKEY)).toBe("3A40D99388CBD0AB");
    expect(publicKeyIdOf(Buffer.from("no comment").toString("base64"))).toMatch(/^sha256:[0-9a-f]{16}$/u);
    expect(() => updaterOf({}, "release")).toThrow(/exactly one/u);
  });
});
