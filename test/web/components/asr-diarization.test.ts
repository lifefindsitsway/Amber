import { describe, expect, it } from "vitest";
import type { AsrProfileDto } from "../../../src/shared/dto/asr-profile.ts";
import { diarizationNoteKey, diarizationOffer, parseSpeakerCount, speakerCountOutOfRange } from "../../../src/web/components/asr-diarization.ts";

const profile = (id: string, provider: AsrProfileDto["provider"], modelIds: string[]): AsrProfileDto => ({
  id,
  name: id,
  provider,
  models: modelIds.map((modelId) => ({ modelId, available: true })),
  credentialStatus: "configured",
  hasCredential: true,
  inUse: false,
  createdAt: 1,
});
const profiles = [profile("bl", "dashscope", ["fun-asr", "typed-in"]), profile("el", "elevenlabs", ["scribe_v2"])];
const ref = (asrProfileId: string, modelId: string) => ({ asrProfileId, modelId });

describe("diarizationOffer", () => {
  it("is available for a known model, with the provider's own count semantics", () => {
    const bailian = diarizationOffer(profiles, ref("bl", "fun-asr"), 600_000);
    expect(bailian.status === "available" && bailian.support.speakerCount).toEqual({ min: 2, max: 100, semantics: "reference" });
    const eleven = diarizationOffer(profiles, ref("el", "scribe_v2"), undefined);
    expect(eleven.status === "available" && eleven.support.speakerCount.semantics).toBe("maximum");
  });

  it("is unsupported for a typed-in model and for a profile that is gone", () => {
    expect(diarizationOffer(profiles, ref("bl", "typed-in"), 1_000).status).toBe("unsupported");
    expect(diarizationOffer(profiles, ref("gone", "fun-asr"), 1_000).status).toBe("unsupported");
  });

  it("needs a chosen model", () => {
    expect(diarizationOffer(profiles, undefined, 1_000).status).toBe("no_model");
  });

  it("is over the recommendation only past the documented length, and never for an unknown length", () => {
    expect(diarizationOffer(profiles, ref("bl", "fun-asr"), 7_200_000).status).toBe("available");
    expect(diarizationOffer(profiles, ref("bl", "fun-asr"), 7_200_001).status).toBe("over_recommended");
    expect(diarizationOffer(profiles, ref("bl", "fun-asr"), undefined).status).toBe("available");
    // ElevenLabs documents no length limit.
    expect(diarizationOffer(profiles, ref("el", "scribe_v2"), 99_999_999).status).toBe("available");
  });
});

describe("speaker count", () => {
  const support = { speakerCount: { min: 2, max: 100, semantics: "reference" as const } };

  it("reads empty as automatic and refuses anything but a whole number", () => {
    expect(parseSpeakerCount("")).toBeUndefined();
    expect(parseSpeakerCount("  ")).toBeUndefined();
    expect(parseSpeakerCount(" 12 ")).toBe(12);
    for (const text of ["1.5", "-3", "abc", "1e2", "12345"]) expect(parseSpeakerCount(text)).toBe("invalid");
  });

  it("refuses a count outside the range instead of clamping it", () => {
    expect(speakerCountOutOfRange(support, undefined)).toBe(false);
    expect(speakerCountOutOfRange(support, 2)).toBe(false);
    expect(speakerCountOutOfRange(support, 100)).toBe(false);
    expect(speakerCountOutOfRange(support, 1)).toBe(true);
    expect(speakerCountOutOfRange(support, 101)).toBe(true);
    expect(speakerCountOutOfRange(support, "invalid")).toBe(true);
  });
});

describe("diarizationNoteKey", () => {
  const offer = diarizationOffer(profiles, ref("bl", "fun-asr"), undefined);
  it("says nothing while the setting is off or no model is chosen", () => {
    expect(diarizationNoteKey(false, offer)).toBeUndefined();
    expect(diarizationNoteKey(true, { status: "no_model" })).toBeUndefined();
  });
  it("says what the setting will do", () => {
    expect(diarizationNoteKey(true, offer)).toBe("willIdentify");
    expect(diarizationNoteKey(true, { status: "unsupported" })).toBe("unsupported");
    expect(diarizationNoteKey(true, { ...offer, status: "over_recommended" } as never)).toBe("overRecommended");
  });
});
