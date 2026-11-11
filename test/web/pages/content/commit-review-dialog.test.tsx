import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { segment } from "../../../fixtures/web/content-data.ts";
import { commitBodies, editorRoutes, mockApi, renderSpeakerEditor, talk } from "../../../fixtures/web/speaker-editor.tsx";

/** A saved draft in which sentences 2 and 4 wait for their speaker to be confirmed. */
function reviewRoutes() {
  const draft = talk().map((item, index) => ({
    id: item.id,
    startMs: item.startMs,
    endMs: item.endMs,
    text: item.text,
    sourceSegmentIds: [item.id],
    speakerId: index === 3 ? null : (item.speakerId ?? null),
    ...(index === 1 || index === 3 ? { speakerReview: "needs_review" as const } : { speakerReview: "auto" as const }),
  }));
  return {
    ...editorRoutes(),
    "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version: 6, segments: draft, updatedAt: 1 } },
  };
}

describe("「完成」 with sentences still to confirm", () => {
  it("asks first, with 「继续核对」 focused, and goes back to the sentences that need review", async () => {
    const { calls } = mockApi(reviewRoutes());
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    expect(screen.getByTestId("draft-review-count").textContent).toBe("需确认 2");
    fireEvent.click(screen.getByTestId("draft-commit"));
    const dialog = await screen.findByTestId("commit-review-dialog");
    expect(screen.getByTestId("commit-review-remaining").textContent).toBe("还有 2 句的发言人只是按时间重叠给出的建议，没有逐句核对。");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("commit-review-continue")));
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByTestId("commit-review-continue"));
    await waitFor(() => expect(screen.queryByTestId("commit-review-dialog")).toBeNull());
    expect(screen.getByTestId("speaker-filter-bar").textContent).toContain("2 / 6");
    expect(screen.getAllByTestId("speaker-lead")).toHaveLength(2);
    expect(commitBodies(calls)).toEqual([]);
  });

  it("commits with the sentences unassigned", async () => {
    const { calls } = mockApi(reviewRoutes());
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    fireEvent.click(screen.getByTestId("draft-commit"));
    fireEvent.click(await screen.findByTestId("commit-review-unassign"));
    await waitFor(() => expect(commitBodies(calls)).toHaveLength(1));
    expect(commitBodies(calls)[0]).toEqual({ expectedPrimaryRevisionId: "r1", draftVersion: 6, speakerReview: "unassign" });
  });

  it("commits with the suggestions taken, counting only sentences that have one", async () => {
    const { calls } = mockApi(reviewRoutes());
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    fireEvent.click(screen.getByTestId("draft-commit"));
    const accept = await screen.findByTestId("commit-review-accept");
    // Sentence 4 has no suggested speaker, so one sentence is taken on trust.
    expect(accept.parentElement?.textContent).toContain("1 句按建议归属");
    fireEvent.click(accept);
    await waitFor(() => expect(commitBodies(calls)).toHaveLength(1));
    expect(commitBodies(calls)[0]).toEqual({ expectedPrimaryRevisionId: "r1", draftVersion: 6, speakerReview: "accept_suggestions" });
  });

  it("repeats the choice when the commit is retried after the primary changed", async () => {
    let attempts = 0;
    const { calls } = mockApi({
      ...reviewRoutes(),
      "POST /api/contents/c1/transcript/draft/commit": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 409, body: { error: { class: "conflict", code: "conflict.primary_changed", retryDisposition: "never", userMessage: "", details: { currentPrimaryRevisionId: "r9" } } } }
          : { status: 201, body: { id: "m1", contentId: "c1", kind: "manual", language: "zh-CN", timingFidelity: "segment_only", generation: {}, segmentCount: 6, createdAt: 1 } };
      },
    });
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    fireEvent.click(screen.getByTestId("draft-commit"));
    fireEvent.click(await screen.findByTestId("commit-review-accept"));
    fireEvent.click(await screen.findByText("仍然提交"));
    await waitFor(() => expect(commitBodies(calls)).toHaveLength(2));
    expect(commitBodies(calls)[1]).toEqual({ expectedPrimaryRevisionId: "r9", draftVersion: 6, speakerReview: "accept_suggestions" });
  });

  it("commits as before when nothing waits for review: the body has no speaker field", async () => {
    const { calls } = mockApi(editorRoutes([segment("t1", 0, 0, 4_000, "只有一句。", { speakerId: "spk-a" })]));
    renderSpeakerEditor();
    await screen.findByDisplayValue("只有一句。");
    fireEvent.change(screen.getByDisplayValue("只有一句。"), { target: { value: "改过一句。" } });
    fireEvent.click(screen.getByTestId("draft-commit"));
    expect(screen.queryByTestId("commit-review-dialog")).toBeNull();
    await waitFor(() => expect(commitBodies(calls)).toHaveLength(1));
    expect(commitBodies(calls)[0]).toEqual({ expectedPrimaryRevisionId: "r1", draftVersion: 1 });
  });
});
