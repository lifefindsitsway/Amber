import { expect, test } from "@playwright/test";
import { BILI_REVISION, BILIBILI_CONTENT, installMockBackend } from "./mock-backend.ts";
import { installFigureExports } from "./mock-export-figures.ts";
import { BILIBILI_TITLE } from "./mock-outputs.ts";

test("export figures: the option counts the figures, the download becomes a zip, the copy stays text, and the saved name is confirmed", async ({ page }) => {
  await installMockBackend(page);
  const { requests } = await installFigureExports(page, 3);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);
  await page.getByTestId("summary-export").click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();

  const option = page.getByTestId("export-markdown-figures");
  await expect(option).toBeEnabled();
  await expect(option).not.toBeChecked();
  await expect(page.getByLabel("包含插图与备注（3 张）").first()).toBeVisible();
  await expect(page.getByTestId("export-markdown")).toHaveText("下载 .md");
  await expect(page.getByTestId("export-copy-note")).toHaveCount(0);

  await option.check();
  await expect(page.getByTestId("export-markdown")).toHaveText("下载 .zip");
  await expect(page.getByTestId("export-markdown-figures-hint")).toHaveText("下载为 .zip：Markdown 文件加 images 文件夹，图片按阅读顺序编号");
  await expect(page.getByTestId("export-copy-note")).toHaveText("复制的 Markdown 不含图片");
  await expect(page.getByTestId("export-copy")).toHaveAccessibleDescription("复制的 Markdown 不含图片");

  const download = page.waitForEvent("download");
  await page.getByTestId("export-markdown").click();
  expect((await download).suggestedFilename()).toBe(`${BILIBILI_TITLE}.zip`);
  expect(requests.at(-1)).toEqual({
    format: "markdown",
    sections: { summary: { templateId: "summary.core" }, transcript: { revisionId: BILI_REVISION, figures: true } },
    backlinks: true,
  });
  await expect(page.getByTestId("export-saved")).toHaveText(`已导出「${BILIBILI_TITLE}.zip」`);

  // Without the transcript section there is nothing to put figures into.
  await page.getByTestId("export-transcript").uncheck();
  await expect(option).toHaveCount(0);
  await expect(page.getByTestId("export-markdown")).toHaveText("下载 .md");
  await page.getByTestId("export-transcript").check();
  await expect(option).toBeChecked();

  // TXT has its own option, under its format; the button and its note say what it becomes.
  const txtOption = page.getByTestId("export-txt-figures");
  await expect(txtOption).not.toBeChecked();
  await expect(page.getByTestId("export-format-txt")).toHaveText("TXT");
  await txtOption.check();
  await expect(page.getByTestId("export-format-txt")).toHaveText("TXT（.zip）");
  await expect(page.getByTestId("export-note-txt")).toHaveText("下载为 .zip：文稿加图片文件，文稿里用编号标出每张图的位置");
  await expect(page.getByTestId("export-note-txt")).not.toContainText("内嵌");
  const txt = page.waitForEvent("download");
  await page.getByTestId("export-format-txt").click();
  expect((await txt).suggestedFilename()).toBe(`${BILIBILI_TITLE}.zip`);
  expect(requests.at(-1)).toEqual({ format: "txt", revisionId: BILI_REVISION, figures: true });

  // The other formats never ask for figures.
  const srt = page.waitForEvent("download");
  await page.getByTestId("export-format-srt").click();
  expect((await srt).suggestedFilename()).toBe(`${BILIBILI_TITLE}.srt`);
  expect(requests.at(-1)).toEqual({ format: "srt", revisionId: BILI_REVISION });
  await expect(page.getByTestId("export-saved")).toHaveText(`已导出「${BILIBILI_TITLE}.srt」`);
});

test("export figures: without figures both options are disabled and say why, and the downloads stay plain", async ({ page }) => {
  await installMockBackend(page);
  const { requests } = await installFigureExports(page, 0);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);
  await page.getByTestId("summary-export").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();

  for (const id of ["export-markdown-figures", "export-txt-figures"]) {
    const option = page.getByTestId(id);
    await expect(option).toBeDisabled();
    await expect(option).toHaveAccessibleDescription("这条内容还没有插图");
    await expect(page.getByTestId(`${id}-hint`)).toHaveText("这条内容还没有插图");
  }
  await expect(page.getByLabel("包含插图与备注（0 张）")).toHaveCount(2);

  const download = page.waitForEvent("download");
  await page.getByTestId("export-markdown").click();
  expect((await download).suggestedFilename()).toBe(`${BILIBILI_TITLE}.md`);
  expect(requests.at(-1)).toEqual({ format: "markdown", sections: { summary: { templateId: "summary.core" }, transcript: { revisionId: BILI_REVISION } }, backlinks: true });
  await expect(page.getByTestId("export-format-txt")).toHaveText("TXT");
});
