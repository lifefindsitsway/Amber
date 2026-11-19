import { describe, expect, it } from "vitest";
import type { ContentPackImportResult, ContentPackPreviewDto, PackContentDiff, PackPreviewCollection, PackPreviewContent } from "../../../../src/shared/dto/content-pack.ts";
import {
  blockingProblems,
  buildDecisions,
  clashingTargets,
  sharedMatches,
  canImportAsNew,
  canStart,
  changeSummary,
  collectionUsable,
  conclusionOf,
  decidingCandidates,
  draftFor,
  durationsDiffer,
  initialCollectionDraft,
  initialDraft,
  needsAttention,
  needsOriginalsDir,
  resultSummary,
  totals,
  type ContentDraft,
} from "../../../../src/web/pages/content-pack/import-model.ts";

function diff(extra: Partial<PackContentDiff> = {}): PackContentDiff {
  return {
    revisions: [
      { key: "r1", kind: "corrected", originalKind: "corrected", language: "zh", segmentCount: 5, createdAt: 1, archived: false, state: "new", standalone: false, becomesCurrentTranslation: false },
      { key: "r2", kind: "asr", originalKind: "asr", language: "zh", segmentCount: 5, createdAt: 0, archived: false, state: "existing", standalone: false, becomesCurrentTranslation: false },
    ],
    speakers: [{ key: "s1", name: "陈明", ordinal: 1, state: "new", sameNameCandidates: [] }],
    figures: { new: 3, existing: 1, differs: 0, placedByTime: 0, deletedHere: 0 },
    notes: { new: 0, existing: 2, differs: 0, unplaceable: 0 },
    platformChapters: "none",
    media: [
      { key: "m1", kind: "original", sizeBytes: 100, state: "new" },
      { key: "m2", kind: "cache", sizeBytes: 50, quality: "720P", state: "existing" },
    ],
    overLimit: [],
    ...extra,
  };
}

function item(key: string, extra: Partial<PackPreviewContent> = {}): PackPreviewContent {
  return { key, title: `内容 ${key}`, sourceKind: "local", durationMs: 60_000, match: "new", candidates: [], diff: diff(), ...extra };
}

const candidate = (contentId: string, reason: "origin" | "mapped" | "fingerprint" | "platform", trashed = false) => ({ contentId, title: `本机 ${contentId}`, durationMs: 60_000, reason, trashed });

describe("the preview's suggestion", () => {
  it("imports a new Content, merges into a single match, waits on several, skips one in the trash", () => {
    expect(initialDraft(item("a")).action).toBe("import");
    const single = item("b", { match: "same", candidates: [candidate("x", "origin")], diff: diff({ targetContentId: "x" }) });
    expect(initialDraft(single)).toMatchObject({ action: "merge", targetContentId: "x" });
    const several = item("c", { match: "same", candidates: [candidate("x", "origin"), candidate("y", "mapped")] });
    expect(initialDraft(several).action).toBeUndefined();
    expect(conclusionOf(several, initialDraft(several))).toEqual({ kind: "choose", count: 2 });
    const trashed = item("d", { match: "trashed", candidates: [candidate("x", "origin", true)] });
    expect(initialDraft(trashed).action).toBe("skip");
    expect(conclusionOf(trashed, initialDraft(trashed))).toEqual({ kind: "trashed" });
  });

  it("offers only the deciding tier as targets, and import-as-new only for a local file matched by its media", () => {
    const mixed = item("e", { match: "same", candidates: [candidate("x", "origin"), candidate("y", "fingerprint")] });
    expect(decidingCandidates(mixed).map((entry) => entry.contentId)).toEqual(["x"]);
    expect(canImportAsNew(item("f", { match: "same_media", candidates: [candidate("y", "fingerprint")] }))).toBe(true);
    expect(canImportAsNew(item("g", { match: "same_media", sourceKind: "bilibili", candidates: [candidate("y", "platform")] }))).toBe(false);
    expect(canImportAsNew(item("h", { match: "same", candidates: [candidate("y", "origin")] }))).toBe(false);
  });

  it("states its conclusion with the target's title", () => {
    const media = item("i", { match: "same_media", candidates: [candidate("y", "fingerprint")], diff: diff({ targetContentId: "y" }) });
    expect(conclusionOf(media, initialDraft(media))).toEqual({ kind: "mergeMedia", title: "本机 y" });
    const manual = draftFor(diff({ targetContentId: "z" }), "merge", { title: "手选的", durationMs: 1 });
    expect(conclusionOf(item("j"), manual)).toEqual({ kind: "mergeOther", title: "手选的" });
    expect(conclusionOf(item("k"), { ...initialDraft(item("k")), action: "skip" })).toEqual({ kind: "skip" });
  });
});

describe("change summaries", () => {
  it("count what goes in under the current switches", () => {
    const draft = initialDraft(item("a"));
    expect(changeSummary(draft)).toMatchObject({ revisions: 1, speakers: 1, figures: 3, notes: 0, media: 1, differs: 0, conflicts: 0 });
    expect(changeSummary({ ...draft, figures: false, excludeRevisionKeys: ["r1"], mediaKeys: [] })).toMatchObject({ revisions: 0, figures: 0, media: 0 });
    // A speaker merged into a same-named local one is not new.
    expect(changeSummary({ ...draft, sameSpeakers: { s1: "local" } }).speakers).toBe(0);
  });

  it("count differing notes and figures, conflicting revisions and caches, rejected translations", () => {
    const messy = draftFor(
      diff({
        revisions: [
          { key: "r1", kind: "corrected", originalKind: "corrected", language: "zh", segmentCount: 5, createdAt: 1, archived: false, state: "differs", standalone: false, becomesCurrentTranslation: false },
          { key: "t1", kind: "translated", originalKind: "translated", language: "en", segmentCount: 5, createdAt: 1, archived: false, state: "new", standalone: false, rejected: "translation_without_parent", becomesCurrentTranslation: false },
        ],
        notes: { new: 0, existing: 0, differs: 2, unplaceable: 0 },
        figures: { new: 0, existing: 0, differs: 1, placedByTime: 0, deletedHere: 0 },
        media: [{ key: "m", kind: "cache", sizeBytes: 1, state: "conflict" }],
      }),
      "merge",
    );
    expect(changeSummary(messy)).toMatchObject({ revisions: 0, differs: 3, conflicts: 3 });
    expect(needsAttention(item("x", { match: "same" }), messy)).toBe(true);
  });
});

describe("blocking and totals", () => {
  const over = diff({ overLimit: [{ category: "figures", over: 3, limit: 100 }] });
  const preview: ContentPackPreviewDto = {
    pack: { formatVersion: 1, createdAt: 0, amberVersion: "0.7.3", sizeBytes: 1000, mediaBytes: 150 },
    contents: [item("a"), item("b", { match: "same", candidates: [candidate("x", "origin"), candidate("y", "origin")] }), item("c", { diff: over })],
    collections: [],
  };

  it("waits for a target and for a category over its limit; unticking the category lets it go", () => {
    const drafts = new Map<string, ContentDraft>();
    expect(blockingProblems(preview, drafts)).toEqual({ choose: 1, overLimit: 1, sameTarget: 0, nothing: false });
    expect(canStart(blockingProblems(preview, drafts))).toBe(false);
    drafts.set("b", draftFor(diff({ targetContentId: "y" }), "merge"));
    drafts.set("c", { ...initialDraft(preview.contents[2] as PackPreviewContent), figures: false });
    expect(canStart(blockingProblems(preview, drafts))).toBe(true);
    const skipped = new Map(preview.contents.map((entry) => [entry.key, { ...initialDraft(entry), action: "skip" as const }]));
    expect(blockingProblems(preview, skipped)).toEqual({ choose: 0, overLimit: 0, sameTarget: 0, nothing: true });
  });

  it("totals actions and media, and knows when originals need a directory", () => {
    const drafts = new Map<string, ContentDraft>([["b", draftFor(diff({ targetContentId: "y" }), "merge")]]);
    expect(totals(preview, drafts)).toEqual({ create: 2, merge: 1, skip: 0, mediaBytes: 300 });
    expect(needsOriginalsDir(preview, drafts)).toBe(true);
    const noOriginals = new Map(preview.contents.map((entry) => [entry.key, { ...initialDraft(entry), action: "import" as const, mediaKeys: [] }]));
    expect(needsOriginalsDir(preview, noOriginals)).toBe(false);
  });
});

describe("decisions", () => {
  const collection: PackPreviewCollection = { key: "k", name: "课程", contentKeys: ["a", "b"], match: "same_name", candidates: [{ collectionId: "col", name: "课程", memberCount: 3 }] };
  const preview: ContentPackPreviewDto = {
    pack: { formatVersion: 1, createdAt: 0, amberVersion: "0.7.3", sizeBytes: 1000, mediaBytes: 150 },
    contents: [item("a"), item("b", { match: "same", candidates: [candidate("x", "origin")], diff: diff({ targetContentId: "x" }) })],
    collections: [collection],
  };

  it("send each Content's choices, only adopting or switching primaries where the user did", () => {
    const drafts = new Map<string, ContentDraft>([
      ["b", { ...initialDraft(preview.contents[1] as PackPreviewContent), adoptPack: true, setPrimaryRevisionKey: "r1", currentTranslationKeys: ["r1", "gone"], sameSpeakers: { s1: "sp" } }],
    ]);
    const decisions = buildDecisions(preview, drafts, new Map());
    expect(decisions.contents[0]).toEqual({
      key: "a",
      action: "import",
      revisions: true,
      excludeRevisionKeys: [],
      figures: true,
      notes: true,
      mediaKeys: ["m1"],
      adoptPack: false,
      currentTranslationKeys: [],
      sameSpeakers: [],
    });
    expect(decisions.contents[1]).toMatchObject({
      key: "b",
      action: "merge",
      targetContentId: "x",
      adoptPack: true,
      setPrimaryRevisionKey: "r1",
      currentTranslationKeys: ["r1"],
      sameSpeakers: [{ speakerKey: "s1", localSpeakerId: "sp" }],
    });
  });

  it("a same-named collection is created unless the user joins it; skipped Contents leave it alone", () => {
    expect(initialCollectionDraft(collection)).toEqual({ action: "create" });
    expect(initialCollectionDraft({ ...collection, match: "same" })).toEqual({ action: "join", targetCollectionId: "col" });
    expect(buildDecisions(preview, new Map(), new Map([["k", { action: "join", targetCollectionId: "col" }]])).collections).toEqual([{ key: "k", action: "join", targetCollectionId: "col" }]);
    const skipped = new Map(preview.contents.map((entry) => [entry.key, { ...initialDraft(entry), action: "skip" as const }]));
    expect(collectionUsable(collection, preview, skipped)).toBe(false);
    expect(collectionUsable(collection, preview, new Map())).toBe(true);
    expect(buildDecisions(preview, skipped, new Map()).collections).toEqual([{ key: "k", action: "skip" }]);
  });

  it("a row still waiting for a target goes as skipped and carries nothing", () => {
    const waiting: ContentPackPreviewDto = { ...preview, contents: [item("c", { match: "same", candidates: [candidate("x", "origin"), candidate("y", "origin")] })], collections: [] };
    expect(buildDecisions(waiting, new Map(), new Map()).contents[0]).toMatchObject({ action: "skip", revisions: false, figures: false, notes: false, mediaKeys: [] });
  });
});

describe("results", () => {
  const result = (contents: Array<"imported" | "merged" | "skipped" | "failed">, collections: Array<"created" | "failed">): ContentPackImportResult => ({
    contents: contents.map((status, index) => ({
      key: String(index),
      status,
      added: { revisions: 0, speakers: 0, figures: 0, notes: 0, media: 0 },
      updated: { figures: 0, notes: 0 },
      conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 },
      placedByTime: 0,
    })),
    collections: collections.map((status, index) => ({ key: String(index), name: "c", status, added: 0 })),
  });

  it("never reads as all good while anything failed, collections included", () => {
    expect(resultSummary(result(["imported", "merged", "skipped"], ["created"])).allOk).toBe(true);
    expect(resultSummary(result(["imported", "failed"], []))).toMatchObject({ failed: 1, allOk: false });
    expect(resultSummary(result(["imported"], ["failed"]))).toMatchObject({ collectionsFailed: 1, allOk: false });
  });

  it("warns about durations far apart, never about unknown ones", () => {
    expect(durationsDiffer(60_000, 75_000, 10_000)).toBe(true);
    expect(durationsDiffer(60_000, 65_000, 10_000)).toBe(false);
    expect(durationsDiffer(undefined, 65_000, 10_000)).toBe(false);
  });
});

describe("several carried Contents and one local Content", () => {
  const pack = { formatVersion: 1, createdAt: 0, amberVersion: "0.7.3", sizeBytes: 1, mediaBytes: 0 };
  // Both carried files match the same local recording; the server suggested it to neither.
  const first = item("a", { match: "same_media", candidates: [candidate("x", "fingerprint")] });
  const second = item("b", { match: "same_media", candidates: [candidate("x", "fingerprint")] });
  const preview: ContentPackPreviewDto = { pack, contents: [first, second, item("c")], collections: [] };

  it("asks for each row on its own, neither imported as new nor merged by default", () => {
    expect(initialDraft(first).action).toBeUndefined();
    expect(initialDraft(second).action).toBeUndefined();
    const shared = sharedMatches(preview);
    expect(shared.get("a")).toEqual({ contentId: "x", title: "本机 x", otherKeys: ["b"] });
    expect(shared.get("b")).toEqual({ contentId: "x", title: "本机 x", otherKeys: ["a"] });
    expect(shared.has("c")).toBe(false);
    expect(conclusionOf(first, initialDraft(first), shared.get("a"))).toEqual({ kind: "shared", title: "本机 x" });
    expect(canStart(blockingProblems(preview, new Map()))).toBe(false);
    expect(blockingProblems(preview, new Map()).choose).toBe(2);
  });

  it("does not take a suggested target for shared", () => {
    const suggested = item("d", { match: "same", candidates: [candidate("x", "origin")], diff: diff({ targetContentId: "x" }) });
    expect(sharedMatches({ pack, contents: [suggested, first], collections: [] }).size).toBe(0);
  });

  it("flags two rows merged into one local Content and blocks the start until one changes", () => {
    const drafts = new Map<string, ContentDraft>([
      ["a", draftFor(diff({ targetContentId: "x" }), "merge")],
      ["b", draftFor(diff({ targetContentId: "x" }), "merge")],
    ]);
    expect(clashingTargets(preview, drafts)).toEqual(
      new Map([
        ["a", { contentId: "x", otherKeys: ["b"] }],
        ["b", { contentId: "x", otherKeys: ["a"] }],
      ]),
    );
    expect(blockingProblems(preview, drafts)).toMatchObject({ choose: 0, sameTarget: 2 });
    expect(canStart(blockingProblems(preview, drafts))).toBe(false);
    drafts.set("b", { ...draftFor(diff(), "import") });
    expect(clashingTargets(preview, drafts).size).toBe(0);
    expect(canStart(blockingProblems(preview, drafts))).toBe(true);
    // A hand-picked target counts too, and a skipped row does not.
    drafts.set("b", draftFor(diff({ targetContentId: "x" }), "merge", { title: "x", durationMs: undefined }));
    expect(clashingTargets(preview, drafts).has("b")).toBe(true);
    drafts.set("b", { ...draftFor(diff({ targetContentId: "x" }), "merge"), action: "skip" });
    expect(clashingTargets(preview, drafts).size).toBe(0);
  });
});
