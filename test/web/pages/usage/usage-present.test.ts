import i18next, { type TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { USAGE_LEGACY_CREDENTIAL, type UsageModalityUsage } from "../../../../src/shared/dto/usage-analytics.ts";
import {
  breakdownDescription,
  buildCredentialVersionLabels,
  callDetailText,
  credentialVersionHint,
  credentialVersionLabelOf,
  rowVersionLabels,
  usageBreakdown,
  usageLines,
  versionTagText,
  type CredentialVersionLabel,
} from "../../../../src/web/pages/usage/usage-present.ts";
import { beijing } from "../../../fixtures/usage/builders.ts";

const t = ((key: string) => key) as unknown as TFunction;

const llm = { input: "1000", output: "20", reasoning: "0", cacheRead: "0", cacheWrite: "0", cacheWrite1h: "0" };
const asr = (billedInputTokens: string, billedOutputTokens: string) => ({ audioMs: "60000", billedInputTokens, billedOutputTokens });

describe("usageLines", () => {
  it("shows billed tokens ahead of the audio for a token-billed transcription", () => {
    const usage: UsageModalityUsage = { llm: null, asr: asr("12000", "300") };
    expect(usageLines(usage, t).map((line) => [line.modality, line.unit])).toEqual([
      ["asr-tokens", "usage.units.asrTokens"],
      ["asr", "usage.units.audio"],
    ]);
  });

  it("shows the billed tokens when only one side was reported", () => {
    expect(usageLines({ llm: null, asr: asr("0", "5") }, t).map((line) => line.modality)).toEqual(["asr-tokens", "asr"]);
  });

  it("keeps only the audio line when no tokens were billed", () => {
    expect(usageLines({ llm: null, asr: asr("0", "0") }, t).map((line) => line.modality)).toEqual(["asr"]);
  });

  it("lists LLM tokens first when both modalities are present", () => {
    expect(usageLines({ llm, asr: asr("12000", "300") }, t).map((line) => line.modality)).toEqual(["llm", "asr-tokens", "asr"]);
  });
});

describe("buildCredentialVersionLabels", () => {
  const real = i18next.t.bind(i18next) as TFunction;
  const now = beijing(2026, 11, 20, 12);
  type Version = { credentialVersion: string; setAt: number | null; requests: number };
  const options = (...versions: Version[]) => [{ profileKey: "p", modality: "llm" as const, profileName: "Auth2API", deleted: false, versions }];
  const v = (credentialVersion: string, setAt: number | null): Version => ({ credentialVersion, setAt, requests: 1 });
  const texts = (versions: Version[]): Record<string, string> => {
    const labels = buildCredentialVersionLabels(options(...versions), real, now).get("p");
    return Object.fromEntries([...(labels?.versions.values() ?? [])].map((label) => [label.credentialVersion, label.text]));
  };

  it("tells a profile with one version not to tag its rows, and one with two (the early records included) to tag them", () => {
    expect(buildCredentialVersionLabels(options(v("a", beijing(2026, 11, 2))), real, now).get("p")?.distinct).toBe(false);
    expect(buildCredentialVersionLabels(options(v("a", beijing(2026, 11, 2)), v(USAGE_LEGACY_CREDENTIAL, null)), real, now).get("p")?.distinct).toBe(true);
  });

  it("names versions by the day they were saved when that tells them apart", () => {
    expect(texts([v("new", beijing(2026, 11, 20, 14, 5)), v("old", beijing(2026, 11, 2, 9))])).toEqual({ new: "11-20 起", old: "11-02 起" });
  });

  it("adds the year when the day was in another year", () => {
    expect(texts([v("new", beijing(2026, 1, 3)), v("old", beijing(2025, 11, 20))])).toEqual({ new: "01-03 起", old: "2025-11-20 起" });
  });

  it("adds the time of day only to the versions saved on the same day", () => {
    expect(texts([v("a", beijing(2026, 11, 20, 9, 30)), v("b", beijing(2026, 11, 20, 14, 5)), v("c", beijing(2026, 11, 2))])).toEqual({
      a: "11-20 09:30 起",
      b: "11-20 14:05 起",
      c: "11-02 起",
    });
  });

  it("numbers versions saved in the same minute by saving time, then by id", () => {
    const minute = beijing(2026, 11, 20, 14, 5);
    expect(texts([v("z", minute + 20_000), v("y", minute), v("x", minute + 20_000)])).toEqual({
      y: "11-20 14:05 起（1）",
      x: "11-20 14:05 起（2）",
      z: "11-20 14:05 起（3）",
    });
  });

  it("numbers the versions without a saved time, after the dated ones, and leaves a lone one bare", () => {
    expect(texts([v("q", null), v("p", null), v("d", beijing(2026, 11, 2))])).toEqual({ p: "未记录时间的版本（1）", q: "未记录时间的版本（2）", d: "11-02 起" });
    expect(texts([v("q", null), v("d", beijing(2026, 11, 2))])).toEqual({ q: "未记录时间的版本", d: "11-02 起" });
  });

  it("names the early records apart: no key prefix, no ordinal, and they do not count among the dated versions", () => {
    const labels = buildCredentialVersionLabels(options(v(USAGE_LEGACY_CREDENTIAL, null), v("a", null)), real, now);
    const legacy = labels.get("p")?.versions.get(USAGE_LEGACY_CREDENTIAL);
    expect(legacy?.text).toBe("早期记录（未区分密钥）");
    expect(legacy?.legacy).toBe(true);
    expect(labels.get("p")?.versions.get("a")?.text).toBe("未记录时间的版本");
    expect(versionTagText(legacy === undefined ? [] : [legacy], real)).toBe("早期记录（未区分密钥）");
  });

  it("keeps each profile's ladder to itself", () => {
    const day = beijing(2026, 11, 20, 9);
    const labels = buildCredentialVersionLabels(
      [
        { profileKey: "a", modality: "llm", profileName: "A", deleted: false, versions: [v("a1", day), v("a2", day + 3_600_000)] },
        { profileKey: "b", modality: "llm", profileName: "B", deleted: false, versions: [v("b1", day), v("b2", beijing(2026, 11, 2))] },
      ],
      real,
      now,
    );
    expect(labels.get("a")?.versions.get("a1")?.text).toBe("11-20 09:00 起");
    expect(labels.get("b")?.versions.get("b1")?.text).toBe("11-20 起");
  });

  it("tags a row with only the versions it used, prefixed once, with the early records apart", () => {
    const labels = buildCredentialVersionLabels(options(v("new", beijing(2026, 11, 20)), v("old", beijing(2026, 11, 2)), v(USAGE_LEGACY_CREDENTIAL, null)), real, now);
    expect(versionTagText(rowVersionLabels(labels, "p", ["old"]), real)).toBe("密钥 · 11-02 起");
    expect(versionTagText(rowVersionLabels(labels, "p", ["new", "old", null]), real)).toBe("密钥 · 11-20 起、11-02 起 · 早期记录（未区分密钥）");
    expect(rowVersionLabels(buildCredentialVersionLabels(options(v("only", beijing(2026, 11, 2))), real, now), "p", ["only"])).toEqual([]);
    expect(rowVersionLabels(labels, "unknown-profile", ["old"])).toEqual([]);
  });

  it("explains a version by when its key was saved, never by anything of the key", () => {
    const labels = buildCredentialVersionLabels(options(v("sk-secret-like-id", beijing(2026, 11, 20, 14, 5)), v("b", null), v(USAGE_LEGACY_CREDENTIAL, null)), real, now);
    const of = (id: string) => credentialVersionHint(labels.get("p")?.versions.get(id) as CredentialVersionLabel, real);
    expect(of("sk-secret-like-id")).toBe("这把 API Key 保存于 2026 年 11 月 20 日 14:05；这里统计的是使用它的调用");
    expect(of("b")).toBe("这把 API Key 的保存时间没有记录；这里统计的是使用它的调用");
    expect(of(USAGE_LEGACY_CREDENTIAL)).toBe("升级前的记录没有区分用的是哪一把 API Key");
    for (const label of labels.get("p")?.versions.values() ?? []) expect(label.text).not.toContain("sk-");
  });

  it("names a version the range does not list on its own terms", () => {
    const labels = buildCredentialVersionLabels([], real, now);
    expect(credentialVersionLabelOf(labels, "p", "x", beijing(2026, 11, 2), real, now).text).toBe("11-02 起");
    expect(credentialVersionLabelOf(labels, "p", null, null, real, now).text).toBe("早期记录（未区分密钥）");
  });
});

describe("usageBreakdown", () => {
  const real = i18next.t.bind(i18next) as TFunction;
  const rows = (usage: UsageModalityUsage) => usageBreakdown(usage, real).map((row) => [row.label, row.value, `${row.unit}${row.note}`, row.depth]);

  it("lists input with its cache parts, the one-hour cache under the cache write, and output with its reasoning", () => {
    const usage: UsageModalityUsage = { llm: { input: "1348", output: "139", reasoning: "64", cacheRead: "207", cacheWrite: "120", cacheWrite1h: "40" }, asr: null };
    expect(rows(usage)).toEqual([
      ["输入", "1,348", "tokens", 0],
      ["其中缓存读取", "207", "", 1],
      ["其中缓存写入", "120", "", 1],
      ["其中 1 小时缓存", "40", "", 2],
      ["输出", "139", "tokens", 0],
      ["其中推理", "64", "", 1],
    ]);
    expect(breakdownDescription(usageBreakdown(usage, real), real)).toBe(
      "已记录的用量：输入 1,348 tokens，其中缓存读取 207，其中缓存写入 120，其中 1 小时缓存 40，输出 139 tokens，其中推理 64",
    );
  });

  it("leaves out every part that is zero, but keeps input and output", () => {
    expect(rows({ llm: { ...llm, input: "0" }, asr: null })).toEqual([
      ["输入", "0", "tokens", 0],
      ["输出", "20", "tokens", 0],
    ]);
  });

  it("says a transcription's audio is what Amber measured, and adds billed tokens only when reported", () => {
    expect(rows({ llm: null, asr: { audioMs: String(12 * 60_000 + 30_000), billedInputTokens: "0", billedOutputTokens: "0" } })).toEqual([["处理音频", "12:30", "（Amber 测得的音频时长）", 0]]);
    expect(rows({ llm: null, asr: asr("12000", "0") })).toEqual([
      ["处理音频", "1:00", "（Amber 测得的音频时长）", 0],
      ["计费输入", "12,000", "tokens", 0],
    ]);
  });

  it("puts LLM tokens before the transcription for a row with both", () => {
    expect(usageBreakdown({ llm, asr: asr("1", "1") }, real).map((row) => row.key)).toEqual(["input", "output", "audio", "billedInput", "billedOutput"]);
  });
});

describe("callDetailText", () => {
  const real = i18next.t.bind(i18next) as TFunction;
  const call = (parts: Partial<typeof llm>, inputMissing = false) => ({ inputMissing, usage: { llm: { ...llm, ...parts }, asr: null } });

  it("lists the call's non-zero parts in one line", () => {
    expect(callDetailText(call({ cacheRead: "207", reasoning: "64" }), real)).toBe("缓存读取 207 · 推理 64");
    expect(callDetailText(call({ cacheWrite: "120", cacheWrite1h: "40" }), real)).toBe("缓存写入 120（其中 1 小时 40）");
  });

  it("says when the upstream sent no input count", () => {
    expect(callDetailText(call({ input: "0", reasoning: "5" }, true), real)).toBe("上游未返回输入用量 · 推理 5");
  });

  it("is empty when there is nothing beyond input and output, and for a transcription", () => {
    expect(callDetailText(call({}), real)).toBe("");
    expect(callDetailText({ inputMissing: false, usage: { llm: null, asr: asr("100", "2") } }, real)).toBe("");
  });
});
