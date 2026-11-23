import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { LIST_PAGE_SIZE_DEFAULT } from "../../../src/shared/defaults.ts";
import type { ContentEvent } from "../../../src/web/api/content-events.ts";
import { useContentEvents } from "../../../src/web/api/context.tsx";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { DeleteContentDialog, DeleteContentsDialog, type DeleteOutcome } from "../../../src/web/components/delete-content-dialog.tsx";
import { noteKeys, useNoteGroups } from "../../../src/web/notes/queries.ts";
import { searchKeys } from "../../../src/web/search/search.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

/** Keeps the notes groups mounted (so an invalidation refetches), exposes the cache and records content events. */
function Probe(props: { onClient: (client: QueryClient) => void; events: ContentEvent[] }) {
  props.onClient(useQueryClient());
  const contentEvents = useContentEvents();
  const { events } = props;
  useEffect(() => contentEvents.subscribe((event) => void events.push(event)), [contentEvents, events]);
  useNoteGroups({ page: 1, pageSize: LIST_PAGE_SIZE_DEFAULT });
  return null;
}

/** A pre-check answer: each entry `[contentId, state, extra]`, titled 「<id> 标题」 unless missing. */
function plan(...items: Array<[string, string, Record<string, unknown>?]>) {
  return { body: { items: items.map(([contentId, state, extra]) => ({ contentId, ...(state === "missing" ? {} : { title: `${contentId} 标题` }), state, ...extra })) } };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

/** The batch dialog as the library opens it: closing clears the ids; settled outcomes are recorded. */
function Batch(props: { ids: string[]; outcomes: DeleteOutcome[] }) {
  const [ids, setIds] = useState<string[] | undefined>(props.ids);
  return (
    <>
      <p data-testid="open">{ids === undefined ? "closed" : "open"}</p>
      <DeleteContentsDialog contentIds={ids} onOpenChange={(open) => (open ? undefined : setIds(undefined))} onSettled={(outcome) => void props.outcomes.push(outcome)} />
    </>
  );
}

const confirmButton = (): HTMLButtonElement => screen.getByTestId("delete-confirm") as HTMLButtonElement;

describe("DeleteContentDialog", () => {
  it("says the Content moves to the trash for the retention period, keeping local files", async () => {
    mockApi({ "POST /api/contents/trash-plan": plan(["c1", "ready"]) });
    renderApp(<DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole("dialog", { name: "删除这条内容？" });
    expect(dialog.textContent).toContain("「第一讲」");
    expect(dialog.textContent).toContain("内容移入回收站，30 天内可恢复；本地原文件不会被删除。");
    // The shared sectioned layout: a scrolling body, a footer with the destructive confirmation.
    expect(dialog.hasAttribute("data-sectioned")).toBe(true);
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(confirmButton().textContent).toBe("删除");
    expect(confirmButton().className).toContain("bg-danger");
    expect(screen.queryByTestId("delete-tasks-note")).toBeNull();
  });

  it("after moving to the trash hides the Content's notes, refreshes every view, announces it and keeps the dismissed cache card", async () => {
    const { calls } = mockApi({
      "POST /api/contents/trash-plan": plan(["c1", "ready"]),
      "DELETE /api/contents/c1": { status: 204 },
      "GET /api/notes/groups": { body: { items: [], total: 0 } },
    });
    let queryClient: QueryClient | undefined;
    const events: ContentEvent[] = [];
    localStorage.setItem("amber.cache.dismissed.c1", "task-1");
    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    renderApp(
      <>
        <Probe onClient={(client) => (queryClient = client)} events={events} />
        <DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={onOpenChange} onDeleted={onDeleted} />
      </>,
    );
    const groupReads = () => calls.filter((call) => call.path.startsWith("/api/notes/groups")).length;
    await waitFor(() => expect(groupReads()).toBe(1));
    queryClient?.setQueryData(queryKeys.content("c1"), { id: "c1" });
    queryClient?.setQueryData(noteKeys.content("c1"), { items: [] });
    queryClient?.setQueryData(noteKeys.content("c1", "rev-1"), { items: [] });
    queryClient?.setQueryData(noteKeys.content("c2"), { items: [] });
    for (const key of [queryKeys.contentsAll, queryKeys.collections, queryKeys.collection("k1"), searchKeys.query("x", "global"), [...queryKeys.trash, "list"]]) {
      queryClient?.setQueryData(key, { items: [] });
    }

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/contents/c1")).toBe(true);
    expect(calls.find((call) => call.path === "/api/contents/trash-plan")?.body).toEqual({ contentIds: ["c1"] });
    // Without tasks a single Content keeps its own endpoint.
    expect(calls.some((call) => call.path === "/api/contents/trash")).toBe(false);
    expect((await screen.findByTestId("toast")).textContent).toContain("已将 1 项移入回收站");
    expect(queryClient?.getQueryData(queryKeys.content("c1"))).toBeUndefined();
    expect(queryClient?.getQueryData(noteKeys.content("c1"))).toBeUndefined();
    expect(queryClient?.getQueryData(noteKeys.content("c1", "rev-1"))).toBeUndefined();
    expect(queryClient?.getQueryData(noteKeys.content("c2"))).toEqual({ items: [] });
    expect(groupReads()).toBe(2);
    for (const key of [queryKeys.contentsAll, queryKeys.collections, queryKeys.collection("k1"), searchKeys.query("x", "global"), [...queryKeys.trash, "list"]]) {
      expect(queryClient?.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(events).toEqual([{ type: "trashed", contentId: "c1" }]);
    // A restore brings the Content back as it was, the closed cache card included.
    expect(localStorage.getItem("amber.cache.dismissed.c1")).toBe("task-1");
    localStorage.removeItem("amber.cache.dismissed.c1");
  });

  it("keeps the dialog open and checks again when a task started after the pre-check, then cancels it on confirm", async () => {
    let planned = 0;
    const { calls } = mockApi({
      // The first pre-check finds nothing in the way; a task starts before the deletion arrives.
      "POST /api/contents/trash-plan": () => {
        planned += 1;
        return planned === 1 ? plan(["c1", "ready"]) : plan(["c1", "tasks", { unfinishedTaskCount: 1 }]);
      },
      "DELETE /api/contents/c1": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.tasks_unfinished", retryDisposition: "never", userMessage: "这条内容还有未结束的任务" } },
      },
      "POST /api/contents/trash": { body: { trashedIds: ["c1"], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 1 } },
    });
    const events: ContentEvent[] = [];
    const onOpenChange = vi.fn();
    renderApp(
      <>
        <Probe onClient={() => undefined} events={events} />
        <DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={onOpenChange} />
      </>,
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    const changed = await within(dialog).findByTestId("delete-plan-changed");
    expect(changed.getAttribute("role")).toBe("alert");
    expect(changed.textContent).toBe("内容没有删除：期间开始了新任务，情况已更新，请重新确认");
    // The server's advice to cancel in the task panel would contradict the new confirm button.
    expect(within(dialog).queryByText("这条内容还有未结束的任务")).toBeNull();
    await waitFor(() => expect(confirmButton().textContent).toBe("取消任务并删除"));
    expect(screen.getByTestId("delete-single-state").textContent).toBe("这条内容有 1 个未结束的任务，删除前会先取消。");
    expect(confirmButton().disabled).toBe(false);
    expect(calls.filter((call) => call.path === "/api/contents/trash-plan")).toHaveLength(2);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(events).toEqual([]);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((call) => call.path === "/api/contents/trash")?.body).toEqual({ contentIds: ["c1"], cancelTasks: true });
  });

  it("keeps the dialog open with the server's reason for any other refusal", async () => {
    mockApi({
      "POST /api/contents/trash-plan": plan(["c1", "ready"]),
      "DELETE /api/contents/c1": {
        status: 500,
        body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "删除失败了" } },
      },
    });
    const onOpenChange = vi.fn();
    renderApp(<DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await within(dialog).findByText("删除失败了")).toBeTruthy();
    expect(screen.queryByTestId("delete-plan-changed")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("DeleteContentDialog with tasks or a summary in the way", () => {
  it("names the unfinished tasks and cancels them through the batch endpoint, refreshing the task panel", async () => {
    const { calls } = mockApi({
      "POST /api/contents/trash-plan": plan(["c1", "tasks", { unfinishedTaskCount: 2 }]),
      "POST /api/contents/trash": { body: { trashedIds: ["c1"], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 2 } },
    });
    let queryClient: QueryClient | undefined;
    const onOpenChange = vi.fn();
    renderApp(
      <>
        <Probe onClient={(client) => (queryClient = client)} events={[]} />
        <DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={onOpenChange} />
      </>,
    );
    expect((await screen.findByTestId("delete-single-state")).textContent).toBe("这条内容有 2 个未结束的任务，删除前会先取消。");
    expect(screen.getByTestId("delete-tasks-note").textContent).toContain("已经发生的模型与转录调用无法撤回；远端转录作业会尽力取消");
    expect(confirmButton().textContent).toBe("取消任务并删除");
    queryClient?.setQueryData(queryKeys.unfinishedTasks, { items: [] });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((call) => call.path === "/api/contents/trash")?.body).toEqual({ contentIds: ["c1"], cancelTasks: true });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(queryClient?.getQueryState(queryKeys.unfinishedTasks)?.isInvalidated).toBe(true);
  });

  it("cannot delete a Content frozen by a running collection summary", async () => {
    const { calls } = mockApi({ "POST /api/contents/trash-plan": plan(["c1", "blocked", { blockingCollections: [{ id: "k1", name: "操作系统" }] }]) });
    renderApp(<DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={() => undefined} />);
    expect((await screen.findByTestId("delete-single-state")).textContent).toBe("正在归纳合集「操作系统」，归纳结束前暂时不能删除。");
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(calls.filter((call) => call.method !== "GET" && call.path !== "/api/contents/trash-plan")).toEqual([]);
  });

  it("says a Content already in the trash needs nothing", async () => {
    mockApi({ "POST /api/contents/trash-plan": plan(["c1", "trashed"]) });
    renderApp(<DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={() => undefined} />);
    expect((await screen.findByTestId("delete-single-state")).textContent).toBe("这条内容已在回收站，无需操作。");
    expect(confirmButton().disabled).toBe(true);
  });
});

describe("DeleteContentsDialog", () => {
  it("counts every state of the pre-check, lists the blocked ones on demand and cancels tasks on confirm", async () => {
    const { calls } = mockApi({
      "POST /api/contents/trash-plan": plan(
        ["a", "ready"],
        ["b", "tasks", { unfinishedTaskCount: 1 }],
        ["c", "blocked", { blockingCollections: [{ id: "k1", name: "操作系统" }, { id: "k2" }] }],
        ["d", "trashed"],
        ["e", "missing"],
        ["f", "ready"],
      ),
      "POST /api/contents/trash": { body: { trashedIds: ["a", "b", "f"], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 1 } },
    });
    const outcomes: DeleteOutcome[] = [];
    renderApp(<Batch ids={["a", "b", "c", "d", "e", "f"]} outcomes={outcomes} />);
    expect(await screen.findByRole("dialog", { name: "删除所选的 6 项内容？" })).toBeTruthy();
    const rows = await screen.findByTestId("delete-plan");
    expect(within(rows).getAllByRole("listitem").map((row) => row.dataset["testid"])).toEqual([
      "delete-plan-ready",
      "delete-plan-tasks",
      "delete-plan-blocked",
      "delete-plan-trashed",
      "delete-plan-missing",
    ]);
    expect(screen.getByTestId("delete-plan-ready").textContent).toBe("可直接删除 2 项");
    expect(screen.getByTestId("delete-plan-tasks").textContent).toBe("需要先取消任务 1 项");
    expect(screen.getByTestId("delete-plan-blocked").textContent).toContain("暂时不能删 1 项（正在归纳合集「操作系统」、（已删除的合集））");
    expect(screen.getByTestId("delete-plan-trashed").textContent).toBe("已在回收站 1 项（无需操作）");
    expect(screen.getByTestId("delete-plan-missing").textContent).toBe("已不存在 1 项（无需操作）");
    expect(screen.getByTestId("delete-tasks-note")).toBeTruthy();

    // The blocked Contents are named only when asked.
    const toggle = screen.getByTestId("delete-plan-blocked-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("delete-plan-blocked-items")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("delete-plan-blocked-items").textContent).toBe("c 标题");

    expect(confirmButton().textContent).toBe("取消任务并删除 3 项");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("closed"));
    // Only what can go is sent; blocked, trashed and missing Contents are not.
    expect(calls.find((call) => call.path === "/api/contents/trash")?.body).toEqual({ contentIds: ["a", "f", "b"], cancelTasks: true });
    // Trashed and missing ones leave the selection too; the blocked one stays picked.
    expect(outcomes).toEqual([{ removedIds: ["a", "b", "f", "d", "e"] }]);
  });

  it("leaves out rows that count 0, deletes without cancelling, and offers the trash in the toast", async () => {
    const { calls } = mockApi({
      "POST /api/contents/trash-plan": plan(["a", "ready"], ["b", "ready"]),
      "POST /api/contents/trash": { body: { trashedIds: ["a", "b"], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 0 } },
    });
    const events: ContentEvent[] = [];
    const outcomes: DeleteOutcome[] = [];
    renderApp(
      <>
        <Probe onClient={() => undefined} events={events} />
        <Batch ids={["a", "b"]} outcomes={outcomes} />
        <Where />
      </>,
      { route: "/library" },
    );
    const rows = await screen.findByTestId("delete-plan");
    expect(within(rows).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["可直接删除 2 项"]);
    expect(screen.queryByTestId("delete-tasks-note")).toBeNull();
    expect(confirmButton().textContent).toBe("删除 2 项");
    fireEvent.click(confirmButton());
    const toast = await screen.findByTestId("toast");
    expect(toast.textContent).toContain("已将 2 项移入回收站");
    expect(screen.getByTestId("open").textContent).toBe("closed");
    expect(calls.find((call) => call.path === "/api/contents/trash")?.body).toEqual({ contentIds: ["a", "b"], cancelTasks: false });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(events).toEqual([
      { type: "trashed", contentId: "a" },
      { type: "trashed", contentId: "b" },
    ]);
    expect(outcomes).toEqual([{ removedIds: ["a", "b"] }]);
    fireEvent.click(within(toast).getByTestId("toast-action"));
    expect(screen.getByTestId("where").textContent).toBe("/trash");
  });

  it("stays open with a report of what failed and why, keeping the failures selected", async () => {
    mockApi({
      "POST /api/contents/trash-plan": plan(["a", "ready"], ["b", "tasks", { unfinishedTaskCount: 1 }], ["c", "tasks", { unfinishedTaskCount: 1 }], ["d", "ready"]),
      "POST /api/contents/trash": {
        body: {
          trashedIds: ["a"],
          alreadyTrashedIds: ["d"],
          failed: [
            { contentId: "b", reason: "stopping" },
            { contentId: "c", reason: "summarizing" },
          ],
          cancelledTaskCount: 2,
        },
      },
    });
    const outcomes: DeleteOutcome[] = [];
    renderApp(<Batch ids={["a", "b", "c", "d"]} outcomes={outcomes} />);
    await screen.findByTestId("delete-plan");
    fireEvent.click(confirmButton());
    const report = await screen.findByTestId("delete-report");
    expect(report.textContent).toContain("已将 2 项移入回收站，2 项未能删除：");
    expect(report.textContent).toContain("已取消 2 个任务。");
    const items = within(report).getAllByTestId("delete-report-item");
    expect(items.map((item) => item.textContent)).toEqual(["b 标题任务已取消，但还没有停下来，请稍后再删", "c 标题正在归纳所在的合集，归纳结束后才能删除"]);
    expect(screen.getByTestId("open").textContent).toBe("open");
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(outcomes).toEqual([{ removedIds: ["a", "d"] }]);
    // Only closing is left to do.
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    fireEvent.click(screen.getByTestId("delete-close"));
    expect(screen.getByTestId("open").textContent).toBe("closed");
  });

  it("does not mention cancelled tasks when none were cancelled", async () => {
    mockApi({
      "POST /api/contents/trash-plan": plan(["a", "ready"], ["b", "ready"]),
      "POST /api/contents/trash": { body: { trashedIds: ["a"], alreadyTrashedIds: [], failed: [{ contentId: "b", reason: "tasks" }], cancelledTaskCount: 0 } },
    });
    renderApp(<Batch ids={["a", "b"]} outcomes={[]} />);
    await screen.findByTestId("delete-plan");
    fireEvent.click(confirmButton());
    const report = await screen.findByTestId("delete-report");
    expect(report.textContent).not.toContain("已取消");
    expect(within(report).getByTestId("delete-report-item").textContent).toBe("b 标题有未结束的任务（可能刚刚开始了新任务）");
  });

  it("shows a skeleton while the pre-check runs and the error with a retry when it fails", async () => {
    let answer: "fail" | "hold" | "ok" = "hold";
    let release: (() => void) | undefined;
    // The route table answers everything else; the pre-check is held, then failed, then answered.
    mockApi({});
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/contents/trash-plan") {
        if (answer === "hold") await new Promise<void>((resolve) => (release = resolve));
        if (answer === "fail") {
          return new Response(JSON.stringify({ error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "检查失败" } }), { status: 500, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(plan(["a", "ready"]).body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return original(input, init);
    });
    renderApp(<Batch ids={["a"]} outcomes={[]} />);
    expect(await screen.findByTestId("delete-plan-loading")).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    answer = "fail";
    release?.();
    expect((await screen.findByTestId("delete-plan-error")).textContent).toContain("检查失败");
    expect(confirmButton().disabled).toBe(true);
    answer = "ok";
    fireEvent.click(screen.getByTestId("delete-plan-retry"));
    expect((await screen.findByTestId("delete-plan-ready")).textContent).toBe("可直接删除 1 项");
    expect(screen.queryByTestId("delete-plan-error")).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it("reads the pre-check again on every opening", async () => {
    const { calls } = mockApi({ "POST /api/contents/trash-plan": plan(["a", "ready"]) });
    function Reopen() {
      const [ids, setIds] = useState<string[] | undefined>(["a"]);
      return (
        <>
          <button type="button" data-testid="reopen" onClick={() => setIds(["a"])} />
          <DeleteContentsDialog contentIds={ids} onOpenChange={(open) => (open ? undefined : setIds(undefined))} />
        </>
      );
    }
    renderApp(<Reopen />);
    await screen.findByTestId("delete-plan");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByTestId("reopen"));
    await screen.findByTestId("delete-plan");
    expect(calls.filter((call) => call.path === "/api/contents/trash-plan")).toHaveLength(2);
  });
});
