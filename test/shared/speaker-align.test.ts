import { describe, expect, it } from "vitest";
import { SPEAKER_ALIGN_MIN_COVERAGE, SPEAKER_ALIGN_MIN_SHARE } from "../../src/shared/defaults.ts";
import { alignSpeakers } from "../../src/shared/speaker-align.ts";

const mapping = new Map<string, string | null>([
  ["s1", "A"],
  ["s2", "B"],
  ["s3", null],
]);

describe("alignSpeakers", () => {
  it("matches a sentence clearly covered by one source speaker", () => {
    const result = alignSpeakers([{ id: "t1", startMs: 0, endMs: 1000 }], [{ startMs: -500, endMs: 1500, speakerId: "s1" }], mapping);
    expect(result.sentences).toEqual([{ id: "t1", speakerId: "A", review: "auto" }]);
    expect(result).toMatchObject({ auto: 1, needsReview: 0, unassigned: 0, coverage: 1, lowCoverage: false });
  });

  it("decides auto at exactly SPEAKER_ALIGN_MIN_SHARE of the overlapped time", () => {
    const target = [{ id: "t", startMs: 0, endMs: 1000 }];
    const at = Math.round(SPEAKER_ALIGN_MIN_SHARE * 1000);
    const source = (boundary: number) => [
      { startMs: 0, endMs: boundary, speakerId: "s1" },
      { startMs: boundary, endMs: 1000, speakerId: "s2" },
    ];
    expect(alignSpeakers(target, source(at), mapping).sentences[0]).toMatchObject({ speakerId: "A", review: "auto" });
    expect(alignSpeakers(target, source(at - 1), mapping).sentences[0]).toMatchObject({ speakerId: "A", review: "needs_review", changeAtMs: at - 1 });
  });

  it("asks for review below the share and records where the source's speaker changes", () => {
    const result = alignSpeakers(
      [{ id: "t", startMs: 1000, endMs: 3000 }],
      [
        { startMs: 0, endMs: 1900, speakerId: "s1" },
        { startMs: 1900, endMs: 4000, speakerId: "s2" },
      ],
      mapping,
    );
    // 900 ms of A, 1100 ms of B: neither reaches the share.
    expect(result.sentences[0]).toEqual({ id: "t", speakerId: "B", review: "needs_review", changeAtMs: 1900 });
    expect(result).toMatchObject({ auto: 0, needsReview: 1, unassigned: 0 });
  });

  it("suggests the identity heard longest for review, even when unmatched speakers together are heard longer", () => {
    const result = alignSpeakers(
      [{ id: "t", startMs: 0, endMs: 1000 }],
      [
        { startMs: 0, endMs: 600, speakerId: "s3" },
        { startMs: 600, endMs: 1000, speakerId: "s1" },
      ],
      mapping,
    );
    expect(result.sentences[0]).toMatchObject({ speakerId: "A", review: "needs_review" });
  });

  it("leaves a sentence without overlap unassigned, and zero-length touching does not count", () => {
    const result = alignSpeakers([{ id: "t", startMs: 1000, endMs: 2000 }], [{ startMs: 0, endMs: 1000, speakerId: "s1" }, { startMs: 2000, endMs: 3000, speakerId: "s2" }], mapping);
    expect(result.sentences[0]).toEqual({ id: "t", speakerId: null });
    expect(result).toMatchObject({ unassigned: 1, coverage: 0, lowCoverage: true });
  });

  it("ignores source sentences without a speaker", () => {
    const result = alignSpeakers([{ id: "t", startMs: 0, endMs: 1000 }], [{ startMs: 0, endMs: 1000 }], mapping);
    expect(result.sentences[0]).toEqual({ id: "t", speakerId: null });
    expect(result.coverage).toBe(0);
  });

  it("leaves a sentence unassigned when its top speaker is mapped to nobody or not mapped", () => {
    const targets = [{ id: "t", startMs: 0, endMs: 1000 }];
    expect(alignSpeakers(targets, [{ startMs: 0, endMs: 1000, speakerId: "s3" }], mapping).sentences[0]).toEqual({ id: "t", speakerId: null });
    expect(alignSpeakers(targets, [{ startMs: 0, endMs: 1000, speakerId: "unknown" }], mapping)).toMatchObject({ unassigned: 1, coverage: 1 });
  });

  it("counts source speakers mapped to the same identity together", () => {
    const merged = new Map<string, string | null>([["s1", "A"], ["s2", "A"]]);
    const result = alignSpeakers(
      [{ id: "t", startMs: 0, endMs: 1000 }],
      [{ startMs: 0, endMs: 500, speakerId: "s1" }, { startMs: 500, endMs: 1000, speakerId: "s2" }],
      merged,
    );
    expect(result.sentences[0]).toEqual({ id: "t", speakerId: "A", review: "auto" });
  });

  it("reports low coverage when fewer than SPEAKER_ALIGN_MIN_COVERAGE of the sentences overlap", () => {
    const targets = Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, startMs: index * 1000, endMs: index * 1000 + 900 }));
    const covered = Math.ceil(SPEAKER_ALIGN_MIN_COVERAGE * 10);
    const sourceFor = (count: number) => Array.from({ length: count }, (_, index) => ({ startMs: index * 1000, endMs: index * 1000 + 900, speakerId: "s1" }));
    expect(alignSpeakers(targets, sourceFor(covered), mapping)).toMatchObject({ coverage: covered / 10, lowCoverage: false });
    expect(alignSpeakers(targets, sourceFor(covered - 1), mapping)).toMatchObject({ coverage: (covered - 1) / 10, lowCoverage: true });
  });

  it("returns results in the order of the targets whatever the order of the inputs", () => {
    const result = alignSpeakers(
      [
        { id: "late", startMs: 5000, endMs: 6000 },
        { id: "early", startMs: 0, endMs: 1000 },
      ],
      [
        { startMs: 5000, endMs: 6000, speakerId: "s2" },
        { startMs: 0, endMs: 1000, speakerId: "s1" },
      ],
      mapping,
    );
    expect(result.sentences.map((sentence) => [sentence.id, sentence.speakerId])).toEqual([["late", "B"], ["early", "A"]]);
  });

  it("handles a source sentence that spans many targets", () => {
    const targets = Array.from({ length: 5 }, (_, index) => ({ id: `t${index}`, startMs: index * 1000, endMs: index * 1000 + 1000 }));
    const result = alignSpeakers(targets, [{ startMs: 0, endMs: 5000, speakerId: "s1" }, { startMs: 2100, endMs: 2200, speakerId: "s2" }], mapping);
    expect(result.sentences.map((sentence) => sentence.speakerId)).toEqual(["A", "A", "A", "A", "A"]);
  });

  it("aligns 2,888 sentences quickly", () => {
    const count = 2888;
    const targets = Array.from({ length: count }, (_, index) => ({ id: `t${index}`, startMs: index * 2000, endMs: index * 2000 + 1900 }));
    // The source cuts at different places and alternates speakers.
    const source = Array.from({ length: count + 100 }, (_, index) => ({ startMs: index * 1900, endMs: index * 1900 + 1800, speakerId: index % 2 === 0 ? "s1" : "s2" }));
    const started = performance.now();
    const result = alignSpeakers(targets, source, mapping);
    const elapsed = performance.now() - started;
    expect(result.sentences).toHaveLength(count);
    expect(result.auto + result.needsReview + result.unassigned).toBe(count);
    // Generous for slow machines: a quadratic scan would take seconds here.
    expect(elapsed).toBeLessThan(1000);
  });
});
