import type { CollectionDetailDto } from "../../src/shared/dto/collection.ts";
import type { ContentDto } from "../../src/shared/dto/content.ts";
import type { ContentPackImportResult, ContentPackPreviewDto, ExportPlanContent, ExportPlanRevision, PackContentDiff } from "../../src/shared/dto/content-pack.ts";
import type { PackScenario } from "./mock-content-pack.ts";

/** The library, plans, previews and results the content pack specs run on. */

export const LECTURE_1 = "01J0000000000000000PACKC1";
export const LECTURE_2 = "01J0000000000000000PACKC2";
export const BUSY = "01J0000000000000000PACKC3";
export const IMPORTED = "01J0000000000000000PACKC4";
export const COURSE = "01J0000000000000000PACKK1";
export const FAVOURITES = "01J0000000000000000PACKK2";
const at = 1_790_000_000_000;

function row(id: string, title: string, extra: Partial<ContentDto> = {}): ContentDto {
  return { id, source: { kind: "bilibili" }, title, durationMs: 3_600_000, processingStatus: "succeeded", collections: [], createdAt: at, updatedAt: at, ...extra };
}

export const LIBRARY: ContentDto[] = [
  row(LECTURE_1, "第一讲：检索增强生成", { collections: [{ id: COURSE, name: "生成式软件工程", itemId: "i1" }, { id: FAVOURITES, name: "收藏", itemId: "i9" }] }),
  row(LECTURE_2, "第二讲：评测与对齐", { durationMs: 3_000_000, collections: [{ id: COURSE, name: "生成式软件工程", itemId: "i2" }] }),
  row(BUSY, "第三讲：正在翻译的一讲", { processingStatus: "running" }),
  row(IMPORTED, "从另一台电脑带来的讲座", { processingStatus: "none", source: { kind: "local" } }),
];

const member = (id: string, position: number, title: string) => ({
  id: `i${position}`,
  contentId: id,
  position,
  addedAt: at,
  title,
  processingStatus: "succeeded" as const,
  source: { kind: "bilibili" as const },
  updatedAt: at,
});

export const COLLECTIONS: CollectionDetailDto[] = [
  { id: COURSE, name: "生成式软件工程", itemCount: 2, createdAt: at, updatedAt: at, items: [member(LECTURE_1, 1, "第一讲：检索增强生成"), member(LECTURE_2, 2, "第二讲：评测与对齐")] },
  { id: FAVOURITES, name: "收藏", itemCount: 1, createdAt: at, updatedAt: at, items: [member(LECTURE_1, 1, "第一讲：检索增强生成")] },
];

const revision = (id: string, extra: Partial<ExportPlanRevision> = {}): ExportPlanRevision => ({
  id,
  kind: "asr",
  language: "zh",
  timingFidelity: "exact_words",
  generation: { kind: "asr", modelId: "paraformer-v2" },
  segmentCount: 480,
  createdAt: at,
  primary: false,
  archived: false,
  currentTranslation: false,
  anchoredFigures: 0,
  notes: 0,
  ...extra,
});

export const PLAN: Record<string, ExportPlanContent> = {
  [LECTURE_1]: {
    contentId: LECTURE_1,
    title: "第一讲：检索增强生成",
    sourceKind: "bilibili",
    durationMs: 3_600_000,
    revisions: [
      revision(`${LECTURE_1}A`, { createdAt: at, notes: 3, anchoredFigures: 2 }),
      revision(`${LECTURE_1}C`, { kind: "corrected", parentRevisionId: `${LECTURE_1}A`, primary: true, createdAt: at + 60_000, generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "deepseek", modelDisplaySnapshot: "deepseek-flash" } }, notes: 1 }),
      revision(`${LECTURE_1}E`, { kind: "translated", language: "en", parentRevisionId: `${LECTURE_1}A`, currentTranslation: true, createdAt: at + 120_000, generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "deepseek", modelDisplaySnapshot: "deepseek-flash" } } }),
      revision(`${LECTURE_1}O`, { createdAt: at - 60_000, archived: true }),
    ],
    figures: 4,
    notes: 4,
    speakers: 2,
    platformChapters: true,
    media: [
      { assetId: `${LECTURE_1}V`, kind: "cache", mimeType: "video/mp4", sizeBytes: 1_288_490_189, quality: "1080P" },
      { assetId: `${LECTURE_1}W`, kind: "cache", mimeType: "video/mp4", sizeBytes: 402_653_184, quality: "720P" },
    ],
  },
  [LECTURE_2]: {
    contentId: LECTURE_2,
    title: "第二讲：评测与对齐",
    sourceKind: "bilibili",
    durationMs: 3_000_000,
    revisions: [revision(`${LECTURE_2}A`, { primary: true, notes: 2 })],
    figures: 0,
    notes: 2,
    speakers: 0,
    platformChapters: false,
    media: [],
  },
  [BUSY]: {
    contentId: BUSY,
    title: "第三讲：正在翻译的一讲",
    sourceKind: "bilibili",
    durationMs: 3_000_000,
    revisions: [],
    figures: 0,
    notes: 0,
    speakers: 0,
    platformChapters: false,
    media: [],
    blocked: "busy",
    busyTaskId: "01J0000000000000000PACKT1",
  },
  [IMPORTED]: {
    contentId: IMPORTED,
    title: "从另一台电脑带来的讲座",
    sourceKind: "local",
    durationMs: 1_800_000,
    revisions: [revision(`${IMPORTED}A`, { kind: "imported", primary: true, generation: { kind: "pack", originalKind: "corrected", originalGeneration: "llm", modelName: "deepseek-flash" } })],
    figures: 1,
    notes: 0,
    speakers: 0,
    platformChapters: false,
    media: [
      { assetId: `${IMPORTED}O`, kind: "original", mimeType: "video/mp4", displayName: "lecture-04.mp4", sizeBytes: 734_003_200 },
      { assetId: `${IMPORTED}X`, kind: "original", mimeType: "video/mp4", displayName: "lecture-04-old.mp4", sizeBytes: 1, unavailable: "missing" },
    ],
  },
};

export const EXPORT_SCENARIO: PackScenario = {
  library: LIBRARY,
  collections: COLLECTIONS,
  plan: PLAN,
  planCollections: [
    { collectionId: COURSE, name: "生成式软件工程", memberCount: 20, contentIds: [LECTURE_1, LECTURE_2] },
    { collectionId: FAVOURITES, name: "收藏", memberCount: 7, contentIds: [LECTURE_1] },
  ],
  exportFileName: "生成式软件工程 20261118-1030.amberpack",
  noTranscript: [IMPORTED],
  tasks: { "01J0000000000000000PACKT1": { contentId: BUSY, kind: "translate" } },
};

// ---------------------------------------------------------------------------------------------
// Import

const diff = (extra: Partial<PackContentDiff> = {}): PackContentDiff => ({
  revisions: [
    { key: "rev-asr", kind: "asr", originalKind: "asr", language: "zh", segmentCount: 480, createdAt: at, archived: false, state: "new", standalone: false, becomesCurrentTranslation: false, modelName: "paraformer-v2" },
  ],
  speakers: [],
  figures: { new: 2, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 },
  notes: { new: 1, existing: 0, differs: 0, unplaceable: 0 },
  platformChapters: "add",
  media: [{ key: "media-cache", kind: "cache", quality: "1080P", sizeBytes: 1_288_490_189, state: "new" }],
  overLimit: [],
  ...extra,
});

export const LOCAL_TARGET = "01J0000000000000000PACKL1";
export const OTHER_TARGET = "01J0000000000000000PACKL2";

export const PREVIEW: ContentPackPreviewDto = {
  pack: { formatVersion: 1, createdAt: at, amberVersion: "0.7.3", sizeBytes: 2_147_483_648, mediaBytes: 2_000_000_000 },
  contents: [
    { key: "c-new", title: "第五讲：智能体", sourceKind: "bilibili", durationMs: 3_600_000, match: "new", candidates: [], diff: diff() },
    {
      key: "c-same",
      title: "第一讲：检索增强生成",
      sourceKind: "bilibili",
      durationMs: 3_600_000,
      match: "same",
      candidates: [{ contentId: LECTURE_1, title: "第一讲：检索增强生成", durationMs: 3_600_000, reason: "origin", trashed: false }],
      diff: diff({
        targetContentId: LECTURE_1,
        revisions: [
          { key: "rev-1", kind: "asr", originalKind: "asr", language: "zh", segmentCount: 480, createdAt: at, archived: false, state: "existing", standalone: false, becomesCurrentTranslation: false },
          { key: "rev-2", kind: "corrected", originalKind: "corrected", language: "zh", segmentCount: 480, createdAt: at + 60_000, archived: false, state: "differs", standalone: false, becomesCurrentTranslation: false, modelName: "deepseek-flash" },
          { key: "rev-3", kind: "manual", originalKind: "manual", language: "zh", segmentCount: 481, createdAt: at + 120_000, archived: false, state: "new", standalone: false, becomesCurrentTranslation: false },
        ],
        speakers: [{ key: "spk-1", name: "陈明", ordinal: 1, state: "new", sameNameCandidates: [{ speakerId: "local-spk", name: "陈明" }] }],
        figures: { new: 1, existing: 2, differs: 1, placedByTime: 1, deletedHere: 0 },
        notes: { new: 0, existing: 3, differs: 2, unplaceable: 0 },
        platformChapters: "keep",
        media: [{ key: "media-1080", kind: "cache", quality: "1080P", sizeBytes: 1_288_490_189, state: "existing" }],
        targetPrimaryRevisionId: `${LECTURE_1}C`,
      }),
    },
    {
      key: "c-media",
      title: "录屏：第六讲",
      sourceKind: "local",
      durationMs: 2_400_000,
      match: "same_media",
      candidates: [
        { contentId: LOCAL_TARGET, title: "录屏（导入的副本）", durationMs: 2_400_000, reason: "fingerprint", trashed: false },
        { contentId: OTHER_TARGET, title: "录屏（又一份）", durationMs: 2_400_000, reason: "fingerprint", trashed: false },
      ],
      diff: diff({ revisions: [], figures: { new: 0, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 }, notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 }, media: [{ key: "media-orig", kind: "original", displayName: "第六讲.mp4", sizeBytes: 700_000_000, state: "new" }], platformChapters: "none" }),
    },
    { key: "c-trash", title: "第七讲：删掉过的", sourceKind: "bilibili", durationMs: 3_000_000, match: "trashed", candidates: [{ contentId: "01J0000000000000000PACKL3", title: "第七讲：删掉过的", durationMs: 3_000_000, reason: "platform", trashed: true }], diff: diff() },
    { key: "c-over", title: "第八讲：插图很多", sourceKind: "bilibili", durationMs: 3_600_000, match: "new", candidates: [], diff: diff({ figures: { new: 103, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 }, overLimit: [{ category: "figures", over: 3, limit: 100 }] }) },
  ],
  collections: [
    { key: "k-course", name: "生成式软件工程", contentKeys: ["c-new", "c-same"], match: "same_name", candidates: [{ collectionId: COURSE, name: "生成式软件工程", memberCount: 2 }] },
  ],
};

export const COMPARE: Record<string, PackContentDiff> = {
  [OTHER_TARGET]: diff({ targetContentId: OTHER_TARGET, revisions: [], figures: { new: 0, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 }, notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 }, media: [{ key: "media-orig", kind: "original", sizeBytes: 700_000_000, state: "fill" }], platformChapters: "none" }),
  [LECTURE_2]: diff({ targetContentId: LECTURE_2 }),
};

/** Every acted-on Content succeeds; the collection fails once, so 「重试合集」 has something to do. */
export function importResult(decisions: { contents: Array<{ key: string; action: string; targetContentId?: string }> }): ContentPackImportResult {
  const titles = new Map(PREVIEW.contents.map((item) => [item.key, item.title]));
  return {
    contents: decisions.contents.map((decision) => ({
      key: decision.key,
      ...(titles.get(decision.key) === undefined ? {} : { title: titles.get(decision.key) as string }),
      status: decision.action === "skip" ? "skipped" : decision.action === "merge" ? "merged" : "imported",
      ...(decision.action === "skip" ? {} : { contentId: decision.targetContentId ?? `01J0000000000000000NEW${decision.key.slice(2, 5).toUpperCase()}` }),
      added: { revisions: decision.action === "skip" ? 0 : 1, speakers: 0, figures: decision.action === "skip" ? 0 : 2, notes: 0, media: 0 },
      updated: { figures: 0, notes: 0 },
      conflicts: { revisions: decision.key === "c-same" ? 1 : 0, figures: 0, notes: 0, media: 0 },
      placedByTime: decision.key === "c-same" ? 1 : 0,
    })),
    collections: [{ key: "k-course", name: "生成式软件工程", status: "failed", added: 0, error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "写入合集时出错" } }],
  };
}

export const IMPORT_SCENARIO: PackScenario = { library: LIBRARY, collections: COLLECTIONS, preview: PREVIEW, compare: COMPARE, importResult };

/**
 * Two recordings in the pack that both match one local recording by their files: the server
 * suggests the local one to neither, so each row asks.
 */
const twin = (key: string, title: string) => ({
  key,
  title,
  sourceKind: "local" as const,
  durationMs: 2_400_000,
  match: "same_media" as const,
  candidates: [{ contentId: LOCAL_TARGET, title: "录屏（导入的副本）", durationMs: 2_400_000, reason: "fingerprint" as const, trashed: false }],
  diff: diff({ revisions: [], figures: { new: 0, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 }, notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 }, media: [], platformChapters: "none" }),
});

export const SHARED_SCENARIO: PackScenario = {
  library: [...LIBRARY, row(LOCAL_TARGET, "录屏（导入的副本）", { source: { kind: "local" }, durationMs: 2_400_000 })],
  collections: COLLECTIONS,
  preview: { ...PREVIEW, contents: [twin("c-twin-1", "录屏：上午场"), twin("c-twin-2", "录屏：下午场")], collections: [] },
  compare: { [LOCAL_TARGET]: diff({ targetContentId: LOCAL_TARGET, revisions: [], media: [], platformChapters: "none" }), ...COMPARE },
  importResult,
};
