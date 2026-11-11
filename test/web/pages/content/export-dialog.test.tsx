import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX } from "../../../../src/shared/defaults.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { markdownExportBody, subtitleExportBody, translationsOf } from "../../../../src/web/pages/content/export-dialog.tsx";
import { resetSubtitlePrefsMemory, writeTrack } from "../../../../src/web/player/subtitle-prefs.ts";
import { contentRoutes, revision, segment } from "../../../fixtures/web/content-data.ts";
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

  it("adds speaker fields only when speakers are asked for", () => {
    expect(markdownExportBody({ summaryTemplateId: undefined, chapters: false, transcriptRevisionId: "r1", subtitlesRevisionId: undefined, backlinks: true, includeSpeakers: true })).toEqual({
      format: "markdown",
      sections: { transcript: { revisionId: "r1" } },
      backlinks: true,
      includeSpeakers: true,
    });
    // Speakers are about the transcript section: without it there is nothing to name them in.
    expect(markdownExportBody({ summaryTemplateId: "summary.core", chapters: false, transcriptRevisionId: undefined, subtitlesRevisionId: undefined, backlinks: true, includeSpeakers: true })).not.toHaveProperty("includeSpeakers");
    expect(subtitleExportBody("srt", "r1", undefined, { labels: "every" })).toEqual({ format: "srt", revisionId: "r1", includeSpeakers: true, speakerLabels: "every" });
    expect(subtitleExportBody("txt", "r1", undefined, { labels: "turn" })).toEqual({ format: "txt", revisionId: "r1", includeSpeakers: true, speakerLabels: "turn" });
    expect(subtitleExportBody("srt-bilingual", "r1", "t1", { labels: "turn" })).toEqual({ format: "srt-bilingual", revisionId: "r1", translationRevisionId: "t1", includeSpeakers: true, speakerLabels: "turn" });
    // VTT and ASS name the speaker on every cue anyway.
    expect(subtitleExportBody("vtt", "r1", undefined, { labels: "every" })).toEqual({ format: "vtt", revisionId: "r1", includeSpeakers: true });
    expect(subtitleExportBody("ass", "r1", undefined, { labels: "every" })).toEqual({ format: "ass", revisionId: "r1", includeSpeakers: true });
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

describe("ExportDialog speakers", () => {
  const spoken = [segment("s1", 0, 0, 4_000, "今天讲检索。", { speakerId: "p1" }), segment("s2", 1, 4_000, 8_000, "先看向量库。", { speakerId: "p2" })];
  const r1 = revision("r1", { kind: "asr", segmentCount: 2 });
  const withSpeakers = () => ({
    ...contentRoutes(),
    "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [r1] } },
    "GET /api/transcript/revisions/r1/segments": { body: { revision: r1, items: spoken } },
    "POST /api/contents/c1/export": { file: { filename: "第一讲.srt", text: "1\n" } },
  });
  const post = (calls: Array<{ method: string; body?: unknown }>) => calls.filter((call) => call.method === "POST").at(-1)?.body;

  it("offers speakers for a version that has them, ticked, and sends them with the chosen labelling", async () => {
    captureDownloads();
    const { calls } = mockApi(withSpeakers());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    const toggle = (await screen.findByTestId("export-speakers")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    const labels = screen.getByTestId("export-speaker-labels") as HTMLSelectElement;
    expect(labels.value).toBe("turn");
    // The scope of the labelling is plain text beside the control, not a hover tip.
    const hint = screen.getByTestId("export-speaker-labels-hint");
    expect(hint.textContent).toBe("只作用于 SRT 与 TXT。");
    expect(labels.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.click(screen.getByTestId("export-format-srt"));
    await waitFor(() => expect(post(calls)).toEqual({ format: "srt", revisionId: "r1", includeSpeakers: true, speakerLabels: "turn" }));
    fireEvent.change(screen.getByTestId("export-speaker-labels"), { target: { value: "every" } });
    fireEvent.click(screen.getByTestId("export-format-txt"));
    await waitFor(() => expect(post(calls)).toEqual({ format: "txt", revisionId: "r1", includeSpeakers: true, speakerLabels: "every" }));
    fireEvent.click(screen.getByTestId("export-format-vtt"));
    await waitFor(() => expect(post(calls)).toEqual({ format: "vtt", revisionId: "r1", includeSpeakers: true }));
  });

  it("sends the plain body once the user unticks the speakers", async () => {
    captureDownloads();
    const { calls } = mockApi(withSpeakers());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    fireEvent.click(await screen.findByTestId("export-speakers"));
    expect(screen.queryByTestId("export-speaker-labels")).toBeNull();
    expect(screen.queryByTestId("export-speaker-labels-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("export-format-srt"));
    await waitFor(() => expect(post(calls)).toEqual({ format: "srt", revisionId: "r1" }));
  });

  it("names the speakers in the Markdown transcript section, ticked by default", async () => {
    captureDownloads();
    const { calls } = mockApi({ ...withSpeakers(), "POST /api/contents/c1/export": { file: { filename: "第一讲.md", text: "# 第一讲\n" } } });
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    expect(((await screen.findByTestId("export-markdown-speakers")) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("export-markdown"));
    await waitFor(() => expect(post(calls)).toEqual({ format: "markdown", sections: { summary: { templateId: "summary.core" }, chapters: true, transcript: { revisionId: "r1" } }, backlinks: true, includeSpeakers: true }));
    fireEvent.click(screen.getByTestId("export-markdown-speakers"));
    fireEvent.click(screen.getByTestId("export-markdown"));
    await waitFor(() => expect(post(calls)).not.toHaveProperty("includeSpeakers"));
  });

  it("shows no speaker controls for a version without speakers", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("summary-export"));
    await screen.findByTestId("export-format-srt");
    await waitFor(() => expect(screen.queryByTestId("export-speakers")).toBeNull());
    expect(screen.queryByTestId("export-markdown-speakers")).toBeNull();
    expect(screen.queryByTestId("export-speaker-labels")).toBeNull();
  });
});
