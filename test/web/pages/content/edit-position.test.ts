import { describe, expect, it } from "vitest";
import { locateDraftTarget } from "../../../../src/web/pages/content/edit-position.ts";

const draft = (id: string | undefined, startMs: number, endMs: number, sources: string[] = id === undefined ? [] : [id]) => ({
  ...(id === undefined ? {} : { id }),
  startMs,
  endMs,
  sourceSegmentIds: sources,
});
const target = (segmentId: string, startMs: number, endMs: number) => ({ segmentId, startMs, endMs });

describe("locateDraftTarget", () => {
  it("finds nothing in an empty draft", () => {
    expect(locateDraftTarget([], target("a", 0, 1000))).toBeUndefined();
  });

  it("takes the sentence carrying the target's id first", () => {
    const sentences = [draft("a", 0, 1000), draft("b", 1000, 2000), draft("c", 2000, 3000)];
    expect(locateDraftTarget(sentences, target("b", 1000, 2000))).toBe(1);
  });

  it("finds the same sentence in a saved draft whose sentences kept their ids", () => {
    const sentences = [draft("a", 0, 1000), draft("b", 1000, 2000)];
    // The draft moved the sentence's times a little: the id still decides.
    expect(locateDraftTarget([sentences[0]!, { ...sentences[1]!, startMs: 1500 }], target("b", 1000, 2000))).toBe(1);
  });

  it("picks the half of a split sentence overlapping it longest, the earlier on a tie", () => {
    const halves = [draft("a", 0, 1000), draft(undefined, 1000, 1300, ["b"]), draft(undefined, 1300, 2000, ["b"])];
    expect(locateDraftTarget(halves, target("b", 1000, 2000))).toBe(2);
    const even = [draft(undefined, 1000, 1500, ["b"]), draft(undefined, 1500, 2000, ["b"])];
    expect(locateDraftTarget(even, target("b", 1000, 2000))).toBe(0);
  });

  it("prefers a sentence made from the target over a longer overlap of another speaker's sentence", () => {
    // Two speakers overlapping in time: the other speaker's sentence covers the target longer.
    const sentences = [draft("x", 900, 2100), draft(undefined, 1800, 2000, ["b"])];
    expect(locateDraftTarget(sentences, target("b", 1000, 2000))).toBe(1);
  });

  it("falls back to the longest overlap when the target's sentence was deleted", () => {
    const sentences = [draft("a", 0, 1100), draft("c", 1400, 3000)];
    expect(locateDraftTarget(sentences, target("b", 1000, 2000))).toBe(1);
  });

  it("breaks an overlap tie by the nearest start, then by order", () => {
    const sentences = [draft("a", 500, 1500), draft("c", 1500, 2500)];
    // Both overlap 500 ms; "c" starts 500 ms away, "a" 500 ms away: the earlier wins.
    expect(locateDraftTarget(sentences, target("b", 1000, 2000))).toBe(0);
    const nearer = [draft("a", 400, 1400), draft("c", 1600, 2600)];
    // Both overlap 400 ms; "c" starts 600 ms away, "a" 600 ms away: still the earlier.
    expect(locateDraftTarget(nearer, target("b", 1000, 2000))).toBe(0);
    const unequal = [draft("a", 300, 1400), draft("c", 1600, 2100)];
    // Both overlap 400 ms; "c" starts 600 ms away, "a" 700 ms away.
    expect(locateDraftTarget(unequal, target("b", 1000, 2000))).toBe(1);
  });

  it("takes the nearest start when nothing overlaps", () => {
    const sentences = [draft("a", 0, 500), draft("c", 2600, 3000), draft("d", 5000, 6000)];
    expect(locateDraftTarget(sentences, target("b", 1000, 2000))).toBe(0);
    expect(locateDraftTarget(sentences, target("b", 2200, 2400))).toBe(1);
  });

  it("matches a draft based on another revision by time only", () => {
    // Sources of another base never name the target; its ids are not the target's either.
    const sentences = [draft("p1", 0, 900, ["q1"]), draft("p2", 900, 2100, ["q2"])];
    expect(locateDraftTarget(sentences, target("b", 1000, 2000))).toBe(1);
  });
});
