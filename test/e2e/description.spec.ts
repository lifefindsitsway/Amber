import { expect, test, type Locator, type Page } from "@playwright/test";
import { CONTENT_DESCRIPTION_MAX_CHARS } from "../../src/shared/defaults.ts";
import { installMockBackend, LOCAL_CONTENT } from "./mock-backend.ts";
import { descriptionContentId, descriptionState, type DescriptionLecture } from "./mock-description.ts";

/*
 * A platform video's own description under the content page's title: how it reads collapsed
 * and expanded, when links appear, and 「获取简介」 / 「重新获取简介」 with every answer the
 * server can give, none of which may disturb playback, a chat draft or the reading position.
 */

test.use({ actionTimeout: 10_000 });

const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";

/** One sentence with a link: it fits, so its link shows without expanding. */
const ONE_SENTENCE = "本期讲检索增强生成的基本思路，课件见 https://example.com/rag-slides 。";
const ONE_SENTENCE_URL = "https://example.com/rag-slides";
/** Shaped like a real course description: paragraphs of Chinese with a link in the middle; 22 lines. */
const LONG_URL = "https://example.com/course/ml-intro/lecture-4?from=bilibili";
const LONG_LINES = [
  "【课程简介】",
  "本课程是《机器学习导论》的第四讲，主题是检索增强生成。",
  "我们从一个最朴素的问答系统出发，看看它为什么会“一本正经地胡说八道”。",
  "",
  "【本讲内容】",
  "1. 为什么大模型需要外部知识",
  "2. 向量检索的基本原理与常见的索引结构",
  "3. 切分、召回与重排序：每一步都会丢掉什么",
  "4. 评测：怎样知道检索真的帮上了忙",
  "",
  `课件下载：${LONG_URL}`,
  "课后习题与参考答案会在下周一更新。",
  "",
  "【参考资料】",
  "- 《信息检索导论》第六章",
  "- 课程讨论区里的精华帖",
  "- 往期直播回放（见合集）",
  "",
  "【说明】",
  "本视频仅供学习交流，转载请注明出处。",
  "如有错误欢迎在评论区指出，我们会在下一期勘误。",
  "感谢大家的支持！",
];
const LONG = LONG_LINES.join("\n");
/** Seven lines, two http(s) links, and two things that look like links but must not become one. */
const SEVEN_URLS = ["https://github.com/example/rag-demo", "http://forum.example.org/t/42"];
const SEVEN = [
  "示例代码与数据集：",
  `GitHub：${SEVEN_URLS[0]}`,
  `讨论区：${SEVEN_URLS[1]}`,
  "不是链接：javascript:alert(1)",
  "也不是：ftp://files.example.com/a.zip",
  "欢迎提交问题。",
  "下期见。",
].join("\n");
const TRUNCATED = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：这是一段很长的简介文字，用来撑满简介区域。`).join("\n");
const TRUNCATED_NOTE = `原简介较长，这里只保留了前 ${CONTENT_DESCRIPTION_MAX_CHARS} 个字符`;
const FETCHING = "正在获取简介…";
const EMPTY = "原平台没有为这个视频填写简介";
const UNKNOWN = "这次没能读到简介，可稍后重试";
const UNREACHABLE = "暂时无法连接原平台，请稍后重试";
const SOURCE_UNREACHABLE = { error: { status: 503, class: "source_unreachable", code: "source_unreachable", userMessage: UNREACHABLE } } as const;

const description = (page: Page): Locator => page.getByTestId("content-description");
const descriptionText = (page: Page): Locator => page.getByTestId("content-description-text");
const toggle = (page: Page): Locator => page.getByTestId("content-description-toggle");
const status = (page: Page): Locator => page.getByTestId("content-description-status");
const fetchButton = (page: Page): Locator => page.getByTestId("content-description-fetch");
const region = (page: Page): Locator => description(page).getByRole("region", { name: "视频简介" });

/** Sets up description lecture `n` for this browser context; it is read when the page asks for it. */
function lecture(page: Page, n: number, setup: Partial<DescriptionLecture> = {}): DescriptionLecture {
  const value: DescriptionLecture = { title: `简介模拟课程 ${n}`, platform: "bilibili", sentences: 40, answers: [], ...setup };
  descriptionState(page).lectures.set(n, value);
  return value;
}

async function openLecture(page: Page, n: number, query = ""): Promise<void> {
  await page.goto(`/contents/${descriptionContentId(n)}${query}`);
  await expect(page.getByTestId("content-title")).toHaveText(`简介模拟课程 ${n}`);
}

/** A promise the mock waits on before answering a fetch, and the function that lets it answer. */
function gate(): { hold: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release };
}

/** The ⋯ menu's 「重新获取简介」, with the menu open. */
async function menuRefetch(page: Page): Promise<Locator> {
  await page.getByTestId("content-menu").click();
  return page.getByTestId("content-menu-refetch-description");
}

/** How the description's text box lays out: whether it clips, and its height in lines. */
function clipping(page: Page): Promise<{ clipped: boolean; lines: number }> {
  return descriptionText(page).evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return { clipped: element.scrollHeight > element.clientHeight, lines: Math.round(element.clientHeight / lineHeight) };
  });
}

/** Presses a key until `target` has the focus, as a keyboard user would reach it; fails if it never does. */
async function tabTo(page: Page, target: Locator, key: "Tab" | "Shift+Tab" = "Tab", limit = 30): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

test.describe("how a description reads", () => {
  test("one sentence that fits shows whole, its link live, and nothing to expand", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 1, { description: ONE_SENTENCE, checkedAt: 1 });
    await openLecture(page, 1);
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);
    await expect(toggle(page)).toHaveCount(0);
    const link = descriptionText(page).getByRole("link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", ONE_SENTENCE_URL);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Settled: nothing to fetch, nothing to report.
    await expect(fetchButton(page)).toHaveCount(0);
    await expect(status(page)).toHaveCount(0);
  });

  test("22 lines: three lines with an ellipsis and no links until 展开; expanded it scrolls inside a capped height with 收起 in view", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 2, { description: LONG, checkedAt: 1 });
    await openLecture(page, 2);
    expect(await clipping(page)).toEqual({ clipped: true, lines: 3 });
    expect(await descriptionText(page).evaluate((element) => [getComputedStyle(element).webkitLineClamp, getComputedStyle(element).whiteSpace])).toEqual(["3", "pre-wrap"]);
    await expect(descriptionText(page).getByRole("link")).toHaveCount(0);
    await expect(toggle(page)).toHaveText("展开");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    await toggle(page).click();
    await expect(toggle(page)).toHaveText("收起");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(descriptionText(page)).toHaveText(LONG);
    const link = descriptionText(page).getByRole("link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", LONG_URL);
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const box = await region(page).evaluate((element) => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { height: element.clientHeight, scroll: element.scrollHeight, cap: Math.min(Math.max(7.5 * rem, 0.3 * window.innerHeight), 20 * rem) };
    });
    expect(box.height).toBeLessThanOrEqual(box.cap + 0.5);
    expect(box.scroll).toBeGreaterThan(box.height);
    await expect(toggle(page)).toBeInViewport();

    await toggle(page).click();
    await expect(toggle(page)).toHaveText("展开");
    await expect(descriptionText(page).getByRole("link")).toHaveCount(0);
  });

  test("seven lines with two links: only the http(s) ones become links, once expanded", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 3, { description: SEVEN, checkedAt: 1 });
    await openLecture(page, 3);
    expect((await clipping(page)).clipped).toBe(true);
    await expect(descriptionText(page).getByRole("link")).toHaveCount(0);
    await toggle(page).click();
    const links = descriptionText(page).getByRole("link");
    await expect(links).toHaveCount(2);
    expect(await links.evaluateAll((elements) => elements.map((element) => element.getAttribute("href")))).toEqual(SEVEN_URLS);
    for (const at of [0, 1]) {
      await expect(links.nth(at)).toHaveAttribute("target", "_blank");
      await expect(links.nth(at)).toHaveAttribute("rel", "noopener noreferrer");
    }
    await expect(descriptionText(page)).toContainText("javascript:alert(1)");
    await expect(descriptionText(page)).toContainText("ftp://files.example.com/a.zip");
  });

  test("no description: nothing at all under the title", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 4, { checkedAt: 1 });
    await openLecture(page, 4);
    await expect(page.getByTestId("content-title")).toBeVisible();
    await expect(description(page)).toHaveCount(0);
    await expect(status(page)).toHaveCount(0);
    await expect(fetchButton(page)).toHaveCount(0);
  });

  test("a truncated description says so at its end, only when expanded", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 5, { description: TRUNCATED, truncated: true, checkedAt: 1 });
    await openLecture(page, 5);
    await expect(page.getByTestId("content-description-truncated")).toHaveCount(0);
    await toggle(page).click();
    const note = page.getByTestId("content-description-truncated");
    await expect(note).toHaveText(TRUNCATED_NOTE);
    // The last thing inside the scrolling region, after the text.
    expect(await region(page).evaluate((element) => element.lastElementChild?.getAttribute("data-testid"))).toBe("content-description-truncated");
    await region(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(note).toBeInViewport();
  });

  test("it sits under the small print as plain text: text-sm, the muted colour, at most 70ch wide, no box", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 2, { description: LONG, checkedAt: 1 });
    await openLecture(page, 2);
    const look = await description(page).evaluate((element) => {
      const probe = (className: string): CSSStyleDeclaration => {
        const span = document.createElement("span");
        span.className = className;
        (element.parentElement as HTMLElement).append(span);
        const style = getComputedStyle(span);
        const values = { fontSize: style.fontSize, color: style.color } as CSSStyleDeclaration;
        span.remove();
        return values;
      };
      const ch = document.createElement("div");
      ch.style.width = "70ch";
      element.append(ch);
      const seventy = ch.getBoundingClientRect().width;
      ch.remove();
      const style = getComputedStyle(element);
      const meta = element.previousElementSibling as HTMLElement;
      return {
        fontSize: style.fontSize,
        textSm: probe("text-sm").fontSize,
        color: style.color,
        muted: probe("text-muted").color,
        maxWidth: Number.parseFloat(style.maxWidth),
        seventy,
        border: [style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth],
        background: style.backgroundColor,
        heading: element.querySelector("h1, h2, h3, h4, h5, h6") !== null,
        belowMeta: element.getBoundingClientRect().top >= meta.getBoundingClientRect().bottom,
        metaText: meta.textContent,
      };
    });
    expect(look.fontSize).toBe(look.textSm);
    expect(look.color).toBe(look.muted);
    expect(Math.abs(look.maxWidth - look.seventy)).toBeLessThanOrEqual(0.5);
    expect(look.border).toEqual(["0px", "0px", "0px", "0px"]);
    expect(look.background).toBe("rgba(0, 0, 0, 0)");
    expect(look.heading).toBe(false);
    expect(look.belowMeta).toBe(true);
    expect(look.metaText).toContain("B 站");
  });
});

test.describe("fetching it", () => {
  test("while a fetch runs both entries are disabled and the line says so; found shows the text and nothing else", async ({ page }) => {
    await installMockBackend(page);
    const wait = gate();
    const state = lecture(page, 10, { answers: [{ result: "found", description: ONE_SENTENCE }], hold: wait.hold });
    await openLecture(page, 10);
    await expect(description(page)).toHaveCount(0);
    await expect(fetchButton(page)).toHaveText("获取简介");
    await fetchButton(page).click();
    await expect(status(page)).toHaveText(FETCHING);
    await expect(status(page)).toHaveAttribute("role", "status");
    await expect(fetchButton(page)).toBeDisabled();
    await expect(await menuRefetch(page)).toHaveAttribute("data-disabled", "");
    await page.keyboard.press("Escape");
    wait.release();
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);
    await expect(status(page)).toHaveCount(0);
    // Settled now: the title row no longer offers it.
    await expect(fetchButton(page)).toHaveCount(0);
    expect(descriptionState(page).fetches).toEqual([10]);
    expect(state.checkedAt).toBeDefined();
  });

  test("empty: the line says the platform has none", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 11, { answers: [{ result: "empty" }] });
    await openLecture(page, 11);
    await fetchButton(page).click();
    await expect(status(page)).toHaveText(EMPTY);
    await expect(description(page)).toHaveCount(0);
    await expect(fetchButton(page)).toHaveCount(0);
  });

  test("unknown: the line offers 重试, which then finds the text", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 12, { answers: [{ result: "unknown" }, { result: "found", description: SEVEN }] });
    await openLecture(page, 12);
    await fetchButton(page).click();
    await expect(status(page)).toHaveText(`${UNKNOWN} · 重试`);
    await expect(description(page)).toHaveCount(0);
    // Nothing was settled: the title row still offers it.
    await expect(fetchButton(page)).toBeVisible();
    await page.getByTestId("content-description-retry").click();
    await expect(descriptionText(page)).toContainText("示例代码与数据集：");
    await expect(status(page)).toHaveCount(0);
    expect(descriptionState(page).fetches).toEqual([12, 12]);
  });

  test("an error: the line shows its message with 重试, which then finds the text", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 13, { answers: [SOURCE_UNREACHABLE, { result: "found", description: ONE_SENTENCE }] });
    await openLecture(page, 13);
    await fetchButton(page).click();
    await expect(status(page)).toHaveText(`${UNREACHABLE} · 重试`);
    await expect(fetchButton(page)).toBeEnabled();
    await page.getByTestId("content-description-retry").click();
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);
    await expect(status(page)).toHaveCount(0);
  });

  test("superseded: the text another request settled shows, without a message", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 14, { answers: [{ result: "superseded", description: ONE_SENTENCE }] });
    await openLecture(page, 14);
    await fetchButton(page).click();
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);
    await expect(status(page)).toHaveCount(0);
  });

  test("重新获取简介 replaces the text; a failed or unknown refetch keeps it", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 15, {
      description: "旧的一句简介。",
      checkedAt: 1,
      answers: [{ result: "found", description: ONE_SENTENCE }, SOURCE_UNREACHABLE, { result: "unknown" }],
    });
    await openLecture(page, 15);
    await expect(fetchButton(page)).toHaveCount(0);
    await expect(descriptionText(page)).toHaveText("旧的一句简介。");
    const refetch = await menuRefetch(page);
    await expect(refetch).toHaveText("重新获取简介");
    await refetch.click();
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);
    await expect(status(page)).toHaveCount(0);

    await (await menuRefetch(page)).click();
    await expect(status(page)).toHaveText(`${UNREACHABLE} · 重试`);
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);

    await (await menuRefetch(page)).click();
    await expect(status(page)).toHaveText(`${UNKNOWN} · 重试`);
    await expect(descriptionText(page)).toHaveText(ONE_SENTENCE);
    expect(descriptionState(page).fetches).toEqual([15, 15, 15]);
  });

  test("a local upload has neither entry", async ({ page }) => {
    await installMockBackend(page);
    await page.goto(`/contents/${LOCAL_CONTENT}`);
    await expect(page.getByTestId("content-title")).toBeVisible();
    await page.getByTestId("content-menu").click();
    await expect(page.getByTestId("content-menu-delete")).toBeVisible();
    await expect(page.getByTestId("content-menu-refetch-description")).toHaveCount(0);
    await expect(fetchButton(page)).toHaveCount(0);
  });
});

test.describe("when 获取简介 is offered", () => {
  /** Waits until the title row has read the lecture's latest Task and that Task's stages. */
  async function openAndSettle(page: Page, n: number, readsTask: boolean): Promise<void> {
    const reads = readsTask ? page.waitForResponse((response) => /\/api\/tasks\/[^/?]+$/.test(new URL(response.url()).pathname)) : Promise.resolve();
    await openLecture(page, n);
    await reads;
    await page.waitForTimeout(300);
  }

  test("hidden while the source stage is running", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 20, { task: { status: "running", stages: [["source", "running"], ["subtitle", "pending"], ["asr", "pending"]] } });
    await openAndSettle(page, 20, true);
    await expect(fetchButton(page)).toHaveCount(0);
  });

  test("hidden while the source stage is still pending", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 21, { task: { status: "queued", stages: [["source", "pending"], ["subtitle", "pending"]] } });
    await openAndSettle(page, 21, true);
    await expect(fetchButton(page)).toHaveCount(0);
  });

  test("shown while only the transcription waits for its model", async ({ page }) => {
    await installMockBackend(page);
    lecture(page, 22, { task: { status: "waiting", stages: [["source", "succeeded"], ["subtitle", "succeeded"], ["asr", "waiting_configuration"]] } });
    await openAndSettle(page, 22, true);
    await expect(fetchButton(page)).toBeVisible();
  });
});

test.describe("expanding with the keyboard", () => {
  test("the toggle and the scrolling region take the focus; scrolling inside reaches the end, then moves the column", async ({ page }) => {
    // Short enough that the middle column scrolls.
    await page.setViewportSize({ width: 1280, height: 560 });
    await installMockBackend(page);
    lecture(page, 2, { description: LONG, checkedAt: 1 });
    await openLecture(page, 2);
    await page.getByTestId("content-rename").focus();
    await tabTo(page, toggle(page));
    await page.keyboard.press("Enter");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(toggle(page)).toBeFocused();
    // The region comes before the toggle, its link inside it.
    await tabTo(page, region(page), "Shift+Tab");
    await expect(region(page)).toHaveAttribute("tabindex", "0");
    // 收起 sits below the region, not inside it: scrolling the region does not move it.
    const toggleBelow = (): Promise<number> =>
      page.evaluate(() => {
        const button = document.querySelector('[data-testid="content-description-toggle"]') as Element;
        const area = document.querySelector('[data-testid="content-description"] [role="region"]') as Element;
        return area.contains(button) ? Number.NaN : button.getBoundingClientRect().top - area.getBoundingClientRect().bottom;
      });
    const below = await toggleBelow();
    expect(below).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("End");
    await expect.poll(() => region(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs((await toggleBelow()) - below)).toBeLessThanOrEqual(0.5);

    // The nearest scrolling ancestor beyond the region: the middle column.
    const columnTop = (): Promise<number> =>
      region(page).evaluate((element) => {
        for (let node = element.parentElement; node !== null; node = node.parentElement) {
          const overflow = getComputedStyle(node).overflowY;
          if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node.scrollTop;
        }
        return Number.NaN;
      });
    const before = await columnTop();
    expect(Number.isNaN(before)).toBe(false);
    const box = await region(page).boundingBox();
    if (box === null) throw new Error("no region");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(columnTop).toBeGreaterThan(before);

    await toggle(page).focus();
    await page.keyboard.press("Enter");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(region(page)).toHaveCount(0);
  });
});

test.describe("width", () => {
  /** One paragraph without a break: two lines in a wide column, four in the narrowest. */
  const ONE_LONG_LINE = "这是一段没有换行的简介，用来检查宽度变化时是否需要展开按钮：在宽栏里它只占两行，不需要展开；把中间一栏收窄以后，同一段文字会折成四行以上，这时才应当出现展开按钮。";
  const THREE_SHORT = "第一行。\n第二行。\n第三行。";
  const FOUR_SHORT = "第一行。\n第二行。\n第三行。\n第四行。";

  /** Narrows the middle column by giving the output column the rest of the window. */
  async function middleWidth(page: Page, outputs: number): Promise<number> {
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [OUTPUTS_WIDTH_KEY, String(outputs)] as const);
    await page.reload();
    await expect(page.getByTestId("content-title")).toBeVisible();
    // The title row spans the middle column.
    return page.getByTestId("content-title").evaluate((element) => element.parentElement?.parentElement?.getBoundingClientRect().width ?? 0);
  }

  test("one long line needs 展开 only in a narrow column; three short lines never do, four always", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await installMockBackend(page);
    lecture(page, 30, { description: ONE_LONG_LINE, checkedAt: 1 });
    lecture(page, 31, { description: THREE_SHORT, checkedAt: 1 });
    lecture(page, 32, { description: FOUR_SHORT, checkedAt: 1 });
    await openLecture(page, 30);
    const wide = await middleWidth(page, 400);
    await expect(toggle(page)).toHaveCount(0);
    expect(await clipping(page)).toEqual({ clipped: false, lines: 2 });
    const narrow = await middleWidth(page, 1600);
    expect(narrow).toBeLessThan(wide);
    await expect(toggle(page)).toHaveText("展开");
    expect(await clipping(page)).toEqual({ clipped: true, lines: 3 });
    // The column widening and narrowing again re-measures in place, without a reload.
    await page.setViewportSize({ width: 2400, height: 900 });
    await expect(toggle(page)).toHaveCount(0);
    expect((await clipping(page)).clipped).toBe(false);
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(toggle(page)).toHaveText("展开");

    for (const [n, toggled] of [
      [31, false],
      [32, true],
    ] as const) {
      await openLecture(page, n);
      for (const outputs of [400, 1600]) {
        await middleWidth(page, outputs);
        await expect(toggle(page)).toHaveCount(toggled ? 1 : 0);
      }
    }
  });
});

test.describe("what a fetch leaves alone", () => {
  test("playback goes on, the chat draft stays and the reader keeps its place", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    lecture(page, 40, { cached: true, sentences: 120, answers: [{ result: "found", description: LONG }] });
    await openLecture(page, 40, "?tab=transcript");
    // Arriving from a list loop plays the cached copy in the local player.
    await page.evaluate(() => history.replaceState({ ...(history.state as object), usr: { autoplayLocal: true } }, ""));
    await page.reload();
    const video = page.getByTestId("player-local").locator("video");
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
    });
    const chat = page.getByTestId("chat-panel").getByTestId("chat-input");
    await chat.fill("这节课的第二部分讲了什么？");
    const reader = page.getByTestId("transcript-reader");
    await expect(reader.locator("[data-segment-id]").first()).toBeVisible();
    await reader.evaluate((element) => {
      element.scrollTop = 600;
    });
    await page.waitForTimeout(300);
    const readerTop = await reader.evaluate((element) => element.scrollTop);
    expect(readerTop).toBeGreaterThan(100);
    const time = (): Promise<number> => video.evaluate((element: HTMLVideoElement) => element.currentTime);
    const before = await time();

    await fetchButton(page).click();
    await expect(descriptionText(page)).toContainText("【课程简介】");
    await page.waitForTimeout(800);
    expect(await time()).toBeGreaterThan(before + 0.5);
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await expect(chat).toHaveValue("这节课的第二部分讲了什么？");
    expect(Math.abs((await reader.evaluate((element) => element.scrollTop)) - readerTop)).toBeLessThanOrEqual(1);
  });
});
