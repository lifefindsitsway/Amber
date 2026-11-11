import { describe, expect, it } from "vitest";
import { decideDiarization, persistedDecision, speakerCountInRange } from "../../../src/server/domain/asr-diarization.ts";
import type { AsrDiarizationSupport } from "../../../src/shared/asr-presets.ts";

const REFERENCE: AsrDiarizationSupport = { speakerCount: { min: 2, max: 100, semantics: "reference" }, recommendedMaxDurationSec: 7200 };
const MAXIMUM: AsrDiarizationSupport = { speakerCount: { min: 1, max: 32, semantics: "maximum" } };

describe("decideDiarization", () => {
  it("is off without a request, or for the off mode, whatever the model offers", () => {
    expect(decideDiarization(undefined, REFERENCE, 1000)).toEqual({ effective: false, status: "off" });
    expect(decideDiarization({ mode: "off" }, REFERENCE, 1000)).toEqual({ effective: false, status: "off" });
    expect(decideDiarization({ mode: "off", speakerCount: 3 }, undefined, 1000)).toEqual({ effective: false, status: "off" });
  });

  it("is unsupported when the model does not offer it, for preferred and required alike", () => {
    for (const mode of ["preferred", "required"] as const) {
      expect(decideDiarization({ mode }, undefined, 1000)).toEqual({ effective: false, status: "unsupported", reason: "unsupported" });
    }
  });

  it("is effective for a supported model within the recommended duration, with the count when given", () => {
    expect(decideDiarization({ mode: "preferred" }, REFERENCE, 7_200_000)).toEqual({ effective: true });
    expect(decideDiarization({ mode: "required", speakerCount: 5 }, REFERENCE, 1000)).toEqual({ effective: true, speakerCount: 5 });
  });

  it("is over_recommended past the model's recommended duration, but never for a model that declares none", () => {
    expect(decideDiarization({ mode: "preferred" }, REFERENCE, 7_200_001)).toEqual({ effective: false, status: "over_recommended", reason: "over_recommended" });
    expect(decideDiarization({ mode: "preferred" }, MAXIMUM, 40 * 3_600_000)).toEqual({ effective: true });
  });

  it("refuses a speaker count outside the model's range at both ends instead of clamping it", () => {
    for (const [support, speakerCount] of [[REFERENCE, 1], [REFERENCE, 101], [MAXIMUM, 0], [MAXIMUM, 33]] as const) {
      expect(decideDiarization({ mode: "preferred", speakerCount }, support, 1000)).toEqual({ effective: false, status: "unsupported", reason: "speaker_count" });
    }
    expect(decideDiarization({ mode: "required", speakerCount: 2 }, REFERENCE, 1000).effective).toBe(true);
    expect(decideDiarization({ mode: "required", speakerCount: 100 }, REFERENCE, 1000).effective).toBe(true);
  });

  it("does not judge the duration when it is not known", () => {
    expect(decideDiarization({ mode: "required" }, REFERENCE, undefined)).toEqual({ effective: true });
  });
});

describe("speakerCountInRange and persistedDecision", () => {
  it("checks both ends inclusively", () => {
    expect(speakerCountInRange(REFERENCE, 2)).toBe(true);
    expect(speakerCountInRange(REFERENCE, 100)).toBe(true);
    expect(speakerCountInRange(REFERENCE, 1)).toBe(false);
  });

  it("persists only what the revision records", () => {
    expect(persistedDecision({ effective: false, status: "unsupported", reason: "speaker_count" })).toEqual({ effective: false, status: "unsupported" });
    expect(persistedDecision({ effective: true, speakerCount: 4 })).toEqual({ effective: true, speakerCount: 4 });
    expect(persistedDecision({ effective: true })).toEqual({ effective: true });
  });
});
