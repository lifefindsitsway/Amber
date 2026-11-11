import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { zhCN } from "../../../../src/shared/i18n/zh-CN/index.ts";
import { acceptedSuggestionsText, diarizationStatusText, revisionInfo } from "../../../../src/web/pages/content/revision-info.ts";
import { revision } from "../../../fixtures/web/content-data.ts";

let t: typeof i18next.t;
beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
  t = instance.t.bind(instance);
});

const asr = (diarization?: unknown) => revision("a", { kind: "asr", generation: { kind: "asr", modelId: "fun-asr", ...(diarization === undefined ? {} : { diarization }) } });

describe("diarizationStatusText", () => {
  it("names each recorded status", () => {
    const texts = (["applied", "no_speakers", "off", "unsupported", "over_recommended"] as const).map((status) => diarizationStatusText(asr({ status }), t));
    expect(texts).toEqual([
      "发言人识别：已识别发言人",
      "发言人识别：未识别出发言人",
      "发言人识别：未开启识别",
      "发言人识别：模型不支持",
      "发言人识别：时长超过建议上限",
    ]);
  });

  it("says nothing for a revision made before the status was recorded, or one that is not from ASR", () => {
    expect(diarizationStatusText(asr(), t)).toBeUndefined();
    expect(diarizationStatusText(asr({ status: "something-new" }), t)).toBeUndefined();
    expect(diarizationStatusText(revision("p", { kind: "platform", generation: { diarization: { status: "applied" } } }), t)).toBeUndefined();
  });
});

describe("acceptedSuggestionsText", () => {
  const manual = (speakerReview: unknown) => revision("m", { kind: "manual", generation: { kind: "manual", ...(speakerReview === undefined ? {} : { speakerReview }) } });

  it("counts the sentences taken from suggestions without being checked one by one", () => {
    expect(acceptedSuggestionsText(manual({ acceptedSuggestions: 12 }), t)).toBe("12 句按建议归属，未逐句核对");
  });

  it("says nothing without such sentences", () => {
    expect(acceptedSuggestionsText(manual({ acceptedSuggestions: 0 }), t)).toBeUndefined();
    expect(acceptedSuggestionsText(manual(undefined), t)).toBeUndefined();
    expect(acceptedSuggestionsText(manual({ acceptedSuggestions: "3" }), t)).toBeUndefined();
    expect(acceptedSuggestionsText(revision("c", { kind: "corrected", generation: { speakerReview: { acceptedSuggestions: 2 } } }), t)).toBeUndefined();
  });
});

describe("revisionInfo", () => {
  // Local time, so the label reads the same in any time zone.
  const at = new Date(2026, 9, 4, 11, 24).getTime();

  it("lists the basis first and then the speaker information, one per line", () => {
    const parent = revision("a", { kind: "asr", createdAt: at, generation: { kind: "asr", modelId: "fun-asr", diarization: { status: "applied" } } });
    const child = revision("m", { kind: "manual", parentRevisionId: "a", generation: { kind: "manual", speakerReview: { acceptedSuggestions: 4 } } });
    expect(revisionInfo(child, [parent, child], t)).toBe("基于：ASR 原稿 · fun-asr · 10-04 11:24\n4 句按建议归属，未逐句核对");
    expect(revisionInfo(parent, [parent, child], t)).toBe("发言人识别：已识别发言人");
  });

  it("is undefined when there is nothing to say", () => {
    expect(revisionInfo(revision("p"), [revision("p")], t)).toBeUndefined();
  });
});
