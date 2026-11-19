import { expect, test } from "@playwright/test";
import { PLAYER_SEEK_TOLERANCE_MS } from "../../src/shared/defaults.ts";
import { DANMAKU_NARROW_PICTURE_PX } from "../../src/web/player/danmaku-narrow.ts";
import { CITED_INDEX, CITED_START_MS, installMockBackend, LOCAL_CONTENT, segmentId } from "./mock-backend.ts";

const REVISION_PREFIX = "01J0000000000000000000REV3";

test("local <video> player: clicking a timestamp seeks within PLAYER_SEEK_TOLERANCE_MS, with the seek bar and following", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  await page.goto(`/contents/${LOCAL_CONTENT}`);

  const video = page.getByTestId("player-local").locator("video");
  await expect(video).toHaveAttribute("src", /\/api\/media\//);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);

  const cited = segmentId(REVISION_PREFIX, CITED_INDEX);
  await page.getByTestId("summary-body").locator(`[data-citation="${cited}"]`).click();
  await expect
    .poll(async () => Math.abs((await video.evaluate((element: HTMLVideoElement) => element.currentTime)) * 1000 - CITED_START_MS))
    .toBeLessThanOrEqual(PLAYER_SEEK_TOLERANCE_MS);

  // Time tracking is supported here: the seek bar follows the jump and subtitle following is offered.
  const seek = page.getByTestId("player-seek");
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(0);
  await page.getByTestId("output-tab-subtitles").click();
  await expect(page.getByTestId("follow-toggle")).toBeVisible();
});

test("local <video> player: a narrow player keeps every control on one row inside the picture", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  await page.goto(`/contents/${LOCAL_CONTENT}`);
  const player = page.getByTestId("player-local");
  await expect(player.getByTestId("player-fullscreen")).toBeAttached();
  for (const width of [240, 300, 360, 640]) {
    await player.evaluate((root, px) => {
      (root.parentElement as HTMLElement).style.width = `${px}px`;
    }, width);
    // The capture button stands in the bar once the picture (filling the 16:9 player) is wide enough; narrower it is in the settings menu.
    const expected = ["play", "clock", "rate", ...(width >= DANMAKU_NARROW_PICTURE_PX ? ["figure-capture"] : []), "volume", "settings", "fullscreen"];
    await expect.poll(() => player.evaluate((root) => [...root.querySelectorAll<HTMLElement>("[data-control]")].map((element) => element.dataset.control))).toEqual(expected);
    const layout = await player.evaluate((root) => {
      const box = root.getBoundingClientRect();
      const controls = [...root.querySelectorAll<HTMLElement>("[data-control]")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.dataset.control, left: rect.left - box.left, right: rect.right - box.left, top: rect.top, height: rect.height };
      });
      const total = root.querySelector<HTMLElement>('[data-testid="player-clock-total"]');
      return { width: box.width, controls, totalShown: total !== null && total.getBoundingClientRect().width > 0 };
    });
    expect(layout.width).toBe(width);
    const rowTop = layout.controls[0]?.top ?? 0;
    for (const control of layout.controls) {
      expect(control.left, `${control.name} at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${control.name} at ${width}px`).toBeLessThanOrEqual(width);
      // One row: no control wraps onto a second line or grows taller than a button.
      expect(Math.abs(control.top + control.height / 2 - (rowTop + (layout.controls[0]?.height ?? 0) / 2)), `${control.name} at ${width}px`).toBeLessThanOrEqual(2);
      expect(control.height, `${control.name} at ${width}px`).toBeLessThanOrEqual(layout.controls[0]?.height ?? 0);
    }
    // The total time goes first when room runs out.
    expect(layout.totalShown).toBe(width >= 320);
  }
});

test("local <video> player: the speed and settings menus mark the choice in the accent colour, and the volume slider stays slim", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  await page.goto(`/contents/${LOCAL_CONTENT}`);
  const player = page.getByTestId("player-local");
  await expect(player.getByTestId("player-fullscreen")).toBeAttached();
  const measureMenu = (menu: ReturnType<typeof page.getByTestId>) =>
    menu.evaluate((root) => {
      const items = [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
      const checked = items.filter((item) => item.getAttribute("aria-checked") === "true");
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.append(probe);
      const accentColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        width: root.getBoundingClientRect().width,
        items: items.map((item) => item.getBoundingClientRect().height),
        checks: root.querySelectorAll("svg").length,
        checkedAccent: checked.length > 0 && checked.every((item) => getComputedStyle(item).color === accentColor),
        othersAccent: items.some((item) => item.getAttribute("aria-checked") !== "true" && getComputedStyle(item).color === accentColor),
      };
    });

  await player.hover();
  await player.getByTestId("player-rate").click();
  const rate = await measureMenu(page.getByTestId("player-rate-menu"));
  expect(rate.width).toBeLessThanOrEqual(96);
  expect(rate.items).toHaveLength(6);
  // Fastest on top, as in the bilibili player; whole rates keep one decimal.
  await expect(page.getByTestId("player-rate-menu").getByRole("menuitemradio")).toHaveText(["2.0x", "1.5x", "1.25x", "1.0x", "0.75x", "0.5x"]);
  // Roomier rows than a context menu, no check marks, the chosen speed in the accent colour.
  for (const height of rate.items) expect(height).toBeGreaterThanOrEqual(30);
  expect(rate.checks).toBe(0);
  expect(rate.checkedAccent).toBe(true);
  expect(rate.othersAccent).toBe(false);
  await page.keyboard.press("Escape");

  await player.getByTestId("player-settings").click();
  const settings = await measureMenu(page.getByTestId("player-settings-menu"));
  expect(settings.width).toBeLessThan(160);
  expect(settings.items.length).toBeGreaterThan(0);
  for (const height of settings.items) expect(height).toBeGreaterThanOrEqual(30);
  expect(settings.checks).toBe(0);
  expect(settings.checkedAccent).toBe(true);
  await page.keyboard.press("Escape");

  // 0.6 × a panel around a native-sized slider (about 38 px around a 16 px range).
  await player.getByTestId("player-mute").hover();
  const popover = player.getByTestId("player-volume-popover");
  await expect(popover).toBeVisible();
  const volume = await popover.evaluate((root) => ({
    panel: (root.firstElementChild as HTMLElement).getBoundingClientRect().width,
    range: (root.querySelector('[data-testid="player-volume-range"]') as HTMLElement).getBoundingClientRect().width,
  }));
  expect(volume.panel).toBeLessThanOrEqual(22);
  expect(volume.range).toBeLessThanOrEqual(10);
});

test("local <video> player: typing a time into the clock and pressing Enter jumps there", async ({ page }) => {
  await installMockBackend(page, { mode: "server" });
  await page.goto(`/contents/${LOCAL_CONTENT}`);
  const player = page.getByTestId("player-local");
  const video = player.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  const clock = player.getByTestId("player-clock-input");

  await player.hover();
  await clock.click();
  await page.keyboard.type("0:03");
  await page.keyboard.press("Enter");
  await expect.poll(async () => Math.abs((await video.evaluate((element: HTMLVideoElement) => element.currentTime)) * 1000 - 3000)).toBeLessThanOrEqual(PLAYER_SEEK_TOLERANCE_MS);
  await expect(player).toBeFocused();
  await expect(clock).toHaveValue("0:03");

  // Escape drops the edit without seeking.
  await clock.click();
  await page.keyboard.type("0:01");
  await page.keyboard.press("Escape");
  await expect(clock).toHaveValue("0:03");
  expect(Math.round(await video.evaluate((element: HTMLVideoElement) => element.currentTime))).toBe(3);
});
