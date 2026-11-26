import { expect, test, type Locator, type Page } from "@playwright/test";
import { backupEstimateDtoSchema, restoreReadinessDtoSchema } from "../../src/shared/dto/backup.ts";
import { transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import { instanceSettingsDtoSchema } from "../../src/shared/dto/instance-settings.ts";
import { noteGroupsDtoSchema } from "../../src/shared/dto/note.ts";
import { THEMES, type Theme } from "../../src/shared/dto/settings.ts";
import { transcriptSegmentPageDtoSchema } from "../../src/shared/dto/transcript.ts";
import {
  BILI_REVISION,
  BILIBILI_CONTENT,
  installMockBackend,
  NOTES_CONTENT,
  NOTES_REVISION,
  NOTES_TITLE,
  noteSegmentId,
  revisionListItem,
  syntheticContentId,
  syntheticContentTitle,
} from "./mock-backend.ts";
import { mockCollections } from "./mock-collections.ts";
import { installFakeDesktopShell } from "./mock-content-pack.ts";
import { installUsageMock } from "./mock-usage.ts";

/*
 * Screenshots of the pages whose buttons share one look (toolbars, selection bars, pagers,
 * settings cards, banners) and of the button states (pressed, focused, disabled, loading,
 * awaiting a second click), in every theme, for comparing by eye before and after a change
 * to the button styles. Only runs when `AMBER_E2E_SHOTS` names a directory.
 */

const SHOTS = process.env["AMBER_E2E_SHOTS"];
test.skip(SHOTS === undefined, "screenshots only on request");

const WIDE = { width: 1280, height: 800 };
/** Narrower windows for the theme whose borders are the faintest; 480 px is a 960 px window at 200% zoom. */
const NARROW_WIDTHS = [1024, 800, 480] as const;
const NARROW_THEME: Theme = "parchment";

/** Enough synthetic rows for the library to have several pages. */
const LIBRARY_ROWS = 25;
const COURSE = "01J0000000000000000000BV01";
const PICKS = "01J0000000000000000000BV02";
/** More members than one page holds, so the collection page's pager has somewhere to go. */
const COURSE_MEMBERS = 12;
const TRASHED = 12;
const NOTE_GROUPS = 25;
/** A re-transcription newer than the user's own transcript of the bilibili lecture. */
const ASR_REVISION = "01J0000000000000000000REV9";

async function withTheme(page: Page, theme: Theme): Promise<void> {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ theme, language: "zh-CN", shortcuts: {}, updatedAt: 0 }) });
  });
}

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const pager = (page: Page): Locator => page.getByRole("navigation", { name: "分页" });

const member = (index: number) => ({ contentId: syntheticContentId(index), title: syntheticContentTitle(index) });

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The selection bar together with the pager under it: the strip a style change touches most. */
async function shootFoot(page: Page, bar: Locator, name: string): Promise<void> {
  const top = await bar.boundingBox();
  const viewport = page.viewportSize();
  if (top === null || viewport === null) throw new Error("no box for the selection bar");
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: 0, y: top.y, width: viewport.width, height: viewport.height - top.y } });
}

async function setUpLibrary(page: Page, theme: Theme) {
  const backend = await installMockBackend(page, { libraryContents: LIBRARY_ROWS });
  const collections = mockCollections(page, backend.trash);
  collections.seed({ id: COURSE, name: "模拟课程", members: Array.from({ length: COURSE_MEMBERS }, (_, index) => member(index + 1)) });
  collections.seed({ id: PICKS, name: "精选", members: [member(2), member(3)] });
  await withTheme(page, theme);
  return backend;
}

async function librarySelecting(page: Page): Promise<Locator> {
  await page.goto("/library");
  await expect(page.getByTestId("library-row").first()).toBeVisible();
  await expect(pager(page)).toBeVisible();
  await page.getByTestId("library-select-mode").click();
  const rows = page.getByTestId("library-select-row");
  await rows.nth(0).check();
  await rows.nth(1).check();
  const bar = page.getByTestId("library-selection-bar");
  await expect(bar).toBeVisible();
  await page.mouse.move(0, 0);
  return bar;
}

async function collectionSelecting(page: Page): Promise<Locator> {
  await page.goto(`/collections/${COURSE}`);
  await expect(page.getByTestId("collection-item").first()).toBeVisible();
  await page.getByTestId("collection-select-mode").click();
  const rows = page.getByTestId("collection-select-row");
  await rows.nth(0).check();
  await rows.nth(1).check();
  const bar = page.getByTestId("collection-selection-bar");
  await expect(bar).toBeVisible();
  await page.mouse.move(0, 0);
  return bar;
}

/** The desktop client's settings page: backups of this device next to the content pack import. */
async function setUpBackup(page: Page, theme: Theme): Promise<void> {
  await installFakeDesktopShell(page, {});
  await installMockBackend(page, { mode: "local" });
  await page.route("**/api/backup/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/backup/estimate") {
      return route.fulfill(json(backupEstimateDtoSchema.parse({ database: { bytes: 12 * 1024 * 1024 }, originals: { count: 3, bytes: 2 * 1024 ** 3, unreadable: [] }, cache: { count: 2, bytes: 300 * 1024 * 1024 } })));
    }
    if (path === "/api/backup/restore-readiness") {
      return route.fulfill(json(restoreReadinessDtoSchema.parse({ fresh: false, nonEmpty: [], willReplace: [] })));
    }
    return route.fallback();
  });
  await withTheme(page, theme);
}

async function openBackup(page: Page): Promise<void> {
  await page.goto("/settings/backup");
  await expect(page.getByTestId("backup-export-start")).toBeEnabled();
  await expect(page.getByTestId("restore-pick")).toBeVisible();
}

/** The content pack card sits below the backup cards, out of the first screen. */
async function scrollToPackImport(page: Page): Promise<void> {
  const button = page.getByTestId("settings-pack-import");
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
}

for (const theme of THEMES) {
  test.describe(`buttons · ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(WIDE);
    });

    test("library: toolbar and pager, selection mode, focus", async ({ page }) => {
      await setUpLibrary(page, theme);
      await page.goto("/library");
      await expect(page.getByTestId("library-row").first()).toBeVisible();
      await expect(pager(page)).toBeVisible();
      await shoot(page, `library-${theme}`);

      // Keyboard focus on the selection-mode button: Shift+Tab then Tab makes the ring keyboard-driven.
      const mode = page.getByTestId("library-select-mode");
      await mode.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(mode).toBeFocused();
      await shoot(page, `library-focus-${theme}`);

      // Pressed, nothing picked yet: the bar stays away.
      await mode.click();
      await expect(mode).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(0, 0);
      await shoot(page, `library-select-pressed-${theme}`);

      const bar = await librarySelecting(page);
      await shoot(page, `library-selecting-${theme}`);
      await shootFoot(page, bar, `library-selecting-foot-${theme}`);
    });

    test("collections list: with collections", async ({ page }) => {
      await setUpLibrary(page, theme);
      await page.goto("/collections");
      await expect(page.getByTestId("collection-card").first()).toBeVisible();
      await shoot(page, `collections-${theme}`);
    });

    test("collections list: empty", async ({ page }) => {
      // Without the collections fake, the backend lists none.
      await installMockBackend(page);
      await withTheme(page, theme);
      await page.goto("/collections");
      await expect(page.getByTestId("collections-loading")).toHaveCount(0);
      await expect(page.getByTestId("collection-card")).toHaveCount(0);
      await shoot(page, `collections-empty-${theme}`);
    });

    test("collection page: toolbar, selection", async ({ page }) => {
      await setUpLibrary(page, theme);
      await page.goto(`/collections/${COURSE}`);
      await expect(page.getByTestId("collection-item").first()).toBeVisible();
      await expect(pager(page)).toBeVisible();
      await shoot(page, `collection-${theme}`);
      const bar = await collectionSelecting(page);
      await shoot(page, `collection-selecting-${theme}`);
      await shootFoot(page, bar, `collection-selecting-foot-${theme}`);
    });

    test("trash: rows and selection; empty trash with its disabled buttons", async ({ page }) => {
      const backend = await installMockBackend(page, { libraryContents: TRASHED });
      for (let index = 1; index <= TRASHED; index += 1) backend.trash.seed(syntheticContentId(index), index * 60_000);
      await withTheme(page, theme);
      await page.goto("/trash");
      await expect(page.getByTestId("trash-row").first()).toBeVisible();
      await shoot(page, `trash-${theme}`);
      await page.getByTestId("trash-select-mode").click();
      const rows = page.getByTestId("trash-select-row");
      await rows.nth(0).check();
      await rows.nth(1).check();
      const bar = page.getByTestId("trash-selection-bar");
      await expect(bar).toBeVisible();
      await page.mouse.move(0, 0);
      await shoot(page, `trash-selecting-${theme}`);
      await shootFoot(page, bar, `trash-selecting-foot-${theme}`);
    });

    test("trash: empty, buttons disabled", async ({ page }) => {
      await installMockBackend(page);
      await withTheme(page, theme);
      await page.goto("/trash");
      await expect(page.getByTestId("trash-empty")).toBeVisible();
      await expect(page.getByTestId("trash-empty-all")).toBeDisabled();
      await expect(page.getByTestId("trash-select-mode")).toBeDisabled();
      await shoot(page, `disabled-trash-empty-${theme}`);
    });

    test("notes page: pager, and a delete awaiting its confirmation", async ({ page }) => {
      const backend = await installMockBackend(page);
      for (const [index, comment] of [[0, "第一条笔记"], [6, "第二条笔记"]] as const) {
        backend.notes.seed({
          transcriptRevisionId: NOTES_REVISION,
          startSegmentId: noteSegmentId(NOTES_REVISION, index),
          startOffset: 0,
          endSegmentId: noteSegmentId(NOTES_REVISION, index),
          endOffset: 4,
          comment,
        });
      }
      // The fake keeps notes on one lecture only; more groups make the pager turn pages.
      await page.route("**/api/notes/groups**", async (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get("limit") ?? NOTE_GROUPS);
        const at = Number(url.searchParams.get("page") ?? 1);
        const all = Array.from({ length: NOTE_GROUPS }, (_, index) =>
          index === 0
            ? { contentId: NOTES_CONTENT, title: NOTES_TITLE, count: 2, latestAt: 1_790_000_000_000 }
            : { contentId: syntheticContentId(index), title: syntheticContentTitle(index), count: index, latestAt: 1_790_000_000_000 - index * 60_000 },
        );
        return route.fulfill(json(noteGroupsDtoSchema.parse({ items: all.slice((at - 1) * limit, at * limit), total: all.length })));
      });
      await withTheme(page, theme);
      await page.goto("/notes");
      await expect(page.getByTestId("note-card").first()).toBeVisible();
      await expect(pager(page)).toBeVisible();
      await shoot(page, `notes-${theme}`);
      await page.getByTestId("note-delete").first().click();
      await expect(page.getByTestId("note-delete-confirm")).toBeVisible();
      await page.mouse.move(0, 0);
      await shoot(page, `confirm-note-delete-${theme}`);
    });

    test("usage page: pager", async ({ page }) => {
      await installMockBackend(page);
      await installUsageMock(page, "main");
      await withTheme(page, theme);
      await page.goto("/usage");
      await expect(page.getByTestId("usage-summary-grid")).toBeVisible();
      await expect(pager(page)).toBeVisible();
      await shoot(page, `usage-${theme}`);
      await pager(page).screenshot({ path: `${SHOTS}/usage-pager-${theme}.png` });
    });

    test("settings: models and platform accounts", async ({ page }) => {
      await installMockBackend(page);
      await withTheme(page, theme);
      await page.goto("/settings/models");
      await expect(page.getByTestId("profile-card").first()).toBeVisible();
      await shoot(page, `settings-models-${theme}`);
      await page.goto("/settings/platform-accounts");
      await expect(page.getByTestId("account-bilibili")).toBeVisible();
      await shoot(page, `settings-platform-accounts-${theme}`);
    });

    test("settings: storage with the low free-space hint, then applying it", async ({ page }) => {
      await installMockBackend(page, { mode: "local" });
      // The old free-ratio default brings the hint card up; applying it stays pending so the loading look can be shot.
      await page.route("**/api/instance-settings", async (route) => {
        if (route.request().method() === "GET") {
          return route.fulfill(
            json(instanceSettingsDtoSchema.parse({ concurrencyPipeline: 2, maxDataGB: 30, lowWaterFreeGB: 10, lowWaterFreeRatio: 0.2, uploadRetentionDefault: "keep", updatedAt: 0, envOverridden: [] })),
          );
        }
        // Left unanswered on purpose: the request hangs until the page closes.
        return undefined;
      });
      await withTheme(page, theme);
      await page.goto("/settings/storage");
      await expect(page.getByTestId("low-water-hint")).toBeVisible();
      await shoot(page, `settings-storage-${theme}`);
      await page.getByTestId("low-water-hint-apply").click();
      await expect(page.getByTestId("low-water-hint-apply")).toBeDisabled();
      await page.mouse.move(0, 0);
      await shoot(page, `loading-low-water-apply-${theme}`);
    });

    test("settings: backup and content packs in the desktop client", async ({ page }) => {
      await setUpBackup(page, theme);
      await openBackup(page);
      await shoot(page, `settings-backup-${theme}`);
      await scrollToPackImport(page);
      await shoot(page, `settings-backup-pack-${theme}`);
    });

    test("content page: the re-transcription banner", async ({ page }) => {
      await installMockBackend(page);
      // The user's own transcript is current and a newer recognition finished: the banner offers to switch.
      const base = { contentId: BILIBILI_CONTENT, language: "zh-CN", timingFidelity: "segment_only", segmentCount: 12 };
      const manual = { ...base, id: BILI_REVISION, kind: "manual", generation: { kind: "manual" }, createdAt: 1_790_000_000_000 };
      const asr = { ...base, id: ASR_REVISION, kind: "asr", generation: { kind: "asr" }, createdAt: 1_790_000_600_000 };
      await page.route(`**/api/contents/${BILIBILI_CONTENT}/transcript/revisions`, (route) =>
        route.fulfill(json(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: BILI_REVISION, revisions: [manual, asr].map(revisionListItem) }))),
      );
      await page.route(`**/api/transcript/revisions/${ASR_REVISION}/segments**`, (route) =>
        route.fulfill(
          json(
            transcriptSegmentPageDtoSchema.parse({
              revision: asr,
              items: Array.from({ length: 12 }, (_, index) => ({
                id: `${ASR_REVISION.slice(0, 22)}${String(index).padStart(4, "0")}`,
                revisionId: ASR_REVISION,
                ordinal: index,
                startMs: index * 10_000,
                endMs: (index + 1) * 10_000 - 500,
                text: `第 ${index + 1} 句重新识别的字幕。`,
                sourceSegmentIds: [],
              })),
            }),
          ),
        ),
      );
      await withTheme(page, theme);
      await page.goto(`/contents/${BILIBILI_CONTENT}?tab=transcript`);
      await expect(page.getByTestId("asr-banner")).toBeVisible();
      await page.mouse.move(0, 0);
      await shoot(page, `content-asr-banner-${theme}`);
      await page.getByTestId("asr-banner").screenshot({ path: `${SHOTS}/content-asr-banner-strip-${theme}.png` });
    });
  });
}

for (const width of NARROW_WIDTHS) {
  test.describe(`narrow · ${width} · ${NARROW_THEME}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test("library selection and collection page", async ({ page }) => {
      await setUpLibrary(page, NARROW_THEME);
      const libraryBar = await librarySelecting(page);
      await shoot(page, `library-selecting-${width}-${NARROW_THEME}`);
      await shootFoot(page, libraryBar, `library-selecting-foot-${width}-${NARROW_THEME}`);
      await page.goto(`/collections/${COURSE}`);
      await expect(page.getByTestId("collection-item").first()).toBeVisible();
      await shoot(page, `collection-${width}-${NARROW_THEME}`);
      const collectionBar = await collectionSelecting(page);
      await shoot(page, `collection-selecting-${width}-${NARROW_THEME}`);
      await shootFoot(page, collectionBar, `collection-selecting-foot-${width}-${NARROW_THEME}`);
    });

    test("settings backup", async ({ page }) => {
      await setUpBackup(page, NARROW_THEME);
      await openBackup(page);
      await shoot(page, `settings-backup-${width}-${NARROW_THEME}`);
      await scrollToPackImport(page);
      await shoot(page, `settings-backup-pack-${width}-${NARROW_THEME}`);
    });
  });
}
