import { describe, expect, it } from "vitest";
import { SPEAKERS_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import { subtitleImportOptionsSchema } from "../../../../src/shared/dto/subtitle-import.ts";
import {
  attributionOf,
  buildSubtitleImportOptions,
  countAttribution,
  effectiveIdentities,
  importBlockers,
  importedTranslationLanguages,
  initialImportChoice,
  isReferenceTextFile,
  needsFreshPreview,
  plainImportPossible,
  replacedTranslations,
  sameNameMatches,
  speakerNeed,
  translationLanguageAllowed,
} from "../../../../src/web/pages/content/subtitle-import-choice.ts";
import { DIGEST, packagePreview, prefixPreview, srtPreview, target } from "../../../fixtures/web/subtitle-preview.ts";

const SEQUENCE = prefixPreview().speakers.sequence;
const SPEAKER = { colorIndex: 0, used: true } as const;

describe("countAttribution", () => {
  it("counts chosen names as labelled and lets the others continue the last labelled speaker", () => {
    expect(countAttribution(SEQUENCE, new Set([0, 1]), "inherit")).toEqual({ labelled: 7, inherited: 3, unassigned: 0 });
  });

  it("leaves every cue without a chosen name unassigned under the unassigned rule", () => {
    expect(countAttribution(SEQUENCE, new Set([0, 1]), "unassigned")).toEqual({ labelled: 7, inherited: 0, unassigned: 3 });
  });

  it("cannot inherit before the first labelled cue, and treats a name left in the text as no label", () => {
    expect(countAttribution(SEQUENCE, new Set([1]), "inherit")).toEqual({ labelled: 3, inherited: 3, unassigned: 4 });
  });

  it("leaves everything unassigned when no name is chosen", () => {
    expect(countAttribution(SEQUENCE, new Set(), "inherit")).toEqual({ labelled: 0, inherited: 0, unassigned: 10 });
    expect(countAttribution([], new Set([0]), "inherit")).toEqual({ labelled: 0, inherited: 0, unassigned: 0 });
  });

  it("never infers for an explicit source", () => {
    const preview = srtPreview({
      format: "vtt",
      speakers: { source: "explicit", candidates: [{ key: "A", label: "A", count: 2, preselected: true }], sequence: [[0, 2], [-1, 3]] },
    });
    expect(attributionOf(preview, initialImportChoice(preview))).toEqual({ labelled: 2, inherited: 0, unassigned: 3 });
  });
});

describe("initialImportChoice", () => {
  it("preselects the names the preview marks and starts with earlier speakers continuing", () => {
    const choice = initialImportChoice(prefixPreview());
    expect(choice).toEqual({ prefixNames: ["张三", "李四"], unlabeled: "inherit", translation: undefined, identities: {}, setCurrent: true });
  });

  it("leaves SRT translation lines out until chosen, and waits for a language for an ASS translation style", () => {
    const lines = srtPreview({ bilingual: { source: "lines", count: 9, samples: [] } });
    expect(initialImportChoice(lines).translation).toBeNull();
    const style = srtPreview({ format: "ass", bilingual: { source: "style", count: 9, samples: [] } });
    expect(initialImportChoice(style).translation).toBeUndefined();
    expect(importBlockers(style, initialImportChoice(style), "zh-CN")).toEqual(["translation_language"]);
    expect(importBlockers(lines, initialImportChoice(lines), "zh-CN")).toEqual([]);
  });
});

describe("buildSubtitleImportOptions", () => {
  it("sends the chosen SRT names in file order with the unlabeled rule, and nothing that only applies to an existing Content", () => {
    const preview = prefixPreview();
    const options = buildSubtitleImportOptions(preview, { ...initialImportChoice(preview), prefixNames: ["李四", "张三"], unlabeled: "unassigned" });
    expect(options).toEqual({ expectedDigest: DIGEST, speakers: { prefixNames: ["张三", "李四"], unlabeled: "unassigned" } });
    expect(subtitleImportOptionsSchema.parse(options)).toEqual(options);
  });

  it("sends an empty name list when every name is left in the text", () => {
    const preview = prefixPreview();
    expect(buildSubtitleImportOptions(preview, { ...initialImportChoice(preview), prefixNames: [] }).speakers).toEqual({ prefixNames: [], unlabeled: "inherit" });
  });

  it("sends a translation language only for lines the file does not name a language for", () => {
    const lines = srtPreview({ bilingual: { source: "lines", count: 9, samples: [] } });
    expect(buildSubtitleImportOptions(lines, initialImportChoice(lines))).toEqual({ expectedDigest: DIGEST });
    expect(buildSubtitleImportOptions(lines, { ...initialImportChoice(lines), translation: "en" })).toEqual({ expectedDigest: DIGEST, translationLanguage: "en" });
    const pack = packagePreview();
    expect(buildSubtitleImportOptions(pack, { ...initialImportChoice(pack), translation: "ja" })).toEqual({ expectedDigest: DIGEST });
  });

  it("adds identities, setCurrent and the state the preview saw for an existing Content", () => {
    const zhang = { ...SPEAKER, id: "sp1", ordinal: 1, name: "张三" };
    const preview = prefixPreview({ target: target({ speakers: [zhang, { ...SPEAKER, id: "sp2", ordinal: 2 }], currentTranslations: { en: "t1" }, speakerRoom: 5 }) });
    const options = buildSubtitleImportOptions(preview, { ...initialImportChoice(preview), identities: { 张三: "sp1" }, setCurrent: false });
    expect(options).toEqual({
      expectedDigest: DIGEST,
      speakers: { prefixNames: ["张三", "李四"], unlabeled: "inherit" },
      identities: [{ key: "张三", speakerId: "sp1" }],
      setCurrent: false,
      expectedState: { primaryRevisionId: "r1", currentTranslations: { en: "t1" }, speakers: [{ id: "sp1", name: "张三" }], speakerRoom: 5 },
    });
    expect(subtitleImportOptionsSchema.parse(options)).toEqual(options);
  });

  it("drops a reuse whose name no longer matches or whose candidate is no longer imported", () => {
    const preview = prefixPreview({ target: target({ speakers: [{ ...SPEAKER, id: "sp1", ordinal: 1, name: "张三" }] }) });
    const choice = { ...initialImportChoice(preview), identities: { 张三: "sp1", 李四: "sp1" } };
    expect(effectiveIdentities(preview, choice).map(({ key }) => key)).toEqual(["张三"]);
    expect(buildSubtitleImportOptions(preview, { ...choice, prefixNames: ["李四"] })).not.toHaveProperty("identities");
  });
});

describe("same-name identities", () => {
  it("lists every existing speaker of the same name, ignoring unnamed ones and surrounding space", () => {
    const preview = prefixPreview({
      target: target({
        speakers: [
          { ...SPEAKER, id: "sp1", ordinal: 1, name: "张三" },
          { ...SPEAKER, id: "sp2", ordinal: 2 },
          { ...SPEAKER, id: "sp3", ordinal: 3, name: " 张三 ", used: false },
        ],
      }),
    });
    const matches = sameNameMatches(preview, initialImportChoice(preview));
    expect(matches.map((match) => [match.candidate.key, match.existing.map((speaker) => speaker.id)])).toEqual([["张三", ["sp1", "sp3"]]]);
    expect(sameNameMatches(prefixPreview(), initialImportChoice(prefixPreview()))).toEqual([]);
  });

  it("lets one existing speaker be continued by one imported speaker only", () => {
    const pack = packagePreview({
      speakers: { source: "package", candidates: [{ key: "a", label: "王", count: 1, preselected: true }, { key: "b", label: "王", count: 1, preselected: true }], sequence: [[0, 1], [1, 1]] },
      target: target({ speakers: [{ ...SPEAKER, id: "sp1", ordinal: 1, name: "王" }] }),
    });
    const choice = { ...initialImportChoice(pack), identities: { a: "sp1", b: "sp1" } };
    expect(effectiveIdentities(pack, choice).map(({ key }) => key)).toEqual(["a"]);
    expect(speakerNeed(pack, choice).needed).toBe(1);
  });
});

describe("speaker capacity", () => {
  it("compares new speakers with the Content's room, and with the per-Content maximum for a new Content", () => {
    const preview = prefixPreview({ target: target({ speakerRoom: 1, speakers: [{ ...SPEAKER, id: "sp1", ordinal: 1, name: "张三" }] }) });
    const choice = initialImportChoice(preview);
    expect(speakerNeed(preview, choice)).toEqual({ needed: 2, room: 1 });
    expect(importBlockers(preview, choice, "zh-CN")).toEqual(["speaker_capacity"]);
    // Continuing the existing 张三 frees the slot.
    expect(importBlockers(preview, { ...choice, identities: { 张三: "sp1" } }, "zh-CN")).toEqual([]);
    expect(speakerNeed(prefixPreview(), initialImportChoice(prefixPreview())).room).toBe(SPEAKERS_PER_CONTENT_MAX);
  });

  it("counts a package's speakers from its summary when the preview lists none", () => {
    const pack = packagePreview({ speakers: { source: "package", candidates: [], sequence: [] }, target: target({ speakerRoom: 1 }) });
    expect(speakerNeed(pack, initialImportChoice(pack)).needed).toBe(2);
  });
});

describe("translations", () => {
  it("names the languages a package brings and which of them replace a current translation", () => {
    const pack = packagePreview({ target: target({ currentTranslations: { EN: "t1" } }) });
    const choice = initialImportChoice(pack);
    expect(importedTranslationLanguages(pack, choice)).toEqual(["en"]);
    expect(replacedTranslations(pack, choice)).toEqual(["en"]);
    expect(replacedTranslations(pack, { ...choice, setCurrent: false })).toEqual([]);
  });

  it("refuses a translation in the subtitle's own language", () => {
    expect(translationLanguageAllowed("zh-TW", "zh-CN")).toBe(false);
    expect(translationLanguageAllowed("en", "zh-CN")).toBe(true);
    expect(translationLanguageAllowed("en", "")).toBe(true);
    const lines = srtPreview({ bilingual: { source: "lines", count: 9, samples: [] } });
    expect(importBlockers(lines, { ...initialImportChoice(lines), translation: "en-GB" }, "en")).toEqual(["translation_same_language"]);
  });
});

describe("file and error rules", () => {
  it("reads TXT and Markdown as reference text by name", () => {
    expect(["notes.txt", "a.MD", "b.markdown"].map(isReferenceTextFile)).toEqual([true, true, true]);
    expect(["a.srt", "b.ambersub", "txt"].map(isReferenceTextFile)).toEqual([false, false, false]);
  });

  it("offers a plain import only where it could succeed, and a fresh preview for stale-state refusals", () => {
    expect(plainImportPossible("not_found")).toBe(true);
    expect(plainImportPossible("invalid_request.subtitle_newer")).toBe(false);
    expect(plainImportPossible("invalid_request.subtitle_format")).toBe(false);
    for (const code of ["conflict.subtitle_changed", "conflict.primary_changed", "conflict.translation_changed", "conflict.speakers_changed", "conflict.speaker_capacity"]) {
      expect(needsFreshPreview(code)).toBe(true);
    }
    expect(needsFreshPreview("invalid_request")).toBe(false);
  });
});
