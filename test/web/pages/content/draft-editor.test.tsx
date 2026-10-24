import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { DraftEditor, draftFromSegments } from "../../../../src/web/pages/content/draft-editor.tsx";
import { contentDetail, revision, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

describe("DraftEditor", () => {
  it("starts from the base sentences, each pointing at its source", () => {
    expect(draftFromSegments(SEGMENTS)[1]).toEqual({ id: "s2", startMs: 4_000, endMs: 8_000, text: "先看向量库。", sourceSegmentIds: ["s2"] });
  });

  it("shows a changed primary instead of overwriting, then commits against the new one on request", async () => {
    let commits = 0;
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } },
      "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
      "PUT /api/contents/c1/transcript/draft": (call) => ({ body: { id: "d1", contentId: "c1", ...(call.body as object), updatedAt: 1 } }),
      "POST /api/contents/c1/transcript/draft/commit": () => {
        commits += 1;
        return commits === 1
          ? {
              status: 409,
              body: {
                error: {
                  class: "conflict",
                  code: "conflict.primary_changed",
                  retryDisposition: "never",
                  userMessage: "",
                  details: { currentPrimaryRevisionId: "r2" },
                },
              },
            }
          : { body: revision("m1", { kind: "manual", parentRevisionId: "r1" }) };
      },
    });
    const onClose = vi.fn();
    const state = { content: contentDetail(), primaryRevisionId: "r1", selection: undefined, select: vi.fn(), openTab: vi.fn(), highlightThreshold: 80, setHighlightThreshold: vi.fn(), openSubtitleEditor: vi.fn() };
    renderApp(
      <ContentPageProvider value={state}>
        <DraftEditor base={revision("r1")} primaryRevisionId="r1" onClose={onClose} />
      </ContentPageProvider>,
    );
    const first = await screen.findByDisplayValue("今天讲检索。");
    fireEvent.change(first, { target: { value: "今天讲检索增强。" } });
    fireEvent.click(screen.getByTestId("draft-commit"));
    expect(await screen.findByTestId("draft-conflict")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    const commitBodies = () => calls.filter((call) => call.path.endsWith("/commit")).map((call) => call.body);
    expect(commitBodies()).toEqual([{ expectedPrimaryRevisionId: "r1" }]);
    const saved = calls.filter((call) => call.method === "PUT").at(-1)?.body as { segments: Array<{ text: string }> };
    expect(saved.segments[0]?.text).toBe("今天讲检索增强。");

    fireEvent.click(screen.getByText("仍然提交"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(commitBodies()).toEqual([{ expectedPrimaryRevisionId: "r1" }, { expectedPrimaryRevisionId: "r2" }]);
  });
  it("discards the draft only after a second confirmation, and a draft never saved is simply left", async () => {
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", segments: draftFromSegments(SEGMENTS), updatedAt: 1 } },
      "DELETE /api/contents/c1/transcript/draft": { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } },
    });
    const onClose = vi.fn();
    const state = { content: contentDetail(), primaryRevisionId: "r1", selection: undefined, select: vi.fn(), openTab: vi.fn(), highlightThreshold: 80, setHighlightThreshold: vi.fn(), openSubtitleEditor: vi.fn() };
    renderApp(
      <ContentPageProvider value={state}>
        <DraftEditor base={revision("r1")} primaryRevisionId="r1" onClose={onClose} />
      </ContentPageProvider>,
    );
    await screen.findByDisplayValue("今天讲检索。");
    const discard = screen.getByTestId("draft-discard");
    expect(discard.textContent).toBe("放弃草稿");
    fireEvent.click(discard);
    expect(discard.textContent).toBe("确认放弃草稿");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(discard);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/contents/c1/transcript/draft"]);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
