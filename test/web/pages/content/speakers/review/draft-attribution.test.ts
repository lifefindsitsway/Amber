import { describe, expect, it } from "vitest";
import { countAttributionChanges } from "../../../../../../src/server/domain/speaker-lineage.ts";
import type { SpeakerReviewResolution } from "../../../../../../src/shared/speakers.ts";
import { committedSpeaker, draftAttribution, type BaseSentence } from "../../../../../../src/web/pages/content/speakers/review/draft-attribution.ts";
import type { DraftSegment } from "../../../../../../src/web/pages/content/speaker-draft.ts";

const BASE: BaseSentence[] = [
  { id: "b1", speakerId: "a" },
  { id: "b2", speakerId: "a" },
  { id: "b3", speakerId: "b" },
  { id: "b4" },
];

const sentence = (sources: string[], speakerId?: string | null, review?: "needs_review"): DraftSegment => ({
  startMs: 0,
  endMs: 1,
  text: "x",
  sourceSegmentIds: sources,
  ...(speakerId === undefined ? {} : { speakerId }),
  ...(review === undefined ? {} : { speakerReview: review }),
});

/** What the server counts for the same commit: the committed speakers against the base. */
function serverCount(draft: readonly DraftSegment[], resolution: SpeakerReviewResolution): number {
  const byId = new Map(BASE.map((item) => [item.id, item]));
  return countAttributionChanges(
    BASE.map((item) => ({ id: item.id, sourceSegmentIds: [], ...(item.speakerId === undefined ? {} : { speakerId: item.speakerId }) })),
    draft.map((segment, index) => {
      const speakerId = committedSpeaker(segment, byId, resolution);
      return { id: `n${index}`, sourceSegmentIds: segment.sourceSegmentIds, ...(speakerId === undefined ? {} : { speakerId }) };
    }),
  );
}

const CASES: Array<[string, DraftSegment[], number, number]> = [
  ["unchanged, with a sentence deleted", [sentence(["b1"], "a"), sentence(["b2"], "a"), sentence(["b3"], "b")], 0, 0],
  ["one sentence reassigned", [sentence(["b1"], "a"), sentence(["b2"], "b"), sentence(["b3"], "b"), sentence(["b4"], null)], 1, 1],
  ["a sentence assigned that had nobody", [sentence(["b1"], "a"), sentence(["b2"], "a"), sentence(["b3"], "b"), sentence(["b4"], "a")], 1, 1],
  ["split with both halves the same speaker", [sentence(["b1"], "a"), sentence(["b1"], "a"), sentence(["b2"], "a")], 0, 0],
  ["split with one half given to someone else", [sentence(["b1"], "a"), sentence(["b1"], "b")], 1, 1],
  ["merged across speakers", [sentence(["b2", "b3"], "a")], 1, 1],
  ["a new sentence naming a speaker", [sentence(["b1"], "a"), sentence([], "b")], 1, 1],
  ["a new sentence naming nobody", [sentence(["b1"], "a"), sentence([], null)], 0, 0],
  ["an old draft sentence without a stated speaker inherits its source's", [sentence(["b1"]), sentence(["b3"])], 0, 0],
  ["a suggestion still to confirm", [sentence(["b1"], "a"), sentence(["b3"], "a", "needs_review")], 1, 1],
  ["a suggestion still to confirm that matches the base", [sentence(["b1"], "a", "needs_review")], 1, 0],
];

describe("draftAttribution", () => {
  it.each(CASES)("counts %s the way the server does", (_name, draft, unassign, accept) => {
    expect(draftAttribution(BASE, draft, "unassign").changed).toBe(unassign);
    expect(draftAttribution(BASE, draft, "accept_suggestions").changed).toBe(accept);
    expect(unassign).toBe(serverCount(draft, "unassign"));
    expect(accept).toBe(serverCount(draft, "accept_suggestions"));
  });

  it("says whether the commit names any speaker", () => {
    expect(draftAttribution(BASE, [sentence(["b4"], null)], "unassign").namesSpeakers).toBe(false);
    expect(draftAttribution(BASE, [sentence(["b1"], "a", "needs_review")], "unassign").namesSpeakers).toBe(false);
    expect(draftAttribution(BASE, [sentence(["b1"], "a", "needs_review")], "accept_suggestions").namesSpeakers).toBe(true);
  });
});
