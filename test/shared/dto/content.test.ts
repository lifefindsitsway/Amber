import { describe, expect, it } from "vitest";
import {
  contentDetailDtoSchema,
  contentDtoSchema,
  contentListDtoSchema,
  mediaAssetDtoSchema,
  primaryTranscriptRequestSchema,
  subtitleImportRequestSchema,
  subtitleImportResponseSchema,
  transcriptRevisionListDtoSchema,
} from "../../../src/shared/dto/content.ts";

const content = {
  id: "c1",
  source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD", platformContentId: "BV1xx411c7mD", platformPartId: "1" },
  processingStatus: "queued",
  collections: [{ id: "k1", name: "course", itemId: "ki1" }],
  createdAt: 1,
  updatedAt: 2,
};

const asset = {
  id: "a1",
  kind: "managed_upload",
  mimeType: "video/mp4",
  sizeBytes: 10,
  availability: "available",
  retentionPolicy: "keep",
  createdAt: 1,
};

describe("content DTOs", () => {
  it("accept platform and local sources and reject unknown source kinds and statuses", () => {
    expect(contentDtoSchema.safeParse(content).success).toBe(true);
    expect(contentDtoSchema.safeParse({ ...content, source: { kind: "local" } }).success).toBe(true);
    expect(contentDtoSchema.safeParse({ ...content, source: { kind: "vimeo" } }).success).toBe(false);
    expect(contentDtoSchema.safeParse({ ...content, processingStatus: "done" }).success).toBe(false);
    // Membership is always present, possibly empty.
    expect(contentDtoSchema.safeParse({ ...content, collections: [] }).success).toBe(true);
    const { collections: _collections, ...withoutCollections } = content;
    expect(contentDtoSchema.safeParse(withoutCollections).success).toBe(false);
    expect(contentListDtoSchema.parse({ items: [content], total: 1, nextCursor: "x" }).items).toHaveLength(1);
    expect(contentListDtoSchema.safeParse({ items: [content] }).success).toBe(false);
    expect(contentDtoSchema.parse({ ...content, customTitle: "我的标题", pinnedAt: 1 })).toMatchObject({ customTitle: "我的标题", pinnedAt: 1 });
  });

  it("never carry a media asset's storage reference or fingerprint", () => {
    expect(Object.keys(mediaAssetDtoSchema.shape)).not.toContain("storageRef");
    expect(Object.keys(mediaAssetDtoSchema.shape)).not.toContain("fingerprint");
    const parsed = mediaAssetDtoSchema.parse({ ...asset, storageRef: "assets/u/c/a1", fingerprint: "sha256:00" });
    expect(parsed).toEqual(asset);
    expect(contentDetailDtoSchema.parse({ ...content, media: [asset] }).media).toEqual([asset]);
  });

  it("list revisions with an optional primary", () => {
    const revision = { id: "r1", contentId: "c1", kind: "platform", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "platform" }, segmentCount: 3, createdAt: 1 };
    const item = {
      ...revision,
      archived: false,
      deletable: true,
      blockers: { children: 0, draft: 0, notes: 0, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0 },
      descendantIds: [],
    };
    expect(transcriptRevisionListDtoSchema.safeParse({ revisions: [item] }).success).toBe(true);
    // A list item carries its archive mark and blockers; a bare revision is not one.
    expect(transcriptRevisionListDtoSchema.safeParse({ revisions: [revision] }).success).toBe(false);
    expect(transcriptRevisionListDtoSchema.safeParse({ primaryTranscriptRevisionId: "r1", revisions: [{ ...item, kind: "draft" }] }).success).toBe(false);
  });

  it("choose a primary by revision id only", () => {
    expect(primaryTranscriptRequestSchema.safeParse({ revisionId: "r1" }).success).toBe(true);
    expect(primaryTranscriptRequestSchema.safeParse({ revisionId: "" }).success).toBe(false);
    expect(primaryTranscriptRequestSchema.safeParse({ revisionId: "r1", force: true }).success).toBe(false);
  });

  it("import a subtitle as non-empty text with an optional format, language and file name", () => {
    expect(subtitleImportRequestSchema.safeParse({ text: "1\n00:00:00,000 --> 00:00:01,000\nx\n" }).success).toBe(true);
    expect(subtitleImportRequestSchema.safeParse({ text: "notes", format: "md", filename: "notes.md" }).success).toBe(true);
    expect(subtitleImportRequestSchema.safeParse({ text: "x", format: "ass" }).success).toBe(false);
    expect(subtitleImportRequestSchema.safeParse({ text: "" }).success).toBe(false);
    expect(subtitleImportRequestSchema.safeParse({ text: "x", path: "/etc/passwd" }).success).toBe(false);
    expect(subtitleImportResponseSchema.parse({ transcriptRevisionId: "r1", warnings: ["subtitle_cue_dropped"] }).warnings).toEqual(["subtitle_cue_dropped"]);
  });
});
