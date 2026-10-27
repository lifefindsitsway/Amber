import { describe, expect, it } from "vitest";
import { deriveCollectionFreshness, deriveFreshness, transcriptAncestors } from "../../../src/server/domain/freshness.ts";

describe("deriveFreshness", () => {
  it("is fresh while every compared input is current", () => {
    expect(deriveFreshness([{ kind: "transcriptRevision", id: "t1" }, { kind: "chapterRevision", id: "c1" }], { primaryTranscriptRevisionId: "t1", chapterRevisionId: "c1" })).toEqual({
      stale: false,
    });
  });

  it("reports transcript_changed before chapters_changed", () => {
    const inputs = [{ kind: "chapterRevision", id: "c1" }, { kind: "transcriptRevision", id: "t1" }] as const;
    expect(deriveFreshness(inputs, { primaryTranscriptRevisionId: "t2", chapterRevisionId: "c2" })).toEqual({ stale: true, staleReason: "transcript_changed" });
    expect(deriveFreshness(inputs, { primaryTranscriptRevisionId: "t1", chapterRevisionId: "c2" })).toEqual({ stale: true, staleReason: "chapters_changed" });
    expect(deriveFreshness([{ kind: "transcriptRevision", id: "t1" }], {})).toEqual({ stale: true, staleReason: "transcript_changed" });
  });

  it("stays fresh when the primary descends from the transcript input, and is transcript_changed across lineages", () => {
    const inputs = [{ kind: "transcriptRevision", id: "asr" }] as const;
    // manual -> corrected -> asr: an edit or proofread of the input.
    expect(deriveFreshness(inputs, { primaryTranscriptRevisionId: "manual", primaryAncestors: ["corrected", "asr"] })).toEqual({ stale: false });
    // A primary on another root, or the input's own parent, is another text.
    expect(deriveFreshness(inputs, { primaryTranscriptRevisionId: "imported", primaryAncestors: [] })).toEqual({ stale: true, staleReason: "transcript_changed" });
    expect(deriveFreshness([{ kind: "transcriptRevision", id: "corrected" }], { primaryTranscriptRevisionId: "asr", primaryAncestors: [] })).toEqual({
      stale: true,
      staleReason: "transcript_changed",
    });
    expect(deriveFreshness(inputs, { primaryAncestors: ["asr"] })).toEqual({ stale: true, staleReason: "transcript_changed" });
  });

  it("keeps an artifact without transcript or chapter inputs fresh, as platform chapters are", () => {
    expect(deriveFreshness([], { primaryTranscriptRevisionId: "t9" })).toEqual({ stale: false });
    expect(deriveFreshness([{ kind: "referenceText", id: "r1" }], {})).toEqual({ stale: false });
  });
});

describe("collection summary freshness", () => {
  const a = { contentId: "a", summaryRevisionId: "sa", transcriptRevisionId: "ta" };
  const b = { contentId: "b", summaryRevisionId: "sb", transcriptRevisionId: "tb" };

  it("is fresh while members, their currents and order are unchanged", () => {
    expect(deriveCollectionFreshness([a, b], [a, b])).toEqual({ stale: false });
  });

  it("is order_changed when only the order differs", () => {
    expect(deriveCollectionFreshness([a, b], [b, a])).toEqual({ stale: true, staleReason: "order_changed" });
  });

  it("is member_changed when a member is added or removed, or its core summary or primary changed", () => {
    const c = { contentId: "c", summaryRevisionId: "sc", transcriptRevisionId: "tc" };
    expect(deriveCollectionFreshness([a, b], [a, b, c])).toEqual({ stale: true, staleReason: "member_changed" });
    expect(deriveCollectionFreshness([a, b], [a])).toEqual({ stale: true, staleReason: "member_changed" });
    expect(deriveCollectionFreshness([a, b], [a, { ...b, summaryRevisionId: "sb2" }])).toEqual({ stale: true, staleReason: "member_changed" });
    expect(deriveCollectionFreshness([a, b], [{ ...a, transcriptRevisionId: "ta2" }, b])).toEqual({ stale: true, staleReason: "member_changed" });
    // A primary edited from the frozen transcript is still that member's text.
    expect(deriveCollectionFreshness([a, b], [{ ...a, transcriptRevisionId: "ta2", transcriptAncestors: ["ta"] }, b])).toEqual({ stale: false });
    expect(deriveCollectionFreshness([a, b], [{ ...a, transcriptRevisionId: "ta2", transcriptAncestors: ["tx"] }, b])).toEqual({ stale: true, staleReason: "member_changed" });
    // Membership wins over order.
    expect(deriveCollectionFreshness([a, b], [{ contentId: "b", transcriptRevisionId: "tb" }, a])).toEqual({ stale: true, staleReason: "member_changed" });
  });
});

describe("transcriptAncestors", () => {
  const revisions = [{ id: "asr" }, { id: "corrected", parentRevisionId: "asr" }, { id: "manual", parentRevisionId: "corrected" }, { id: "platform" }];

  it("lists the ancestors nearest first, and nothing for a root or without a revision", () => {
    expect(transcriptAncestors("manual", revisions)).toEqual(["corrected", "asr"]);
    expect(transcriptAncestors("platform", revisions)).toEqual([]);
    expect(transcriptAncestors(undefined, revisions)).toEqual([]);
  });

  it("stops at a parent that is not among the revisions", () => {
    expect(transcriptAncestors("orphan", [{ id: "orphan", parentRevisionId: "gone" }])).toEqual([]);
  });
});
