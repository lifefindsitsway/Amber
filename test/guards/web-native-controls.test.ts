import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { webNativeControlCounts, webNativeControls } from "./lib/web-native-controls.ts";
import { WEB_NATIVE_CONTROLS_ALLOWLIST } from "./lib/web-native-controls-allowlist.ts";

const FIXTURE = fixtureRoot("web-native-controls");

describe("shared controls and notices in src/web", () => {
  it("finds no violation in the repository", () => {
    expect(webNativeControls(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture and leaves src/web/ui alone", () => {
    expect(webNativeControls(FIXTURE, [])).toEqual([
      { file: "src/web/pages/allowed-page.tsx", rule: "hand-tinted-notice", line: 1 },
      { file: "src/web/pages/allowed-page.tsx", rule: "native-select", line: 6 },
      { file: "src/web/pages/allowed-page.tsx", rule: "native-select", line: 7 },
      { file: "src/web/pages/allowed-page.tsx", rule: "native-checkbox", line: 8 },
      { file: "src/web/pages/bad-page.tsx", rule: "native-select", line: 4 },
      { file: "src/web/pages/bad-page.tsx", rule: "native-checkbox", line: 7 },
      { file: "src/web/pages/bad-page.tsx", rule: "native-radio", line: 8 },
      { file: "src/web/pages/bad-page.tsx", rule: "hand-tinted-notice", line: 10 },
      { file: "src/web/pages/bad-page.tsx", rule: "hand-tinted-notice", line: 11 },
    ]);
  });

  it("holds an allowlisted file to its exact counts and reports entries left behind", () => {
    const exact = { "native-select": 2, "native-checkbox": 1, "hand-tinted-notice": 1 };
    const pass = webNativeControls(FIXTURE, [{ file: "src/web/pages/allowed-page.tsx", counts: exact, reason: "fixture" }]).filter((violation) => violation.file !== "src/web/pages/bad-page.tsx");
    expect(pass).toEqual([]);
    expect(
      webNativeControls(FIXTURE, [
        { file: "src/web/pages/allowed-page.tsx", counts: { "native-select": 1, "native-checkbox": 2, "hand-tinted-notice": 1 }, reason: "fixture" },
        { file: "src/web/pages/clean-page.tsx", counts: { "native-select": 1 }, reason: "fixture" },
        { file: "src/web/pages/gone-page.tsx", counts: { "native-radio": 1 }, reason: "fixture" },
      ]).filter((violation) => violation.file !== "src/web/pages/bad-page.tsx"),
    ).toEqual([
      { file: "src/web/pages/allowed-page.tsx", rule: "native-select-over-allowlist" },
      { file: "src/web/pages/allowed-page.tsx", rule: "native-checkbox-allowlist-stale" },
      { file: "src/web/pages/clean-page.tsx", rule: "allowlist-unused" },
      { file: "src/web/pages/gone-page.tsx", rule: "allowlist-unused" },
    ]);
  });

  it("keeps the real allowlist exact, sorted, reasoned and free of zero counts", () => {
    const files = WEB_NATIVE_CONTROLS_ALLOWLIST.map((entry) => entry.file);
    expect(files).toEqual([...new Set(files)].sort());
    const actual = webNativeControlCounts(REPO_ROOT);
    for (const entry of WEB_NATIVE_CONTROLS_ALLOWLIST) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(Object.values(entry.counts).every((count) => count > 0), entry.file).toBe(true);
      expect(entry.counts, entry.file).toEqual(actual.get(entry.file)?.counts);
    }
  });
});
