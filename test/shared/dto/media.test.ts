import { describe, expect, it } from "vitest";
import { burnRequestSchema } from "../../../src/shared/dto/media.ts";
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
