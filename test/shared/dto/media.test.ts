import { describe, expect, it } from "vitest";
import { burnRequestSchema, cacheMediaInspectRequestSchema, cacheMediaQualitiesDtoSchema, cacheMediaRequestSchema } from "../../../src/shared/dto/media.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";

const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };

describe("burnRequestSchema", () => {
  it("accepts the legacy body and the full styled body", () => {
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original" }).success).toBe(true);
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", delivery: "soft", container: "mkv", style }).success).toBe(true);
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", delivery: "hard", container: "mp4", style }).success).toBe(true);
  });

  it("refuses a partial set of delivery, container and style", () => {
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", delivery: "soft" }).success).toBe(false);
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", delivery: "soft", container: "mkv" }).success).toBe(false);
  });

  it("accepts sourceAssetId only with the styled fields", () => {
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", delivery: "hard", container: "mp4", style, sourceAssetId: "a1" }).success).toBe(true);
    const legacy = burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", sourceAssetId: "a1" });
    expect(legacy.success).toBe(false);
    expect(legacy.error?.issues.map((issue) => issue.path)).toContainEqual(["sourceAssetId"]);
  });

  it("refuses a hard-subtitle MKV", () => {
    expect(burnRequestSchema.safeParse({ revisionId: "r1", mode: "original", delivery: "hard", container: "mkv", style }).success).toBe(false);
  });
});

describe("cacheMediaInspectRequestSchema / cacheMediaRequestSchema", () => {
  it("take any quality tier as the height cap and refuse other heights", () => {
    for (const schema of [cacheMediaInspectRequestSchema, cacheMediaRequestSchema]) {
      for (const quality of [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320]) {
        expect(schema.safeParse({ quality }).success, String(quality)).toBe(true);
      }
      for (const quality of [700, 0, -1, 1200, "1440"]) {
        expect(schema.safeParse({ quality }).success, String(quality)).toBe(false);
      }
      expect(schema.safeParse({ type: "audio", quality: 1440 }).success).toBe(false);
    }
  });
});

describe("cacheMediaQualitiesDtoSchema", () => {
  it("holds only a status and the tiers with the picture size of their stream", () => {
    const qualities = [
      { tier: 360, width: 640, height: 206 },
      { tier: 720, width: 1280, height: 410 },
      { tier: 1440, width: 2560, height: 1440 },
    ];
    expect(cacheMediaQualitiesDtoSchema.parse({ status: "available", qualities })).toEqual({ status: "available", qualities });
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "audio_only", qualities: [] }).success).toBe(true);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "unknown", qualities: [] }).success).toBe(true);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "probing", qualities: [] }).success).toBe(false);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "available", qualities: [{ tier: 700, width: 1244, height: 700 }] }).success).toBe(false);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "available", qualities: [720] }).success).toBe(false);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "available", qualities: [{ tier: 720, width: 0, height: 720 }] }).success).toBe(false);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "available", qualities: [{ tier: 720, width: 1280.5, height: 720 }] }).success).toBe(false);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "available", qualities: [{ tier: 720, width: 1280, height: 720, formatId: "30064" }] }).success).toBe(false);
    expect(cacheMediaQualitiesDtoSchema.safeParse({ status: "available", qualities: [{ tier: 720, width: 1280, height: 720 }], formats: [] }).success).toBe(false);
  });
});
