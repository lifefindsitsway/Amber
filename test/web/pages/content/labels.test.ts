import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import type { TranscriptRevisionDto } from "../../../../src/shared/dto/content.ts";
import { zhCN } from "../../../../src/shared/i18n/zh-CN/index.ts";
import { revisionBasis, revisionLabel } from "../../../../src/web/pages/content/labels.ts";
import { revision } from "../../../fixtures/web/content-data.ts";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
});

/** Local time, so the labels read the same in any time zone. */
const at = (hour: number, minute: number, second = 0): number => new Date(2026, 9, 4, hour, minute, second).getTime();
const llm = (modelDisplaySnapshot: string) => ({ kind: "llm", modelRef: { providerProfileId: "p", modelId: "raw-id", modelDisplaySnapshot } });

const platform = revision("r0", { createdAt: at(11, 24) });
const first = revision("r1", { kind: "corrected", parentRevisionId: "r0", generation: llm("deepseek-flash"), createdAt: at(11, 34) });
const second = revision("r2", { kind: "corrected", parentRevisionId: "r1", generation: llm("deepseek-flash"), createdAt: at(11, 50) });
const all: TranscriptRevisionDto[] = [platform, first, second];

describe("revisionLabel", () => {
  it("names a manual revision by its time and tags an archived one", () => {
    const t = i18n.t.bind(i18n);
    const manual = revision("m1", { kind: "manual", parentRevisionId: "r0", createdAt: at(12, 5) });
    expect(revisionLabel(manual, undefined, t, i18n)).toBe("手动修订 · 10-04 12:05");
    expect(revisionLabel({ ...manual, archived: true }, undefined, t, i18n)).toBe("手动修订 · 10-04 12:05 · 已归档");
  });

  it("names kind, model and time so two proofreads by one model tell apart, and marks the current one", () => {
    const t = i18n.t.bind(i18n);
    expect(all.map((item) => revisionLabel(item, "r2", t, i18n, all))).toEqual([
      "平台字幕 · 10-04 11:24",
      "校对稿 · deepseek-flash · 10-04 11:34",
      "校对稿 · deepseek-flash · 10-04 11:50（当前）",
    ]);
  });

  it("takes an ASR model id, falls back to the model id without a display snapshot, and names a translation's language", () => {
    const t = i18n.t.bind(i18n);
    expect(revisionLabel(revision("a", { kind: "asr", generation: { kind: "asr", asrProfileId: "x", modelId: "scribe_v2" }, createdAt: at(9, 5) }), undefined, t, i18n)).toBe("ASR 原稿 · scribe_v2 · 10-04 09:05");
    expect(revisionLabel(revision("b", { kind: "corrected", generation: { kind: "llm", modelRef: { modelId: "raw-id" } }, createdAt: at(9, 5) }), undefined, t, i18n)).toBe("校对稿 · raw-id · 10-04 09:05");
    expect(revisionLabel(revision("c", { kind: "translated", language: "en", generation: llm("gpt-5.6-sol"), createdAt: at(12, 26) }), undefined, t, i18n)).toBe("翻译 · 英语 · gpt-5.6-sol · 10-04 12:26");
  });

  it("adds seconds only where two listed labels would read the same", () => {
    const t = i18n.t.bind(i18n);
    const twin = revision("r3", { kind: "corrected", generation: llm("deepseek-flash"), createdAt: at(11, 50, 42) });
    const list = [...all, twin];
    expect(revisionLabel(second, undefined, t, i18n, list)).toBe("校对稿 · deepseek-flash · 10-04 11:50:00");
    expect(revisionLabel(twin, undefined, t, i18n, list)).toBe("校对稿 · deepseek-flash · 10-04 11:50:42");
    expect(revisionLabel(first, undefined, t, i18n, list)).toBe("校对稿 · deepseek-flash · 10-04 11:34");
  });
});

describe("revisionBasis", () => {
  it("names the revision a proofread was made from, and nothing for a root or an unlisted parent", () => {
    const t = i18n.t.bind(i18n);
    expect(revisionBasis(second, all, t, i18n)).toBe("基于：校对稿 · deepseek-flash · 10-04 11:34");
    expect(revisionBasis(platform, all, t, i18n)).toBeUndefined();
    expect(revisionBasis(second, [second], t, i18n)).toBeUndefined();
  });
});
