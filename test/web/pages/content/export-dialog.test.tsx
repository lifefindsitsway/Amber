import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX } from "../../../../src/shared/defaults.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { markdownExportBody, subtitleExportBody, translationsOf } from "../../../../src/web/pages/content/export-dialog.tsx";
import { resetSubtitlePrefsMemory, writeTrack } from "../../../../src/web/player/subtitle-prefs.ts";
import { contentRoutes, revision } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const MARKDOWN = "# 第一讲\n";

/** Records what the browser saver downloads instead of navigating. */
function captureDownloads(): Array<{ download: string }> {
  const saved: Array<{ download: string }> = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => "blob:mock";
  URL.revokeObjectURL = () => undefined;
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ download: this.download });
  });
  onTestFinished(() => {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
    click.mockRestore();
  });
  return saved;
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
});

describe("export request bodies", () => {
  it("names only the ticked sections, each with its revision", () => {
    expect(markdownExportBody({ summaryTemplateId: "summary.core", chapters: true, transcriptRevisionId: "r1", subtitlesRevisionId: undefined, backlinks: false })).toEqual({
      format: "markdown",
      sections: { summary: { templateId: "summary.core" }, chapters: true, transcript: { revisionId: "r1" } },
      backlinks: false,
    });
    expect(subtitleExportBody("srt", "r1", "t1")).toEqual({ format: "srt", revisionId: "r1" });
    expect(subtitleExportBody("ass-bilingual", "r1", "t1")).toEqual({ format: "ass-bilingual", revisionId: "r1", translationRevisionId: "t1" });
  });

  it("pairs a revision only with translations made from it", () => {
    const revisions = [revision("r1"), revision("r2", { kind: "corrected", parentRevisionId: "r1" }), revision("t1", { kind: "translated", parentRevisionId: "r2" })];
    expect(translationsOf("r2", revisions).map((item) => item.id)).toEqual(["t1"]);
    expect(translationsOf("r1", revisions)).toEqual([]);
  });

  it("never pairs with an archived translation, so no default falls back to one", () => {
    const revisions = [revision("r1"), { ...revision("t1", { kind: "translated", parentRevisionId: "r1" }), archived: true }, revision("t2", { kind: "translated", parentRevisionId: "r1" })];
    expect(translationsOf("r1", revisions).map((item) => item.id)).toEqual(["t2"]);
    expect(translationsOf("r1", revisions.slice(0, 2))).toEqual([]);
  });
});

describe("ExportDialog", () => {
  it("downloads the Markdown of the ticked sections and copies the same response", async () => {
    const saved = captureDownloads();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { calls } = mockApi({ ...contentRoutes(), "POST /api/contents/c1/export": { file: { filename: "第一讲.md", text: MARKDOWN } } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    await screen.findByTestId("export-dialog");
    fireEvent.click(screen.getByTestId("export-backlinks"));
    fireEvent.click(screen.getByTestId("export-markdown"));
    await waitFor(() => expect(saved).toEqual([{ download: "第一讲.md" }]));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      format: "markdown",
      sections: { summary: { templateId: "summary.core" }, chapters: true, transcript: { revisionId: "r1" } },
      backlinks: false,
    });
    fireEvent.click(screen.getByTestId("export-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MARKDOWN));
  });

  it("lists every lineage root next to the primary and disables bilingual files without a translation", async () => {
    captureDownloads();
    const revisions = [revision("asr", { kind: "asr" }), revision("imp", { kind: "imported" }), revision("r1", { kind: "corrected", parentRevisionId: "asr" })];
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions } },
      "POST /api/contents/c1/export": { file: { filename: "第一讲.srt", text: "1\n" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    const transcript = (await screen.findByTestId("export-transcript-revision")) as HTMLSelectElement;
    expect([...transcript.options].map((option) => option.value)).toEqual(["r1", "asr", "imp"]);
    expect((screen.getByTestId("export-format-srt-bilingual") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("export-format-srt"));
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toEqual({ format: "srt", revisionId: "r1" }));
  });

  it("offers one manual revision for subtitles: the one the corrected primary descends from", async () => {
    // asr ← m1 ← r1 (corrected, primary) ; asr ← m0, an earlier edit off the primary's line
    const revisions = [
      revision("asr", { kind: "asr", createdAt: 1 }),
      revision("m0", { kind: "manual", parentRevisionId: "asr", createdAt: 2 }),
      revision("m1", { kind: "manual", parentRevisionId: "asr", createdAt: 3 }),
      revision("r1", { kind: "corrected", parentRevisionId: "m1", createdAt: 4 }),
    ];
    mockApi({ ...contentRoutes(), "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions } } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    const subtitles = (await screen.findByTestId("export-subtitle-revision")) as HTMLSelectElement;
    expect([...subtitles.options].map((option) => option.value)).toEqual(["asr", "m1", "r1"]);
    expect(subtitles.value).toBe("r1");
    const transcript = screen.getByTestId("export-transcript-revision") as HTMLSelectElement;
    expect([...transcript.options].map((option) => option.value)).not.toContain("m0");
  });

  it("starts the bilingual files from the translation the player would show", async () => {
    resetSubtitlePrefsMemory();
    // en: t1 is current although t3 is newer; ja: t2.
    const enCurrent = revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1", createdAt: 2 });
    const ja = revision("t2", { kind: "translated", language: "ja", parentRevisionId: "r1", createdAt: 3 });
    const enNewer = revision("t3", { kind: "translated", language: "en", parentRevisionId: "r1", createdAt: 4 });
    mockApi({
      ...contentRoutes(),
      "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), enCurrent, ja, enNewer] } },
      "GET /api/contents/c1/translations": {
        body: {
          translations: [
            { artifactId: "a-en", targetLanguage: "en", current: enCurrent, revisions: [enCurrent, enNewer], stale: false },
            { artifactId: "a-ja", targetLanguage: "ja", current: ja, revisions: [ja], stale: false },
          ],
          activeTasks: [],
        },
      },
    });
    const { unmount } = renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    await waitFor(() => expect((screen.getByTestId("export-translation") as HTMLSelectElement).value).toBe("t1"));
    unmount();

    writeTrack("u1", "c1", { version: 2, mode: "off", translation: { language: "en", lockedRevisionId: "t3" } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    await waitFor(() => expect((screen.getByTestId("export-translation") as HTMLSelectElement).value).toBe("t3"));
  });
});
