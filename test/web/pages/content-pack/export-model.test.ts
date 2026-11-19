import { describe, expect, it } from "vitest";
import type { ContentPackExportPlanDto, ExportPlanContent, ExportPlanRevision } from "../../../../src/shared/dto/content-pack.ts";
import {
  applyTemplate,
  applyToContent,
  buildSelection,
  cardHints,
  choiceSummary,
  choiceValid,
  defaultChoice,
  includeRevisions,
  selectedRevisions,
  suggestedPackName,
  totalBytes,
  type ExportChoice,
} from "../../../../src/web/pages/content-pack/export-model.ts";

function revision(id: string, extra: Partial<ExportPlanRevision> = {}): ExportPlanRevision {
  return {
    id,
    kind: "asr",
    language: "zh",
    timingFidelity: "segment_only",
    generation: { kind: "asr", modelId: "m" },
    segmentCount: 10,
    createdAt: 1,
    primary: false,
    archived: false,
    currentTranslation: false,
    anchoredFigures: 0,
    notes: 0,
    ...extra,
  };
}

/** asr → corrected (current) → translation of corrected; an archived old asr; an English translation of the asr. */
function lecture(extra: Partial<ExportPlanContent> = {}): ExportPlanContent {
  return {
    contentId: "c1",
    title: "第一讲",
    sourceKind: "bilibili",
    durationMs: 60_000,
    revisions: [
      revision("asr", { createdAt: 1, notes: 2, anchoredFigures: 1 }),
      revision("old", { createdAt: 0, archived: true }),
      revision("cor", { kind: "corrected", parentRevisionId: "asr", primary: true, createdAt: 2, notes: 3 }),
      revision("tr-cor", { kind: "translated", language: "en", parentRevisionId: "cor", currentTranslation: true, createdAt: 3 }),
      revision("tr-asr", { kind: "translated", language: "ja", parentRevisionId: "asr", currentTranslation: true, createdAt: 4, notes: 1 }),
    ],
    figures: 4,
    notes: 6,
    speakers: 2,
    platformChapters: true,
    media: [
      { assetId: "orig", kind: "original", mimeType: "video/mp4", sizeBytes: 1000 },
      { assetId: "c720", kind: "cache", mimeType: "video/mp4", sizeBytes: 500, quality: "720P" },
      { assetId: "gone", kind: "original", mimeType: "video/mp4", sizeBytes: 9999, unavailable: "missing" },
    ],
    ...extra,
  };
}

describe("export choices", () => {
  it("start from the current transcript, current translations, figures, no notes and the original files", () => {
    const choice = defaultChoice(lecture());
    expect(choice).toEqual({ transcripts: "current", picked: [], translations: ["tr-cor", "tr-asr"], figures: true, notes: false, media: ["orig"] });
  });

  it("carry a translation's original along and say so", () => {
    const content = lecture();
    const choice = defaultChoice(content);
    expect(selectedRevisions(content, choice)).toEqual({ ids: ["asr", "cor", "tr-cor", "tr-asr"], autoParents: ["asr"] });
    expect(cardHints(content, choice)).toContainEqual({ kind: "translationParents", revisionIds: ["asr"] });
  });

  it("count notes and figures on revisions left behind only while their category is ticked", () => {
    const content = lecture();
    const base: ExportChoice = { ...defaultChoice(content), translations: [] };
    const hints = cardHints(content, base);
    expect(hints).toContainEqual({ kind: "figuresOnUnselected", count: 1, revisionIds: ["asr"] });
    expect(hints.some((hint) => hint.kind === "notesOnUnselected")).toBe(false);
    expect(cardHints(content, { ...base, notes: true })).toContainEqual({ kind: "notesOnUnselected", count: 3, revisionIds: ["asr", "tr-asr"] });
    expect(cardHints(content, { ...base, figures: false }).some((hint) => hint.kind === "figuresOnUnselected")).toBe(false);
  });

  it("warn that a corrected revision without its parent stands alone", () => {
    const content = lecture();
    expect(cardHints(content, { ...defaultChoice(content), translations: [] })).toContainEqual({ kind: "standalone", revisionIds: ["cor"] });
    // Its parent carried by a translation: no longer standalone.
    expect(cardHints(content, defaultChoice(content)).some((hint) => hint.kind === "standalone")).toBe(false);
  });

  it("brings the versions notes are on along, switching to a picked set", () => {
    const content = lecture();
    const base: ExportChoice = { ...defaultChoice(content), translations: [], notes: true };
    const next = includeRevisions(content, base, ["asr", "tr-asr"]);
    expect(next.transcripts).toBe("pick");
    expect(next.picked).toEqual(["asr", "cor"]);
    expect(next.translations).toEqual(["tr-asr"]);
    expect(cardHints(content, next).some((hint) => hint.kind === "notesOnUnselected")).toBe(false);
    // A translation among them is ticked instead.
    expect(includeRevisions(content, base, ["tr-asr"]).translations).toEqual(["tr-asr"]);
    // Picking every transcript is plain 「全部版本」.
    expect(includeRevisions(content, base, ["asr", "old"]).transcripts).toBe("all");
  });

  it("without a transcript: a platform Content still goes, a local one needs a file", () => {
    const platform = lecture();
    const none: ExportChoice = { transcripts: "none", picked: [], translations: [], figures: false, notes: false, media: [] };
    expect(cardHints(platform, none)).toEqual([{ kind: "noTranscript" }]);
    expect(choiceValid(platform, none)).toBe(true);
    const local = lecture({ sourceKind: "local" });
    expect(cardHints(local, none)).toEqual([{ kind: "nothingToCarry" }]);
    expect(choiceValid(local, none)).toBe(false);
    expect(cardHints(local, { ...none, media: ["orig"] })).toEqual([{ kind: "noTranscript" }]);
  });

  it("summarise a collapsed card", () => {
    const content = lecture();
    expect(choiceSummary(content, defaultChoice(content))).toEqual({ transcripts: 2, translationLanguages: 2, figures: 4, notes: 0, mediaBytes: 1000, mediaKind: "video" });
    expect(choiceSummary(content, { ...defaultChoice(content), notes: true }).notes).toBe(6);
    const audio = lecture({ media: [{ assetId: "a", kind: "original", mimeType: "audio/mpeg", sizeBytes: 5 }] });
    expect(choiceSummary(audio, defaultChoice(audio)).mediaKind).toBe("audio");
  });
});

describe("应用到全部", () => {
  it("carries rules, not revision ids, and leaves alone what the source card cannot speak for", () => {
    const source = lecture({ media: [] });
    const choice: ExportChoice = { transcripts: "pick", picked: ["asr"], translations: [], figures: false, notes: true, media: [] };
    const template = applyTemplate(source, choice);
    expect(template).toEqual({ transcripts: "current", transcriptsFromPick: true, translations: "none", figures: false, notes: true, originals: "keep", caches: "keep" });

    const other = lecture({ contentId: "c2" });
    const before = { ...defaultChoice(other), media: ["orig", "c720"] };
    const after = applyToContent(other, before, template);
    expect(after).toEqual({ transcripts: "current", picked: [], translations: [], figures: false, notes: true, media: ["orig", "c720"] });
  });

  it("turns files on or off by kind, and the current transcript off where there is none", () => {
    const source = lecture();
    const template = applyTemplate(source, { ...defaultChoice(source), media: ["c720"] });
    expect(template.originals).toBe(false);
    expect(template.caches).toBe(true);
    const bare = lecture({ contentId: "c3", revisions: [] });
    const after = applyToContent(bare, defaultChoice(bare), template);
    expect(after.transcripts).toBe("none");
    expect(after.media).toEqual(["c720"]);
  });

  it("all translations, when every one was ticked", () => {
    const source = lecture();
    expect(applyTemplate(source, { ...defaultChoice(source), translations: ["tr-cor", "tr-asr"] }).translations).toBe("all");
  });
});

describe("the export request", () => {
  const plan: ContentPackExportPlanDto = {
    contents: [lecture(), lecture({ contentId: "busy", blocked: "busy", busyTaskId: "t1" }), lecture({ contentId: "c2", title: "第二讲" })],
    collections: [
      { collectionId: "k1", name: "课程", memberCount: 20, contentIds: ["c1", "c2"] },
      { collectionId: "k2", name: "只有忙的", memberCount: 3, contentIds: ["busy"] },
      { collectionId: "k3", name: "没勾", memberCount: 3, contentIds: ["c1"] },
    ],
  };

  it("names every revision and file, leaves blocked Contents and empty or unticked collections out", () => {
    const selection = buildSelection(plan, new Map(), new Set(["k1", "k2"]));
    expect(selection.contents.map((content) => content.contentId)).toEqual(["c1", "c2"]);
    expect(selection.contents[0]).toEqual({ contentId: "c1", revisionIds: ["asr", "cor", "tr-cor", "tr-asr"], figures: true, notes: false, mediaAssetIds: ["orig"] });
    expect(selection.collectionIds).toEqual(["k1"]);
    expect(totalBytes(plan, new Map())).toBe(2000);
  });

  it("never sends a file that cannot be carried", () => {
    const choices = new Map([["c1", { ...defaultChoice(lecture()), media: ["orig", "gone"] }]]);
    expect(buildSelection(plan, choices, new Set()).contents[0]?.mediaAssetIds).toEqual(["orig"]);
  });

  it("suggests a file name from the one title or the collection", () => {
    const base = { fallback: "导出内容包", stamp: "20261118-1030", extension: "amberpack" };
    expect(suggestedPackName({ ...base, titles: ["第一讲: 检索/增强"] })).toBe("第一讲 检索 增强 20261118-1030.amberpack");
    expect(suggestedPackName({ ...base, titles: ["a", "b"], collectionName: "课程" })).toBe("课程 20261118-1030.amberpack");
    expect(suggestedPackName({ ...base, titles: ["a", "b"] })).toBe("导出内容包 20261118-1030.amberpack");
  });
});
