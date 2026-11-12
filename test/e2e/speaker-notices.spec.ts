import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SpeakerContextDto } from "../../src/shared/dto/speaker-context.ts";
import { THEMES } from "../../src/shared/dto/settings.ts";
import { installMockBackend, segmentId } from "./mock-backend.ts";
import {
  BASIS_CHAT_ANSWER,
  BASIS_CITED_INDEX,
  BASIS_COLLECTION,
  BASIS_CONTENT,
  BASIS_REVISION,
  GUEST,
  installSpeakerBasis,
  PROFESSOR,
  PROFESSOR_NAME,
  type SpeakerBasisState,
} from "./mock-outputs.ts";
import { setTheme } from "./mock-usage.ts";

/*
 * The one-line notices about the speakers an AI result was generated with, the speakers on
 * highlight cards, citation cards and under chat answers, the version info, and how all of
 * that reads with the keyboard, to a screen reader and in every theme.
 */

const CITED = segmentId(BASIS_REVISION, BASIS_CITED_INDEX);
/** WCAG AA for text below the large-text size; every notice here is 12 px. */
const MIN_CONTRAST = 4.5;

async function open(page: Page, initial: Partial<SpeakerBasisState>, query = ""): Promise<SpeakerBasisState> {
  await installMockBackend(page);
  const state = await installSpeakerBasis(page, initial);
  await page.goto(`/contents/${BASIS_CONTENT}${query}`);
  return state;
}

interface NoticeCase {
  title: string;
  basis: SpeakerContextDto | undefined;
  confirmed: boolean;
  /** The line every result shows, or null for none. */
  text: string | null;
  state?: string;
}

const SPEAKERS = [
  { id: PROFESSOR, label: PROFESSOR_NAME },
  { id: GUEST, label: "发言人 2" },
];

const CASES: NoticeCase[] = [
  {
    title: "attribution_changed",
    basis: { state: "attribution_changed", speakers: SPEAKERS, changedSentences: 3 },
    confirmed: true,
    text: "生成后有 3 句改了发言人，其中的人物观点可能不再准确",
  },
  {
    title: "evidence_removed",
    basis: { state: "evidence_removed", speakers: SPEAKERS, removedCitations: 1 },
    confirmed: true,
    text: "引用的 1 句原话已被删除，相关结论失去依据",
  },
  { title: "unknown", basis: { state: "unknown", speakers: SPEAKERS }, confirmed: true, text: "无法确认发言人依据是否仍然一致" },
  {
    title: "names_changed",
    basis: { state: "names_changed", speakers: SPEAKERS, renamed: [{ id: GUEST, was: "发言人 2", now: "李同学" }] },
    confirmed: true,
    text: "生成时为发言人 2，现为李同学",
  },
  { title: "unconfirmed", basis: { state: "unconfirmed", speakers: SPEAKERS }, confirmed: false, text: "当前字幕稿的发言人未核对" },
  { title: "made without speakers, reviewed now", basis: undefined, confirmed: true, text: "重新生成可带上发言人", state: "can_include" },
  { title: "consistent", basis: { state: "consistent", speakers: SPEAKERS }, confirmed: true, text: null },
  { title: "made without speakers, not reviewed now", basis: undefined, confirmed: false, text: null },
];

for (const notice of CASES) {
  test(`speaker basis notice on the summary, chapters and highlights: ${notice.title}`, async ({ page }) => {
    await open(page, { basis: notice.basis, confirmed: notice.confirmed });
    await expect(page.getByTestId("summary-body")).toBeVisible();
    await expect(page.getByTestId("chapter-section").getByText("开场")).toBeVisible();
    const lines = [page.getByTestId("summary-speaker-basis"), page.getByTestId("chapters-speaker-basis")];
    for (const line of lines) {
      if (notice.text === null) {
        await expect(line).toHaveCount(0);
      } else {
        // A note read with the result, not a live announcement; the words carry the state.
        await expect(line).toHaveText(notice.text);
        await expect(line).toHaveAttribute("role", "note");
        await expect(line).not.toHaveAttribute("aria-live");
        await expect(line).toHaveAttribute("data-state", notice.state ?? notice.title);
      }
    }
    // While the transcript a generation would read has unreviewed speakers, each entry says it leaves them out.
    const notRead = [page.getByTestId("summary-speakers-not-read"), page.getByTestId("chapters-speakers-not-read")];
    for (const hint of notRead) {
      if (notice.confirmed) await expect(hint).toHaveCount(0);
      else await expect(hint).toHaveText("发言人未核对，本次不读取");
    }

    await page.goto(`/contents/${BASIS_CONTENT}?tab=ai-highlights`);
    await expect(page.getByTestId("highlight-item")).toHaveCount(2);
    const highlights = page.getByTestId("highlights-speaker-basis");
    if (notice.text === null) await expect(highlights).toHaveCount(0);
    else await expect(highlights).toHaveText(notice.text);
    const hint = page.getByTestId("highlights-speakers-not-read");
    if (notice.confirmed) await expect(hint).toHaveCount(0);
    else await expect(hint).toHaveText("发言人未核对，本次不读取");
  });
}

test("highlight cards name the speaker of their sentence", async ({ page }) => {
  await open(page, {}, "?tab=ai-highlights");
  const items = page.getByTestId("highlight-item");
  await expect(items).toHaveCount(2);
  const speakers = page.getByTestId("highlight-speaker");
  // The name follows a letter avatar, which is decorative and not part of what is read out.
  await expect(speakers.locator("span.font-medium")).toHaveText([PROFESSOR_NAME, "发言人 2"]);
  await expect(speakers.first()).toHaveAttribute("data-speaker-id", PROFESSOR);
  await expect(items.first()).toHaveAccessibleName(new RegExp(`^第 1 句是重点 ?${PROFESSOR_NAME} ?第 1 句依据模拟字幕。`));
  await expect(items.nth(1)).toHaveAccessibleName(/^第 3 句是重点 ?发言人 2 ?第 3 句依据模拟字幕。/);
});

test("citation card: keyboard focus opens it with the speaker and 「跳到这句」, Tab reaches the action, Esc returns to the badge", async ({ page }) => {
  await open(page, {});
  const badge = page.getByTestId("summary-body").locator(`[data-citation="${CITED}"]`);
  await expect(badge).toHaveRole("button");
  // Tab from the summary's last toolbar control reaches the badge without a pointer.
  await page.getByTestId("summary-export").focus();
  for (let step = 0; step < 10 && !(await badge.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(badge).toBeFocused();
  const card = page.getByRole("group", { name: "引用的原句" });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("citation-card-speaker")).toHaveText("发言人 2");
  await expect(card).toContainText("第 3 句依据模拟字幕。");
  // The bilibili player can only be moved there.
  const action = card.getByRole("button", { name: "跳到这句" });
  await expect(action).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(action).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(badge).toBeFocused();
  // Leaving by Tab closes it as well.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(card).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(card).toHaveCount(0);
});

test("citation card: a player that plays a range offers 「播放这句」, by hover too", async ({ page }) => {
  await open(page, { source: "youtube" });
  const badge = page.getByTestId("summary-body").locator(`[data-citation="${CITED}"]`);
  await badge.hover();
  const card = page.getByRole("group", { name: "引用的原句" });
  await expect(card.getByTestId("citation-card-speaker")).toHaveText("发言人 2");
  await expect(card.getByRole("button", { name: "播放这句" })).toBeVisible();
  await expect(card.getByRole("button", { name: "跳到这句" })).toHaveCount(0);
});

test("chat: an answer whose speakers no longer hold says so underneath; its citation card names the speaker", async ({ page }) => {
  await open(page, { chatAnswer: { state: "attribution_changed", speakers: SPEAKERS, changedSentences: 2 } });
  const panel = page.getByTestId("chat-panel");
  const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(answer).toContainText(BASIS_CHAT_ANSWER);
  const line = answer.getByTestId("chat-speaker-mismatch");
  await expect(line).toHaveText(`回答时的发言人：${PROFESSOR_NAME}、发言人 2 · 与当前不一致`);
  await expect(line).toHaveAttribute("data-state", "attribution_changed");
  await answer.locator(`[data-citation="${CITED}"]`).focus();
  const card = panel.getByRole("group", { name: "引用的原句" });
  await expect(card.getByTestId("citation-card-speaker")).toHaveText("发言人 2");
  await expect(card.getByRole("button", { name: "跳到这句" })).toBeVisible();
});

test("chat: an answer without a speaker context has no speaker line", async ({ page }) => {
  await open(page, { chatAnswer: undefined });
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-speaker-mismatch")).toHaveCount(0);
});

test("collection: the count of members whose speaker basis changed sits by the summary button", async ({ page }) => {
  await installMockBackend(page);
  await installSpeakerBasis(page, { collectionChanged: 2 });
  await page.goto(`/collections/${BASIS_COLLECTION}`);
  const card = page.getByTestId("collection-summary");
  const hint = card.getByTestId("collection-summary-speaker-hint");
  await expect(hint).toHaveText("2 个成员的总结发言人依据已变化，建议先重新生成");
  // Beside the button, and never a gate: the button stays enabled.
  const button = card.getByRole("button", { name: "立即归纳" });
  await expect(button).toBeEnabled();
  const [hintBox, buttonBox] = [await hint.boundingBox(), await button.boundingBox()];
  expect(hintBox !== null && buttonBox !== null && Math.abs(hintBox.y - (buttonBox.y + buttonBox.height)) < 24).toBe(true);
});

test("version info: the revision picker's hover text says how speakers were identified", async ({ page }) => {
  await open(page, {}, "?tab=transcript");
  const picker = page.getByTestId("transcript-version");
  await expect(picker).toHaveAttribute("title", /发言人识别：已识别发言人/);
  await expect(picker.locator("option").first()).toHaveAttribute("title", /发言人识别：已识别发言人/);
});

/** Effective WCAG contrast of each element's text over what is painted behind it, opacity included. */
async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    // The canvas normalises any CSS colour syntax (rgb, oklch, color-mix results) to sRGB.
    const rgba = (css: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r ?? 0, g ?? 0, b ?? 0, (a ?? 0) / 255];
    };
    const over = (top: [number, number, number, number], bottom: [number, number, number]): [number, number, number] => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
    ];
    const layers: Array<[number, number, number, number]> = [];
    let opacity = 1;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      const background = rgba(style.backgroundColor);
      if (background[3] > 0) layers.push(background);
    }
    let backdrop: [number, number, number] = [255, 255, 255];
    for (const layer of layers.reverse()) backdrop = over(layer, backdrop);
    const color = rgba(getComputedStyle(element).color);
    const text = over([color[0], color[1], color[2], color[3] * opacity], backdrop);
    const luminance = (rgb: [number, number, number]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(text), luminance(backdrop)].sort((a, b) => b - a) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  });
}

for (const theme of THEMES) {
  test(`contrast of the speaker notices, hints and marks in the ${theme} theme`, async ({ page }, info) => {
    await installMockBackend(page);
    const state = await installSpeakerBasis(page, {
      basis: { state: "attribution_changed", speakers: SPEAKERS, changedSentences: 3 },
      confirmed: false,
      chatAnswer: { state: "names_changed", speakers: SPEAKERS, renamed: [{ id: GUEST, was: "发言人 2", now: "李同学" }] },
      collectionChanged: 2,
    });
    await setTheme(page, theme);
    const ratios: Record<string, number> = {};
    const measure = async (name: string, locator: Locator): Promise<void> => {
      await expect(locator).toBeVisible();
      ratios[name] = Math.round((await contrastOf(locator)) * 100) / 100;
    };

    await page.goto(`/contents/${BASIS_CONTENT}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await measure("summary basis notice", page.getByTestId("summary-speaker-basis"));
    await measure("chapters basis notice", page.getByTestId("chapters-speaker-basis"));
    await measure("summary not-read hint", page.getByTestId("summary-speakers-not-read"));
    await measure("chat speaker line", page.getByTestId("chat-speaker-mismatch"));

    await page.goto(`/contents/${BASIS_CONTENT}?tab=transcript`);
    await measure("review badge (unconfirmed)", page.getByTestId("speaker-review-badge"));

    state.basis = undefined;
    state.confirmed = true;
    await page.goto(`/contents/${BASIS_CONTENT}?tab=ai-highlights`);
    await measure("highlights can-include notice", page.getByTestId("highlights-speaker-basis"));

    await page.goto(`/collections/${BASIS_COLLECTION}`);
    await measure("collection hint", page.getByTestId("collection-summary-speaker-hint"));

    // Search marks: a reviewed lecture's summary with a changed basis, the namesake's unreviewed sentences.
    state.basis = { state: "attribution_changed", speakers: SPEAKERS, changedSentences: 3 };
    await page.goto("/library");
    await page.getByTestId("library-search").fill("依据");
    const unconfirmed = page.getByTestId("hit-speaker").filter({ hasText: "未核对" }).first().getByText("未核对", { exact: true });
    await measure("library hit 「未核对」", unconfirmed);
    await page.getByTestId("library-search").fill("嘉宾认为");
    await measure("library hit 「人物依据已变化」", page.getByTestId("hit-basis-changed").first());
    await page.getByTestId("library-search").fill("");
    await page.keyboard.press("Control+K");
    const omnibox = page.getByTestId("omnibox");
    await omnibox.locator("input").fill("同名字幕");
    // The first option is the selected one; the second shows the resting look.
    const resting = omnibox.getByTestId("omnibox-group-segments").getByRole("option").nth(1);
    await expect(resting).toHaveAttribute("aria-selected", "false");
    await measure("omnibox hit 「未核对」", resting.getByText("未核对", { exact: true }));
    await omnibox.locator("input").fill("嘉宾认为");
    await measure("omnibox hit 「人物依据已变化」", omnibox.getByTestId("hit-basis-changed"));

    info.annotations.push({ type: "contrast", description: JSON.stringify(ratios) });
    console.log(`contrast ${theme}: ${JSON.stringify(ratios)}`);
    for (const [name, ratio] of Object.entries(ratios)) {
      expect.soft(ratio, `${name} in ${theme}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
}
