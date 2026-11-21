import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { modelNameBranching } from "./lib/model-branching.ts";
import { MODEL_BRANCHING_ALLOWLIST } from "./lib/model-branching-allowlist.ts";

describe("no branching on model names", () => {
  it("finds no violation in the repository", () => {
    expect(modelNameBranching(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(modelNameBranching(fixtureRoot("model-branching"), [])).toEqual([
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-match", line: 2 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-literal", line: 2 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-comparison", line: 5 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-switch", line: 9 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-literal", line: 9 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-match", line: 12 },
    ]);
  });

  it("passes an allowlisted file only while it keeps its conditions", () => {
    const allowlist = [
      { file: "src/web/models/model-family.ts", importer: "src/web/models/model-mark.tsx", reason: "fixture" },
      { file: "src/web/models/no-match.ts", importer: "src/web/models/model-mark.tsx", reason: "fixture" },
      { file: "src/web/models/gone.ts", importer: "src/web/models/model-mark.tsx", reason: "fixture" },
    ];
    expect(modelNameBranching(fixtureRoot("model-branching-allowlist"), allowlist)).toEqual([
      { file: "src/web/pages/picker.tsx", rule: "model-name-literal", line: 3 },
      { file: "src/web/models/model-family.ts", rule: "allowlist-runtime-import", line: 1 },
      { file: "src/web/pages/picker.tsx", rule: "allowlist-importer", line: 1 },
      { file: "src/web/models/no-match.ts", rule: "allowlist-unused" },
      { file: "src/web/models/gone.ts", rule: "allowlist-unused" },
    ]);
  });

  it("reports the same file without the allowlist", () => {
    const rules = modelNameBranching(fixtureRoot("model-branching-allowlist"), [])
      .filter((violation) => violation.file === "src/web/models/model-family.ts")
      .map((violation) => violation.rule);
    expect(rules).toEqual(["model-name-literal", "model-name-literal"]);
  });

  it("keeps the real allowlist to one file with a stated reason", () => {
    expect(MODEL_BRANCHING_ALLOWLIST.map((entry) => [entry.file, entry.importer])).toEqual([["src/web/models/model-family.ts", "src/web/models/model-mark.tsx"]]);
    for (const entry of MODEL_BRANCHING_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});

