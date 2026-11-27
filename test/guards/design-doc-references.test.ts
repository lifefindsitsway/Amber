import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { materializeTemplates } from "./lib/fixture.ts";
import { DESIGN_DOC_RULE_IDS, designDocScanFiles, scanDesignDocReferences } from "./lib/design-doc-references.ts";

const FILE = "references.txt";

describe("design-document reference guard", () => {
  it("finds no reference to the internal design documents in the published files", () => {
    const { violations, skipped } = scanDesignDocReferences(REPO_ROOT, designDocScanFiles(REPO_ROOT));
    console.info(`design-doc reference scan skipped ${skipped.length} binary files:\n${skipped.join("\n")}`);
    // Only file, line and rule are printed, never the matched text.
    expect(violations.map((violation) => `${violation.file}:${violation.line ?? "-"} ${violation.rule}`)).toEqual([]);
  });

  it("rejects every counter-example, each rule at least once", () => {
    const { root, files } = materializeTemplates("design-doc-references");
    expect(files).toEqual(["clean.txt", FILE]);
    const { violations } = scanDesignDocReferences(root, files);
    expect(violations).toEqual([
      { file: FILE, line: 1, rule: "design-doc-file" },
      { file: FILE, line: 2, rule: "design-doc-file" },
      { file: FILE, line: 3, rule: "docs-path" },
      { file: FILE, line: 4, rule: "bare-plan" },
      { file: FILE, line: 5, rule: "section-ref" },
      { file: FILE, line: 6, rule: "section-ref" },
      { file: FILE, line: 7, rule: "section-ref" },
      { file: FILE, line: 8, rule: "section-ref" },
      { file: FILE, line: 9, rule: "section-ref" },
      { file: FILE, line: 10, rule: "bare-plan" },
      { file: FILE, line: 10, rule: "section-ref" },
      { file: FILE, line: 11, rule: "frozen-contract" },
      { file: FILE, line: 12, rule: "decision-ref" },
      { file: FILE, line: 13, rule: "acceptance-id" },
      { file: FILE, line: 14, rule: "stage-ref" },
      { file: FILE, line: 15, rule: "stage-ref" },
      { file: FILE, line: 16, rule: "claude-rule" },
      { file: FILE, line: 16, rule: "design-doc-file" },
      { file: FILE, line: 17, rule: "design-doc-file" },
      { file: FILE, line: 18, rule: "design-doc-file" },
      { file: FILE, line: 19, rule: "design-doc-file" },
      { file: FILE, line: 20, rule: "design-doc-file" },
    ]);
    const covered = new Set(violations.map((violation) => violation.rule));
    // The star and the circled numbers cannot sit in a committed template; the next case covers them.
    expect(DESIGN_DOC_RULE_IDS.filter((rule) => !covered.has(rule))).toEqual(["circled-number"]);
  });

  it("rejects invariant stars, circled numbers and references in file paths", () => {
    const root = mkdtempSync(join(tmpdir(), "amber-guard-"));
    const star = String.fromCodePoint(0x2605);
    writeFileSync(join(root, "marks.txt"), [`Invariant ${star}4`, `guard ${String.fromCodePoint(0x2460)}`, `guard ${String.fromCodePoint(0x2473)}`].join("\n"));
    const stagePath = ["notes-", "V", "1", "-C.txt"].join("");
    writeFileSync(join(root, stagePath), "plain text\n");
    expect(scanDesignDocReferences(root, ["marks.txt", stagePath]).violations).toEqual([
      { file: "marks.txt", line: 1, rule: "frozen-contract" },
      { file: "marks.txt", line: 2, rule: "circled-number" },
      { file: "marks.txt", line: 3, rule: "circled-number" },
      { file: stagePath, rule: "stage-ref" },
    ]);
  });

  it("accepts URLs, encodings, hashes and lower-case plan / v1", () => {
    const { root, files } = materializeTemplates("design-doc-references");
    expect(scanDesignDocReferences(root, files.filter((file) => file === "clean.txt")).violations).toEqual([]);
  });

  it("skips binary files and fails on a file it cannot read", () => {
    const root = mkdtempSync(join(tmpdir(), "amber-guard-"));
    writeFileSync(join(root, "image.png"), "not scanned");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x50, 0x00, 0x51]));
    expect(scanDesignDocReferences(root, ["image.png", "blob.bin"])).toEqual({ violations: [], skipped: ["blob.bin", "image.png"] });
    expect(() => scanDesignDocReferences(root, ["missing.txt"])).toThrow(/cannot read missing\.txt/u);
  });

  it("honours an exact allowlist entry and reports one that matches nothing", () => {
    const { root, files } = materializeTemplates("design-doc-references");
    const decision = ["D", "53"].join("");
    const { violations } = scanDesignDocReferences(root, files, [
      { file: FILE, pattern: decision, reason: "counter-example" },
      { file: "clean.txt", pattern: decision, reason: "matches nothing" },
    ]);
    expect(violations.filter((violation) => violation.rule === "decision-ref")).toEqual([]);
    expect(violations.filter((violation) => violation.rule === "allowlist-unused")).toEqual([{ file: "clean.txt", rule: "allowlist-unused" }]);
    expect(violations).toHaveLength(22);
  });
});
