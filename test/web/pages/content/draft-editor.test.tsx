import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useContentEvents } from "../../../../src/web/api/context.tsx";
import type { ContentEvent } from "../../../../src/web/api/content-events.ts";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { DraftEditor, draftFromSegments } from "../../../../src/web/pages/content/draft-editor.tsx";
import { contentDetail, revision, segment, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";
import { commitBodies, editorRoutes, puts as speakerPuts, renderSpeakerEditor, talk } from "../../../fixtures/web/speaker-editor.tsx";

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
    expect(draftFromSegments(SEGMENTS)[1]).toEqual({ id: "s2", startMs: 4_000, endMs: 8_000, text: "先看向量库。", sourceSegmentIds: ["s2"], speakerId: null });
  });

  it("states each sentence's speaker in a new draft: the source's, or null for none", () => {
    const draft = draftFromSegments([segment("a", 0, 0, 1_000, "甲", { speakerId: "spk-a" }), segment("b", 1, 1_000, 2_000, "乙")]);
    expect(draft.map((item) => item.speakerId)).toEqual(["spk-a", null]);
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

describe("DraftEditor and speakers", () => {
  it("saves a new draft with every sentence stating its speaker", async () => {
    const { calls } = mockApi(editorRoutes());
    renderSpeakerEditor();
    fireEvent.change(await screen.findByDisplayValue("第1句内容。"), { target: { value: "改过。" } });
    await waitFor(() => expect(speakerPuts(calls)).toHaveLength(1), { timeout: 3000 });
    expect(speakerPuts(calls)[0]?.segments.map((item) => item["speakerId"])).toEqual(["spk-a", "spk-a", "spk-b", "spk-b", "spk-b", "spk-a"]);
  });

  it("keeps an older draft's sentences as they are, speakers absent, while showing the source's speakers", async () => {
    const old = talk().map((item) => ({ id: item.id, startMs: item.startMs, endMs: item.endMs, text: item.text, sourceSegmentIds: [item.id] }));
    const { calls } = mockApi({
      ...editorRoutes(),
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version: 2, segments: old, updatedAt: 1 } },
    });
    renderSpeakerEditor();
    fireEvent.change(await screen.findByDisplayValue("第1句内容。"), { target: { value: "改过。" } });
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")[2]?.getAttribute("aria-label")).toBe("发言人：林雪"));
    await waitFor(() => expect(speakerPuts(calls)).toHaveLength(1), { timeout: 3000 });
    for (const sent of speakerPuts(calls)[0]?.segments ?? []) expect(sent).not.toHaveProperty("speakerId");
  });

  it("keeps speakerReview through a save and a reload of the draft", async () => {
    const reviewed = talk().map((item, index) => ({ id: item.id, startMs: item.startMs, endMs: item.endMs, text: item.text, sourceSegmentIds: [item.id], speakerId: item.speakerId ?? null, speakerReview: index === 2 ? ("needs_review" as const) : ("auto" as const) }));
    let stored: unknown = reviewed;
    let version = 3;
    const { calls } = mockApi({
      ...editorRoutes(),
      "GET /api/contents/c1/transcript/draft": () => ({ body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version, segments: stored, updatedAt: 1 } }),
      "PUT /api/contents/c1/transcript/draft": (call) => {
        stored = (call.body as { segments: unknown }).segments;
        version += 1;
        return { body: { id: "d1", contentId: "c1", ...(call.body as object), version, updatedAt: 1 } };
      },
    });
    renderSpeakerEditor();
    fireEvent.change(await screen.findByDisplayValue("第1句内容。"), { target: { value: "改过。" } });
    await waitFor(() => expect(speakerPuts(calls)).toHaveLength(1), { timeout: 3000 });
    expect(speakerPuts(calls)[0]?.segments.map((item) => item["speakerReview"])).toEqual(["auto", "auto", "needs_review", "auto", "auto", "auto"]);
    cleanup();
    renderSpeakerEditor();
    await screen.findByDisplayValue("改过。");
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead-review")).toHaveLength(1));
    expect(screen.getByTestId("draft-review-count").textContent).toBe("需确认 1");
  });

  it("filters a 2,888-sentence draft to the sentences to confirm, edits and reassigns some, and commits all 2,888 as they were otherwise", async () => {
    const total = 2_888;
    const toConfirm = new Set(Array.from({ length: 50 }, (_, index) => index * 57 + 3));
    const draft = Array.from({ length: total }, (_, index) => ({
      id: `n${index}`,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: `第${index}句。`,
      sourceSegmentIds: [`n${index}`],
      speakerId: index % 7 < 3 ? "spk-a" : "spk-b",
      speakerReview: toConfirm.has(index) ? ("needs_review" as const) : ("auto" as const),
    }));
    const { calls } = mockApi({
      ...editorRoutes(),
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version: 5, segments: draft, updatedAt: 1 } },
    });
    renderSpeakerEditor();
    await screen.findByDisplayValue("第0句。");
    fireEvent.click(screen.getByTestId("draft-review-count"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(50));
    expect(screen.getByTestId("speaker-filter-bar").textContent).toContain(`50 / ${total.toLocaleString()}`);
    const confirmed = [...toConfirm].sort((a, b) => a - b);
    // Three texts edited, and three speakers changed with the digit keys, all inside the filtered view.
    const edited = new Set([confirmed[0] as number, confirmed[1] as number, confirmed[49] as number]);
    for (const index of edited) fireEvent.change(screen.getByDisplayValue(`第${index}句。`), { target: { value: `改${index}。` } });
    const reassigned = new Map<number, string>();
    const targets = [10, 25, 40].map((position) => ({ index: confirmed[position] as number, lead: screen.getAllByTestId("speaker-lead")[position] as HTMLElement }));
    for (const { index, lead } of targets) {
      const was = draft[index]?.speakerId;
      reassigned.set(index, was === "spk-a" ? "spk-b" : "spk-a");
      fireEvent.keyDown(lead, { key: was === "spk-a" ? "2" : "1" });
    }
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(47));
    expect(screen.getByTestId("draft-review-count").textContent).toBe("需确认 47");

    fireEvent.click(screen.getByTestId("draft-commit"));
    fireEvent.click(await screen.findByTestId("commit-review-accept"));
    await waitFor(() => expect(commitBodies(calls)).toHaveLength(1));
    expect(commitBodies(calls)[0]).toEqual({ expectedPrimaryRevisionId: "r1", draftVersion: 1, speakerReview: "accept_suggestions" });

    // Every sentence, hidden or not, is what it was except the six that were touched.
    const last = speakerPuts(calls).at(-1)?.segments ?? [];
    expect(last).toHaveLength(total);
    const expected = draft.map((original, index) => ({
      ...original,
      ...(edited.has(index) ? { text: `改${index}。` } : {}),
      ...(reassigned.has(index) ? { speakerId: reassigned.get(index) } : {}),
    }));
    for (const index of reassigned.keys()) delete (expected[index] as { speakerReview?: string }).speakerReview;
    expect(last).toEqual(expected);
  }, 60_000);

  it("tells the user's other tabs about the speakers when it commits", async () => {
    const seen: ContentEvent[] = [];
    function Listen() {
      const events = useContentEvents();
      useEffect(() => events.subscribe((event) => seen.push(event)), [events]);
      return null;
    }
    const { calls } = mockApi(editorRoutes());
    renderSpeakerEditor({
      wrap: (children) => (
        <>
          <Listen />
          {children}
        </>
      ),
    });
    fireEvent.change(await screen.findByDisplayValue("第1句内容。"), { target: { value: "改过。" } });
    fireEvent.click(screen.getByTestId("draft-commit"));
    await waitFor(() => expect(commitBodies(calls)).toHaveLength(1));
    await waitFor(() => expect(seen).toContainEqual({ type: "speakersChanged", contentId: "c1" }));
  });
});
