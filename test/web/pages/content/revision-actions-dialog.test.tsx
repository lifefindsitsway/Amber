import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RevisionDeleteDialog, setBlockers, setHistoryArtifacts } from "../../../../src/web/pages/content/revision-actions-dialog.tsx";
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
  history: 0,
  ...overrides,
});

/** Local-time instants, so the `MM-DD HH:mm` labels read the same in any time zone. */
const AT_1004 = new Date(2026, 9, 4, 11, 50).getTime();
const AT_1005 = new Date(2026, 9, 5, 9, 5).getTime();
const AT_1006 = new Date(2026, 9, 6, 20, 30).getTime();

const SUMMARIES_ROUTE = {
  "GET /api/contents/c1/summaries": {
    body: { templates: [{ template: { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false }, stale: false }] },
  },
};

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

  it("counts a history artifact once however many members it cites", () => {
    const shared = { kind: "chapter" as const, revisionId: "cr1", createdAt: AT_1005 };
    const list = [
      revision("a", { kind: "manual", blockers: blockers({ history: 2 }), historyArtifacts: [{ kind: "summary", revisionId: "sr1", templateId: "summary.core", createdAt: AT_1006 }, shared], descendantIds: ["b"] }),
      revision("b", { kind: "manual", parentRevisionId: "a", blockers: blockers({ history: 2 }), historyArtifacts: [shared, { kind: "highlight", revisionId: "hr1", createdAt: AT_1004 }] }),
    ];
    expect(setHistoryArtifacts(["a"], list).map((artifact) => artifact.revisionId)).toEqual(["cr1", "sr1"]);
    expect(setHistoryArtifacts(["a", "b"], list).map((artifact) => artifact.revisionId)).toEqual(["hr1", "cr1", "sr1"]);
    expect(setBlockers(["a", "b"], list)).toEqual(blockers({ history: 3 }));
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
    const { api } = render(target, {
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "m1", version: 4, segments: [], updatedAt: 1 } },
      "GET /api/contents/c1/translations": {
        body: {
          activeTasks: [],
          translations: [
            { artifactId: "a-en", targetLanguage: "en", revisions: [], stale: false, draft: { baseRevisionId: "m1-en", version: 2, updatedAt: 1 } },
            { artifactId: "a-ja", targetLanguage: "ja", revisions: [], stale: false, draft: { baseRevisionId: "m1", version: 1, updatedAt: 1 } },
          ],
        },
      },
      "DELETE /api/contents/c1/transcript/draft": { status: 204 },
      "DELETE /api/contents/c1/translations/ja/draft": { status: 204 },
    });
    const discard = await screen.findByTestId("revision-discard-draft");
    expect((screen.getByTestId("revision-archive-instead") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(discard);
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(discard.textContent).toBe("确认放弃草稿");
    expect(screen.getByTestId("revision-discard-draft-hint")).toBeTruthy();
    fireEvent.click(discard);
    // Only drafts whose base is in the delete set go, each at the version just read, so a save
    // from another window in between is refused rather than lost.
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
        "/api/contents/c1/transcript/draft?version=4",
        "/api/contents/c1/translations/ja/draft?version=1",
      ]),
    );
  });

  it("leaves a transcript draft whose base is outside the delete set", async () => {
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", blockers: blockers({ draft: 1 }) });
    const { api } = render(target, {
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version: 4, segments: [], updatedAt: 1 } },
      "GET /api/contents/c1/translations": {
        body: { activeTasks: [], translations: [{ artifactId: "a-ja", targetLanguage: "ja", revisions: [], stale: false, draft: { baseRevisionId: "m1", version: 1, updatedAt: 1 } }] },
      },
      "DELETE /api/contents/c1/translations/ja/draft": { status: 204 },
    });
    const discard = await screen.findByTestId("revision-discard-draft");
    fireEvent.click(discard);
    fireEvent.click(discard);
    await waitFor(() => expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/contents/c1/translations/ja/draft?version=1"]));
  });

  it("lists the history artifacts and blocks the delete until they are opted in", async () => {
    const target = revision("m1", {
      kind: "manual",
      parentRevisionId: "r1",
      deletable: true,
      blockers: blockers({ history: 4 }),
      historyArtifacts: [
        { kind: "summary", revisionId: "sr1", templateId: "summary.core", createdAt: AT_1004 },
        { kind: "summary", revisionId: "sr2", templateId: "gone", createdAt: AT_1005 },
        { kind: "chapter", revisionId: "cr1", createdAt: AT_1005 },
        { kind: "highlight", revisionId: "hr1", createdAt: AT_1006 },
      ],
    });
    const { api, onDeleted } = render(target, { ...SUMMARIES_ROUTE, "DELETE /api/transcript/revisions/m1": { status: 204 } });
    const section = screen.getByTestId("revision-history-artifacts");
    await waitFor(() => expect(section.querySelector('[data-artifact-revision-id="sr1"]')?.textContent).toBe("核心总结 · 10-04 11:50 · 历史版本"));
    expect([...section.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "核心总结 · 10-04 11:50 · 历史版本",
      "总结 · 10-05 09:05 · 历史版本",
      "章节 · 10-05 09:05 · 历史版本",
      "AI 高光 · 10-06 20:30 · 历史版本",
    ]);
    const optIn = screen.getByTestId("revision-delete-history") as HTMLInputElement;
    expect(optIn.checked).toBe(false);
    expect(section.textContent).toContain("同时删除这些历史版本（4 份）");
    expect(screen.getByTestId("revision-blocker-history").textContent).toBe("历史版本 4 份（可勾选上方选项一并删除）");
    expect((screen.getByTestId("revision-delete-confirm") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(optIn);
    expect(screen.queryByTestId("revision-blockers")).toBeNull();
    const confirm = screen.getByTestId("revision-delete-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.calls.find((call) => call.method === "DELETE")?.path).toBe("/api/transcript/revisions/m1?withDescendants=false&withHistory=true");
  });

  it("gathers the history of the descendants deleted along, each artifact once", async () => {
    const shared = { kind: "chapter" as const, revisionId: "cr1", createdAt: AT_1005 };
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", descendantIds: ["m2"], blockers: blockers({ children: 1, history: 1 }), historyArtifacts: [shared] });
    const child = revision("m2", { kind: "manual", parentRevisionId: "m1", blockers: blockers({ history: 2 }), historyArtifacts: [shared, { kind: "highlight", revisionId: "hr1", createdAt: AT_1006 }] });
    const api = mockApi({ ...SUMMARIES_ROUTE, "DELETE /api/transcript/revisions/m1": { status: 204 } });
    const onDeleted = vi.fn();
    renderApp(<RevisionDeleteDialog contentId="c1" revision={target} revisions={[revision("r1", { kind: "asr" }), target, child]} primaryId="r1" onClose={vi.fn()} onDeleted={onDeleted} />);
    const items = () => [...screen.getByTestId("revision-history-artifacts").querySelectorAll("li")].map((item) => item.getAttribute("data-artifact-revision-id"));
    expect(items()).toEqual(["cr1"]);
    fireEvent.click(screen.getByTestId("revision-delete-descendants"));
    expect(items()).toEqual(["cr1", "hr1"]);
    expect(screen.getByTestId("revision-blocker-history").textContent).toBe("历史版本 2 份（可勾选上方选项一并删除）");
    expect(screen.queryByTestId("revision-blocker-children")).toBeNull();
    fireEvent.click(screen.getByTestId("revision-delete-history"));
    fireEvent.click(screen.getByTestId("revision-delete-confirm"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.calls.find((call) => call.method === "DELETE")?.path).toBe("/api/transcript/revisions/m1?withDescendants=true&withHistory=true");
  });

  it("shows a refused history count as a blocker until it is opted in", async () => {
    const target = revision("m1", { kind: "manual", parentRevisionId: "r1", deletable: true });
    render(target, {
      "DELETE /api/transcript/revisions/m1": {
        status: 409,
        body: {
          error: {
            class: "conflict",
            code: "conflict.revision_referenced",
            retryDisposition: "never",
            userMessage: "这个版本仍被引用，不能删除",
            details: { ...blockers(), history: 1 },
          },
        },
      },
    });
    expect(screen.queryByTestId("revision-history-artifacts")).toBeNull();
    fireEvent.click(await screen.findByTestId("revision-delete-confirm"));
    expect((await screen.findByTestId("revision-blocker-history")).textContent).toBe("历史版本 1 份（可勾选上方选项一并删除）");
    expect((screen.getByTestId("revision-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("revision-history-artifacts").textContent).toContain("同时删除这些历史版本（1 份）");
  });
});
