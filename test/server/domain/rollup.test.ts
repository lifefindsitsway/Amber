import { describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { ArtifactInputRef } from "../../../src/server/domain/artifact.ts";
import { assertFits, carryAllowance, partialItemRange, planSummary, transcriptBudget, type PlannedSentence } from "../../../src/server/domain/rollup.ts";
import { SPEAKER_RULES_FRAGMENT } from "../../../src/server/domain/prompts.ts";
import { attributionDigest, speakerFraming } from "../../../src/server/domain/speaker-context.ts";
import { estimateTokens } from "../../../src/server/domain/token-estimate.ts";
import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT, ROLLUP_CARRY_BUDGET_CHARS, SPEAKER_NAME_MAX_GRAPHEMES } from "../../../src/shared/defaults.ts";

const modelRef = { providerProfileId: "p", modelId: "m" };

/** `count` sentences of `chars` CJK characters each, one second apart. */
function sentences(count: number, chars = 10): PlannedSentence[] {
  return Array.from({ length: count }, (_, i) => ({ line: `[[s${i + 1}]] ${"字".repeat(chars)}`, startMs: i * 1000 }));
}

/** A window whose input room is exactly `room` tokens with a 10-token output reservation. */
function limitsFor(room: number) {
  return { contextWindowTokens: Math.ceil((room + 10) / CONTEXT_SAFETY_RATIO), maxOutputTokens: 10 };
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

describe("budgets", () => {
  it("is the window times CONTEXT_SAFETY_RATIO minus the fixed part and the output reservation", () => {
    expect(transcriptBudget({ contextWindowTokens: 10_000, maxOutputTokens: 500 }, "固定")).toBe(Math.floor(10_000 * CONTEXT_SAFETY_RATIO) - 500 - estimateTokens("固定"));
    expect(transcriptBudget({ contextWindowTokens: 100_000 }, "")).toBe(Math.floor(100_000 * CONTEXT_SAFETY_RATIO) - LLM_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(transcriptBudget({}, "")).toBeUndefined();
    expect([...carryAllowance()]).toHaveLength(ROLLUP_CARRY_BUDGET_CHARS);
  });

  it("assertFits rejects a prompt over the room with context_length and checks nothing for an unknown window", () => {
    const limits = limitsFor(estimateTokens("字".repeat(50)));
    expect(codeOf(() => assertFits(limits, "字".repeat(50)))).toBeUndefined();
    expect(codeOf(() => assertFits(limits, "字".repeat(80)))).toBe("llm_capability.context_length");
    expect(codeOf(() => assertFits({}, "字".repeat(100_000)))).toBeUndefined();
  });
});

describe("planSummary", () => {
  const cost = estimateTokens(`${sentences(1)[0]?.line}\n`);

  it("summarizes in one call when the whole transcript fits", () => {
    expect(planSummary({ sentences: sentences(5), singleFixed: "", partialFixed: "", limits: limitsFor(cost * 5), modelRef })).toEqual({ mode: "single" });
  });

  it("rolls greedily by sentence without chapters", () => {
    const plan = planSummary({ sentences: sentences(7), singleFixed: "", partialFixed: "", limits: limitsFor(cost * 3), modelRef });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: false,
      groups: [
        { first: 0, count: 3 },
        { first: 3, count: 3 },
        { first: 6, count: 1 },
      ],
    });
  });

  it("rolls by chapter, sentences before the first chapter going to it, splitting a long chapter evenly without crossing chapters", () => {
    // Chapters start at 2 s, 4 s and 9 s: sentences 0..3 (the first two precede it) go to the
    // first, 4..8 to the second (over budget, so two even runs), 9 to the third.
    const plan = planSummary({ sentences: sentences(10), chapterStarts: [2000, 4000, 9000], singleFixed: "", partialFixed: "", limits: limitsFor(cost * 4), modelRef });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 4, chapterIndex: 0 },
        { first: 4, count: 3, chapterIndex: 1 },
        { first: 7, count: 2, chapterIndex: 1 },
        { first: 9, count: 1, chapterIndex: 2 },
      ],
    });
  });

  it("with an unknown window rolls by chapter without checks, and without chapters fails with context_window_unknown", () => {
    const plan = planSummary({ sentences: sentences(4, 5000), chapterStarts: [0, 2000], singleFixed: "", partialFixed: "", limits: {}, modelRef });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 2, chapterIndex: 0 },
        { first: 2, count: 2, chapterIndex: 1 },
      ],
    });
    let details: unknown;
    try {
      planSummary({ sentences: sentences(4), singleFixed: "", partialFixed: "", limits: {}, modelRef });
    } catch (error) {
      details = isAmberError(error) ? [error.appError.code, error.appError.details] : error;
    }
    expect(details).toEqual(["llm_capability.context_window_unknown", { providerProfileId: "p", modelId: "m" }]);
  });

  it("fails with context_length when no budget is left or one sentence alone is over it", () => {
    expect(codeOf(() => planSummary({ sentences: sentences(3), singleFixed: "字".repeat(500), partialFixed: "", limits: limitsFor(100), modelRef }))).toBe(
      "llm_capability.context_length",
    );
    expect(codeOf(() => planSummary({ sentences: [...sentences(3), { line: "字".repeat(400), startMs: 9000 }], singleFixed: "", partialFixed: "", limits: limitsFor(cost * 3), modelRef }))).toBe(
      "llm_capability.context_length",
    );
    expect(codeOf(() => planSummary({ sentences: sentences(20), singleFixed: "", partialFixed: "字".repeat(200), limits: limitsFor(cost * 3), modelRef }))).toBe(
      "llm_capability.context_length",
    );
  });
});

describe("planSummary with position-priced sentences", () => {
  const line = estimateTokens(`${sentences(1)[0]?.line}\n`);
  const HEADER = 3;
  /** One speaker throughout: a header is paid only where a block opens. */
  const opening = (sentenceLine: string, _position: number, blockStart: boolean) => estimateTokens(`${sentenceLine}\n`) + (blockStart ? HEADER : 0);

  it("counts the single call's one header in its total", () => {
    const fits = { sentences: sentences(5), singleFixed: "", partialFixed: "", limits: limitsFor(line * 5 + HEADER), modelRef, cost: opening };
    expect(planSummary(fits)).toEqual({ mode: "single" });
    expect(planSummary({ ...fits, limits: limitsFor(line * 5 + HEADER - 1) }).mode).toBe("rolling");
  });

  it("charges each group's first sentence its header, so groups hold fewer lines than unpriced ones", () => {
    const limits = limitsFor(line * 3);
    expect(planSummary({ sentences: sentences(7), singleFixed: "", partialFixed: "", limits, modelRef }).mode).toBe("rolling");
    expect(planSummary({ sentences: sentences(7), singleFixed: "", partialFixed: "", limits, modelRef, cost: opening })).toEqual({
      mode: "rolling",
      byChapters: false,
      groups: [
        { first: 0, count: 2 },
        { first: 2, count: 2 },
        { first: 4, count: 2 },
        { first: 6, count: 1 },
      ],
    });
  });

  it("splits a chapter into runs that each fit with their opening header", () => {
    const plan = planSummary({ sentences: sentences(6), chapterStarts: [0], singleFixed: "", partialFixed: "", limits: limitsFor(line * 3), modelRef, cost: opening });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 2, chapterIndex: 0 },
        { first: 2, count: 2, chapterIndex: 0 },
        { first: 4, count: 2, chapterIndex: 0 },
      ],
    });
  });

  it("keeps every request as sent within the budget for any attribution pattern (alternating, longest names, very short sentences)", () => {
    const labels = ["名".repeat(SPEAKER_NAME_MAX_GRAPHEMES), "Ｎ".repeat(SPEAKER_NAME_MAX_GRAPHEMES), "发言人 3"];
    let state = 7;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    for (let round = 0; round < 40; round += 1) {
      const count = 30 + Math.floor(next() * 120);
      const planned = Array.from({ length: count }, (_, i) => ({
        line: `[[s${i + 1}]] ${"字".repeat(1 + Math.floor(next() * (next() < 0.5 ? 3 : 40)))}`,
        startMs: i * 1000,
      }));
      const ids = planned.map((_, i) => (round % 3 === 0 ? i % 2 : round % 3 === 1 ? (next() < 0.15 ? undefined : Math.floor(next() * 3)) : Math.floor(i / 4) % 3));
      const segments = ids.map((speaker, i) => ({ id: `seg${i}`, ...(speaker === undefined ? {} : { speakerId: `spk${speaker}` }) }));
      const framing = speakerFraming(
        {
          version: 1,
          rules: SPEAKER_RULES_FRAGMENT.ref,
          attributionDigest: attributionDigest(segments),
          speakers: labels.map((label, index) => ({ id: `spk${index}`, ordinal: index + 1, label })),
        },
        SPEAKER_RULES_FRAGMENT,
        segments,
      );
      const fixed = `固定部分。${framing.slotValue("")}`;
      const limits = limitsFor(estimateTokens(fixed) + 150 + Math.floor(next() * 600));
      const plan = planSummary({ sentences: planned, singleFixed: fixed, partialFixed: fixed, limits, modelRef, cost: framing.cost });
      const groups = plan.mode === "single" ? [{ first: 0, count }] : plan.groups;
      for (const group of groups) {
        const lines = planned.slice(group.first, group.first + group.count).map((sentence) => sentence.line);
        const sent = `固定部分。${framing.slotValue(framing.block(lines, group.first).join("\n"))}`;
        expect(codeOf(() => assertFits(limits, sent))).toBeUndefined();
      }
    }
  });

  it("prices a chapter's heading with the first sentence of each of its groups, so a chapter it would overflow is split", () => {
    const heading = "【章节】短\n";
    expect(estimateTokens(heading)).toBeGreaterThan(0);
    expect(estimateTokens(heading)).toBeLessThanOrEqual(line);
    const input = { sentences: sentences(6), chapterStarts: [0, 3000], singleFixed: "", partialFixed: "", limits: limitsFor(line * 3), modelRef };
    expect(planSummary(input)).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 3, chapterIndex: 0 },
        { first: 3, count: 3, chapterIndex: 1 },
      ],
    });
    expect(planSummary({ ...input, chapterHeadings: [heading, ""] })).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 2, chapterIndex: 0 },
        { first: 2, count: 1, chapterIndex: 0 },
        { first: 3, count: 3, chapterIndex: 1 },
      ],
    });
    // Priced the same way with speakers: the heading adds to the opening sentence's header.
    expect(planSummary({ ...input, chapterHeadings: [heading, heading], cost: opening, limits: limitsFor(line * 2 + HEADER + estimateTokens(heading)) })).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 2, chapterIndex: 0 },
        { first: 2, count: 1, chapterIndex: 0 },
        { first: 3, count: 2, chapterIndex: 1 },
        { first: 5, count: 1, chapterIndex: 1 },
      ],
    });
  });

  it("fails with context_length when a chapter's heading and one sentence are over the budget", () => {
    const heading = `【章节】${"长".repeat(200)}\n`;
    expect(
      codeOf(() => planSummary({ sentences: sentences(6), chapterStarts: [0], chapterHeadings: [heading], singleFixed: "", partialFixed: "", limits: limitsFor(line * 5), modelRef })),
    ).toBe("llm_capability.context_length");
  });

  it("fails with context_length when one sentence with its header is over the budget", () => {
    expect(codeOf(() => planSummary({ sentences: sentences(3), singleFixed: "", partialFixed: "", limits: limitsFor(line + HEADER - 1), modelRef, cost: opening }))).toBe(
      "llm_capability.context_length",
    );
  });
});

describe("partialItemRange", () => {
  /** Members `m1…m<n>` at the given positions, in that order. */
  function items(positions: readonly number[]) {
    return positions.map((position, index) => ({ collectionItemId: `m${index + 1}`, contentId: `c${index + 1}`, position }));
  }

  function snapshots(ids: readonly string[]): ArtifactInputRef[] {
    return ids.map((collectionItemId) => ({ kind: "collectionItemSnapshot", collectionItemId, contentId: `c-${collectionItemId}`, position: 0 }));
  }

  it("numbers twelve members in groups of five as 1–5, 6–10 and 11–12", () => {
    const members = items(Array.from({ length: 12 }, (_, index) => index));
    const ids = members.map((member) => member.collectionItemId);
    expect([ids.slice(0, 5), ids.slice(5, 10), ids.slice(10)].map((group) => partialItemRange(members, snapshots(group)))).toEqual([
      { first: 1, last: 5 },
      { first: 6, last: 10 },
      { first: 11, last: 12 },
    ]);
  });

  it("numbers by ascending position without gaps, whatever order the snapshot lists them in", () => {
    const members = items([0, 1, 4, 7, 9]);
    expect(partialItemRange(members, snapshots(["m3", "m4", "m5"]))).toEqual({ first: 3, last: 5 });
    const shuffled = [members[4], members[0], members[3], members[1], members[2]] as typeof members;
    expect(partialItemRange(shuffled, snapshots(["m4", "m3"]))).toEqual({ first: 3, last: 4 });
  });

  it("reads numbers only from the snapshot it is given, not from any later order", () => {
    const snapshot = items([0, 1, 2]);
    // The same members after the live collection moved m3 to the front.
    const reordered = snapshot.map((member) => ({ ...member, position: member.collectionItemId === "m3" ? -1 : member.position }));
    expect(partialItemRange(snapshot, snapshots(["m1", "m2"]))).toEqual({ first: 1, last: 2 });
    expect(partialItemRange(reordered, snapshots(["m1", "m2"]))).toEqual({ first: 2, last: 3 });
  });

  it("has no range unless the inputs are distinct member snapshots of one consecutive run", () => {
    const members = items([0, 1, 2, 3]);
    expect(partialItemRange(members, [])).toBeUndefined();
    expect(partialItemRange(members, [...snapshots(["m1"]), { kind: "summaryRevision", id: "s1" }])).toBeUndefined();
    expect(partialItemRange(members, snapshots(["m1", "gone"]))).toBeUndefined();
    expect(partialItemRange(members, snapshots(["m1", "m2", "m2"]))).toBeUndefined();
    expect(partialItemRange(members, snapshots(["m1", "m3"]))).toBeUndefined();
  });
});
