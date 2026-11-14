import { expect, test, type Locator, type Page } from "@playwright/test";
import { THEMES, type Theme } from "../../src/shared/dto/settings.ts";
import type { SpeakerDto } from "../../src/shared/dto/speaker.ts";
import type { SubtitleInspectResponse } from "../../src/shared/dto/subtitle-import.ts";
import { installMockBackend } from "./mock-backend.ts";
import { digestOf, IMPORT_CONTENT, IMPORT_REVISION, IMPORT_TITLE, installSubtitleImport, machineTranslation, type PreviewScript, type SubtitleImportState } from "./mock-subtitle-import.ts";
import { setTheme } from "./mock-usage.ts";

/*
 * Importing subtitle files: the preview shared by the import dialog and the new page, what
 * each format expands into, the choices recounted without asking the server again, the
 * options an import sends, conflicts and failures, the one-line result, the subtitle package
 * export, and how the dialog reads with the keyboard, at a narrow width and in every theme.
 */

type Preview = Omit<SubtitleInspectResponse, "digest" | "target">;

/** An SRT whose cues start with 「张三：」 or 「李四：」 four and three times, 「注意：」 once, two unlabelled. */
const PREFIX_SRT = ["张三：大家好", "张三：今天讲字幕", "先看第一部分", "然后是第二部分", "李四：我有个问题", "李四：关于时间轴", "李四：怎么对齐", "注意：这里要小心", "张三：好问题", "张三：我们继续"]
  .map((line, index) => `${index + 1}\n00:00:${String(index * 5).padStart(2, "0")},000 --> 00:00:${String(index * 5 + 4).padStart(2, "0")},000\n${line}\n`)
  .join("\n");

/**
 * The preview of PREFIX_SRT: 张三 (4, preselected), 李四 (3, preselected), 注意 (1, not). In
 * file order: 张三 ×2, unlabelled ×2, 李四 ×3, 注意, 张三 ×2.
 */
const PREFIX_PREVIEW: Preview = {
  format: "srt",
  cueCount: 10,
  droppedCues: { count: 0, samples: [] },
  rangeMs: { start: 0, end: 49_000 },
  speakers: {
    source: "prefix",
    candidates: [
      { key: "张三", label: "张三", count: 4, preselected: true },
      { key: "李四", label: "李四", count: 3, preselected: true },
      { key: "注意", label: "注意", count: 1, preselected: false },
    ],
    sequence: [
      [0, 2],
      [-1, 2],
      [1, 3],
      [2, 1],
      [0, 2],
    ],
  },
  limits: ["speaker_identity", "unlabeled_inferred"],
};

/** An Amber subtitle package: 2,888 sentences, two speakers, an English translation. */
const PACKAGE_PREVIEW: Preview = {
  format: "ambersub",
  cueCount: 2888,
  droppedCues: { count: 0, samples: [] },
  rangeMs: { start: 0, end: 3_723_000 },
  speakers: {
    source: "package",
    candidates: [
      { key: "s1", label: "张三", count: 2000, preselected: true },
      { key: "s2", label: "发言人 2", count: 888, preselected: true },
    ],
    sequence: [
      [0, 2000],
      [1, 888],
    ],
  },
  bilingual: { source: "package", count: 2888, samples: [{ original: "你好", translation: "Hello" }], languages: ["en"] },
  package: { formatVersion: 1, generator: { app: "Amber", version: "0.7.0" }, language: "zh-CN", segmentCount: 2888, speakerCount: 2, translationLanguages: ["en"] },
  limits: ["package_scope"],
};

/** Six two-line cues whose second line may be a translation; three pairs are offered as samples. */
const BILINGUAL_LINES: NonNullable<Preview["bilingual"]> = {
  source: "lines",
  count: 6,
  samples: [
    { original: "大家好", translation: "Hello everyone" },
    { original: "今天讲字幕", translation: "Today: subtitles" },
    { original: "第三对", translation: "Third pair" },
  ],
};

/** An SRT whose cues are all two lines, without speakers. */
const BILINGUAL_PREVIEW: Preview = {
  format: "srt",
  cueCount: 6,
  droppedCues: { count: 0, samples: [] },
  rangeMs: { start: 0, end: 30_000 },
  speakers: { source: "none", candidates: [], sequence: [[-1, 6]] },
  bilingual: BILINGUAL_LINES,
  limits: [],
};

/** A styled ASS whose restore data no longer matches its dialogue lines, read as a plain ASS naming two speakers. */
const MISMATCH_ASS_PREVIEW: Preview = {
  format: "ass",
  cueCount: 8,
  droppedCues: { count: 0, samples: [] },
  rangeMs: { start: 0, end: 40_000 },
  speakers: {
    source: "explicit",
    candidates: [
      { key: "林老师", label: "林老师", count: 5, preselected: true },
      { key: "王同学", label: "王同学", count: 2, preselected: true },
    ],
    sequence: [
      [0, 3],
      [1, 2],
      [0, 2],
      [-1, 1],
    ],
  },
  limits: ["restore_data_mismatch", "speaker_identity", "centisecond_timing"],
};

const file = (name: string, text: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") });
const SRT_TEXT = "1\n00:00:00,000 --> 00:00:04,000\n大家好\n";
const BILINGUAL_SRT = "1\n00:00:00,000 --> 00:00:04,000\n大家好\nHello everyone\n\n2\n00:00:05,000 --> 00:00:09,000\n今天讲字幕\nToday: subtitles\n";
const PACKAGE_TEXT = JSON.stringify({ amberSubtitlePackage: 1, note: "scripted by the fake" });

const existingSpeaker = (id: string, ordinal: number, name: string | undefined, used: boolean): SpeakerDto => ({
  id,
  ordinal,
  ...(name === undefined ? {} : { name }),
  colorIndex: ordinal - 1,
  used,
});

type Setup = Parameters<typeof installSubtitleImport>[1] & {
  theme?: Theme;
  /** A narrow window stacks the player and the outputs behind tabs; the outputs are opened. */
  narrow?: boolean;
};

async function openContent(page: Page, previews: Record<string, PreviewScript>, setup: Setup = {}): Promise<SubtitleImportState> {
  const { theme, narrow, ...initial } = setup;
  await installMockBackend(page);
  if (theme !== undefined) await setTheme(page, theme);
  const state = await installSubtitleImport(page, { previews: new Map(Object.entries(previews)), ...initial });
  await page.goto(`/contents/${IMPORT_CONTENT}?tab=subtitles`);
  if (narrow === true) await page.getByRole("tab", { name: "产出物" }).click();
  await expect(page.getByTestId("subtitles-version")).toBeVisible();
  return state;
}

/** Opens 「导入字幕」 and picks a file; resolves with the dialog. */
async function importFile(page: Page, name: string, text: string): Promise<Locator> {
  await page.getByTestId("subtitles-toolbar").getByRole("button", { name: "导入字幕" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("subtitle-import-dialog")).toBeVisible();
  await dialog.getByTestId("subtitle-import-file").setInputFiles(file(name, text));
  return dialog;
}

/** The last import body, parsed loosely for assertions. */
function lastImport(state: SubtitleImportState): Record<string, unknown> {
  return state.imports.at(-1) as Record<string, unknown>;
}

const versionOptions = (page: Page) => page.getByTestId("subtitles-version").locator("option");

test("an SRT with leading names: the choices recount offline, the import sends them, the result and warnings show and the versions refresh", async ({ page }) => {
  const state = await openContent(page, { "lecture.srt": { preview: PREFIX_PREVIEW } }, { importWarnings: ["subtitle_cue_dropped", "subtitle_gap"] });
  const dialog = await importFile(page, "lecture.srt", PREFIX_SRT);

  const preview = dialog.getByTestId("subtitle-preview");
  await expect(preview).toHaveAttribute("data-format", "srt");
  await expect(preview.getByTestId("subtitle-preview-summary")).toHaveText("10 句 · 0:00 – 0:49");
  const candidates = preview.getByTestId("subtitle-preview-candidate");
  await expect(candidates).toHaveCount(3);
  await expect(preview.getByRole("group", { name: "行首名字" })).toContainText("张三4 句");
  await expect(preview.getByRole("group", { name: "行首名字" })).toContainText("注意1 句");
  await expect(candidates.nth(0)).toBeChecked();
  await expect(candidates.nth(1)).toBeChecked();
  await expect(candidates.nth(2)).not.toBeChecked();
  const stats = preview.getByTestId("subtitle-preview-stats");
  await expect(stats).toHaveText("有标注 7 句 · 沿用（推断）3 句 · 未分配 0 句");
  await expect(preview.getByTestId("subtitle-preview-unlabeled-inherit")).toBeChecked();

  // Every change is recounted from the preview alone.
  await preview.getByTestId("subtitle-preview-unlabeled-unassigned").check();
  await expect(stats).toHaveText("有标注 7 句 · 沿用（推断）0 句 · 未分配 3 句");
  await candidates.nth(2).check();
  await expect(stats).toHaveText("有标注 8 句 · 沿用（推断）0 句 · 未分配 2 句");
  await candidates.nth(1).uncheck();
  await expect(stats).toHaveText("有标注 5 句 · 沿用（推断）0 句 · 未分配 5 句");
  await candidates.nth(1).check();
  expect(state.inspects).toEqual([{ text: PREFIX_SRT, filename: "lecture.srt", contentId: IMPORT_CONTENT }]);
  await expect(dialog.getByTestId("subtitle-import-language")).toHaveValue("zh-CN");

  await dialog.getByTestId("subtitle-import-submit").click();
  const result = dialog.getByTestId("subtitle-import-result");
  await expect(result.getByTestId("subtitle-import-summary")).toHaveText("已导入 10 句 · 3 位发言人");
  await expect(result.getByTestId("subtitle-import-warnings").locator("li")).toHaveText(["字幕中间有很长的空白", "跳过了无效的字幕条（正文为空或时间无效）"]);
  expect(lastImport(state)).toEqual({
    text: PREFIX_SRT,
    filename: "lecture.srt",
    format: "srt",
    language: "zh-CN",
    options: {
      expectedDigest: digestOf(PREFIX_SRT),
      speakers: { prefixNames: ["张三", "李四", "注意"], unlabeled: "unassigned" },
      setCurrent: true,
      expectedState: { primaryRevisionId: IMPORT_REVISION, currentTranslations: {}, speakers: [], speakerRoom: 128 },
    },
  });
  expect(state.inspects).toHaveLength(1);

  await result.getByTestId("subtitle-import-done").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The revision list was read again: the import is there and, made current, shown.
  await expect(versionOptions(page).filter({ hasText: /^导入字幕 · / })).toHaveCount(1);
  await expect(page.getByTestId("subtitles-version").locator("option:checked")).toHaveText(/^导入字幕 · /);
  await expect(page.getByTestId("subtitle-rows")).toContainText("导入的第 1 句字幕导入模拟。");
});

test("a subtitle package shows its three numbers and what it restores, imports without per-name choices, and its translation is labelled 「导入译文」", async ({ page }) => {
  const state = await openContent(page, { "lecture.ambersub": { preview: PACKAGE_PREVIEW } });
  const dialog = await importFile(page, "lecture.ambersub", PACKAGE_TEXT);

  const preview = dialog.getByTestId("subtitle-preview");
  await expect(preview.getByRole("heading", { level: 3 })).toHaveText("字幕预览：Amber 字幕包");
  await expect(preview.getByTestId("subtitle-preview-summary")).toHaveText("原文：简体中文 · 0:00 – 1:02:03 · 由 Amber 0.7.0 导出");
  await expect(preview.getByTestId("subtitle-preview-package-sentences")).toHaveText("句数2,888");
  await expect(preview.getByTestId("subtitle-preview-package-speakers")).toHaveText("发言人2");
  await expect(preview.getByTestId("subtitle-preview-package-translations")).toHaveText("译文语言英语");
  await expect(preview.getByTestId("subtitle-preview-package")).toContainText("还原逐句时间、正文、发言人（序号与颜色）、段落与各语言译文");
  await expect(preview.getByTestId("subtitle-preview-candidate")).toHaveCount(0);
  await expect(preview.getByTestId("subtitle-preview-translation")).toHaveCount(0);
  // The package names its own language and scope.
  await expect(dialog.getByTestId("subtitle-import-language")).toHaveCount(0);
  await expect(preview.getByTestId("subtitle-preview-limits")).toHaveCount(0);

  await dialog.getByTestId("subtitle-import-submit").click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入 2,888 句 · 2 位发言人 · 英语译文");
  expect(lastImport(state)).toEqual({
    text: PACKAGE_TEXT,
    filename: "lecture.ambersub",
    format: "ambersub",
    language: "zh-CN",
    options: {
      expectedDigest: digestOf(PACKAGE_TEXT),
      setCurrent: true,
      expectedState: { primaryRevisionId: IMPORT_REVISION, currentTranslations: {}, speakers: [], speakerRoom: 128 },
    },
  });
  await dialog.getByTestId("subtitle-import-done").click();
  await expect(versionOptions(page).filter({ hasText: /^导入字幕 · / })).toHaveCount(1);
  await expect(versionOptions(page).filter({ hasText: /^导入译文 · 英语 · / })).toHaveCount(1);
});

test("a bilingual SRT only suggests its translation: not preselected, two samples, and a chosen language is sent", async ({ page }) => {
  const state = await openContent(page, { "bilingual.srt": { preview: BILINGUAL_PREVIEW } });
  const dialog = await importFile(page, "bilingual.srt", BILINGUAL_SRT);

  const section = dialog.getByTestId("subtitle-preview-translation");
  await expect(section).toContainText("6 条字幕恰好两行，第二行可能是译文");
  const samples = section.getByRole("list", { name: "配对示例" }).locator("li");
  await expect(samples).toHaveCount(2);
  await expect(samples.nth(0)).toHaveText("原文：大家好译文：Hello everyone");
  const language = section.getByTestId("subtitle-preview-translation-language");
  await expect(language.locator("option:checked")).toHaveText("不导入译文");
  // The subtitle's own language is no translation language.
  await expect(language.locator("option", { hasText: "简体中文" })).toHaveCount(0);
  await expect(language.locator("option", { hasText: "英语" })).toHaveCount(1);

  await language.selectOption({ label: "英语" });
  await dialog.getByTestId("subtitle-import-submit").click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入 6 句 · 英语译文");
  expect((lastImport(state)["options"] as Record<string, unknown>)["translationLanguage"]).toBe("en");
  expect(Object.keys(lastImport(state)["options"] as object)).not.toContain("speakers");
});

test("a bilingual SRT left at 「不导入译文」 sends no translation language", async ({ page }) => {
  const state = await openContent(page, { "bilingual.srt": { preview: BILINGUAL_PREVIEW } });
  const dialog = await importFile(page, "bilingual.srt", BILINGUAL_SRT);
  await expect(dialog.getByTestId("subtitle-preview-translation-language")).toBeVisible();
  await dialog.getByTestId("subtitle-import-submit").click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入 6 句");
  expect(lastImport(state)["options"]).not.toHaveProperty("translationLanguage");
});

test("a name an existing speaker has: a new speaker by default, or one of the same-named ones, sent as an identity", async ({ page }) => {
  const zhangUsed = "01J00000000000000000SPKZ01";
  const zhangUnused = "01J00000000000000000SPKZ02";
  const state = await openContent(
    page,
    { "lecture.srt": { preview: PREFIX_PREVIEW } },
    { speakers: [existingSpeaker(zhangUsed, 1, "张三", true), existingSpeaker("01J00000000000000000SPKW01", 2, "王五", true), existingSpeaker(zhangUnused, 3, "张三", false)] },
  );
  const dialog = await importFile(page, "lecture.srt", PREFIX_SRT);

  const rows = dialog.getByTestId("subtitle-preview-identity");
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toHaveAttribute("data-key", "张三");
  await expect(row.locator("legend")).toHaveText("文件中的「张三」· 4 句");
  await expect(row.getByTestId("subtitle-preview-identity-create")).toBeChecked();
  const reuse = row.getByTestId("subtitle-preview-identity-reuse");
  await expect(reuse).toHaveCount(2);
  await expect(row.getByText("序号 1 · 已在稿中使用")).toBeVisible();
  await expect(row.getByText("序号 3 · 未被引用")).toBeVisible();

  await row.locator(`[data-speaker-id="${zhangUsed}"]`).check();
  await expect(row.getByTestId("subtitle-preview-identity-create")).not.toBeChecked();
  await dialog.getByTestId("subtitle-import-submit").click();
  // 张三 continues an existing speaker, so only 李四 is new.
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入 10 句 · 2 位发言人");
  expect(lastImport(state)["options"]).toEqual({
    expectedDigest: digestOf(PREFIX_SRT),
    speakers: { prefixNames: ["张三", "李四"], unlabeled: "inherit" },
    identities: [{ key: "张三", speakerId: zhangUsed }],
    setCurrent: true,
    expectedState: { primaryRevisionId: IMPORT_REVISION, currentTranslations: {}, speakers: [{ id: zhangUsed, name: "张三" }], speakerRoom: 125 },
  });
});

test("「导入后设为当前版本」 starts checked, says a current translation is replaced, and unchecked keeps the current versions", async ({ page }) => {
  const english = machineTranslation("en");
  const state = await openContent(page, { "lecture.ambersub": { preview: PACKAGE_PREVIEW } }, { machineTranslations: ["en"] });
  const dialog = await importFile(page, "lecture.ambersub", PACKAGE_TEXT);

  const current = dialog.getByTestId("subtitle-preview-set-current");
  await expect(current).toBeChecked();
  const note = dialog.getByTestId("subtitle-preview-current-note");
  await expect(note).toHaveText("导入的译文会设为当前，现有译文保留在历史中");
  await expect(current).toHaveAccessibleDescription("导入的译文会设为当前，现有译文保留在历史中");
  await current.uncheck();
  await expect(note).toHaveText("只新增版本，当前稿与译文不变");

  await dialog.getByTestId("subtitle-import-submit").click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toBeVisible();
  const options = lastImport(state)["options"] as Record<string, unknown>;
  expect(options["setCurrent"]).toBe(false);
  expect(options["expectedState"]).toMatchObject({ currentTranslations: { en: english.id } });
  await dialog.getByTestId("subtitle-import-done").click();
  // Not made current: the original stays the shown version.
  await expect(page.getByTestId("subtitles-version").locator("option:checked")).toHaveText(/^平台字幕 · /);
  await expect(versionOptions(page).filter({ hasText: /^导入字幕 · / })).toHaveCount(1);
});

test("more new speakers than the Content has room for disable the import with the reason", async ({ page }) => {
  const state = await openContent(page, { "lecture.srt": { preview: PREFIX_PREVIEW } }, { speakerRoom: 1 });
  const dialog = await importFile(page, "lecture.srt", PREFIX_SRT);

  const capacity = dialog.getByTestId("subtitle-preview-capacity");
  await expect(capacity).toHaveText("需要新建 2 位发言人，但只剩 1 个名额。请少选几个名字，或改为沿用现有发言人。");
  await expect(dialog.getByTestId("subtitle-preview-blockers")).toHaveAttribute("role", "alert");
  await expect(dialog.getByTestId("subtitle-import-submit")).toBeDisabled();

  await dialog.getByTestId("subtitle-preview-candidate").nth(1).uncheck();
  await expect(capacity).toHaveCount(0);
  await expect(dialog.getByTestId("subtitle-import-submit")).toBeEnabled();
  expect(state.imports).toEqual([]);
});

test("an import refused because the file or the Content changed asks for a fresh preview, which keeps the choices", async ({ page }) => {
  const state = await openContent(
    page,
    { "lecture.srt": { preview: PREFIX_PREVIEW } },
    {
      importFailures: [
        { status: 409, errorClass: "conflict", code: "conflict.subtitle_changed" },
        { status: 409, errorClass: "conflict", code: "conflict.primary_changed" },
      ],
    },
  );
  const dialog = await importFile(page, "lecture.srt", PREFIX_SRT);
  await dialog.getByTestId("subtitle-preview-unlabeled-unassigned").check();
  const submit = dialog.getByTestId("subtitle-import-submit");
  const error = dialog.getByTestId("subtitle-import-error");

  await submit.click();
  await expect(error).toContainText("字幕文件在预览之后有变化，请重新选择文件或重新预览");
  await expect(submit).toBeDisabled();
  await error.getByTestId("subtitle-import-repreview").click();
  await expect(error).toHaveCount(0);
  await expect(dialog.getByTestId("subtitle-preview-unlabeled-unassigned")).toBeChecked();
  expect(state.inspects).toHaveLength(2);

  await submit.click();
  await expect(error).toContainText("当前稿已变化，请重新载入后再提交");
  await error.getByTestId("subtitle-import-repreview").click();
  await expect(error).toHaveCount(0);
  expect(state.inspects).toHaveLength(3);

  await submit.click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入 10 句 · 2 位发言人");
  expect(state.imports).toHaveLength(3);
  expect((lastImport(state)["options"] as { speakers: unknown }).speakers).toEqual({ prefixNames: ["张三", "李四"], unlabeled: "unassigned" });
});

test("a preview that fails shows why; a plain import sends no options, and a failure a plain import would repeat offers none", async ({ page }) => {
  const state = await openContent(page, {
    "odd.srt": { error: { status: 400, errorClass: "invalid_request", code: "invalid_request" } },
    "newer.ambersub": { error: { status: 400, errorClass: "invalid_request", code: "invalid_request.subtitle_newer" } },
  });
  const dialog = await importFile(page, "newer.ambersub", PACKAGE_TEXT);
  const failed = dialog.getByTestId("subtitle-preview-failed");
  await expect(failed).toContainText("这个字幕包来自更新版本的 Amber，请升级后再导入");
  await expect(failed).not.toContainText("仍可按普通字幕导入");
  await expect(dialog.getByTestId("subtitle-import-submit")).toBeDisabled();

  await dialog.getByTestId("subtitle-import-file").setInputFiles(file("odd.srt", SRT_TEXT));
  await expect(failed).toContainText("仍可按普通字幕导入：只导入时间和正文，不识别发言人与译文");
  // 「重新预览」 asks again.
  await failed.getByTestId("subtitle-preview-retry").click();
  await expect(failed).toBeVisible();
  expect(state.inspects).toHaveLength(3);
  const submit = dialog.getByTestId("subtitle-import-submit");
  await expect(submit).toHaveText("按普通字幕导入");
  await expect(dialog.getByTestId("subtitle-import-language")).toHaveValue("zh-CN");
  await submit.click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入字幕");
  expect(lastImport(state)).toEqual({ text: SRT_TEXT, filename: "odd.srt", language: "zh-CN" });
});

test("a styled ASS whose restore data no longer matches says so first and lists its speakers as named in the file", async ({ page }) => {
  const intact: Preview = {
    ...PACKAGE_PREVIEW,
    format: "ass",
    bilingual: { source: "package", count: 2888, samples: [{ original: "你好", translation: "Hello" }], languages: ["en"] },
  };
  const state = await openContent(page, { "edited.ass": { preview: MISMATCH_ASS_PREVIEW }, "styled.ass": { preview: intact } });
  const dialog = await importFile(page, "edited.ass", "[Script Info]\n");

  const preview = dialog.getByTestId("subtitle-preview");
  await expect(preview.getByTestId("subtitle-preview-notices").locator('[data-notice="mismatch"]')).toHaveText("文件被修改过，按普通 ASS 导入");
  await expect(preview.getByRole("heading", { level: 3 })).toHaveText("字幕预览：ASS");
  const speakers = preview.getByTestId("subtitle-preview-speakers");
  await expect(speakers).toHaveAttribute("data-source", "explicit");
  await expect(speakers.getByTestId("subtitle-preview-speaker")).toHaveText(["林老师5 句", "王同学2 句"]);
  await expect(speakers).toContainText("另有 1 句没有标注，保持未分配");
  // The mismatch is the notice, not one of the listed differences.
  const limits = preview.getByTestId("subtitle-preview-limits");
  await expect(limits.locator("summary")).toHaveText("导入后会有的差异（2）");
  await limits.locator("summary").click();
  await expect(limits.locator("li")).toHaveText(["标准格式不保存发言人身份，同名的不同发言人会合为一人", "ASS 的时间精度为 10 毫秒"]);

  // A styled ASS whose restore data held reads like a package.
  await dialog.getByTestId("subtitle-import-file").setInputFiles(file("styled.ass", "[Script Info]\n; styled\n"));
  await expect(preview.getByRole("heading", { level: 3 })).toHaveText("字幕预览：带样式 ASS · 含还原数据");
  await expect(preview.getByTestId("subtitle-preview-notices")).toHaveCount(0);
  await expect(preview.getByTestId("subtitle-preview-package")).toBeVisible();
  expect(state.inspects).toHaveLength(2);
});

test("TXT and Markdown are imported as reference text without a preview", async ({ page }) => {
  const state = await openContent(page, {});
  const dialog = await importFile(page, "notes.md", "# 讲义\n\n要点");
  await expect(dialog.getByTestId("subtitle-import-reference")).toHaveText("将导入为参考文本，可用于总结与对话，不生成字幕稿");
  await expect(dialog.getByTestId("subtitle-preview")).toHaveCount(0);
  await expect(dialog.getByTestId("subtitle-import-language")).toHaveCount(0);

  await dialog.getByTestId("subtitle-import-file").setInputFiles(file("notes.txt", "要点一\n要点二"));
  await dialog.getByTestId("subtitle-import-submit").click();
  await expect(dialog.getByTestId("subtitle-import-summary")).toHaveText("已导入为参考文本");
  expect(state.inspects).toEqual([]);
  expect(state.imports).toEqual([{ text: "要点一\n要点二", filename: "notes.txt" }]);
});

test.describe("new page", () => {
  const MEDIA = { name: "lecture.mp4", mimeType: "video/mp4", buffer: Buffer.from("not really a video") };

  test("an attached subtitle is previewed under it, turns automatic proofreading off until the user decides, and its options go in a part before the subtitle", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    const state = await installSubtitleImport(page, { previews: new Map([["lecture.srt", { preview: PREFIX_PREVIEW }]]) });
    await page.goto("/new");
    await page.getByRole("tab", { name: "上传本地文件" }).click();
    await page.getByTestId("upload-file").setInputFiles(MEDIA);
    await page.getByRole("button", { name: "本次设置" }).click();
    const settingsProofread = page.getByRole("checkbox", { name: "自动校对" });
    await expect(settingsProofread).toBeChecked();

    await page.getByTestId("upload-subtitle").setInputFiles(file("lecture.srt", PREFIX_SRT));
    const preview = page.getByTestId("subtitle-preview");
    await expect(preview.getByTestId("subtitle-preview-stats")).toHaveText("有标注 7 句 · 沿用（推断）3 句 · 未分配 0 句");
    // Without a Content there is nothing to map onto or make current.
    await expect(preview.getByTestId("subtitle-preview-set-current")).toHaveCount(0);
    const proofread = page.getByTestId("subtitle-auto-proofread");
    await expect(proofread.getByRole("checkbox")).not.toBeChecked();
    await expect(proofread).toContainText("已附带字幕，默认不用 AI 改写；总结和章节仍会生成");
    await expect(proofread.getByRole("checkbox")).toHaveAccessibleDescription("已附带字幕，默认不用 AI 改写；总结和章节仍会生成");
    // One checkbox only: the settings section no longer shows its own.
    await expect(page.getByRole("checkbox", { name: "自动校对" })).toHaveCount(1);

    // Removing the subtitle brings the default back.
    await page.getByTestId("upload-remove-subtitle").click();
    await expect(page.getByTestId("subtitle-preview")).toHaveCount(0);
    await expect(settingsProofread).toBeChecked();

    // The user's choice wins while the subtitle stays.
    await page.getByTestId("upload-subtitle").setInputFiles(file("lecture.srt", PREFIX_SRT));
    await expect(proofread.getByRole("checkbox")).not.toBeChecked();
    await proofread.getByRole("checkbox").check();
    await preview.getByTestId("subtitle-preview-candidate").nth(2).check();
    await expect(proofread.getByRole("checkbox")).toBeChecked();
    await page.getByTestId("upload-subtitle-language").selectOption("zh-CN");
    await page.getByTestId("new-submit").click();

    await expect.poll(() => state.uploads.length).toBe(1);
    const parts = state.uploads[0] ?? [];
    const names = parts.map((part) => part.name);
    expect(names.indexOf("subtitleOptions")).toBe(names.indexOf("subtitle") - 1);
    expect(names.at(-1)).toBe("file");
    expect(parts.find((part) => part.name === "subtitleLanguage")?.value).toBe("zh-CN");
    expect(JSON.parse(parts.find((part) => part.name === "subtitleOptions")?.value ?? "null")).toEqual({
      expectedDigest: digestOf(PREFIX_SRT),
      speakers: { prefixNames: ["张三", "李四", "注意"], unlabeled: "inherit" },
    });
    expect(JSON.parse(parts.find((part) => part.name === "settings")?.value ?? "null")).toMatchObject({ autoProofread: true });
  });

  test("a link with a subtitle package: the language comes from the package, proofreading stays off and `initialSubtitle.options` is sent", async ({ page }) => {
    const backend = await installMockBackend(page);
    const state = await installSubtitleImport(page, { previews: new Map([["lecture.ambersub", { preview: PACKAGE_PREVIEW }]]) });
    await page.goto("/new");
    await page.getByRole("tab", { name: "导入字幕" }).click();
    await page.getByLabel("音视频链接").fill("https://www.youtube.com/watch?v=mockVideo01");
    await page.getByTestId("subtitle-file").setInputFiles(file("lecture.ambersub", PACKAGE_TEXT));
    await expect(page.getByTestId("subtitle-preview-package")).toBeVisible();
    await expect(page.getByTestId("subtitle-language")).toHaveCount(0);
    await expect(page.getByTestId("subtitle-auto-proofread").getByRole("checkbox")).not.toBeChecked();
    await page.getByTestId("new-submit").click();

    await expect.poll(() => backend.mutations.some((mutation) => mutation.path === "/api/contents/import")).toBe(true);
    const body = backend.mutations.find((mutation) => mutation.path === "/api/contents/import")?.body as { items: unknown[]; settings: Record<string, unknown> };
    expect(body.items).toEqual([
      {
        url: "https://www.youtube.com/watch?v=mockVideo01",
        initialSubtitle: { text: PACKAGE_TEXT, language: "zh-CN", format: "ambersub", options: { expectedDigest: digestOf(PACKAGE_TEXT) } },
      },
    ]);
    expect(body.settings["autoProofread"]).toBe(false);
    expect(state.inspects).toEqual([{ text: PACKAGE_TEXT, filename: "lecture.ambersub" }]);
  });
});

test("export: 「Amber 字幕包」 with its note in the dialog and the quick menu, made from an original only", async ({ page }) => {
  const english = machineTranslation("en");
  const state = await openContent(page, {}, { machineTranslations: ["en"] });

  // The quick menu offers it for the original and not for a translation.
  await page.getByTestId("subtitles-download").click();
  const quick = page.getByTestId("subtitles-download-ambersub");
  await expect(quick).toContainText("Amber 字幕包");
  await expect(quick).toContainText("用于在另一台设备上还原");
  const quickFile = page.waitForEvent("download");
  await quick.click();
  expect((await quickFile).suggestedFilename()).toBe(`${IMPORT_TITLE}.ambersub`);
  expect(state.exports.at(-1)).toEqual({ format: "ambersub", revisionId: IMPORT_REVISION });
  await page.getByTestId("subtitles-version").selectOption(english.id);
  await page.getByTestId("subtitles-download").click();
  await expect(page.getByTestId("subtitles-download-srt")).toBeVisible();
  await expect(page.getByTestId("subtitles-download-ambersub")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("output-tab-summary").click();
  await page.getByTestId("summary-export").click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();
  const button = dialog.getByTestId("export-format-ambersub");
  await expect(button).toHaveText("Amber 字幕包");
  await expect(dialog.getByTestId("export-note-ambersub")).toHaveText("在另一台设备上完整还原字幕、发言人与译文，需要 Amber 0.7.0 或更高版本");
  await expect(button).toHaveAccessibleDescription("在另一台设备上完整还原字幕、发言人与译文，需要 Amber 0.7.0 或更高版本");

  await dialog.getByTestId("export-subtitle-revision").selectOption(english.id);
  await expect(button).toBeDisabled();
  await expect(dialog.getByTestId("export-ambersub-translated")).toBeVisible();
  await dialog.getByTestId("export-subtitle-revision").selectOption(IMPORT_REVISION);
  await expect(button).toBeEnabled();
  const download = page.waitForEvent("download");
  await button.click();
  expect((await download).suggestedFilename()).toBe(`${IMPORT_TITLE}.ambersub`);
  expect(state.exports.at(-1)).toEqual({ format: "ambersub", revisionId: IMPORT_REVISION });
});

test("keyboard only: open, pick, choose, read the differences and close", async ({ page }) => {
  await openContent(page, { "lecture.srt": { preview: PREFIX_PREVIEW } });
  const open = page.getByTestId("subtitles-toolbar").getByRole("button", { name: "导入字幕" });
  await open.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "导入字幕" });
  await expect(dialog).toBeVisible();

  /** Tabs forward until `target` has the focus; fails after too many stops. */
  const tabTo = async (target: Locator): Promise<void> => {
    for (let stops = 0; stops < 30; stops += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) return;
      await page.keyboard.press("Tab");
    }
    throw new Error("focus never reached the target");
  };

  const chooser = page.waitForEvent("filechooser");
  await tabTo(dialog.getByRole("button", { name: /选择文件/ }));
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(file("lecture.srt", PREFIX_SRT));

  const third = dialog.getByTestId("subtitle-preview-candidate").nth(2);
  await tabTo(third);
  await page.keyboard.press("Space");
  await expect(third).toBeChecked();
  await expect(dialog.getByTestId("subtitle-preview-stats")).toHaveText("有标注 8 句 · 沿用（推断）2 句 · 未分配 0 句");

  // The radio group moves with the arrow keys.
  await tabTo(dialog.getByTestId("subtitle-preview-unlabeled-inherit"));
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByTestId("subtitle-preview-unlabeled-unassigned")).toBeChecked();
  await expect(dialog.getByTestId("subtitle-preview-stats")).toHaveText("有标注 8 句 · 沿用（推断）0 句 · 未分配 2 句");

  const current = dialog.getByTestId("subtitle-preview-set-current");
  await tabTo(current);
  await page.keyboard.press("Space");
  await expect(current).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(current).toBeChecked();

  const limits = dialog.getByTestId("subtitle-preview-limits");
  await tabTo(limits.locator("summary"));
  await page.keyboard.press("Enter");
  await expect(limits).toHaveAttribute("open", "");

  await tabTo(dialog.getByTestId("subtitle-import-submit"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Focus goes back to the button that opened the dialog, where the keyboard user left off.
  await expect(open).toBeFocused();
});

/** A file that opens every section of the dialog at once: names, identities, translation, current. */
const EVERYTHING_PREVIEW: Preview = {
  ...PREFIX_PREVIEW,
  droppedCues: { count: 2, samples: ["00:00:61,000 --> 00:00:62,000 一条时间无效、而且非常非常长的字幕，用来检查窄屏时是否会撑出横向滚动条"] },
  speakers: {
    ...PREFIX_PREVIEW.speakers,
    // A long name next to its count must wrap or truncate, not widen the dialog.
    candidates: PREFIX_PREVIEW.speakers.candidates.map((candidate, index) => (index === 1 ? { ...candidate, key: "一位名字特别特别长的主讲嘉宾老师", label: "一位名字特别特别长的主讲嘉宾老师" } : candidate)),
  },
  bilingual: BILINGUAL_LINES,
  limits: ["speaker_identity", "unlabeled_inferred", "markup_removed"],
};

async function openEverything(page: Page, extra: Pick<Setup, "theme" | "narrow"> = {}): Promise<Locator> {
  await openContent(
    page,
    { "everything.srt": { preview: EVERYTHING_PREVIEW, target: { coverageWarning: true } } },
    {
      speakers: [existingSpeaker("01J00000000000000000SPKZ01", 1, "张三", true), existingSpeaker("01J00000000000000000SPKZ02", 2, "张三", false)],
      machineTranslations: ["en"],
      ...extra,
    },
  );
  const dialog = await importFile(page, "everything.srt", PREFIX_SRT);
  await expect(dialog.getByTestId("subtitle-preview-identity")).toBeVisible();
  await dialog.getByTestId("subtitle-preview-translation-language").selectOption({ label: "英语" });
  await expect(dialog.getByTestId("subtitle-preview-current-note")).toBeVisible();
  await dialog.getByTestId("subtitle-preview-limits").locator("summary").click();
  return dialog;
}

test("at 375 px the dialog has no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  const dialog = await openEverything(page, { narrow: true });
  await expect(dialog.getByTestId("subtitle-preview-notices").locator("li")).toHaveCount(2);
  const overflow = await dialog.evaluate((element) => {
    const wide = [...element.querySelectorAll<HTMLElement>("*")]
      .filter((child) => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1 && child.getClientRects().length > 0 && getComputedStyle(child).position !== "fixed")
      .map((child) => `${child.tagName}.${child.className}`.slice(0, 80));
    return { scroll: element.scrollWidth, client: element.clientWidth, document: document.documentElement.scrollWidth, wide };
  });
  expect(overflow.wide).toEqual([]);
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  expect(overflow.document).toBeLessThanOrEqual(375);
});

for (const theme of THEMES) {
  test(`the dialog renders in the ${theme} theme without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const dialog = await openEverything(page, { theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(dialog.getByTestId("subtitle-preview")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
