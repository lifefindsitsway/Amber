import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRevisionListItemDto } from "../../../../src/shared/dto/content.ts";
import { relockTranslation } from "../../../../src/web/player/subtitle-prefs.ts";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { TranslationDraftEditor } from "../../../../src/web/pages/content/translation-draft-editor.tsx";
import { contentDetail, revision, segment, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

vi.mock("../../../../src/web/player/subtitle-prefs.ts", async (original) => ({
  ...(await original<object>()),
  relockTranslation: vi.fn(),
}));

const NOT_FOUND = { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } };
const ME = { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } };
const URL = "/api/contents/c1/translations/en/draft";

const T_EN = revision("t-en", { kind: "translated", language: "en", parentRevisionId: "r1", generation: { kind: "llm", modelRef: { modelId: "m" } } });
const T_EN2 = revision("t-en2", { kind: "translated", language: "en", parentRevisionId: "r1", createdAt: 2 });
const EN_SEGMENTS = [
  segment("e1", 0, 0, 4_000, "Today: retrieval.", { revisionId: "t-en", sourceSegmentIds: ["s1"] }),
  segment("e2", 1, 4_000, 8_000, "First the vector store.", { revisionId: "t-en", sourceSegmentIds: ["s2"] }),
];

function translationsRoute(current: TranscriptRevisionListItemDto, draft?: { baseRevisionId: string; version: number }) {
  return {
    body: {
      activeTasks: [],
      translations: [{ artifactId: "a-en", targetLanguage: "en", current, revisions: [T_EN, T_EN2], stale: false, ...(draft === undefined ? {} : { draft: { ...draft, updatedAt: 1 } }) }],
    },
  };
}

function routes(options: { current?: TranscriptRevisionListItemDto; draft?: () => object; archived?: string[] } = {}) {
  const current = options.current ?? T_EN;
  const archived = new Set(options.archived ?? []);
  return {
    "GET /api/auth/me": ME,
    "GET /api/contents/c1/transcript/revisions": {
      body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), ...[T_EN, T_EN2].map((item) => ({ ...item, archived: archived.has(item.id) }))] },
    },
    "GET /api/contents/c1/translations": translationsRoute(current),
    "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
    "GET /api/transcript/revisions/t-en/segments": { body: { revision: T_EN, items: EN_SEGMENTS } },
    "GET /api/transcript/revisions/t-en2/segments": { body: { revision: T_EN2, items: EN_SEGMENTS.map((item) => ({ ...item, revisionId: "t-en2", text: `${item.text} (v2)` })) } },
    [`GET ${URL}`]: options.draft ?? (() => NOT_FOUND),
  };
}

function renderEditor(onClose = vi.fn()) {
  const state = { content: contentDetail(), primaryRevisionId: "r1", selection: undefined, select: vi.fn(), openTab: vi.fn(), highlightThreshold: 80, setHighlightThreshold: vi.fn(), openSubtitleEditor: vi.fn() };
  renderApp(
    <ContentPageProvider value={state}>
      <TranslationDraftEditor language="en" onClose={onClose} />
    </ContentPageProvider>,
  );
  return onClose;
}

const bodies = (calls: RecordedCall[], method: string, suffix = "") => calls.filter((call) => call.method === method && call.path.split("?")[0] === `${URL}${suffix}`).map((call) => call.body);
const saved = (version: number) => (call: RecordedCall) => ({ body: { id: "d1", contentId: "c1", targetLanguage: "en", ...(call.body as object), version, updatedAt: 1 } });

beforeEach(() => vi.mocked(relockTranslation).mockClear());

describe("TranslationDraftEditor", () => {
  it("starts a new draft from the current translation and shows each sentence with its time, number and original", async () => {
    const { calls } = mockApi({
      ...routes(),
      [`PUT ${URL}`]: saved(1),
      [`POST ${URL}/commit`]: { status: 201, body: revision("t-new", { kind: "translated", language: "en", parentRevisionId: "r1", generation: { kind: "manual" } }) },
    });
    const onClose = renderEditor();
    const input = await screen.findByDisplayValue("Today: retrieval.");
    expect(await screen.findByText("0:00 – 0:04 · 第 1 句")).toBeTruthy();
    await screen.findByText("今天讲检索。");
    expect(input.getAttribute("aria-label")).toBe("第 1 句译文");
    fireEvent.change(input, { target: { value: "Today: retrieval, revised." } });
    fireEvent.click(screen.getByTestId("draft-commit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies(calls, "PUT")).toEqual([
      {
        baseRevisionId: "t-en",
        expectedVersion: null,
        segments: [
          { id: "e1", text: "Today: retrieval, revised." },
          { id: "e2", text: "First the vector store." },
        ],
      },
    ]);
    expect(bodies(calls, "POST", "/commit")).toEqual([{ expectedRevisionId: "t-en", draftVersion: 1 }]);
    expect(relockTranslation).toHaveBeenCalledWith("u1", "c1", "t-en", "t-new");
    // The translation list and the version lists are read again.
    expect(calls.filter((call) => call.path === "/api/contents/c1/translations").length).toBeGreaterThan(1);
    expect(calls.filter((call) => call.path === "/api/contents/c1/transcript/revisions").length).toBeGreaterThan(1);
  });

  it("resumes a saved draft and refuses to commit while a sentence is empty", async () => {
    mockApi(
      routes({ draft: () => ({ body: { id: "d1", contentId: "c1", targetLanguage: "en", baseRevisionId: "t-en", version: 4, segments: [{ id: "e1", text: "Mine." }, { id: "e2", text: "" }], updatedAt: 1 } }) }),
    );
    renderEditor();
    expect(await screen.findByDisplayValue("Mine.")).toBeTruthy();
    const empty = screen.getByLabelText("第 2 句译文");
    expect(empty.getAttribute("aria-invalid")).toBe("true");
    expect(empty.className).toContain("border-danger");
    expect(screen.getByTestId("translation-empty-count").textContent).toBe("1 句译文为空");
    expect((screen.getByTestId("draft-commit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(empty, { target: { value: "Filled." } });
    expect(screen.queryByTestId("translation-empty-count")).toBeNull();
    expect((screen.getByTestId("draft-commit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("flags a draft on an older translation and can discard it to edit the current one", async () => {
    let gets = 0;
    const { calls } = mockApi({
      ...routes({
        current: T_EN2,
        draft: () => {
          gets += 1;
          return gets === 1 ? { body: { id: "d1", contentId: "c1", targetLanguage: "en", baseRevisionId: "t-en", version: 4, segments: [{ id: "e1", text: "Old." }, { id: "e2", text: "Older." }], updatedAt: 1 } } : NOT_FOUND;
        },
      }),
      [`DELETE ${URL}`]: { status: 204 },
    });
    renderEditor();
    await screen.findByDisplayValue("Old.");
    expect(screen.getByTestId("translation-draft-outdated").textContent).toContain("此草稿基于较早的译文，提交前需要确认");
    fireEvent.click(screen.getByTestId("translation-draft-restart"));
    expect(await screen.findByDisplayValue("Today: retrieval. (v2)")).toBeTruthy();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`${URL}?version=4`]);
    expect(screen.queryByTestId("translation-draft-outdated")).toBeNull();
  });

  it("asks before committing over a changed translation, and asks again when it changes again", async () => {
    let commits = 0;
    const changed = (current: string) => ({
      status: 409,
      body: { error: { class: "conflict", code: "conflict.translation_changed", retryDisposition: "never", userMessage: "", details: { currentRevisionId: current } } },
    });
    const { calls } = mockApi({
      ...routes({ draft: () => ({ body: { id: "d1", contentId: "c1", targetLanguage: "en", baseRevisionId: "t-en", version: 2, segments: [{ id: "e1", text: "A." }, { id: "e2", text: "B." }], updatedAt: 1 } }) }),
      [`POST ${URL}/commit`]: () => {
        commits += 1;
        if (commits === 1) return changed("t-en2");
        if (commits === 2) return changed("t-en3");
        return { status: 201, body: revision("t-new", { kind: "translated", language: "en", generation: { kind: "manual" } }) };
      },
    });
    const onClose = renderEditor();
    await screen.findByDisplayValue("A.");
    fireEvent.click(screen.getByTestId("draft-commit"));
    expect(await screen.findByTestId("translation-draft-conflict")).toBeTruthy();
    fireEvent.click(screen.getByTestId("translation-draft-commit-anyway"));
    await waitFor(() => expect(commits).toBe(2));
    expect(await screen.findByTestId("translation-draft-conflict")).toBeTruthy();
    fireEvent.click(screen.getByTestId("translation-draft-commit-anyway"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies(calls, "POST", "/commit")).toEqual([
      { expectedRevisionId: "t-en", draftVersion: 2 },
      { expectedRevisionId: "t-en2", draftVersion: 2, allowOutdatedBase: true },
      { expectedRevisionId: "t-en3", draftVersion: 2, allowOutdatedBase: true },
    ]);
    expect(bodies(calls, "PUT")).toEqual([]);
    expect(relockTranslation).toHaveBeenCalledWith("u1", "c1", "t-en", "t-new");
  });

  it("shows freshness from the draft's base even when another translation is current", async () => {
    mockApi({
      ...routes({
        current: T_EN2,
        draft: () => ({ body: { id: "d1", contentId: "c1", targetLanguage: "en", baseRevisionId: "t-en", version: 3, segments: [{ id: "e1", text: "A." }, { id: "e2", text: "B." }], updatedAt: 1 } }),
      }),
      "GET /api/contents/c1/transcript/revisions": {
        body: { primaryTranscriptRevisionId: "r2", revisions: [revision("r2"), T_EN, T_EN2] },
      },
    });
    renderEditor();
    await screen.findByDisplayValue("A.");
    expect(screen.getByTestId("translation-draft-stale").textContent).toContain("原文已更新");
    expect(screen.getByTestId("translation-draft-outdated")).toBeTruthy();
  });

  it("offers only to discard a draft whose base was archived", async () => {
    const { calls } = mockApi({
      ...routes({
        current: T_EN2,
        archived: ["t-en"],
        draft: () => ({ body: { id: "d1", contentId: "c1", targetLanguage: "en", baseRevisionId: "t-en", version: 3, segments: [{ id: "e1", text: "A." }], updatedAt: 1 } }),
      }),
      [`DELETE ${URL}`]: { status: 204 },
    });
    const onClose = renderEditor();
    expect(await screen.findByTestId("translation-draft-unavailable")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByTestId("draft-discard"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`${URL}?version=3`]);
  });
});
