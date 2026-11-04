import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { DraftEditor, draftFromSegments } from "../../../../src/web/pages/content/draft-editor.tsx";
import { contentDetail, revision, segment, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

const NOT_FOUND = { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } };

function draftChanged(currentVersion?: number) {
  return {
    status: 409,
    body: { error: { class: "conflict", code: "conflict.draft_changed", retryDisposition: "never", userMessage: "", details: currentVersion === undefined ? {} : { currentVersion } } },
  };
}

/** A saved draft as the server returns it. */
function savedDraft(version: number, segments = draftFromSegments(SEGMENTS)) {
  return { id: "d1", contentId: "c1", baseRevisionId: "r1", version, segments, updatedAt: 1 };
}

/** Answers a PUT with the body it was sent, at `version`. */
const echo = (version: number) => (call: RecordedCall) => ({ body: { id: "d1", contentId: "c1", ...(call.body as object), version, updatedAt: 1 } });

function renderEditor(onClose = vi.fn()) {
  const state = { content: contentDetail(), primaryRevisionId: "r1", selection: undefined, select: vi.fn(), openTab: vi.fn(), highlightThreshold: 80, setHighlightThreshold: vi.fn(), openSubtitleEditor: vi.fn() };
  renderApp(
    <ContentPageProvider value={state}>
      <DraftEditor base={revision("r1")} primaryRevisionId="r1" onClose={onClose} />
    </ContentPageProvider>,
  );
  return onClose;
}

const puts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "PUT").map((call) => call.body as { expectedVersion: number | null; segments: Array<{ text: string }> });

describe("DraftEditor", () => {
  it("starts from the base sentences, each pointing at its source", () => {
    expect(draftFromSegments(SEGMENTS)[1]).toEqual({ id: "s2", startMs: 4_000, endMs: 8_000, text: "先看向量库。", sourceSegmentIds: ["s2"] });
  });

  it("saves before committing, names the draft version, and shows a changed primary instead of overwriting", async () => {
    let commits = 0;
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": NOT_FOUND,
      "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
      "PUT /api/contents/c1/transcript/draft": echo(1),
      "POST /api/contents/c1/transcript/draft/commit": () => {
        commits += 1;
        return commits === 1
          ? { status: 409, body: { error: { class: "conflict", code: "conflict.primary_changed", retryDisposition: "never", userMessage: "", details: { currentPrimaryRevisionId: "r2" } } } }
          : { status: 201, body: revision("m1", { kind: "manual", parentRevisionId: "r1" }) };
      },
    });
    const onClose = renderEditor();
    const first = await screen.findByDisplayValue("今天讲检索。");
    fireEvent.change(first, { target: { value: "今天讲检索增强。" } });
    fireEvent.click(screen.getByTestId("draft-commit"));
    expect(await screen.findByTestId("draft-conflict")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    const commitBodies = () => calls.filter((call) => call.path.endsWith("/commit")).map((call) => call.body);
    expect(commitBodies()).toEqual([{ expectedPrimaryRevisionId: "r1", draftVersion: 1 }]);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]?.expectedVersion).toBeNull();
    expect(puts(calls)[0]?.segments[0]?.text).toBe("今天讲检索增强。");

    fireEvent.click(screen.getByText("仍然提交"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(commitBodies()).toEqual([
      { expectedPrimaryRevisionId: "r1", draftVersion: 1 },
      { expectedPrimaryRevisionId: "r2", draftVersion: 1 },
    ]);
    // Already saved: the retry does not save again.
    expect(puts(calls)).toHaveLength(1);
  });

  it("discards a saved draft at its version, only after a second confirmation", async () => {
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": { body: savedDraft(3) },
      "DELETE /api/contents/c1/transcript/draft": { status: 204 },
    });
    const onClose = renderEditor();
    await screen.findByDisplayValue("今天讲检索。");
    const discard = screen.getByTestId("draft-discard");
    expect(discard.textContent).toBe("放弃草稿");
    fireEvent.click(discard);
    expect(discard.textContent).toBe("确认放弃草稿");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(discard);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/contents/c1/transcript/draft?version=3"]);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("leaves a draft that never reached the server without any request", async () => {
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": NOT_FOUND,
      "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
    });
    const onClose = renderEditor();
    await screen.findByDisplayValue("今天讲检索。");
    fireEvent.click(screen.getByTestId("draft-discard"));
    fireEvent.click(screen.getByTestId("draft-discard"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.some((call) => call.method === "DELETE" || call.method === "PUT")).toBe(false);
  });

  it("on a draft changed elsewhere, 「以本窗口为准」 overwrites at the server's version", async () => {
    let saves = 0;
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": { body: savedDraft(3) },
      "PUT /api/contents/c1/transcript/draft": (call) => {
        saves += 1;
        return saves === 1 ? draftChanged(5) : echo(6)(call);
      },
    });
    renderEditor();
    fireEvent.change(await screen.findByDisplayValue("今天讲检索。"), { target: { value: "本窗口" } });
    expect(await screen.findByTestId("draft-changed", {}, { timeout: 3000 })).toBeTruthy();
    expect((screen.getByTestId("draft-commit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("draft-keep-mine"));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls).map((body) => body.expectedVersion)).toEqual([3, 5]);
    expect(puts(calls)[1]?.segments[0]?.text).toBe("本窗口");
    await waitFor(() => expect(screen.queryByTestId("draft-changed")).toBeNull());
  });

  it("「以本窗口为准」 re-creates a draft that is gone; 「载入最新」 takes the other window's text", async () => {
    let gets = 0;
    let saves = 0;
    const { calls } = mockApi({
      "GET /api/contents/c1/transcript/draft": () => {
        gets += 1;
        return { body: gets === 1 ? savedDraft(3) : savedDraft(7, draftFromSegments([segment("s1", 0, 0, 4_000, "另一个窗口")])) };
      },
      "PUT /api/contents/c1/transcript/draft": (call) => {
        saves += 1;
        return saves === 1 ? draftChanged() : echo(1)(call);
      },
    });
    renderEditor();
    fireEvent.change(await screen.findByDisplayValue("今天讲检索。"), { target: { value: "本窗口" } });
    await screen.findByTestId("draft-changed", {}, { timeout: 3000 });
    // The banner names the conflict; the status line does not repeat it.
    expect(screen.getByTestId("draft-save-status").textContent).toBe("未保存");
    fireEvent.click(screen.getByTestId("draft-load-latest"));
    expect(await screen.findByDisplayValue("另一个窗口")).toBeTruthy();
    expect(screen.queryByTestId("draft-changed")).toBeNull();
    fireEvent.change(screen.getByDisplayValue("另一个窗口"), { target: { value: "再改" } });
    await waitFor(() => expect(puts(calls)).toHaveLength(2), { timeout: 3000 });
    expect(puts(calls)[1]?.expectedVersion).toBe(7);
  });

  it("shows a failed save with a retry, and asks before leaving unsaved edits", async () => {
    let saves = 0;
    mockApi({
      "GET /api/contents/c1/transcript/draft": { body: savedDraft(3) },
      "PUT /api/contents/c1/transcript/draft": (call) => {
        saves += 1;
        return saves === 1 ? { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } } : echo(4)(call);
      },
    });
    const onClose = renderEditor();
    fireEvent.change(await screen.findByDisplayValue("今天讲检索。"), { target: { value: "改了" } });
    expect(await screen.findByTestId("draft-retry", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByTestId("draft-save-status").textContent).toContain("保存失败");
    fireEvent.click(screen.getByTestId("draft-exit"));
    expect(await screen.findByText("还有修改没有保存到草稿，退出后这些修改会丢失。")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("取消"));
    fireEvent.click(screen.getByTestId("draft-retry"));
    await waitFor(() => expect(screen.getByTestId("draft-save-status").textContent).toBe("自动保存"));
    fireEvent.click(screen.getByTestId("draft-exit"));
    expect(onClose).toHaveBeenCalled();
  });
});
