import { describe, expect, it } from "vitest";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import {
  burnTaskRequestSchema,
  cacheMediaTaskRequestSchema,
  intentDifferences,
  parseStageInput,
  processContentRequestSchema,
  regenerateSummaryRequestSchema,
  sameIntent,
  taskRequestView,
} from "../../../src/server/domain/task-request.ts";

describe("task requests", () => {
  it("validates the process_content v1 request strictly", () => {
    const valid = { requestSchemaVersion: 1, kind: "process_content", autoProofread: true };
    expect(processContentRequestSchema.safeParse(valid).success).toBe(true);
    expect(processContentRequestSchema.safeParse({ ...valid, requestSchemaVersion: 2 }).success).toBe(false);
    expect(processContentRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("exposes the fields the pipeline interprets and ignores the rest", () => {
    const modelRef = { providerProfileId: "p", modelId: "m" };
    expect(taskRequestView(JSON.stringify({ modelRef, autoProofread: false, baseRevisionId: "r" }))).toEqual({ modelRef, autoProofread: false });
    expect(() => taskRequestView(JSON.stringify({ modelRef: { providerProfileId: "p" } }))).toThrow();
  });

  it("compares intent by canonical request, not by key order", () => {
    const a = '{"autoProofread":true,"kind":"process_content"}';
    const b = '{"kind":"process_content","autoProofread":true}';
    expect(sameIntent("process_content", a, { kind: "process_content", requestJson: b })).toBe(true);
    expect(sameIntent("process_content", a, { kind: "reproofread", requestJson: b })).toBe(false);
  });

  it("records an initial subtitle without making it part of the intent", () => {
    const base = { requestSchemaVersion: 1, kind: "process_content", autoProofread: true };
    expect(processContentRequestSchema.safeParse({ ...base, initialSubtitleRevisionId: "r1" }).success).toBe(true);
    const withSubtitle = JSON.stringify({ ...base, initialSubtitleRevisionId: "r1" });
    expect(sameIntent("process_content", withSubtitle, { kind: "process_content", requestJson: JSON.stringify(base) })).toBe(true);
    expect(sameIntent("process_content", withSubtitle, { kind: "process_content", requestJson: JSON.stringify({ ...base, autoProofread: false }) })).toBe(false);
  });

  it("parses frozen stage input and rejects anything but a modelRef", () => {
    expect(parseStageInput(undefined)).toEqual({});
    expect(parseStageInput('{"modelRef":{"providerProfileId":"p","modelId":"m"}}')).toEqual({ modelRef: { providerProfileId: "p", modelId: "m" } });
    expect(() => parseStageInput('{"templateRef":{}}')).toThrow();
  });

  it("freezes a regenerate_summary request on its base revision", () => {
    const base = { requestSchemaVersion: 1, kind: "regenerate_summary", baseRevisionId: "rev" };
    expect(regenerateSummaryRequestSchema.safeParse(base).success).toBe(true);
    expect(regenerateSummaryRequestSchema.safeParse({ ...base, modelRef: { providerProfileId: "p", modelId: "m" }, outputLanguage: "en" }).success).toBe(true);
    expect(regenerateSummaryRequestSchema.safeParse({ requestSchemaVersion: 1, kind: "regenerate_summary" }).success).toBe(false);
    expect(regenerateSummaryRequestSchema.safeParse({ ...base, autoProofread: true }).success).toBe(false);
    expect(regenerateSummaryRequestSchema.safeParse({ ...base, outputLanguage: "" }).success).toBe(false);
  });

  it("lists the intent fields that differ, sorted, without source-only and ignored fields", () => {
    const a = JSON.stringify({ requestSchemaVersion: 1, kind: "process_content", autoProofread: true, outputLanguage: "en", initialSubtitleRevisionId: "r1" });
    const b = JSON.stringify({ requestSchemaVersion: 1, kind: "process_content", autoProofread: false, modelRef: { providerProfileId: "p", modelId: "m" } });
    expect(intentDifferences(a, b)).toEqual(["autoProofread", "modelRef", "outputLanguage"]);
    expect(intentDifferences(a, b, ["autoProofread"])).toEqual(["modelRef", "outputLanguage"]);
    expect(intentDifferences(a, a)).toEqual([]);
    // Key order and a present-versus-absent initial subtitle make no difference.
    const reordered = JSON.stringify({ outputLanguage: "en", autoProofread: true, kind: "process_content", requestSchemaVersion: 1 });
    expect(intentDifferences(a, reordered)).toEqual([]);
  });
});

describe("burn task request schema versions", () => {
  const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };
  const v1 = { requestSchemaVersion: 1, kind: "burn", mode: "original", revisionId: "r1" };
  const v2 = { ...v1, requestSchemaVersion: 2, source: { assetId: "a1", fingerprint: "sha256:x" }, delivery: "soft", container: "mkv", style };

  it("parses the legacy v1 request and the frozen v2 export", () => {
    expect(burnTaskRequestSchema.parse(v1)).toEqual(v1);
    expect(burnTaskRequestSchema.parse(v2)).toEqual(v2);
  });

  it("allows a v2 source without a fingerprint and refuses v2 without its frozen fields", () => {
    expect(burnTaskRequestSchema.safeParse({ ...v2, source: { assetId: "a1" } }).success).toBe(true);
    const { style: _style, ...withoutStyle } = v2;
    expect(burnTaskRequestSchema.safeParse(withoutStyle).success).toBe(false);
    expect(burnTaskRequestSchema.safeParse({ ...v1, delivery: "hard" }).success).toBe(false);
  });
});

describe("cacheMediaTaskRequestSchema", () => {
  it("parses every schema version and checks the v3 fields", () => {
    const v3 = { requestSchemaVersion: 3, kind: "cache_media", type: "video", quality: 720, stem: "课", expectedHeight: 720, assetId: "a", overwrite: { assetId: "b", fileName: "课 [720P].mp4" } };
    expect(cacheMediaTaskRequestSchema.parse(v3)).toEqual(v3);
    expect(cacheMediaTaskRequestSchema.parse({ requestSchemaVersion: 2, kind: "cache_media", type: "audio", fileName: "x", assetId: "a" }).requestSchemaVersion).toBe(2);
    expect(cacheMediaTaskRequestSchema.parse({ requestSchemaVersion: 1, kind: "cache_media", quality: 480 }).requestSchemaVersion).toBe(1);
    expect(cacheMediaTaskRequestSchema.safeParse({ ...v3, stem: "" }).success).toBe(false);
    expect(cacheMediaTaskRequestSchema.safeParse({ ...v3, fileName: "x" }).success).toBe(false);
    expect(cacheMediaTaskRequestSchema.safeParse({ ...v3, expectedHeight: 0 }).success).toBe(false);
  });
});

