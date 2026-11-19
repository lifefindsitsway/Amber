import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { zhCN } from "../../../../src/shared/i18n/zh-CN/index.ts";
import { describedRevisionLabel } from "../../../../src/web/pages/content-pack/pack-labels.ts";

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
