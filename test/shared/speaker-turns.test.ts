import { describe, expect, it } from "vitest";
import { PARAGRAPH_GAP_MS } from "../../src/shared/defaults.ts";
import { readingParagraphs, type ReadingSentence } from "../../src/shared/reading.ts";
import { speakerModeFor, speakerSections, speakerShares, speakerTurns } from "../../src/shared/speaker-turns.ts";

function sentence(startMs: number, endMs: number, text: string, speakerId?: string, extra: Partial<ReadingSentence> = {}): ReadingSentence {
  return { startMs, endMs, text, ...(speakerId === undefined ? {} : { speakerId }), ...extra };
}

describe("speakerTurns", () => {
  it("groups consecutive paragraphs of one speaker, keeping unassigned as its own kind of turn", () => {
    const sentences = [
      sentence(0, 1000, "a。", "A"),
      sentence(1000 + PARAGRAPH_GAP_MS + 1, 3000 + PARAGRAPH_GAP_MS, "b。", "A"),
      sentence(5000 + PARAGRAPH_GAP_MS, 6000 + PARAGRAPH_GAP_MS, "c。", "B"),
      sentence(6100 + PARAGRAPH_GAP_MS, 7000 + PARAGRAPH_GAP_MS, "d。"),
      sentence(7100 + PARAGRAPH_GAP_MS, 8000 + PARAGRAPH_GAP_MS, "e。"),
      sentence(8100 + PARAGRAPH_GAP_MS, 9000 + PARAGRAPH_GAP_MS, "f。", "A"),
    ];
    const paragraphs = readingParagraphs(sentences);
    const turns = speakerTurns(paragraphs);
    expect(turns.map((turn) => [turn.speakerId, turn.paragraphs.length])).toEqual([
      ["A", 2],
      ["B", 1],
      [undefined, 1],
      ["A", 1],
    ]);
    expect(turns[0]).toMatchObject({ startMs: 0, endMs: 3000 + PARAGRAPH_GAP_MS });
    expect("speakerId" in (turns[2] as object)).toBe(false);
    expect(turns.flatMap((turn) => turn.paragraphs)).toEqual(paragraphs);
  });

  it("takes the latest end of overlapping sentences as the end of the turn", () => {
    const [turn] = speakerTurns(readingParagraphs([sentence(0, 5000, "长。", "A"), sentence(1000, 2000, "短。", "A")]));
    expect(turn?.endMs).toBe(5000);
  });

  it("gives an empty list for no paragraphs", () => {
    expect(speakerTurns([])).toEqual([]);
  });
});

describe("speakerSections", () => {
  it("shows the same speaker again after a chapter start", () => {
    const sentences = [sentence(0, 1000, "a。", "A"), sentence(1100, 2000, "b。", "A"), sentence(3000, 4000, "c。", "A")];
    const sections = speakerSections(sentences, [{ startMs: 3000, title: "二" }]);
    expect(sections.map((section) => [section.chapter?.title, section.turns.map((turn) => turn.speakerId)])).toEqual([
      [undefined, ["A"]],
      ["二", ["A"]],
    ]);
  });
});

describe("speakerModeFor", () => {
  it("is on for two distinct speakers or one named speaker, off otherwise", () => {
    const speakers = [{ id: "A" }, { id: "B", name: "乙" }, { id: "C", name: "  " }];
    expect(speakerModeFor([{ speakerId: "A" }, { speakerId: "C" }], speakers)).toBe(true);
    expect(speakerModeFor([{ speakerId: "B" }, { speakerId: "B" }], speakers)).toBe(true);
    expect(speakerModeFor([{ speakerId: "A" }, { speakerId: "A" }, {}], speakers)).toBe(false);
    expect(speakerModeFor([{ speakerId: "C" }], speakers)).toBe(false);
    expect(speakerModeFor([{}, {}], speakers)).toBe(false);
    expect(speakerModeFor([], speakers)).toBe(false);
  });

  it("ignores a named speaker the revision does not reference", () => {
    expect(speakerModeFor([{ speakerId: "A" }], [{ id: "A" }, { id: "B", name: "乙" }])).toBe(false);
  });
});

describe("speakerShares", () => {
  it("counts sentences and shares assigned time per speaker in order of first appearance", () => {
    const shares = speakerShares([
      { startMs: 0, endMs: 1000, speakerId: "A" },
      { startMs: 1000, endMs: 4000, speakerId: "B" },
      { startMs: 4000, endMs: 5000 },
      { startMs: 5000, endMs: 6000, speakerId: "A" },
    ]);
    expect(shares).toEqual([
      { speakerId: "A", sentences: 2, durationMs: 2000, share: 0.4 },
      { speakerId: "B", sentences: 1, durationMs: 3000, share: 0.6 },
    ]);
  });

  it("is empty, with no division by zero, when nobody is assigned", () => {
    expect(speakerShares([{ startMs: 0, endMs: 10 }])).toEqual([]);
    expect(speakerShares([{ startMs: 5, endMs: 5, speakerId: "A" }])).toEqual([{ speakerId: "A", sentences: 1, durationMs: 0, share: 0 }]);
  });
});
