import { describe, expect, it } from "vitest";
import type { SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import {
  compareSpeakerLineage,
  attributionChangeCounts,
  countAttributionChanges,
  deriveSpeakerContextState,
  lineageVerdict,
  type LineageRevision,
  type LineageSegment,
  type SpeakerLineageComparison,
} from "../../../src/server/domain/speaker-lineage.ts";

/** A sentence: id, speaker (`-` = unassigned), sources. */
const seg = (id: string, speaker: string, sources: string[] = []): LineageSegment => ({
  id,
  ...(speaker === "-" ? {} : { speakerId: speaker }),
  sourceSegmentIds: sources,
});

/** Revisions in a chain, oldest first: `A` is the root, each later one the child of the previous. */
function chain(levels: Record<string, LineageSegment[]>, missingSegments: string[] = []) {
  const ids = Object.keys(levels);
  const revisions = new Map<string, LineageRevision>(ids.map((id, index) => [id, { id, ...(index === 0 ? {} : { parentRevisionId: ids[index - 1] as string }) }]));
  return {
    revisions,
    segmentsOf: (revisionId: string) => (missingSegments.includes(revisionId) ? undefined : levels[revisionId]),
  };
}

function compare(levels: Record<string, LineageSegment[]>, from = "A", to = Object.keys(levels).at(-1) as string): SpeakerLineageComparison {
  return compareSpeakerLineage({ fromRevisionId: from, toRevisionId: to, ...chain(levels) });
}

const A = [seg("a1", "x"), seg("a2", "y"), seg("a3", "x")];

describe("compareSpeakerLineage: one sentence of the generated-from revision, in the current one", () => {
  it("still there with the same speaker: consistent", () => {
    const result = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b2", "y", ["a2"]), seg("b3", "x", ["a3"])] });
    expect(lineageVerdict(result, ["a1", "a2"])).toEqual({ state: "consistent", changedSentences: 0, removedCitations: 0 });
  });

  it("split, every part with the same speaker: consistent", () => {
    const result = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b1b", "x", ["a1"]), seg("b2", "y", ["a2"]), seg("b3", "x", ["a3"])] });
    expect(lineageVerdict(result, []).state).toBe("consistent");
  });

  it("split, one part given to someone else: changed", () => {
    const result = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b1b", "y", ["a1"]), seg("b2", "y", ["a2"]), seg("b3", "x", ["a3"])] });
    expect(lineageVerdict(result, [])).toEqual({ state: "attribution_changed", changedSentences: 1, removedCitations: 0 });
  });

  it("given whole to someone else: changed; taking the speaker away counts too", () => {
    const result = compare({ A, B: [seg("b1", "y", ["a1"]), seg("b2", "-", ["a2"]), seg("b3", "x", ["a3"])] });
    expect(result.kind === "compared" ? [...result.changed] : []).toEqual(["a1", "a2"]);
    expect(lineageVerdict(result, []).changedSentences).toBe(2);
  });

  it("given to someone else and back again: only the two ends count", () => {
    const result = compare({
      A,
      M: [seg("m1", "y", ["a1"]), seg("m2", "y", ["a2"]), seg("m3", "x", ["a3"])],
      B: [seg("b1", "x", ["m1"]), seg("b2", "y", ["m2"]), seg("b3", "x", ["m3"])],
    });
    expect(lineageVerdict(result, []).state).toBe("consistent");
  });

  it("merged with a sentence of someone else: both changed", () => {
    const result = compare({ A, B: [seg("b12", "x", ["a1", "a2"]), seg("b3", "x", ["a3"])] });
    expect(result.kind === "compared" ? [...result.changed] : []).toEqual(["a2"]);
    const both = compare({ A, B: [seg("b12", "z", ["a1", "a2"]), seg("b3", "x", ["a3"])] });
    expect(both.kind === "compared" ? [...both.changed] : []).toEqual(["a1", "a2"]);
  });

  it("deleted and cited by the result: evidence removed", () => {
    const result = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b3", "x", ["a3"])] });
    expect(lineageVerdict(result, ["a2", "a3"])).toEqual({ state: "evidence_removed", changedSentences: 0, removedCitations: 1 });
  });

  it("deleted and not cited: nothing to report", () => {
    const result = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b3", "x", ["a3"])] });
    expect(lineageVerdict(result, ["a1"]).state).toBe("consistent");
  });

  it("a sentence that names a speaker but comes from nowhere, or a broken lineage: unknown", () => {
    const unsourced = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b2", "y", ["a2"]), seg("b3", "x", ["a3"]), seg("new", "y")] });
    expect(lineageVerdict(unsourced, []).state).toBe("unknown");
    // An unassigned new sentence says nothing about anyone.
    expect(lineageVerdict(compare({ A, B: [seg("b1", "x", ["a1"]), seg("b2", "y", ["a2"]), seg("b3", "x", ["a3"]), seg("new", "-")] }), []).state).toBe("consistent");
    const levels = { A, M: [seg("m1", "x", ["a1"])], B: [seg("b1", "x", ["m1"])] };
    expect(compareSpeakerLineage({ fromRevisionId: "A", toRevisionId: "B", ...chain(levels, ["M"]) })).toEqual({ kind: "untraceable" });
    const gap = chain(levels);
    gap.revisions.delete("M");
    expect(compareSpeakerLineage({ fromRevisionId: "A", toRevisionId: "B", ...gap })).toEqual({ kind: "untraceable" });
    expect(compare({ A, B: [seg("b1", "x", ["zz"])] })).toEqual({ kind: "untraceable" });
    expect(lineageVerdict({ kind: "untraceable" }, ["a1"])).toEqual({ state: "unknown", changedSentences: 0, removedCitations: 0 });
  });

  it("is consistent with itself, and untraceable when the revision is not an ancestor", () => {
    expect(lineageVerdict(compare({ A }, "A", "A"), []).state).toBe("consistent");
    expect(compare({ A, B: [seg("b1", "x", ["a1"])] }, "B", "A")).toEqual({ kind: "untraceable" });
  });

  it("gives the same answer once intermediate manual revisions are folded into the newest", () => {
    // Before folding: A → M → B; after: A → B' with the sources carried up to A.
    const before = compare({
      A,
      M: [seg("m1", "x", ["a1"]), seg("m1b", "y", ["a1"]), seg("m3", "x", ["a3"])],
      B: [seg("b1", "x", ["m1"]), seg("b1b", "y", ["m1b"]), seg("b3", "x", ["m3"])],
    });
    const after = compare({ A, B: [seg("b1", "x", ["a1"]), seg("b1b", "y", ["a1"]), seg("b3", "x", ["a3"])] });
    expect(lineageVerdict(after, ["a2"])).toEqual(lineageVerdict(before, ["a2"]));
    expect(lineageVerdict(after, ["a2"])).toEqual({ state: "attribution_changed", changedSentences: 1, removedCitations: 1 });
  });
});

describe("lineageVerdict order", () => {
  it("reports a change before a removed citation, and a removed citation before an unknown sentence", () => {
    const changed = compare({ A, B: [seg("b1", "y", ["a1"]), seg("new", "x")] });
    expect(lineageVerdict(changed, ["a2"]).state).toBe("attribution_changed");
    const removed = compare({ A, B: [seg("b1", "x", ["a1"]), seg("new", "x")] });
    expect(lineageVerdict(removed, ["a2"]).state).toBe("evidence_removed");
  });
});

describe("countAttributionChanges", () => {
  it("counts the parent's sentences that changed hands and new sentences with a speaker", () => {
    expect(countAttributionChanges(A, [seg("n1", "x", ["a1"]), seg("n2", "y", ["a2"]), seg("n3", "x", ["a3"])])).toBe(0);
    expect(countAttributionChanges(A, [seg("n1", "x", ["a1"]), seg("n3", "x", ["a3"])])).toBe(0);
    expect(countAttributionChanges(A, [seg("n1", "y", ["a1"]), seg("n2", "-", ["a2"]), seg("n3", "x", ["a3"]), seg("n4", "x")])).toBe(3);
    expect(countAttributionChanges(A, [seg("n1", "x", ["a1"]), seg("n2", "y", ["a2"]), seg("n3", "x", ["a3"]), seg("n4", "-")])).toBe(0);
  });

  it("keeps the changes of hands apart from the new sentences with a speaker", () => {
    expect(attributionChangeCounts(A, [seg("n1", "y", ["a1"]), seg("n2", "-", ["a2"]), seg("n3", "x", ["a3"]), seg("n4", "x")])).toEqual({ changed: 2, unsourcedAssigned: 1 });
  });
});

describe("deriveSpeakerContextState", () => {
  const snapshot: SpeakerContextSnapshot = {
    version: 1,
    rules: { id: "speaker.rules", version: 1 },
    attributionDigest: "d",
    speakers: [
      { id: "x", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
      { id: "y", ordinal: 2, label: "发言人 2" },
    ],
  };
  const same = new Map([["x", "蒋炎岩"], ["y", "发言人 2"]]);
  const consistent = { state: "consistent" as const, changedSentences: 0, removedCitations: 0 };

  it("takes each of the six states in order", () => {
    expect(deriveSpeakerContextState({ state: "attribution_changed", changedSentences: 2, removedCitations: 1 }, snapshot, new Map([["x", "张三"]]), false)).toEqual({
      state: "attribution_changed",
      changedSentences: 2,
    });
    expect(deriveSpeakerContextState({ state: "evidence_removed", changedSentences: 0, removedCitations: 1 }, snapshot, same, false)).toEqual({ state: "evidence_removed", removedCitations: 1 });
    expect(deriveSpeakerContextState({ state: "unknown", changedSentences: 0, removedCitations: 0 }, snapshot, same, false)).toEqual({ state: "unknown" });
    expect(deriveSpeakerContextState(consistent, snapshot, new Map([["x", "张三"], ["y", "发言人 2"]]), false)).toEqual({
      state: "names_changed",
      renamed: [{ id: "x", was: "蒋炎岩", now: "张三" }],
    });
    expect(deriveSpeakerContextState(consistent, snapshot, same, false)).toEqual({ state: "unconfirmed" });
    expect(deriveSpeakerContextState(consistent, snapshot, same, true)).toEqual({ state: "consistent" });
  });

  it("does not compare a speaker without a current label", () => {
    expect(deriveSpeakerContextState(consistent, snapshot, new Map([["x", "蒋炎岩"]]), true)).toEqual({ state: "consistent" });
  });
});
