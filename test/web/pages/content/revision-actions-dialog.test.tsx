import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RevisionDeleteDialog, setBlockers } from "../../../../src/web/pages/content/revision-actions-dialog.tsx";
import { revision } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const blockers = (overrides: Partial<ReturnType<typeof revision>["blockers"]> = {}) => ({
  children: 0,
  draft: 0,
  notes: 0,
  highlights: 0,
  chatMessages: 0,
  artifacts: 0,
  activeTasks: 0,
  ...overrides,
});

describe("setBlockers", () => {
  it("drops children inside the set and sums the other references", () => {
    const list = [
      revision("a", { kind: "manual", blockers: blockers({ children: 1, notes: 1 }), descendantIds: ["b"] }),
      revision("b", { kind: "manual", parentRevisionId: "a", blockers: blockers({ artifacts: 2 }) }),
      revision("c", { kind: "manual", parentRevisionId: "b" }),
    ];
    expect(setBlockers(["a"], list)).toEqual(blockers({ children: 1, notes: 1 }));
    expect(setBlockers(["a", "b"], list)).toEqual(blockers({ children: 1, notes: 1, artifacts: 2 }));
    expect(setBlockers(["a", "b", "c"], list)).toEqual(blockers({ notes: 1, artifacts: 2 }));
  });
});

describe("RevisionDeleteDialog", () => {
  function render(target: ReturnType<typeof revision>, routes: Parameters<typeof mockApi>[0]) {
    const api = mockApi(routes);
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    renderApp(<RevisionDeleteDialog contentId="c1" revision={target} revisions={[revision("r1", { kind: "asr" }), target]} primaryId="r1" onClose={onClose} onDeleted={onDeleted} />);
    return { api, onDeleted, onClose };
  }

  it("deletes an unblocked revision alone by default", async () => {
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", deletable: true });
    const { api, onDeleted } = render(target, { "DELETE /api/transcript/revisions/m1": { status: 204 } });
    expect(screen.queryByTestId("revision-delete-descendants")).toBeNull();
    fireEvent.click(await screen.findByTestId("revision-delete-confirm"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.calls.find((call) => call.method === "DELETE")?.path).toBe("/api/transcript/revisions/m1?withDescendants=false");
  });

  it("shows the server's blockers when it refuses", async () => {
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", deletable: true });
    const { onDeleted } = render(target, {
      "DELETE /api/transcript/revisions/m1": {
        status: 409,
        body: {
          error: {
            class: "conflict",
            code: "conflict.revision_referenced",
            retryDisposition: "never",
            userMessage: "这个版本仍被引用，不能删除",
            details: { ...blockers(), activeTasks: 1 },
          },
        },
      },
    });
    fireEvent.click(await screen.findByTestId("revision-delete-confirm"));
    expect((await screen.findByTestId("revision-blocker-activeTasks")).textContent).toBe("未结束的任务 1 个");
    expect(onDeleted).not.toHaveBeenCalled();
    expect((screen.getByTestId("revision-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("archives instead when blocked", async () => {
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", blockers: blockers({ chatMessages: 3 }) });
    const { api, onClose } = render(target, { "PUT /api/transcript/revisions/m1/archived": { body: { ...target, archived: true, archivedAt: 5 } } });
    expect((await screen.findByTestId("revision-blocker-chatMessages")).textContent).toBe("对话 3 条");
    fireEvent.click(screen.getByTestId("revision-archive-instead"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ archived: true });
  });

  it("discards a blocking draft only after a second confirmation", async () => {
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", blockers: blockers({ draft: 1 }) });
    const { api } = render(target, { "DELETE /api/contents/c1/transcript/draft": { status: 204 } });
    const discard = await screen.findByTestId("revision-discard-draft");
    expect((screen.getByTestId("revision-archive-instead") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(discard);
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(discard.textContent).toBe("确认放弃草稿");
    expect(screen.getByTestId("revision-discard-draft-hint")).toBeTruthy();
    fireEvent.click(discard);
    await waitFor(() => expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/api/contents/c1/transcript/draft")).toBe(true));
  });
});
