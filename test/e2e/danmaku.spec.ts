import { expect, test, type Locator, type Page } from "@playwright/test";
import { DANMAKU_FETCH_COOLDOWN_MS, DANMAKU_ONSCREEN_MAX } from "../../src/shared/defaults.ts";
import { DANMAKU_PREFS_DEFAULT, DANMAKU_PREFS_KEY, type DanmakuPrefs } from "../../src/shared/danmaku-prefs.ts";
import type { DanmakuItem } from "../../src/shared/dto/danmaku.ts";
import { installMockBackend, LOCAL_CONTENT } from "./mock-backend.ts";
import { DANMAKU_NARROW_PICTURE_PX } from "../../src/web/player/danmaku-narrow.ts";
import { DANMAKU_CACHE_HD, DANMAKU_CACHE_SD, DANMAKU_CONTENT, setupDanmaku } from "./mock-danmaku.ts";

const item = (timeMs: number, text: string, mode: DanmakuItem["mode"] = "scroll", weight = 5): DanmakuItem => ({ timeMs, mode, color: 0xffffff, weight, text });

/** A steady stream: one item every `stepMs` over the clip, alternating scroll / top / bottom every few. */
function stream(stepMs: number, untilMs = 120_000): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  for (let at = 0, index = 0; at < untilMs; at += stepMs, index += 1) {
    items.push(item(at, `第 ${index} 条弹幕${"！".repeat(index % 7)}`, index % 9 === 4 ? "top" : index % 9 === 8 ? "bottom" : "scroll", 1 + (index % 10)));
  }
  return items;
}

async function preferDanmaku(page: Page, prefs: Partial<DanmakuPrefs> = {}): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [DANMAKU_PREFS_KEY, JSON.stringify({ ...DANMAKU_PREFS_DEFAULT, enabled: true, ...prefs })] as const);
}

/** Opens the lecture and switches to its cached copy (the server mode streams it over /api/media). */
async function openCached(page: Page): Promise<{ player: Locator; video: Locator }> {
  await page.goto(`/contents/${DANMAKU_CONTENT}`);
  // The first page of a busy run can take a while to come up.
  await expect(page.getByTestId("player-bilibili")).toBeVisible({ timeout: 20_000 });
  const inline = page.getByTestId("switch-player-local");
  if (await inline.isVisible()) {
    await inline.click();
  } else {
    await page.getByTestId("content-menu").click();
    await page.getByTestId("overflow-switch-player-local").click();
  }
  const player = page.getByTestId("player-local");
  const video = player.locator("video");
  await expect(video).toHaveAttribute("src", /\/api\/media\//);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  return { player, video };
}

const seek = (video: Locator, seconds: number) =>
  video.evaluate(
    (element: HTMLVideoElement, to) =>
      new Promise<void>((done) => {
        element.addEventListener("seeked", () => done(), { once: true });
        element.currentTime = to;
      }),
    seconds,
  );

/** Narrows or widens the player's column; the picture follows it once the player re-measures. */
const setPlayerWidth = (player: Locator, width: number) =>
  player.evaluate((root, px) => {
    (root.parentElement as HTMLElement).style.width = `${px}px`;
  }, width);

const danmakuTexts = (page: Page) => page.locator("[data-danmaku]").allTextContents();

test.describe("danmaku", () => {
  test("server mode plays the bilibili cache over /api/media and switches between online and cached; the button is there only for danmaku", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    const mock = setupDanmaku(page, { snapshot: [item(1000, "你好")], qualities: [1080, 480] });
    const { player } = await openCached(page);
    expect(mock.mediaRequests()[0]).toBe(`/api/media/${DANMAKU_CACHE_HD}`);
    await expect(page.getByTestId("switch-player-local")).toHaveAttribute("aria-pressed", "true");
    await expect(player.getByTestId("player-danmaku")).toBeAttached();
    // The quality menu lists both cached qualities in the server mode too.
    await player.hover();
    await expect(player.getByTestId("player-quality")).toHaveText("1080P");
    await player.getByTestId("player-quality").click();
    await expect(page.getByTestId(`player-quality-item-${DANMAKU_CACHE_SD}`)).toBeVisible();
    await page.keyboard.press("Escape");
    // Back online, and to the cache again.
    await page.getByTestId("switch-player-online").click();
    await expect(page.getByTestId("player-bilibili")).toBeVisible();
    await expect(page.getByTestId("player-danmaku")).toHaveCount(0);
    await page.getByTestId("switch-player-local").click();
    await expect(page.getByTestId("player-local").getByTestId("player-danmaku")).toBeAttached();

    // A Content whose platform has no danmaku gets no button.
    await page.goto(`/contents/${LOCAL_CONTENT}`);
    await expect(page.getByTestId("player-local").getByTestId("player-fullscreen")).toBeAttached();
    await expect(page.getByTestId("player-danmaku")).toHaveCount(0);
  });

  test("server mode without a video cache keeps 「本地缓存」 disabled and says why", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    setupDanmaku(page, { qualities: [] });
    await page.goto(`/contents/${DANMAKU_CONTENT}`);
    const local = page.getByTestId("switch-player-local");
    await expect(local).toBeDisabled({ timeout: 20_000 });
    await expect(local).toHaveAttribute("title", "没有视频缓存：在客户端缓存后，用内容包导入到这里即可播放");
  });

  test("the first opening fetches once; later only 「更新弹幕」 does, each outcome said in words, the cooldown shown", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    const mock = setupDanmaku(page, {
      hold: true,
      fetches: [{ result: "fetched", items: stream(500) }, { result: "cooldown", retryAfterMs: 9_000 }],
    });
    const { player } = await openCached(page);
    await player.hover();
    const button = player.getByTestId("player-danmaku");
    await expect(button).toHaveAccessibleName("弹幕");
    await button.click();
    const popover = page.getByTestId("player-danmaku-popover");
    await expect(popover).toBeVisible();
    // Portalled into the player, so it stays visible in fullscreen; the controls stay shown meanwhile.
    expect(await popover.evaluate((element) => element.closest('[data-testid="player-local"]') !== null)).toBe(true);
    await expect(player).toHaveAttribute("data-controls", "shown");
    await expect(page.getByTestId("player-danmaku-status")).toHaveText("正在获取弹幕…");
    await expect(page.getByTestId("player-danmaku-update")).toBeDisabled();
    mock.release();
    await expect(page.getByTestId("player-danmaku-status")).toHaveText("已获取 240 条弹幕");
    await expect(page.getByTestId("player-danmaku-summary")).toContainText("已获取 240 条 · 更新于");
    // Counted from the request, which the test held for a while.
    const wait = Number((await page.getByTestId("player-danmaku-cooldown").textContent())?.match(/^(\d+) 秒后可再次更新$/u)?.[1]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(DANMAKU_FETCH_COOLDOWN_MS / 1000);
    await expect(page.getByTestId("player-danmaku-update")).toBeDisabled();
    // Closing and opening again asks nothing.
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await button.click();
    expect(mock.fetchCount()).toBe(1);
  });

  test("「更新弹幕」: no danmaku, a failure that keeps the last snapshot, a refusal while cooling down", async ({ page }) => {
    await page.clock.install();
    await installMockBackend(page, { mode: "server" });
    const mock = setupDanmaku(page, {
      snapshot: [item(500, "旧的")],
      fetches: [{ result: "failed", userMessage: "平台暂时无法访问" }, { result: "empty" }, { result: "cooldown", retryAfterMs: 20_000 }],
    });
    const { player } = await openCached(page);
    await player.hover();
    await player.getByTestId("player-danmaku").click();
    await expect(page.getByTestId("player-danmaku-summary")).toContainText("已获取 1 条");
    expect(mock.fetchCount()).toBe(0);
    const update = page.getByTestId("player-danmaku-update");
    await update.click();
    await expect(page.getByTestId("player-danmaku-status")).toHaveText("获取失败（平台暂时无法访问），已保留上次的弹幕");
    await expect(page.getByTestId("player-danmaku-summary")).toContainText("已获取 1 条");
    await page.clock.fastForward(DANMAKU_FETCH_COOLDOWN_MS + 1000);
    await update.click();
    await expect(page.getByTestId("player-danmaku-status")).toHaveText("这个视频没有弹幕");
    await expect(page.getByTestId("player-danmaku-summary")).toContainText("已获取 0 条");
    await page.clock.fastForward(DANMAKU_FETCH_COOLDOWN_MS + 1000);
    await update.click();
    await expect(page.getByTestId("player-danmaku-status")).toHaveText("刚刚更新过弹幕，请稍后再试");
    await expect(page.getByTestId("player-danmaku-cooldown")).toHaveText(/^(19|20) 秒后可再次更新$/u);
    await expect(update).toBeDisabled();
    expect(mock.fetchCount()).toBe(3);
  });

  test("preferences persist across a reload: off by default, then on with density, opacity and size", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    setupDanmaku(page, { snapshot: stream(400) });
    const { player, video } = await openCached(page);
    await seek(video, 10);
    await expect(page.getByTestId("danmaku-layer")).toHaveCount(0);
    await player.hover();
    await player.getByTestId("player-danmaku").click();
    const toggle = page.getByRole("switch", { name: "显示弹幕" });
    await expect(toggle).not.toBeChecked();
    // Keyboard only: the switch, then the opacity slider.
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(player.getByTestId("player-danmaku")).toHaveAttribute("data-active", "true");
    await expect(page.locator("[data-danmaku]").first()).toBeAttached();
    await page.getByTestId("player-danmaku-opacity").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("player-danmaku-opacity")).toHaveAttribute("aria-valuetext", "80%");
    await page.getByTestId("player-danmaku-density").fill("0.5");
    await page.getByTestId("player-danmaku-font-scale").fill("1.5");
    // The player's own keys did not fire: still paused at 10 s.
    expect(await video.evaluate((element: HTMLVideoElement) => [element.paused, Math.round(element.currentTime)])).toEqual([true, 10]);
    await page.reload();
    const again = await openCached(page);
    await expect(page.getByTestId("danmaku-layer")).toHaveCSS("opacity", "0.8");
    await again.player.hover();
    await again.player.getByTestId("player-danmaku").click();
    await expect(page.getByRole("switch", { name: "显示弹幕" })).toBeChecked();
    await expect(page.getByTestId("player-danmaku-density")).toHaveValue("0.5");
    await expect(page.getByTestId("player-danmaku-font-scale")).toHaveValue("1.5");
  });

  test("danmaku follow the video's own time: nothing before its time, there once it is reached, re-laid out after a seek; text stays text", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page);
    const hostile = '<img src=x onerror="window.__pwned=1">';
    setupDanmaku(page, { snapshot: [item(20_000, "二十秒", "top"), item(40_000, hostile, "top"), item(60_000, "六十秒", "bottom")] });
    const { video } = await openCached(page);
    await seek(video, 19.5);
    expect(await danmakuTexts(page)).toEqual([]);
    await seek(video, 20.2);
    expect(await danmakuTexts(page)).toEqual(["二十秒"]);
    // Held for DANMAKU_FIXED_MS from its own time, at any point a seek lands within it.
    await seek(video, 23.5);
    expect(await danmakuTexts(page)).toEqual(["二十秒"]);
    await seek(video, 41);
    expect(await danmakuTexts(page)).toEqual([hostile]);
    expect(await page.locator("[data-testid='danmaku-layer'] img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // Playing on from 59.8 s brings the next one at its time.
    await seek(video, 59.8);
    expect(await danmakuTexts(page)).toEqual([]);
    await video.evaluate((element: HTMLVideoElement) => element.play());
    await expect.poll(() => danmakuTexts(page)).toEqual(["六十秒"]);
    const at = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    expect(at).toBeGreaterThanOrEqual(60);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
  });

  test("scrolling danmaku move on the compositor while playing, stop when paused and follow the speed", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page);
    setupDanmaku(page, { snapshot: [item(5000, "滚动的一条")] });
    const { video } = await openCached(page);
    await seek(video, 5.5);
    const one = page.locator("[data-danmaku='scroll']");
    await expect(one).toHaveCount(1);
    const animation = () =>
      one.evaluate((element) => {
        const running = element.getAnimations()[0];
        return { state: running?.playState, rate: running?.playbackRate, time: Number(running?.currentTime ?? 0) };
      });
    expect((await animation()).state).toBe("paused");
    expect(Math.round((await animation()).time)).toBe(500);
    await page.getByTestId("player-local").hover();
    await page.getByTestId("player-rate").click();
    await page.getByTestId("player-rate-2").click();
    await video.evaluate((element: HTMLVideoElement) => element.play());
    await expect.poll(async () => (await animation()).state).toBe("running");
    expect((await animation()).rate).toBe(2);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
    await expect.poll(async () => (await animation()).state).toBe("paused");
    // Its animation time is media time: where the video stands, less when it came on.
    const [media, shown] = await Promise.all([video.evaluate((element: HTMLVideoElement) => element.currentTime * 1000), animation()]);
    expect(Math.abs(media - 5000 - shown.time)).toBeLessThanOrEqual(150);
  });

  test("high density at 2× and repeated seeks never put more than DANMAKU_ONSCREEN_MAX on screen", async ({ page }) => {
    test.slow();
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page, { fontScale: 0.5 });
    setupDanmaku(page, { snapshot: stream(6) });
    const { video } = await openCached(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await video.evaluate((element: HTMLVideoElement) => {
      element.playbackRate = 2;
      element.muted = true;
      return element.play();
    });
    let peak = 0;
    for (let round = 0; round < 12; round += 1) {
      for (let sample = 0; sample < 5; sample += 1) {
        const count = await page.locator("[data-danmaku]").count();
        peak = Math.max(peak, count);
        expect(count).toBeLessThanOrEqual(DANMAKU_ONSCREEN_MAX);
        await page.waitForTimeout(80);
      }
      await video.evaluate((element: HTMLVideoElement, round) => {
        element.currentTime = (round * 37) % 110;
      }, round);
    }
    expect(peak).toBeGreaterThan(20);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
  });

  test("switching quality rebinds the danmaku to the new element and carries on from the same time", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page);
    setupDanmaku(page, { snapshot: [item(30_000, "三十秒", "top"), item(31_000, "三十一秒", "top")], qualities: [1080, 480] });
    const { player, video } = await openCached(page);
    await seek(video, 30.5);
    expect(await danmakuTexts(page)).toEqual(["三十秒"]);
    const before = await video.elementHandle();
    await player.hover();
    await player.getByTestId("player-quality").click();
    await page.getByTestId(`player-quality-item-${DANMAKU_CACHE_SD}`).click();
    await expect.poll(async () => (await player.locator("video").elementHandle()) !== null && (await player.locator("video").evaluate((element, old) => element !== old, before))).toBe(true);
    await expect(player.getByTestId("player-quality")).toHaveText("480P");
    await expect.poll(() => danmakuTexts(page)).toEqual(["三十秒"]);
    const fresh = player.locator("video");
    expect(Math.round(await fresh.evaluate((element: HTMLVideoElement) => element.currentTime))).toBe(31);
    await seek(fresh, 31.2);
    expect(await danmakuTexts(page)).toEqual(["三十秒", "三十一秒"]);
  });

  test("without subtitles the layer covers exactly the picture, letterbox excluded, in fullscreen too", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page);
    setupDanmaku(page, { snapshot: [item(1000, "一", "top")] });
    await page.setViewportSize({ width: 1000, height: 800 });
    const { player, video } = await openCached(page);
    await seek(video, 1.5);
    const picture = () =>
      video.evaluate((element: HTMLVideoElement) => {
        const box = element.getBoundingClientRect();
        const scale = Math.min(box.width / element.videoWidth, box.height / element.videoHeight);
        const width = element.videoWidth * scale;
        const height = element.videoHeight * scale;
        return { x: box.left + (box.width - width) / 2, y: box.top + (box.height - height) / 2, width, height };
      });
    const layer = async () => {
      const box = await page.getByTestId("danmaku-layer").boundingBox();
      if (box === null) throw new Error("no layer");
      return box;
    };
    const close = async () => {
      const [expected, actual] = await Promise.all([picture(), layer()]);
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(expected[key] - actual[key]), key).toBeLessThanOrEqual(1);
      return actual;
    };
    await close();
    await player.hover();
    await player.getByTestId("player-fullscreen").click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") ?? null)).toBe("player-local");
    // A 16:9 picture on a 1000 × 800 screen: bars above and below.
    await expect.poll(async () => (await layer()).width).toBeGreaterThan(990);
    const full = await close();
    expect(full.y).toBeGreaterThan(100);
    // The popover shows inside fullscreen.
    await player.hover();
    await player.getByTestId("player-danmaku").click();
    await expect(page.getByTestId("player-danmaku-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.exitFullscreen());
  });

  test("new danmaku keep clear of the subtitles where they really are, after the subtitles move too", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page);
    setupDanmaku(page, { snapshot: stream(150) });
    const { player, video } = await openCached(page);
    await player.hover();
    await player.getByTestId("player-subtitles").click();
    await page.getByTestId("player-subtitles-mode-original").click();
    await page.keyboard.press("Escape");
    await expect(player.getByTestId("subtitle-block")).toBeVisible();
    const overlaps = () =>
      page.evaluate(() => {
        const block = document.querySelector('[data-testid="subtitle-block"]')?.getBoundingClientRect();
        if (block === undefined) return { block: false, overlapping: 0, total: 0 };
        const items = [...document.querySelectorAll<HTMLElement>("[data-danmaku]")];
        const overlapping = items.filter((element) => {
          const box = element.getBoundingClientRect();
          return box.top < block.bottom && box.bottom > block.top;
        });
        return { block: true, overlapping: overlapping.length, total: items.length };
      });
    const check = async () => {
      // Seeking lays everything out anew, so every item on screen was placed with the current subtitles known.
      await seek(video, 40);
      await seek(video, 45);
      const result = await overlaps();
      expect(result.block).toBe(true);
      expect(result.total).toBeGreaterThan(5);
      expect(result.overlapping).toBe(0);
    };
    await check();
    // Moved to the top with the editor's preset.
    await player.hover();
    await player.getByTestId("player-subtitles").click();
    await page.getByTestId("player-subtitles-edit").click();
    await page.getByTestId("subtitle-preset-top").click();
    await page.getByTestId("subtitle-editor-done").click();
    await check();
  });

  test("with reduced motion nothing scrolls: items are held at the top or bottom", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installMockBackend(page, { mode: "server" });
    await preferDanmaku(page);
    setupDanmaku(page, { snapshot: [item(2000, "原本滚动"), item(2100, "底部", "bottom")] });
    const { player, video } = await openCached(page);
    await seek(video, 2.5);
    await expect(page.locator("[data-danmaku]")).toHaveCount(2);
    await expect(page.locator("[data-danmaku='scroll']")).toHaveCount(0);
    await player.hover();
    await player.getByTestId("player-danmaku").click();
    await expect(page.getByTestId("player-danmaku-reduced-motion")).toBeVisible();
  });

  test("a wide player keeps 「弹幕」 in its control bar without pushing any control out", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    setupDanmaku(page, { snapshot: [item(1000, "一")] });
    const { player } = await openCached(page);
    for (const width of [DANMAKU_NARROW_PICTURE_PX, 480]) {
      await setPlayerWidth(player, width);
      await expect(player.locator("[data-control='danmaku']")).toHaveCount(1);
      const layout = await player.evaluate((root) => {
        const box = root.getBoundingClientRect();
        return [...root.querySelectorAll<HTMLElement>("[data-control]")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { name: element.dataset["control"], left: rect.left - box.left, right: rect.right - box.left };
        });
      });
      for (const control of layout) {
        expect(control.left, `${control.name} at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(control.right, `${control.name} at ${width}px`).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a narrow player moves 「弹幕」 into the settings menu; the entry opens the same popover, all by keyboard, inside the player", async ({ page }) => {
    await installMockBackend(page, { mode: "server" });
    setupDanmaku(page, { snapshot: [item(1000, "一")] });
    const { player } = await openCached(page);
    await setPlayerWidth(player, DANMAKU_NARROW_PICTURE_PX - 20);
    await expect(player.locator("[data-control='danmaku']")).toHaveCount(0);
    await expect(player.getByTestId("player-danmaku")).toHaveCount(0);
    // Keyboard only: to the settings button, open the menu, pick 「弹幕…」.
    await player.getByTestId("player-settings").focus();
    await page.keyboard.press("Enter");
    const entry = page.getByTestId("player-settings-danmaku");
    await expect(entry).toBeVisible();
    await expect(entry).toContainText("弹幕…");
    await expect(entry).toContainText("关");
    await entry.focus();
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("player-danmaku-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("player-settings-menu")).toHaveCount(0);
    // Focus is inside the popover, and its controls work from the keyboard.
    await expect.poll(() => popover.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const toggle = page.getByRole("switch", { name: "显示弹幕" });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(player).toHaveAttribute("data-controls", "shown");
    const box = await popover.boundingBox();
    const outer = await player.boundingBox();
    // Inside the player both ways: a short player scrolls the popover rather than cutting it off.
    expect(box !== null && outer !== null && box.x >= outer.x - 1 && box.x + box.width <= outer.x + outer.width + 1).toBe(true);
    expect(box !== null && outer !== null && box.y >= outer.y - 1 && box.y + box.height <= outer.y + outer.height + 1).toBe(true);
    // Escape closes it and leaves the focus with the player; the entry now reads 「开」.
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(player).toBeFocused();
    await player.getByTestId("player-settings").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("player-settings-danmaku")).toContainText("开");
    await page.keyboard.press("Escape");
    // Wide again: the button is back in the bar.
    await setPlayerWidth(player, 480);
    await expect(player.getByTestId("player-danmaku")).toBeVisible();
  });
});
