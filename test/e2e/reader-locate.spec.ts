import { expect, test, type Locator, type Page } from "@playwright/test";
import { READER_LOCATE_PULSE_MS, READER_LOCATE_VIEWPORT_RATIO } from "../../src/shared/defaults.ts";
import { speakerListDtoSchema } from "../../src/shared/dto/speaker.ts";
import { transcriptSegmentPageDtoSchema } from "../../src/shared/dto/transcript.ts";
import { BILIBILI_CONTENT, installMockBackend, LOCAL_CONTENT, segmentId } from "./mock-backend.ts";

/*
 * 「定位到播放位置」 in the transcript reading view: the floating button between 「去顶部」 and
 * 「去底部」 scrolls the reader back to the sentence playing now, its first line a fixed share of
 * the reading area's height below the top, without seeking, selecting or touching the address.
 * The local video of the mock backend plays a 130 s clip; each spec serves its own sentences over
 * that clip's time.
 */

test.use({ actionTimeout: 15_000 });
test.describe.configure({ timeout: 120_000 });

const LOCAL_REVISION = "01J0000000000000000000REV3";
const TEACHER = "01J0000000000000000000SPK5";
const STUDENT = "01J0000000000000000000SPK6";
const OUTPUTS_WIDTH_KEY = "amber.content.outputsWidth";
const RESTORE_ATTRIBUTE = "data-return-restore";
const PULSE_ATTRIBUTE = "data-locate-pulse";
/** How far the located first line may sit from its place, in CSS px. */
const PLACE_TOLERANCE_PX = 2;
const CREATED_AT = 1_790_000_000_000;

interface Sentence {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
}

/** `count` sentences, one every `slotMs`, each ending `gapMs` before the next starts. */
function lecture(count: number, slotMs: number, gapMs: number, options: { text?: (index: number) => string; speaker?: (index: number) => string | undefined } = {}): Sentence[] {
  return Array.from({ length: count }, (_, index) => {
    const speakerId = options.speaker?.(index);
    return {
      startMs: index * slotMs,
      endMs: (index + 1) * slotMs - gapMs,
      text: options.text?.(index) ?? `第 ${index + 1} 句：这一句讲的是定位到播放位置时需要看到的内容，长一点好占满几行。`,
      ...(speakerId === undefined ? {} : { speakerId }),
    };
  });
}

/** Turns that alternate every sentence, so each sentence is a row of its own. */
const alternating = (index: number): string => (index % 2 === 0 ? TEACHER : STUDENT);

/** Serves `sentences` as the local video's transcript, and the two speakers when any sentence names one. */
async function serveLecture(page: Page, sentences: readonly Sentence[]): Promise<void> {
  const items = sentences.map((sentence, index) => ({
    id: segmentId(LOCAL_REVISION, index),
    revisionId: LOCAL_REVISION,
    ordinal: index,
    startMs: sentence.startMs,
    endMs: sentence.endMs,
    text: sentence.text,
    sourceSegmentIds: [],
    ...(sentence.speakerId === undefined ? {} : { speakerId: sentence.speakerId }),
  }));
  const revision = {
    id: LOCAL_REVISION,
    contentId: LOCAL_CONTENT,
    kind: "platform",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "platform" },
    segmentCount: items.length,
    createdAt: CREATED_AT,
  };
  // Routes added after the mock backend's are asked first.
  await page.route(new RegExp(`/api/transcript/revisions/${LOCAL_REVISION}/segments(\\?|$)`), (route) => route.fulfill({ json: transcriptSegmentPageDtoSchema.parse({ revision, items }) }));
  if (sentences.some((sentence) => sentence.speakerId !== undefined)) {
    const speakers = [
      { id: TEACHER, ordinal: 1, name: "林老师", colorIndex: 0, used: true, referenced: true },
      { id: STUDENT, ordinal: 2, colorIndex: 1, used: true, referenced: true },
    ];
    await page.route(new RegExp(`/api/contents/${LOCAL_CONTENT}/speakers$`), (route) => route.fulfill({ json: speakerListDtoSchema.parse({ items: speakers }) }));
  }
}

const reader = (page: Page): Locator => page.getByTestId("transcript-reader");
const readerRoot = (page: Page): Locator => page.locator(`[data-revision-id="${LOCAL_REVISION}"]`);
const locateButton = (page: Page): Locator => page.getByTestId("reader-locate");
const video = (page: Page): Locator => page.getByTestId("player-local").locator("video");
const sentenceAt = (page: Page, index: number): Locator => reader(page).locator(`[data-segment-id="${segmentId(LOCAL_REVISION, index)}"]`);
const params = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

/** Opens the local video's reading view with a fixed output column, its clip loaded. */
async function openLocal(page: Page, sentences: readonly Sentence[], query = ""): Promise<void> {
  await installMockBackend(page, { mode: "server" });
  await serveLecture(page, sentences);
  const url = `/contents/${LOCAL_CONTENT}?tab=transcript${query}`;
  await page.goto(url);
  await page.evaluate((key) => localStorage.setItem(key, "900"), OUTPUTS_WIDTH_KEY);
  await page.goto(url);
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
}

/** Seeks the paused clip as the user would with its own controls, and waits for the reader to have the time. */
async function seekClip(page: Page, seconds: number): Promise<void> {
  await video(page).evaluate(async (element: HTMLVideoElement, at) => {
    element.pause();
    // A seek to where the clip already is still runs, and reports its time, like any other.
    const seeked = new Promise((resolve) => element.addEventListener("seeked", resolve, { once: true }));
    element.currentTime = at;
    await seeked;
  }, seconds);
  await expect(locateButton(page)).not.toHaveAttribute("aria-disabled", /.*/);
}

interface Placement {
  /** The sentence's first line below the reader's top; `undefined` when it is not mounted. */
  offset: number | undefined;
  /** Where the first line belongs: the configured share of the reader's height. */
  goal: number;
  scrollTop: number;
  maxScroll: number;
}

function placement(page: Page, index: number): Promise<Placement> {
  return reader(page).evaluate(
    (scroller, [id, ratio]) => {
      const element = Array.from(scroller.querySelectorAll("[data-segment-id]")).find((candidate) => candidate.getAttribute("data-segment-id") === id);
      const first = element === undefined ? undefined : (Array.from(element.getClientRects()).find((line) => line.height > 0) ?? element.getBoundingClientRect());
      return {
        offset: first === undefined ? undefined : first.top - scroller.getBoundingClientRect().top,
        goal: scroller.clientHeight * (ratio as number),
        scrollTop: scroller.scrollTop,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
      };
    },
    [segmentId(LOCAL_REVISION, index), READER_LOCATE_VIEWPORT_RATIO] as const,
  );
}

/** The placement once the reader has stopped moving: two reads 150 ms apart agree. */
async function settledPlacement(page: Page, index: number): Promise<Placement> {
  let previous = await placement(page, index);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(150);
    const next = await placement(page, index);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error("the reader never settled");
}

/** The sentence's first line sits at the configured height, and stays there for half a second. */
async function expectLocated(page: Page, index: number): Promise<void> {
  const at = await settledPlacement(page, index);
  expect(at.offset, `sentence ${index} is mounted`).toBeDefined();
  expect(Math.abs((at.offset ?? Number.NaN) - at.goal), `sentence ${index} at ${at.offset}, want ${at.goal}`).toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
  await page.waitForTimeout(500);
  const later = await placement(page, index);
  expect(Math.abs((later.offset ?? Number.NaN) - (at.offset ?? Number.NaN))).toBeLessThanOrEqual(1);
}

/** Scrolls the reader to a fraction of its scroll range, as the scrollbar would, and lets it settle. */
async function scrollReader(page: Page, fraction: number): Promise<void> {
  await reader(page).evaluate((scroller, at) => {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * at;
  }, fraction);
  await page.waitForTimeout(300);
}

const scrollTopOf = (page: Page): Promise<number> => reader(page).evaluate((scroller) => scroller.scrollTop);

/** 120 sentences of a second each over two minutes of the clip, 200 ms apart, in paragraphs of a few. */
const PLAIN = lecture(120, 1_000, 200);

test.describe("a local video", () => {
  test("played, then scrolled away: the button brings the playing sentence back at its height, fades it once, and changes nothing else", async ({ page }) => {
    await openLocal(page, PLAIN);
    // A selected sentence, then playback elsewhere.
    await sentenceAt(page, 3).click();
    await expect(sentenceAt(page, 3)).toHaveAttribute("aria-current", "true");
    await seekClip(page, 100.4);
    await scrollReader(page, 0);
    const address = page.url();
    const time = await video(page).evaluate((element: HTMLVideoElement) => element.currentTime);
    expect(time).toBe(100.4);
    expect((await placement(page, 100)).offset ?? Number.POSITIVE_INFINITY).toBeGreaterThan((await placement(page, 100)).goal + 200);

    // Same box and size as its neighbours, between them, with its name.
    const box = locateButton(page).locator("..");
    expect(await box.locator(":scope > button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-testid")))).toEqual(["reader-to-top", "reader-locate", "reader-to-bottom"]);
    const sizes = await box.locator(":scope > button").evaluateAll((buttons) => buttons.map((button) => `${button.getBoundingClientRect().width}x${button.getBoundingClientRect().height}`));
    expect(new Set(sizes)).toEqual(new Set(["28x28"]));
    await expect(page.getByRole("button", { name: "定位到播放位置" })).toHaveAttribute("title", "定位到播放位置");

    await locateButton(page).click();
    await expect(sentenceAt(page, 100)).toHaveAttribute(PULSE_ATTRIBUTE, "");
    expect(await sentenceAt(page, 100).evaluate((element) => getComputedStyle(element).animationName)).toBe("reader-locate-pulse");
    await expectLocated(page, 100);
    await expect(sentenceAt(page, 100)).not.toHaveAttribute(PULSE_ATTRIBUTE, /.*/, { timeout: READER_LOCATE_PULSE_MS * 3 });

    expect(await video(page).evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(time);
    expect(await video(page).evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    expect(page.url()).toBe(address);
    expect(params(page).get("segment")).toBe(segmentId(LOCAL_REVISION, 3));
    await expect(reader(page).locator("[aria-current]")).toHaveCount(1);
    await expect(sentenceAt(page, 3)).toHaveAttribute("aria-current", "true");

    // Again from below: the fade runs again.
    await scrollReader(page, 1);
    await locateButton(page).click();
    await expect(sentenceAt(page, 100)).toHaveAttribute(PULSE_ATTRIBUTE, "");
    await expectLocated(page, 100);
  });

  test("in a pause between sentences, goes to the nearest one, and to the later one when both are as near", async ({ page }) => {
    await openLocal(page, PLAIN);
    // Sentence 51 ends at 50.8 s, sentence 52 starts at 51 s.
    await seekClip(page, 50.85);
    await expect(page.getByTestId("current-sentence")).toHaveCount(0);
    await scrollReader(page, 1);
    await locateButton(page).click();
    await expectLocated(page, 50);

    await seekClip(page, 50.9);
    await scrollReader(page, 0);
    await locateButton(page).click();
    await expectLocated(page, 51);
  });

  test("is disabled with its reason before anything played, then works from 0 s, stopping at the top", async ({ page }) => {
    await openLocal(page, PLAIN);
    await expect(locateButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(locateButton(page)).toHaveAttribute("title", "还没有播放位置，开始播放后可用");
    await expect(page.getByRole("button", { name: "定位到播放位置" })).toBeVisible();
    await scrollReader(page, 0.5);
    const before = await scrollTopOf(page);
    // Playwright waits for an `aria-disabled` control to become enabled; the user's click does not.
    await locateButton(page).click({ force: true });
    await page.waitForTimeout(500);
    expect(await scrollTopOf(page)).toBe(before);
    await expect(reader(page).locator(`[${PULSE_ATTRIBUTE}]`)).toHaveCount(0);

    await seekClip(page, 0);
    await locateButton(page).click();
    // The first sentence cannot come lower than the top of the text: the reader stops at its top.
    await expect.poll(() => scrollTopOf(page)).toBe(0);
    const at = await settledPlacement(page, 0);
    expect(at.offset ?? Number.NaN).toBeLessThan(at.goal);
    await expect(sentenceAt(page, 0)).toHaveAttribute(PULSE_ATTRIBUTE, "");
  });

  test("is not there while the player is hidden", async ({ page }) => {
    await openLocal(page, PLAIN);
    await seekClip(page, 20.5);
    await expect(locateButton(page)).toBeVisible();
    await page.getByTestId("toggle-player").click();
    await expect(page.getByTestId("player-local")).toHaveCount(0);
    await expect(page.getByTestId("reader-to-top")).toBeVisible();
    await expect(locateButton(page)).toHaveCount(0);
  });

  test("a paragraph taller than the reader: the playing sentence's own first line is placed, not the paragraph's", async ({ page }) => {
    const long = "这是一段特别长的讲解，老师从头讲到尾没有停顿，所以它自己就比阅读区还高，";
    const sentences = [
      ...lecture(40, 1_000, 200),
      // After a pause long enough to start a paragraph: an opening sentence that does not end it, then one very long sentence.
      { startMs: 43_000, endMs: 44_000, text: `${"开头的铺垫，".repeat(60)}` },
      { startMs: 44_000, endMs: 50_000, text: `${long.repeat(60)}讲完了。` },
      ...lecture(30, 1_000, 200).map((sentence) => ({ ...sentence, startMs: sentence.startMs + 53_000, endMs: sentence.endMs + 53_000 })),
    ];
    await openLocal(page, sentences);
    await seekClip(page, 47);
    await scrollReader(page, 0);
    await locateButton(page).click();
    await expectLocated(page, 41);
    // The sentence and its paragraph start apart, and the paragraph is taller than the reader.
    const geometry = await sentenceAt(page, 41).evaluate((element) => {
      const paragraph = element.closest("p") as HTMLElement;
      const scroller = element.closest("[data-testid='transcript-reader']") as HTMLElement;
      return { paragraphTop: paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top, paragraphHeight: paragraph.getBoundingClientRect().height, readerHeight: scroller.clientHeight };
    });
    expect(geometry.paragraphHeight).toBeGreaterThan(geometry.readerHeight);
    expect(geometry.paragraphTop).toBeLessThan(0);
  });

  test("the buttons stay clear of the text at the default margin", async ({ page }) => {
    const full = (index: number): string => `第 ${index + 1} 句${"这句话很长，好让每一行都排到右边的边距为止，".repeat(8)}`;
    await openLocal(page, lecture(60, 2_000, 200, { text: full }));
    await seekClip(page, 30.5);
    await scrollReader(page, 0.4);
    const geometry = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-testid='transcript-reader']") as HTMLElement;
      const view = scroller.getBoundingClientRect();
      const box = (document.querySelector("[data-testid='reader-locate']") as HTMLElement).parentElement?.getBoundingClientRect() as DOMRect;
      const lines = [...scroller.querySelectorAll<HTMLElement>("p[data-reader-text]")].flatMap((paragraph) => {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.bottom > view.top && rect.top < view.bottom);
      });
      const covered = lines.filter((line) => line.left < box.right && box.left < line.right && line.top < box.bottom && box.top < line.bottom).length;
      // Lines running beside the box: text that reaches its height, so the check above has something to miss.
      const beside = lines.filter((line) => line.top < box.bottom && box.top < line.bottom).length;
      return { covered, beside, width: box.width };
    });
    expect(geometry.width).toBe(28);
    expect(geometry.beside).toBeGreaterThan(0);
    expect(geometry.covered).toBe(0);
  });

  test("under reduced motion, the arrival is a still tint that goes away", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openLocal(page, PLAIN);
    await seekClip(page, 100.4);
    await scrollReader(page, 0);
    await locateButton(page).click();
    await expect(sentenceAt(page, 100)).toHaveAttribute(PULSE_ATTRIBUTE, "");
    const style = await sentenceAt(page, 100).evaluate((element) => ({ animation: getComputedStyle(element).animationName, background: getComputedStyle(element).backgroundColor }));
    expect(style.animation).toBe("none");
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
    await expect(sentenceAt(page, 100)).not.toHaveAttribute(PULSE_ATTRIBUTE, /.*/, { timeout: READER_LOCATE_PULSE_MS * 3 });
    expect(await sentenceAt(page, 100).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("a 3,000-sentence local lecture, one row per sentence", () => {
  test("locates the playing sentence across the windowed rows", async ({ page }) => {
    // 40 ms a sentence over two minutes of the clip.
    await openLocal(page, lecture(3000, 40, 10, { speaker: alternating, text: (index) => `第 ${index + 1} 句长稿。` }));
    await seekClip(page, 80.015);
    await scrollReader(page, 0.1);
    // Windowed: only the rows near the viewport are in the page.
    expect(await reader(page).locator("[data-row-key]").count()).toBeLessThan(200);
    await expect(sentenceAt(page, 2000)).toHaveCount(0);
    await locateButton(page).click();
    await expect(sentenceAt(page, 2000)).toHaveAttribute(PULSE_ATTRIBUTE, "");
    await expectLocated(page, 2000);
  });
});

test.describe("「只看」 hiding the playing sentence", () => {
  /** Every fourth sentence is the student's; the filter shows only the teacher's. */
  const TURNS = lecture(120, 1_000, 200, { speaker: (index) => (index % 4 === 3 ? STUDENT : TEACHER) });

  test("clears the filter, then arrives at the sentence", async ({ page }) => {
    await openLocal(page, TURNS, `&speaker=${TEACHER}`);
    await expect(page.getByTestId("speaker-filter-bar")).toBeVisible();
    await seekClip(page, 63.4);
    await expect(sentenceAt(page, 63)).toHaveCount(0);
    await expect(locateButton(page)).toHaveAttribute("title", "定位到播放位置（将显示全部发言人）");
    await expect(page.getByRole("button", { name: "定位到播放位置" })).toBeVisible();
    await locateButton(page).click();
    await expect(page.getByTestId("speaker-filter-bar")).toHaveCount(0);
    expect(params(page).getAll("speaker")).toEqual([]);
    await expectLocated(page, 63);
    await expect(locateButton(page)).toHaveAttribute("title", "定位到播放位置");
  });

  test("a scroll by the user before the text comes back cancels the locate", async ({ page }) => {
    await openLocal(page, TURNS, `&speaker=${TEACHER}`);
    await seekClip(page, 63.4);
    await scrollReader(page, 0);
    // The wheel lands in the same task as the click, before the cleared filter has rendered.
    await page.evaluate(() => {
      (document.querySelector("[data-testid='reader-locate']") as HTMLElement).click();
      document.querySelector("[data-testid='transcript-reader']")?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    });
    await expect(page.getByTestId("speaker-filter-bar")).toHaveCount(0);
    await page.waitForTimeout(1_000);
    const at = await placement(page, 63);
    expect(at.offset === undefined || Math.abs(at.offset - at.goal) > 50).toBe(true);
    await expect(reader(page).locator(`[${PULSE_ATTRIBUTE}]`)).toHaveCount(0);
  });
});

test.describe("while the reader is still coming back from the editor", () => {
  /** Holds the page's animation frames, so a return that corrects the scroll position frame by frame stays in progress. */
  async function holdFrames(page: Page): Promise<void> {
    await page.evaluate(() => {
      const held = new Map<number, FrameRequestCallback>();
      let next = 1;
      const store = window as unknown as { __held?: { held: Map<number, FrameRequestCallback>; raf: typeof requestAnimationFrame; caf: typeof cancelAnimationFrame } };
      store.__held = { held, raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window) };
      window.requestAnimationFrame = (callback) => {
        const id = next++;
        held.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        held.delete(id);
      };
    });
  }

  async function releaseFrames(page: Page): Promise<void> {
    await page.evaluate(() => {
      const store = window as unknown as { __held?: { held: Map<number, FrameRequestCallback>; raf: typeof requestAnimationFrame; caf: typeof cancelAnimationFrame } };
      const frames = store.__held;
      if (frames === undefined) return;
      delete store.__held;
      window.requestAnimationFrame = frames.raf;
      window.cancelAnimationFrame = frames.caf;
      for (const callback of frames.held.values()) frames.raf(callback);
      frames.held.clear();
    });
  }

  test("the locate wins over the return", async ({ page }) => {
    // Windowed rows, so the return corrects the position over several frames.
    await openLocal(page, lecture(320, 300, 50, { speaker: alternating, text: (index) => `第 ${index + 1} 句讲稿。` }));
    await seekClip(page, 60.1);
    await scrollReader(page, 0.8);
    await page.getByTestId("transcript-edit").click();
    await expect(page.locator("[data-testid='sentence-rows'][data-initial-scroll]")).toHaveCount(1, { timeout: 60_000 });
    await holdFrames(page);
    await page.getByTestId("draft-exit").click();
    await expect(readerRoot(page)).toBeVisible();
    await expect(readerRoot(page)).not.toHaveAttribute(RESTORE_ATTRIBUTE, /.*/);
    await locateButton(page).click();
    await expect(readerRoot(page)).toHaveAttribute(RESTORE_ATTRIBUTE, "cancelled");
    await releaseFrames(page);
    await expectLocated(page, 200);
    expect(await video(page).evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(60.1);
  });
});

test("a Bilibili video, whose player tells no time, has no locate button", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}?tab=transcript`);
  await expect(reader(page).locator("[data-segment-id]").first()).toBeVisible();
  await expect(page.getByTestId("reader-to-top")).toBeVisible();
  await expect(locateButton(page)).toHaveCount(0);
});
