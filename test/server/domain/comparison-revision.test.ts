import { describe, expect, it } from "vitest";
import { comparisonSpeakerRoom, isComparisonRevision, isPermanentRevision, isRecyclableSpeaker } from "../../../src/server/domain/comparison-revision.ts";
import type { TranscriptRevision } from "../../../src/server/domain/transcript.ts";
import { SPEAKER_COMPARISON_ROOM_FACTOR, SPEAKERS_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";

const asr = (purpose?: "comparison"): Pick<TranscriptRevision, "kind" | "generation"> => ({
  kind: "asr",
  generation: { kind: "asr", asrProfileId: "p", modelId: "m", ...(purpose === undefined ? {} : { purpose }) },
});

describe("comparison revisions", () => {
  it("are recognized by the mark in their generation alone", () => {
    expect(isComparisonRevision(asr("comparison"))).toBe(true);
    expect(isComparisonRevision(asr())).toBe(false);
    expect(isComparisonRevision({ generation: { kind: "manual" } })).toBe(false);
  });

  it("are the one kind of ASR original a user may delete", () => {
    expect(isPermanentRevision(asr())).toBe(true);
    expect(isPermanentRevision({ kind: "platform", generation: { kind: "platform", acquisition: "guest" } })).toBe(true);
    expect(isPermanentRevision(asr("comparison"))).toBe(false);
    expect(isPermanentRevision({ kind: "manual", generation: { kind: "manual" } })).toBe(false);
  });
});

describe("comparisonSpeakerRoom", () => {
  it("needs the factor times the primary's speakers within what is left under the maximum", () => {
    expect(comparisonSpeakerRoom(SPEAKERS_PER_CONTENT_MAX - 6, 3)).toEqual({ room: 6, required: 3 * SPEAKER_COMPARISON_ROOM_FACTOR, enough: true });
    expect(comparisonSpeakerRoom(SPEAKERS_PER_CONTENT_MAX - 5, 3)).toEqual({ room: 5, required: 3 * SPEAKER_COMPARISON_ROOM_FACTOR, enough: false });
    expect(comparisonSpeakerRoom(SPEAKERS_PER_CONTENT_MAX + 1, 0)).toEqual({ room: 0, required: 0, enough: true });
  });
});

describe("isRecyclableSpeaker", () => {
  it("reclaims only a speaker without a name and without a photo", () => {
    expect(isRecyclableSpeaker({})).toBe(true);
    expect(isRecyclableSpeaker({ name: "王老师" })).toBe(false);
    expect(isRecyclableSpeaker({ avatar: { mime: "image/png", version: 1 } })).toBe(false);
  });
});
