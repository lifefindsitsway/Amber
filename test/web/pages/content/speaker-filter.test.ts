import { describe, expect, it } from "vitest";
import { PARAGRAPH_GAP_MS } from "../../../../src/shared/defaults.ts";
import type { TranscriptSegmentDto } from "../../../../src/shared/dto/transcript.ts";
import { viewRowKey } from "../../../../src/web/pages/content/reader-rows.ts";
import {
  countTurns,
  filteredRowKey,
  filteredViewRows,
  matchesSpeakers,
  normalizeSelection,
  paramsWithSelection,
  rowIndexOfSegment,
  selectionFromParams,
  sentenceCounts,
  skippedParts,
  type FilteredRow,
} from "../../../../src/web/pages/content/speaker-filter.ts";
import { segment } from "../../../fixtures/web/content-data.ts";

const ROSTER = [
  { id: "sp2", ordinal: 2 },
  { id: "sp1", ordinal: 1 },
  { id: "sp3", ordinal: 3 },
];

const say = (id: string, index: number, startMs: number, endMs: number, speakerId: string | undefined): TranscriptSegmentDto =>
  segment(id, index, startMs, endMs, `第${index}句。`, speakerId === undefined ? {} : { speakerId });

/** sp1 · sp1 · sp2 · sp1 · (nobody) · sp1 (second chapter) · sp2. */
const TEXT = [
  say("a", 0, 0, 4_000, "sp1"),
  say("b", 1, 4_000, 8_000, "sp1"),
  say("c", 2, 8_000, 20_000, "sp2"),
  say("d", 3, 20_000, 24_000, "sp1"),
  say("e", 4, 24_000, 30_000, undefined),
  say("f", 5, 75_000, 80_000, "sp1"),
  say("g", 6, 80_000, 90_000, "sp2"),
];
const CHAPTERS = [
  { startMs: 0, title: "开场" },
  { startMs: 60_000, title: "正文" },
];

const describeRows = (rows: readonly FilteredRow[]): string[] =>
  rows.map((row) =>
    row.kind === "gap"
      ? `gap:${row.firstSkippedId}:${row.skippedMs}`
      : row.kind === "chapter"
        ? `chapter:${row.title}`
        : `${row.paragraph.segments.map((item) => item.id).join("")}${row.turn?.first === true ? "*" : ""}`,
  );

describe("selection in the address", () => {
  it("keeps known ids once each, in ordinal order, and drops unknown ones", () => {
    expect(normalizeSelection(["sp3", "nobody", "sp1", "sp3"], ROSTER)).toEqual(["sp1", "sp3"]);
    expect(selectionFromParams(new URLSearchParams("speaker=sp2&search=x&speaker=sp1&speaker=gone"), ROSTER)).toEqual(["sp1", "sp2"]);
  });

  it("writes repeated speaker parameters without touching search, revision or tab, and round-trips", () => {
    const before = new URLSearchParams("tab=transcript&revision=r1&search=%E9%87%8D%E6%8E%92&speaker=old");
    const next = paramsWithSelection(before, ["sp3", "sp1", "sp1", "ghost"], ROSTER);
    expect(next.getAll("speaker")).toEqual(["sp1", "sp3"]);
    expect(next.get("search")).toBe("重排");
    expect(next.get("revision")).toBe("r1");
    expect(next.get("tab")).toBe("transcript");
    expect(selectionFromParams(new URLSearchParams(next.toString()), ROSTER)).toEqual(["sp1", "sp3"]);
    expect(paramsWithSelection(next, [], ROSTER).has("speaker")).toBe(false);
    // The original is not changed.
    expect(before.getAll("speaker")).toEqual(["old"]);
  });
});

describe("filtering sentences", () => {
  it("lets every sentence through an empty selection and only the selected speakers' otherwise", () => {
    expect(matchesSpeakers({}, new Set())).toBe(true);
    expect(matchesSpeakers({ speakerId: "sp1" }, new Set(["sp1"]))).toBe(true);
    expect(matchesSpeakers({ speakerId: "sp2" }, new Set(["sp1"]))).toBe(false);
    expect(matchesSpeakers({}, new Set(["sp1"]))).toBe(false);
  });

  it("counts sentences per speaker, leaving unassigned ones out", () => {
    expect(Object.fromEntries(sentenceCounts(TEXT))).toEqual({ sp1: 4, sp2: 2 });
  });

  it("counts turns as runs of one speaker in the full text", () => {
    expect(countTurns(TEXT, new Set(["sp1"]))).toBe(3);
    expect(countTurns(TEXT, new Set(["sp2"]))).toBe(2);
    expect(countTurns(TEXT, new Set(["sp1", "sp2"]))).toBe(5);
    expect(countTurns(TEXT, new Set(["sp3"]))).toBe(0);
  });
});

describe("filteredViewRows", () => {
  const options = { turns: true, hasMarks: () => false };

  it("keeps the selected speaker's turns apart with a gap bar naming the skipped time and the first skipped sentence", () => {
    const view = filteredViewRows(TEXT, CHAPTERS, new Set(["sp1"]), options);
    expect(describeRows(view.rows)).toEqual(["chapter:开场", "ab*", "gap:c:12000", "d*", "gap:e:51000", "chapter:正文", "f*"]);
    expect(view.turns).toBe(3);
    expect(view.sentences).toBe(4);
  });

  it("shows several speakers together, with gaps only where something was skipped", () => {
    const view = filteredViewRows(TEXT, CHAPTERS, new Set(["sp1", "sp2"]), options);
    expect(describeRows(view.rows)).toEqual(["chapter:开场", "ab*", "c*", "d*", "gap:e:51000", "chapter:正文", "f*", "g*"]);
    expect(view.turns).toBe(5);
  });

  it("never merges one speaker's sentences across skipped text into a paragraph, even when paragraphs would", () => {
    const close = [say("x", 0, 0, 1_000, "sp1"), say("y", 1, 1_000, 2_000, "sp2"), say("z", 2, 2_000, 3_000, "sp1")];
    const view = filteredViewRows(close, [], new Set(["sp1"]), { turns: false, hasMarks: () => false });
    expect(describeRows(view.rows)).toEqual(["x", "gap:y:1000", "z"]);
  });

  it("reports a clamped skipped time when the sentences around a gap overlap", () => {
    const overlapping = [say("x", 0, 0, 5_000, "sp1"), say("y", 1, 3_000, 4_000, "sp2"), say("z", 2, 4_500, 6_000, "sp1")];
    expect(describeRows(filteredViewRows(overlapping, [], new Set(["sp1"]), options).rows)).toEqual(["x*", "gap:y:0", "z*"]);
  });

  it("splits a long run into paragraphs as the full text would", () => {
    const run = [say("p", 0, 0, 1_000, "sp1"), say("q", 1, 1_000 + PARAGRAPH_GAP_MS + 1, 2_000 + PARAGRAPH_GAP_MS, "sp1")];
    expect(describeRows(filteredViewRows(run, [], new Set(["sp1"]), options).rows)).toEqual(["p*", "q"]);
  });

  it("is empty for speakers without sentences in the revision", () => {
    const view = filteredViewRows(TEXT, CHAPTERS, new Set(["sp3"]), options);
    expect(view).toEqual({ rows: [], turns: 0, sentences: 0 });
  });

  it("finds the row of a sentence and keys gap rows apart from the rest", () => {
    const view = filteredViewRows(TEXT, CHAPTERS, new Set(["sp1"]), options);
    expect(rowIndexOfSegment(view.rows, "d")).toBe(3);
    expect(rowIndexOfSegment(view.rows, "c")).toBe(-1);
    const keys = view.rows.map((row) => filteredRowKey(row, viewRowKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("gap:c");
  });
});

describe("skippedParts", () => {
  it("splits a duration into the units it is read in", () => {
    expect(skippedParts(0)).toEqual({ unit: "seconds", seconds: 0 });
    expect(skippedParts(45_400)).toEqual({ unit: "seconds", seconds: 45 });
    expect(skippedParts(200_000)).toEqual({ unit: "minutes", minutes: 3, seconds: 20 });
    expect(skippedParts(3_725_000)).toEqual({ unit: "hours", hours: 1, minutes: 2 });
  });
});
