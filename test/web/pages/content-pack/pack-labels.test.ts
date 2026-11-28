import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { zhCN } from "../../../../src/shared/i18n/zh-CN/index.ts";
import { describedRevisionLabel, quotedTitle } from "../../../../src/web/pages/content-pack/pack-labels.ts";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
});
const at = new Date(2026, 10, 18, 10, 2).getTime();

describe("describedRevisionLabel", () => {
  it("names a local revision the way the revision list does", () => {
    const t = i18n.t.bind(i18n);
    expect(describedRevisionLabel({ kind: "corrected", language: "zh", createdAt: at, modelName: "deepseek-flash" }, t, i18n)).toBe("校对稿 · deepseek-flash · 11-18 10:02");
    expect(describedRevisionLabel({ kind: "asr", language: "zh", createdAt: at }, t, i18n)).toBe("ASR 原稿 · 11-18 10:02");
    expect(describedRevisionLabel({ kind: "translated", language: "en", createdAt: at }, t, i18n)).toBe("翻译 · 英语 · 11-18 10:02");
  });
});

describe("quotedTitle", () => {
  it("quotes a title in 「」 and leaves one that carries its own 《》 as it is", () => {
    const t = i18n.t.bind(i18n);
    expect(quotedTitle("第一讲", t)).toBe("「第一讲」");
    expect(quotedTitle("《三体》", t)).toBe("《三体》");
    expect(quotedTitle("《三体》第一集", t)).toBe("「《三体》第一集」");
    expect(quotedTitle("第一集《三体》", t)).toBe("「第一集《三体》」");
    expect(quotedTitle("《", t)).toBe("「《」");
  });
});

/** Every copy string under a resource subtree. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsOf);
  return [];
}

describe("content pack copy", () => {
  it("leaves the quoting of titles and names to the caller, so no sentence wraps them in 《》", () => {
    const { titleMarks, ...copy } = zhCN.contentPack;
    expect(titleMarks).toEqual({ open: "《", close: "》" });
    expect(stringsOf(copy).filter((text) => text.includes("《") || text.includes("》"))).toEqual([]);
    // Speaker names are not titles: their sentences quote them in the copy.
    const { speakers: _speakers, ...preview } = zhCN.contentPack.import;
    expect(stringsOf(preview).filter((text) => /「\{\{(title|name)\}\}」/.test(text))).toEqual([]);
  });
});
