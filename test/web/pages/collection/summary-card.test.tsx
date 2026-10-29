import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { CollectionSummaryDto } from "../../../../src/shared/dto/collection.ts";
import type { RollupPartialDto } from "../../../../src/shared/dto/summary.ts";
import type { TaskDto } from "../../../../src/shared/dto/task.ts";
import { SummaryCard, summaryExpandedKey, summaryFailureDismissedKey } from "../../../../src/web/pages/collection/summary-card.tsx";
import { stageRun, taskDetail } from "../../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const FAILURE = { class: "llm_failed", code: "llm_failed", retryDisposition: "policy", userMessage: "AI 模型调用失败" } as const;
const ENGINE = { kind: "llm", modelRef: { providerProfileId: "p1", modelId: "m1" } } as const;

/** A published summary with one partial, stale because the order changed; as the server sends it, without citations. */
const PUBLISHED: CollectionSummaryDto = {
  artifactId: "a1",
  stale: true,
  staleReason: "order_changed",
  current: {
    id: "s1",
    artifactId: "a1",
    body: "合集的脉络",
    citations: [],
    inputItems: [{ collectionItemId: "i1", contentId: "c1", transcriptRevisionId: "r1", position: 0 }],
    partials: [{ id: "p0", index: 0, body: "第一组", citations: [], createdAt: 0 }],
    quality: "normal",
    qualityReasons: [],
    stale: true,
    staleReason: "order_changed",
    createdAt: 0,
  },
};
function withPartials(partials: RollupPartialDto[]): CollectionSummaryDto {
  if (PUBLISHED.current === undefined) throw new Error("fixture has a current summary");
  return { ...PUBLISHED, current: { ...PUBLISHED.current, partials } };
}

const FAILED: TaskDto = { id: "f1", kind: "summarize_collection", statusProjection: "failed", collectionId: "k1", createdAt: 1 };

function routes() {
  return mockApi({
    "GET /api/tasks/events": { body: {} },
    "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "collection_summary", "running", { progress: 0.5 })], { kind: "summarize_collection" }) },
    "GET /api/tasks/f1": {
      body: taskDetail("f1", [stageRun("f1", "collection_summary", "failed", { error: FAILURE, engine: ENGINE })], { kind: "summarize_collection", statusProjection: "failed" }),
    },
    "GET /api/tasks/f2": {
      body: taskDetail("f2", [stageRun("f2", "collection_summary", "failed", { error: FAILURE, engine: ENGINE })], { kind: "summarize_collection", statusProjection: "failed" }),
    },
    "POST /api/tasks/f1/retry-stage": { status: 202, body: { taskId: "f1" } },
  });
}

function card(props: { collectionId?: string; summary?: CollectionSummaryDto; latestTask?: TaskDto | null } = {}) {
  return (
    <SummaryCard
      collectionId={props.collectionId ?? "k1"}
      summary={props.summary ?? PUBLISHED}
      latestTask={props.latestTask ?? null}
      onGenerate={() => undefined}
      onDelete={async () => undefined}
    />
  );
}

const toggle = () => screen.getByRole("button", { name: "合集归纳" });

beforeEach(() => {
  localStorage.clear();
});

describe("SummaryCard", () => {
  it("starts closed, still showing the actions and the stale notice", () => {
    routes();
    renderApp(card());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().title).toBe("展开");
    expect(screen.queryByTestId("collection-summary-body")).toBeNull();
    expect(screen.queryByText("合集的脉络")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看详细归纳" })).toBeNull();
    expect(within(screen.getByTestId("collection-summary-actions")).getAllByRole("button").map((button) => button.textContent)).toEqual(["重新归纳", "删除归纳"]);
    expect(screen.getByText("内容顺序已调整，归纳可能已过时")).toBeTruthy();
  });

  it("opens the body without citation jumps, and remembers it per collection across mounts", () => {
    routes();
    const first = renderApp(card());
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().title).toBe("收起");
    const body = screen.getByTestId("collection-summary-body");
    expect(toggle().getAttribute("aria-controls")).toBe(body.id);
    expect(within(body).getByText("合集的脉络")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看详细归纳" }));
    expect(screen.getByText("第一组")).toBeTruthy();
    expect(document.querySelector("[data-citation]")).toBeNull();
    expect(localStorage.getItem(summaryExpandedKey("k1"))).toBe("1");
    first.unmount();

    const second = renderApp(card());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("合集的脉络")).toBeTruthy();
    second.unmount();

    // Another collection keeps its own (default) state.
    const other = renderApp(card({ collectionId: "k2" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    other.unmount();

    renderApp(card());
    fireEvent.click(toggle());
    expect(screen.queryByText("合集的脉络")).toBeNull();
    expect(localStorage.getItem(summaryExpandedKey("k1"))).toBeNull();
  });

  it("offers no details toggle when the summary has no partials", () => {
    routes();
    renderApp(card({ summary: withPartials([]) }));
    fireEvent.click(toggle());
    expect(screen.getByText("合集的脉络")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /详细归纳/ })).toBeNull();
  });

  it("shows a single partial as the details themselves, without a number or hint", () => {
    routes();
    renderApp(card());
    fireEvent.click(toggle());
    const details = screen.getByRole("button", { name: "查看详细归纳" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("第一组")).toBeNull();
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByTestId("collection-summary-body");
    expect(within(body).getByText("第一组")).toBeTruthy();
    expect(within(body).queryByText(/^第 \d+ (组|段|项)$/)).toBeNull();
    expect(within(body).queryByText("第 1 组")).toBeNull();
    expect(within(body).queryByText("第 1 段")).toBeNull();
    expect(screen.queryByText("内容较多时会按顺序分段归纳，序号以生成时为准")).toBeNull();
  });

  it("labels several partials in order by the members they covered, or by sequence when unknown", () => {
    routes();
    const partials = [
      { id: "p2", index: 2, body: "第三段内容", citations: [], createdAt: 0 },
      { id: "p0", index: 0, body: "第一段内容", citations: [], createdAt: 0, itemRange: { first: 1, last: 5 } },
      { id: "p1", index: 1, body: "第二段内容", citations: [], createdAt: 0, itemRange: { first: 6, last: 6 } },
    ];
    renderApp(card({ summary: withPartials(partials) }));
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "详细归纳（3 段）" }));
    expect(screen.getByText("内容较多时会按顺序分段归纳，序号以生成时为准")).toBeTruthy();
    const items = within(screen.getByTestId("collection-summary-body")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["第 1–5 项第一段内容", "第 6 项第二段内容", "第 3 段第三段内容"]);
  });

  it("counts two partials in the toggle and falls back to the segment number without a range", () => {
    routes();
    const partials = [
      { id: "p0", index: 0, body: "前半", citations: [], createdAt: 0, itemRange: { first: 1, last: 5 } },
      { id: "p1", index: 1, body: "后半", citations: [], createdAt: 0 },
    ];
    renderApp(card({ summary: withPartials(partials) }));
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "详细归纳（2 段）" }));
    expect(screen.getByText("第 1–5 项")).toBeTruthy();
    expect(screen.getByText("第 2 段")).toBeTruthy();
  });

  it("keeps the choice for the session when storage refuses writes", () => {
    routes();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    onTestFinished(() => {
      setItem.mockRestore();
      getItem.mockRestore();
    });
    const first = renderApp(card({ collectionId: "k9" }));
    fireEvent.click(toggle());
    expect(screen.getByText("合集的脉络")).toBeTruthy();
    first.unmount();
    renderApp(card({ collectionId: "k9" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a running summary Task's flow while closed", async () => {
    routes();
    renderApp(card({ summary: { ...PUBLISHED, activeTaskId: "t1" }, latestTask: FAILED }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const flow = await screen.findByTestId("task-flow");
    expect(flow.dataset["status"]).toBe("running");
    // The running Task replaces the failed one's notice.
    expect(screen.queryByTestId("collection-summary-failed")).toBeNull();
    for (const button of within(screen.getByTestId("collection-summary-actions")).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the last failed summary Task for a re-run while closed, until closed by its id", async () => {
    const api = routes();
    const first = renderApp(card({ latestTask: FAILED }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const notice = await screen.findByTestId("collection-summary-failed");
    expect(within(notice).getByText("上次归纳失败，可从失败的步骤重跑")).toBeTruthy();
    expect((await within(notice).findByTestId("stage-collection_summary")).dataset["status"]).toBe("failed");
    fireEvent.click(within(notice).getByRole("button", { name: "从这步重跑" }));
    await waitFor(() => expect(api.calls.find((call) => call.path === "/api/tasks/f1/retry-stage")?.body).toEqual({ stage: "collection_summary" }));
    fireEvent.click(within(notice).getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("collection-summary-failed")).toBeNull();
    expect(localStorage.getItem(summaryFailureDismissedKey("k1"))).toBe("f1");
    first.unmount();

    const second = renderApp(card({ latestTask: FAILED }));
    expect(screen.queryByTestId("collection-summary-failed")).toBeNull();
    second.unmount();

    // A later failure is another Task and shows again.
    renderApp(card({ latestTask: { ...FAILED, id: "f2" } }));
    expect((await screen.findByTestId("collection-summary-failed")).dataset["taskId"]).toBe("f2");
  });

  it("offers a failed Task before there is a summary too, next to 「立即归纳」 and without a fold", async () => {
    routes();
    renderApp(card({ summary: { stale: false }, latestTask: FAILED }));
    expect(await screen.findByTestId("collection-summary-failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即归纳" })).toBeTruthy();
    expect(screen.queryByTestId("collection-summary-toggle")).toBeNull();
  });

  it("offers nothing when the last summary Task succeeded or there is none", () => {
    routes();
    const done = renderApp(card({ latestTask: { ...FAILED, statusProjection: "succeeded" } }));
    expect(screen.queryByTestId("collection-summary-failed")).toBeNull();
    done.unmount();
    renderApp(card({ latestTask: null }));
    expect(screen.queryByTestId("collection-summary-failed")).toBeNull();
  });
});
