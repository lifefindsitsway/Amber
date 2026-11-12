import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_HISTORY_HIDE_MAX, TASK_HISTORY_PAGE_SIZE } from "../../../src/shared/defaults.ts";
import { collectionDetailDtoSchema } from "../../../src/shared/dto/collection.ts";
import type { ContentEventBus } from "../../../src/web/api/content-events.ts";
import { useApi, useContentEvents } from "../../../src/web/api/context.tsx";
import { queryKeys, useContents } from "../../../src/web/api/queries.ts";
import { formatDateTime, formatTime } from "../../../src/web/format.ts";
import { TaskPanel, taskTarget, useTaskListRefresh } from "../../../src/web/shell/task-panel.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { baseRoutes, collectionDetail, stageRun, task, taskDetail } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

/** The first history page the panel reads. */
const HISTORY_PATH = `/api/tasks?history=1&limit=${TASK_HISTORY_PAGE_SIZE}`;
const HISTORY = `GET ${HISTORY_PATH}`;

const INSTANCE = {
  concurrencyPipeline: 2,
  maxDataGB: 50,
  lowWaterFreeGB: 5,
  lowWaterFreeRatio: 0.05,
  uploadRetentionDefault: "keep",
  updatedAt: 0,
  envOverridden: [],
};

describe("taskTarget", () => {
  it("points at the content or the collection a task works on", () => {
    expect(taskTarget({ contentId: "c1" })).toBe("/contents/c1");
    expect(taskTarget({ collectionId: "k1" })).toBe("/collections/k1");
    expect(taskTarget({})).toBeUndefined();
  });
});

describe("TaskPanel", () => {
  it("lists unfinished tasks with their current stage and cancels on request", async () => {
    const running = task("t1", { targetTitle: "第一讲" });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [running], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "source", "succeeded"), stageRun("t1", "asr", "running", { progress: 0.5 })], { targetTitle: "第一讲" }) },
      "POST /api/tasks/t1/cancel": { body: taskDetail("t1", [], { statusProjection: "cancelled" }) },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    expect(await screen.findByText("第一讲")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("当前：语音转写"));
    expect(screen.getByRole("link", { name: "查看" }).getAttribute("href")).toBe("/contents/content-t1");
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/tasks/t1/cancel")).toBe(true));
  });

  it("surfaces a parked unit even while other units of the stage still run", async () => {
    const proofread = stageRun("t1", "proofread", "running", { progress: 0.4 });
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { targetTitle: "第一讲" })], eventSeq: 0 } },
      "GET /api/tasks/t1": {
        body: taskDetail("t1", [stageRun("t1", "source", "succeeded"), proofread], {
          targetTitle: "第一讲",
          workUnits: [
            { id: "w1", stageRunId: proofread.id, key: "proofread:0", status: "running", attempt: 1, retryCount: 0 },
            { id: "w2", stageRunId: proofread.id, key: "proofread:1", status: "waiting_user_action", attempt: 1, retryCount: 0 },
          ],
        }),
      },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("校对 · 等待你确认"));
    expect(screen.getByRole("button", { name: "确认重新发送（1）" })).toBeTruthy();
    expect(screen.getByText(/1 个请求已发出但结果未知/)).toBeTruthy();
  });

  it("confirms every parked unit in order with one click", async () => {
    const proofread = stageRun("t1", "proofread", "running");
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { statusProjection: "waiting" })], eventSeq: 0 } },
      "GET /api/tasks/t1": {
        body: taskDetail("t1", [proofread], {
          statusProjection: "waiting",
          workUnits: [
            { id: "w1", stageRunId: proofread.id, key: "proofread:0", status: "waiting_user_action", attempt: 1, retryCount: 0 },
            { id: "w2", stageRunId: proofread.id, key: "proofread:1", status: "waiting_user_action", attempt: 1, retryCount: 0 },
          ],
        }),
      },
      "POST /api/tasks/t1/work-units/w1/confirm-resend": { status: 202, body: { taskId: "t1" } },
      "POST /api/tasks/t1/work-units/w2/confirm-resend": { status: 202, body: { taskId: "t1" } },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "确认重新发送（2）" }));
    const posts = () => calls.filter((call) => call.method === "POST").map((call) => call.path);
    await waitFor(() => expect(posts()).toEqual(["/api/tasks/t1/work-units/w1/confirm-resend", "/api/tasks/t1/work-units/w2/confirm-resend"]));
    expect(screen.queryByTestId("task-progress")).toBeNull();
  });

  it("ignores a parked unit of an earlier attempt of the stage", async () => {
    const old = stageRun("t1", "proofread", "failed");
    const latest = stageRun("t1", "proofread", "running", { attempt: 2 });
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1")], eventSeq: 0 } },
      "GET /api/tasks/t1": {
        body: taskDetail("t1", [old, latest], {
          workUnits: [{ id: "w1", stageRunId: old.id, key: "proofread:0", status: "waiting_user_action", attempt: 1, retryCount: 0 }],
        }),
      },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("当前：校对"));
    expect(screen.queryByTestId("resend-prompt")).toBeNull();
    expect(screen.queryByRole("button", { name: /确认重新发送/ })).toBeNull();
  });

  it("stops at the first failed confirmation, shows the error and reads the task again", async () => {
    const proofread = stageRun("t1", "proofread", "running");
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { statusProjection: "waiting" })], eventSeq: 0 } },
      "GET /api/tasks/t1": {
        body: taskDetail("t1", [proofread], {
          statusProjection: "waiting",
          workUnits: [
            { id: "w1", stageRunId: proofread.id, key: "proofread:0", status: "waiting_user_action", attempt: 1, retryCount: 0 },
            { id: "w2", stageRunId: proofread.id, key: "proofread:1", status: "waiting_user_action", attempt: 1, retryCount: 0 },
          ],
        }),
      },
      "POST /api/tasks/t1/work-units/w1/confirm-resend": { status: 202, body: { taskId: "t1" } },
      "POST /api/tasks/t1/work-units/w2/confirm-resend": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict", retryDisposition: "never", userMessage: "状态已变化" } },
      },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    const button = await screen.findByRole("button", { name: "确认重新发送（2）" });
    const snapshotReads = () => calls.filter((call) => call.method === "GET" && call.path === "/api/tasks/t1").length;
    await waitFor(() => expect(snapshotReads()).toBeGreaterThan(0));
    const readsBefore = snapshotReads();
    fireEvent.click(button);
    expect(await screen.findByText("状态已变化")).toBeTruthy();
    const posts = calls.filter((call) => call.method === "POST").map((call) => call.path);
    expect(posts).toEqual(["/api/tasks/t1/work-units/w1/confirm-resend", "/api/tasks/t1/work-units/w2/confirm-resend"]);
    await waitFor(() => expect(snapshotReads()).toBeGreaterThan(readsBefore));
  });

  it("keeps the progress bar for a running stage without parked units", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1")], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "asr", "running", { progress: 0.5 })]) },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("当前：语音转写"));
    expect(screen.getByTestId("task-progress").querySelector<HTMLElement>("div")?.style.width).toBe("50%");
    expect(screen.queryByTestId("resend-prompt")).toBeNull();
  });

  it("names the running step after the current stage", async () => {
    const asr = stageRun("t1", "asr", "running", { progress: 0.2 });
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1")], eventSeq: 0 } },
      "GET /api/tasks/t1": {
        body: taskDetail("t1", [stageRun("t1", "source", "succeeded"), asr], {
          workUnits: [{ id: "w1", stageRunId: asr.id, key: "media:fetch_audio", status: "running", attempt: 1, retryCount: 0 }],
        }),
      },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("当前：语音转写 · 下载音频"));
    expect(screen.queryByTestId("resend-prompt")).toBeNull();
  });

  it("says a queued task waits its turn instead of naming a stage", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { statusProjection: "queued" })], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "source", "pending")], { statusProjection: "queued" }) },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("排队中"));
    expect(screen.getByTestId("task-card").textContent).not.toContain("当前：");
    expect(screen.queryByTestId("task-progress")).toBeNull();
  });

  describe("a task waiting for the model service", () => {
    // Only `Date` is faked so the test library's own timers keep running.
    const NOW = new Date(2026, 9, 7, 10, 0).getTime();
    afterEach(() => {
      vi.useRealTimers();
    });

    function renderQueued(retryNotBefore: number | undefined) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const extra = retryNotBefore === undefined ? {} : { retryNotBefore };
      mockApi({
        ...baseRoutes(),
        "GET /api/tasks": { body: { items: [task("t1", { statusProjection: "queued", ...extra })], eventSeq: 0 } },
        "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "proofread", "running")], { statusProjection: "queued", ...extra }) },
      });
      renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    }

    it("says when it continues, in local time, while the cooldown lasts", async () => {
      renderQueued(new Date(2026, 9, 7, 10, 5).getTime());
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("等待模型服务恢复，10:05 后继续"));
      expect(screen.getByTestId("task-card").textContent).not.toContain("排队中");
      expect(screen.queryByTestId("task-progress")).toBeNull();
    });

    it("adds the date when the cooldown ends on another day", async () => {
      renderQueued(new Date(2026, 9, 8, 9, 5).getTime());
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("等待模型服务恢复，10/8 09:05 后继续"));
    });

    it("says it waits for the transcription result when the wait is an ASR job's", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const wait = { statusProjection: "queued" as const, retryNotBefore: new Date(2026, 9, 7, 10, 5).getTime(), waitingStep: "awaitResult" as const };
      mockApi({
        ...baseRoutes(),
        "GET /api/tasks": { body: { items: [task("t1", wait)], eventSeq: 0 } },
        "GET /api/tasks/t1": { body: taskDetail("t1", [stageRun("t1", "asr", "running")], wait) },
      });
      renderApp(<TaskPanel open onOpenChange={() => undefined} />);
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("等待转写结果，10:05 后查询"));
      expect(screen.getByTestId("task-card").textContent).not.toContain("等待模型服务恢复");
    });

    it("says queued once the cooldown has passed", async () => {
      renderQueued(NOW - 1_000);
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("排队中"));
      expect(screen.getByTestId("task-card").textContent).not.toContain("等待模型服务恢复");
    });

    it("says queued without a cooldown", async () => {
      renderQueued(undefined);
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("排队中"));
      expect(screen.getByTestId("task-card").textContent).not.toContain("等待模型服务恢复");
    });

    it("falls back to queued when the cooldown passes without a new event", async () => {
      renderQueued(NOW + 50);
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("等待模型服务恢复，10:00 后继续"));
      vi.setSystemTime(NOW + 60);
      await waitFor(() => expect(screen.getByTestId("task-card").textContent).toContain("排队中"));
    });
  });

  it("shows the local administrator the task limit with a link to the concurrency settings", async () => {
    const onOpenChange = vi.fn();
    mockApi({ ...baseRoutes(), "GET /api/instance-settings": { body: INSTANCE } });
    renderApp(<TaskPanel open onOpenChange={onOpenChange} />);
    expect((await screen.findByTestId("task-capacity")).textContent).toContain("最多同时处理 2 个任务");
    const adjust = screen.getByRole("link", { name: "调整" });
    expect(adjust.getAttribute("href")).toBe("/settings/storage#concurrency");
    fireEvent.click(adjust);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("points a server administrator to the admin area", async () => {
    mockApi({ ...baseRoutes({ mode: "server" }), "GET /api/instance-settings": { body: { ...INSTANCE, concurrencyPipeline: 5 } } });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />, { mode: "server" });
    expect((await screen.findByTestId("task-capacity")).textContent).toContain("最多同时处理 5 个任务");
    expect(screen.getByRole("link", { name: "调整" }).getAttribute("href")).toBe("/admin/instance#concurrency");
  });

  it("never reads the instance parameters for a server user who is not an administrator", async () => {
    const { calls } = mockApi({
      ...baseRoutes({ mode: "server" }),
      "GET /api/auth/me": { body: { userId: "u2", username: "reader", role: "user", mode: "server", mustChangePassword: false } },
      "GET /api/instance-settings": { body: INSTANCE },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />, { mode: "server" });
    expect(await screen.findByText("没有进行中的任务")).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.path === "/api/auth/me")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.some((call) => call.path === "/api/instance-settings")).toBe(false);
    expect(screen.queryByTestId("task-capacity")).toBeNull();
  });

  it("shows an empty state", async () => {
    mockApi(baseRoutes());
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    expect(await screen.findByText("没有进行中的任务")).toBeTruthy();
  });
});

describe("TaskPanel and the trash", () => {
  /** Exposes the content event bus of the rendered app. */
  function BusProbe(props: { onBus: (bus: ContentEventBus) => void }) {
    props.onBus(useContentEvents());
    return null;
  }

  it("drops the card of a task whose snapshot read finds it gone and reads the lists again", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { targetTitle: "第一讲" }), task("t2", { targetTitle: "第二讲" })], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [], { targetTitle: "第一讲" }) },
      "GET /api/tasks/t2": { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    expect(await screen.findByText("第一讲")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("第二讲")).toBeNull());
    expect(screen.getAllByTestId("task-card")).toHaveLength(1);
    // The lists are out of date, so they are read again.
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/tasks?unfinished=1").length).toBeGreaterThan(1));
  });

  it("reads both lists again when a Content is trashed, purged or restored, and shows what the server lists", async () => {
    const hidden = new Set<string>();
    const listed = (items: ReturnType<typeof task>[]) => ({ body: { items: items.filter((item) => !hidden.has(item.contentId as string)), eventSeq: 0 } });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": () => listed([task("t1", { targetTitle: "第一讲", contentId: "c1" }), task("t3", { targetTitle: "第三讲", contentId: "c3" })]),
      [HISTORY]: () => listed([task("h2", { targetTitle: "第二讲", contentId: "c2", statusProjection: "succeeded", finishedAt: 2 })]),
      "GET /api/tasks/t1": { body: taskDetail("t1", [], { targetTitle: "第一讲", contentId: "c1" }) },
      "GET /api/tasks/t3": { body: taskDetail("t3", [], { targetTitle: "第三讲", contentId: "c3" }) },
    });
    let bus: ContentEventBus | undefined;
    renderApp(
      <>
        <BusProbe onBus={(value) => (bus = value)} />
        <TaskPanel open onOpenChange={() => undefined} />
      </>,
    );
    expect(await screen.findByText("第二讲")).toBeTruthy();
    expect(screen.getAllByTestId("task-card")).toHaveLength(2);
    const reads = (path: string) => calls.filter((call) => call.path === path).length;
    const before = { unfinished: reads("/api/tasks?unfinished=1"), history: reads(HISTORY_PATH) };
    hidden.add("c1");
    hidden.add("c2");
    act(() => bus?.publish({ type: "trashed", contentId: "c1" }));
    act(() => bus?.publish({ type: "purged", contentId: "c2" }));
    await waitFor(() => expect(screen.getAllByTestId("task-card")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("task-history")).toBeNull());
    expect(screen.getByText("第三讲")).toBeTruthy();
    expect(reads("/api/tasks?unfinished=1")).toBeGreaterThan(before.unfinished);
    expect(reads(HISTORY_PATH)).toBeGreaterThan(before.history);
    hidden.delete("c2");
    act(() => bus?.publish({ type: "restored", contentId: "c2" }));
    expect(await screen.findByText("第二讲")).toBeTruthy();
  });

  it("does not read the lists again for speaker changes or speaker reviews, which change no task", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": { body: { items: [task("t1", { targetTitle: "第一讲", contentId: "c1" })], eventSeq: 0 } },
      [HISTORY]: { body: { items: [], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [], { targetTitle: "第一讲", contentId: "c1" }) },
    });
    let bus: ContentEventBus | undefined;
    renderApp(
      <>
        <BusProbe onBus={(value) => (bus = value)} />
        <TaskPanel open onOpenChange={() => undefined} />
      </>,
    );
    expect(await screen.findByText("第一讲")).toBeTruthy();
    const reads = () => calls.filter((call) => call.path === "/api/tasks?unfinished=1" || call.path === HISTORY_PATH).length;
    const before = reads();
    act(() => bus?.publish({ type: "speakersChanged", contentId: "c1" }));
    act(() => bus?.publish({ type: "speakerReviewChanged", contentId: "c1" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toBe(before);
  });
});

describe("task history", () => {
  it("shows finished tasks read from the server below the unfinished ones, each task once", async () => {
    const created = new Date(2026, 9, 1, 9, 30).getTime();
    const ended = new Date(2026, 9, 1, 10, 15).getTime();
    const nextDay = new Date(2026, 9, 2, 0, 5).getTime();
    const { contentId: _content, ...rest } = task("h2", { kind: "summarize_collection", statusProjection: "failed", createdAt: created });
    const collectionTask = { ...rest, collectionId: "k1" };
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": { body: { items: [task("t1", { targetTitle: "第一讲" })], eventSeq: 0 } },
      [HISTORY]: {
        body: {
          items: [
            // Finished a moment ago, and still in the unfinished list until it is read again.
            task("t1", { targetTitle: "第一讲", statusProjection: "succeeded", finishedAt: ended }),
            task("h1", { targetTitle: "第二讲", statusProjection: "succeeded", createdAt: created, finishedAt: ended }),
            collectionTask,
            task("h3", { targetTitle: "第三讲", statusProjection: "succeeded", createdAt: created, finishedAt: nextDay }),
          ],
          eventSeq: 0,
        },
      },
      "GET /api/tasks/t1": { body: taskDetail("t1", [], { targetTitle: "第一讲" }) },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    const history = await screen.findByTestId("task-history");
    expect(within(screen.getByTestId("task-active")).getAllByTestId("task-card")).toHaveLength(1);
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(within(history).getByText("历史")).toBeTruthy();
    const cards = within(history).getAllByTestId("task-history-card");
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain("第二讲");
    expect(cards[0]?.textContent).toContain("处理视频 · 已完成");
    // An end on the start's date repeats only the time; one on a later date shows its date.
    expect(cards[0]?.textContent).toContain(`开始于 ${formatDateTime(created, "zh-CN")} · 结束于 ${formatTime(ended, "zh-CN")}`);
    expect(cards[2]?.textContent).toContain(`开始于 ${formatDateTime(created, "zh-CN")} · 结束于 ${formatDateTime(nextDay, "zh-CN")}`);
    expect(within(cards[0] as HTMLElement).getByRole("link", { name: "查看" }).getAttribute("href")).toBe("/contents/content-h1");
    expect(cards[1]?.textContent).toContain("合集归纳 · 失败");
    expect(cards[1]?.textContent).not.toContain("结束于");
    expect(within(cards[1] as HTMLElement).getByRole("link", { name: "查看" }).getAttribute("href")).toBe("/collections/k1");
    expect(screen.queryByTestId("task-history-more")).toBeNull();
    // History cards show the listed fields and read no snapshot.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => /^\/api\/tasks\/h\d$/.test(call.path))).toEqual([]);
  });

  it("shows the history alone, without the unfinished heading or the empty state", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } },
      [HISTORY]: { body: { items: [task("h1", { targetTitle: "第二讲", statusProjection: "cancelled", finishedAt: 2 })], eventSeq: 0 } },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    expect((await screen.findByTestId("task-history-card")).textContent).toContain("已取消");
    expect(screen.queryByTestId("task-active")).toBeNull();
    expect(screen.queryByText("进行中")).toBeNull();
    expect(screen.queryByText("没有进行中的任务")).toBeNull();
  });

  it("names a transcription made only to compare speakers with apart from the Content's re-transcription", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } },
      [HISTORY]: {
        body: {
          items: [
            task("h1", { kind: "retranscribe", comparison: true, targetTitle: "第一讲", statusProjection: "failed", finishedAt: 2 }),
            task("h2", { kind: "retranscribe", targetTitle: "第一讲", statusProjection: "succeeded", finishedAt: 2 }),
          ],
          eventSeq: 0,
        },
      },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findAllByTestId("task-history-card");
    const cards = screen.getAllByTestId("task-history-card");
    expect(cards[0]?.textContent).toContain("对比转录 · 失败");
    expect(cards[0]?.textContent).not.toContain("重新转录");
    expect(cards[1]?.textContent).toContain("重新转录 · 已完成");
  });

  it("loads the next page after the last one's cursor on request", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } },
      [HISTORY]: { body: { items: [task("h1", { targetTitle: "第一讲", statusProjection: "succeeded", finishedAt: 3 })], nextCursor: "next-1", eventSeq: 0 } },
      [`${HISTORY}&cursor=next-1`]: { body: { items: [task("h2", { targetTitle: "第二讲", statusProjection: "succeeded", finishedAt: 2 })], eventSeq: 0 } },
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    expect(await screen.findByText("第一讲")).toBeTruthy();
    expect(calls.some((call) => call.path.includes("cursor="))).toBe(false);
    fireEvent.click(screen.getByTestId("task-history-more"));
    expect(await screen.findByText("第二讲")).toBeTruthy();
    expect(screen.getAllByTestId("task-history-card")).toHaveLength(2);
    expect(calls.filter((call) => call.path === `${HISTORY_PATH}&cursor=next-1`)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("task-history-more")).toBeNull());
  });
});

describe("useTaskListRefresh", () => {
  it("reads collection lecture lists again when a task finishes", async () => {
    const { calls } = mockApi({ ...baseRoutes(), "GET /api/collections/k1": { body: collectionDetail("k1", "LLM", ["c1"]) } });
    // The task stream is one the test pushes frames into; everything else goes to the route table.
    const routed = globalThis.fetch;
    let push: (text: string) => void = () => undefined;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/api/tasks/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return routed(input, init);
    });
    function Probe() {
      useTaskListRefresh();
      const api = useApi();
      useQuery({ queryKey: queryKeys.collection("k1"), queryFn: () => api.get("/api/collections/k1", collectionDetailDtoSchema) });
      return null;
    }
    const lectureReads = () => calls.filter((call) => call.path === "/api/collections/k1").length;
    renderApp(<Probe />);
    await waitFor(() => expect(lectureReads()).toBe(1));
    push(`event: task.finished\ndata: ${JSON.stringify({ task: task("t1", { statusProjection: "succeeded" }) })}\nid: 1\n\n`);
    await waitFor(() => expect(lectureReads()).toBe(2));
  });

  it("reads content lists again once a new Content's title is known, before its task ends", async () => {
    const { calls } = mockApi(baseRoutes());
    const routed = globalThis.fetch;
    let push: (text: string) => void = () => undefined;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/api/tasks/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return routed(input, init);
    });
    function Probe() {
      useTaskListRefresh();
      useContents({ limit: 10, uncollected: true });
      return null;
    }
    const listReads = () => calls.filter((call) => call.path.startsWith("/api/contents?")).length;
    renderApp(<Probe />);
    await waitFor(() => expect(listReads()).toBe(1));
    const frame = (id: number, stage: string, status: string) =>
      `event: stage.updated\ndata: ${JSON.stringify({ stageRun: stageRun("t1", stage as never, status as never) })}\nid: ${id}\n\n`;
    // Other stages, or the title stage still running, change no title.
    push(frame(1, "subtitle", "succeeded"));
    push(frame(2, "media", "running"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listReads()).toBe(1);
    push(frame(3, "media", "succeeded"));
    await waitFor(() => expect(listReads()).toBe(2));
  });
});

/** Fires a right click and reports whether the browser menu was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe("task card context menu", () => {
  function renderPanel(onOpenChange: (open: boolean) => void) {
    renderApp(
      <ContextMenuHost blockNative={false}>
        <TaskPanel open onOpenChange={onOpenChange} />
        <Where />
      </ContextMenuHost>,
      { route: "/library" },
    );
  }

  it("views the task's result and closes the panel", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { targetTitle: "第一讲" })], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [], { targetTitle: "第一讲" }) },
    });
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);
    const card = (await screen.findByText("第一讲")).closest("[data-testid='task-card']") as HTMLElement;
    expect(rightClick(card)).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["查看", "取消任务"]);
    fireEvent.click(screen.getByTestId("context-menu-item-view"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/content-t1"));
  });

  it("cancels the task without the press on the menu closing the panel", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [task("t1", { targetTitle: "第一讲" })], eventSeq: 0 } },
      "GET /api/tasks/t1": { body: taskDetail("t1", [], { targetTitle: "第一讲" }) },
      "POST /api/tasks/t1/cancel": { body: taskDetail("t1", [], { statusProjection: "cancelled" }) },
    });
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);
    const card = (await screen.findByText("第一讲")).closest("[data-testid='task-card']") as HTMLElement;
    rightClick(card);
    const item = screen.getByTestId("context-menu-item-cancel-task");
    // The dialog starts listening for outside presses a tick after it opens.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/tasks/t1/cancel")).toBe(true));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("offers viewing and removing on a history card", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } },
      [HISTORY]: { body: { items: [task("h1", { targetTitle: "第二讲", statusProjection: "succeeded", finishedAt: 2 })], eventSeq: 0 } },
    });
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);
    const card = (await screen.findByText("第二讲")).closest("[data-testid='task-history-card']") as HTMLElement;
    expect(rightClick(card)).toBe(true);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["查看", "从历史移除"]);
    fireEvent.click(screen.getByTestId("context-menu-item-view"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/contents/content-h1"));
  });

  it("offers nothing for a finished task without a result page, leaving the browser menu", async () => {
    const { contentId: _content, ...finished } = task("t2", { targetTitle: "导出", statusProjection: "succeeded" });
    mockApi({
      ...baseRoutes(),
      "GET /api/tasks": { body: { items: [finished], eventSeq: 0 } },
      "GET /api/tasks/t2": { body: { ...finished, stageRuns: [], workUnits: [], eventSeq: 0 } },
    });
    renderPanel(() => undefined);
    const card = (await screen.findByText("导出")).closest("[data-testid='task-card']") as HTMLElement;
    expect(rightClick(card)).toBe(false);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });
});

/** A history the test controls: hidden tasks leave `GET`, a restore brings back the batch. */
function historyApi(initial: ReturnType<typeof task>[], extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) {
  const hidden = new Map<string, string[]>();
  const hiddenIds = (): Set<string> => new Set([...hidden.values()].flat());
  let batches = 0;
  const hide = (ids: string[]): { body: { hidden: number; batchId: string } } => {
    const fresh = ids.filter((id) => !hiddenIds().has(id));
    const batchId = `b${(batches += 1)}`;
    hidden.set(batchId, fresh);
    return { body: { hidden: fresh.length, batchId } };
  };
  const api = mockApi({
    ...baseRoutes(),
    "GET /api/tasks?unfinished=1": { body: { items: [], eventSeq: 0 } },
    [HISTORY]: () => ({ body: { items: initial.filter((item) => !hiddenIds().has(item.id)), eventSeq: 0 } }),
    "POST /api/tasks/history/hide": (call) => hide((call.body as { taskIds: string[] }).taskIds),
    "POST /api/tasks/history/clear": () => hide(initial.filter((item) => !hiddenIds().has(item.id)).map((item) => item.id)),
    "POST /api/tasks/history/restore": (call) => {
      const batch = hidden.get((call.body as { batchId: string }).batchId) ?? [];
      hidden.delete((call.body as { batchId: string }).batchId);
      return { body: { restored: batch.length } };
    },
    ...extra,
  });
  return { ...api, posts: () => api.calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]), reads: () => api.calls.filter((call) => call.path === HISTORY_PATH).length };
}

const finishedTask = (id: string, title: string) => task(id, { targetTitle: title, statusProjection: "succeeded", finishedAt: 2 });
const titles = () => screen.queryAllByTestId("task-history-card").map((card) => card.querySelector("p")?.textContent);

describe("removing tasks from the history", () => {
  it("lists the history with history=1, never finished=1", async () => {
    const { calls } = historyApi([finishedTask("h1", "第一讲")]);
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("第一讲");
    expect(calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/tasks?") && call.path.includes("limit=")).map((call) => call.path)).toEqual([HISTORY_PATH]);
    // Two secondary actions in the heading row, none in the danger colour.
    const actions = screen.getByTestId("task-history-actions");
    expect([...actions.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["选择", "清空历史"]);
    expect(actions.innerHTML).not.toContain("text-danger");
  });

  it("removes the picked cards, with an undo that puts the same batch back", async () => {
    const { posts, reads } = historyApi([finishedTask("h1", "第一讲"), finishedTask("h2", "第二讲"), finishedTask("h3", "第三讲")]);
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("第一讲");
    expect(screen.queryAllByTestId("task-history-check")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("task-history-select"));
    const checks = screen.getAllByTestId("task-history-check") as HTMLInputElement[];
    expect(checks).toHaveLength(3);
    expect(checks[0]?.getAttribute("aria-label")).toBe("选择任务记录「第一讲」");
    const removeButton = screen.getByTestId("task-history-remove-selected") as HTMLButtonElement;
    expect(removeButton.textContent).toBe("从历史移除（0）");
    expect(removeButton.disabled).toBe(true);
    fireEvent.click(checks[0] as HTMLElement);
    fireEvent.click(checks[2] as HTMLElement);
    expect(removeButton.textContent).toBe("从历史移除（2）");
    const readsBefore = reads();
    fireEvent.click(removeButton);
    await waitFor(() => expect(posts()).toEqual([["/api/tasks/history/hide", { taskIds: ["h1", "h3"] }]]));
    await waitFor(() => expect(titles()).toEqual(["第二讲"]));
    // The mode ends, the notice offers the undo, and the list is read again.
    expect(screen.queryByTestId("task-history-check")).toBeNull();
    expect(screen.getByTestId("task-history-removed").textContent).toContain("已从任务栏移除 2 项");
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));

    fireEvent.click(screen.getByTestId("task-history-undo"));
    await waitFor(() => expect(posts().at(-1)).toEqual(["/api/tasks/history/restore", { batchId: "b1" }]));
    await waitFor(() => expect(titles()).toEqual(["第一讲", "第二讲", "第三讲"]));
    expect(screen.queryByTestId("task-history-removed")).toBeNull();
  });

  it("selects all cards and toggles back, and leaves the mode with no request", async () => {
    const { posts } = historyApi([finishedTask("h1", "第一讲"), finishedTask("h2", "第二讲")]);
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("第一讲");
    fireEvent.click(screen.getByTestId("task-history-select"));
    fireEvent.click(screen.getByTestId("task-history-select-all"));
    expect(screen.getByTestId("task-history-remove-selected").textContent).toBe("从历史移除（2）");
    expect(screen.getByTestId("task-history-select-all").textContent).toBe("取消全选");
    fireEvent.click(screen.getByTestId("task-history-select-all"));
    expect(screen.getByTestId("task-history-remove-selected").textContent).toBe("从历史移除（0）");
    fireEvent.click(screen.getByTestId("task-history-done"));
    expect(screen.queryByTestId("task-history-check")).toBeNull();
    expect(screen.getByTestId("task-history-select")).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it("sends a long selection in requests of at most TASK_HISTORY_HIDE_MAX ids, and undoes every batch", async () => {
    const total = TASK_HISTORY_HIDE_MAX + 5;
    const all = Array.from({ length: total }, (_, index) => finishedTask(`h${index}`, `讲 ${index}`));
    const { posts } = historyApi(all);
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("讲 0");
    fireEvent.click(screen.getByTestId("task-history-select"));
    fireEvent.click(screen.getByTestId("task-history-select-all"));
    fireEvent.click(screen.getByTestId("task-history-remove-selected"));
    await waitFor(() => expect(screen.getByTestId("task-history-removed").textContent).toContain(`已从任务栏移除 ${total} 项`));
    const hides = posts().filter(([path]) => path === "/api/tasks/history/hide");
    expect(hides.map(([, body]) => (body as { taskIds: string[] }).taskIds.length)).toEqual([TASK_HISTORY_HIDE_MAX, 5]);
    fireEvent.click(screen.getByTestId("task-history-undo"));
    await waitFor(() => expect(posts().filter(([path]) => path === "/api/tasks/history/restore").map(([, body]) => body)).toEqual([{ batchId: "b1" }, { batchId: "b2" }]));
  });

  it("clears the history only after a confirmation that says nothing is deleted", async () => {
    const { posts } = historyApi([finishedTask("h1", "第一讲"), finishedTask("h2", "第二讲")]);
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("第一讲");
    fireEvent.click(screen.getByTestId("task-history-clear"));
    const dialog = await screen.findByRole("dialog", { name: "清空历史？" });
    expect(dialog.textContent).toContain("只从任务栏移除，任务记录与已生成的内容都保留");
    // Not the danger colour: nothing is deleted.
    expect(within(dialog).getByRole("button", { name: "清空" }).className).not.toContain("text-danger");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "清空历史？" })).toBeNull());
    expect(posts()).toEqual([]);

    fireEvent.click(screen.getByTestId("task-history-clear"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "清空历史？" })).getByRole("button", { name: "清空" }));
    await waitFor(() => expect(posts()).toEqual([["/api/tasks/history/clear", undefined]]));
    await waitFor(() => expect(titles()).toEqual([]));
    expect(screen.queryByTestId("task-history")).toBeNull();
    expect((await screen.findByTestId("task-history-removed")).textContent).toContain("已从任务栏移除 2 项");
  });

  it("removes one card from its context menu", async () => {
    const { posts } = historyApi([finishedTask("h1", "第一讲"), finishedTask("h2", "第二讲")]);
    renderApp(
      <ContextMenuHost blockNative={false}>
        <TaskPanel open onOpenChange={() => undefined} />
      </ContextMenuHost>,
    );
    const card = (await screen.findByText("第二讲")).closest("[data-testid='task-history-card']") as HTMLElement;
    expect(rightClick(card)).toBe(true);
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const item = screen.getByTestId("context-menu-item-remove-from-history");
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await waitFor(() => expect(posts()).toEqual([["/api/tasks/history/hide", { taskIds: ["h2"] }]]));
    await waitFor(() => expect(titles()).toEqual(["第一讲"]));
    expect(screen.getByTestId("task-history-removed").textContent).toContain("已从任务栏移除 1 项");
  });

  it("hides the card before the server answers, and puts it back when the request fails", async () => {
    let answer: (reply: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      answer = resolve;
    });
    const failure = { class: "internal", code: "internal", retryDisposition: "safe", userMessage: "移除失败" };
    historyApi([finishedTask("h1", "第一讲"), finishedTask("h2", "第二讲")]);
    // The held answer: the route table answers synchronously, so the hide request is held in `fetch`.
    const routed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/tasks/history/hide") {
        const reply = await pending;
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
      }
      return routed(input, init);
    });
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("第一讲");
    fireEvent.click(screen.getByTestId("task-history-select"));
    fireEvent.click(screen.getAllByTestId("task-history-check")[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("task-history-remove-selected"));
    await waitFor(() => expect(titles()).toEqual(["第二讲"]));
    answer({ status: 500, body: { error: failure } });
    await waitFor(() => expect(titles()).toEqual(["第一讲", "第二讲"]));
    expect(await screen.findByText("移除失败")).toBeTruthy();
    expect(screen.queryByTestId("task-history-removed")).toBeNull();
  });

  it("leaves the picking mode once the picked cards are removed, with no pick left over", async () => {
    historyApi([finishedTask("h1", "第一讲")]);
    renderApp(<TaskPanel open onOpenChange={() => undefined} />);
    await screen.findByText("第一讲");
    fireEvent.click(screen.getByTestId("task-history-select"));
    fireEvent.click(screen.getByTestId("task-history-select-all"));
    fireEvent.click(screen.getByTestId("task-history-remove-selected"));
    await waitFor(() => expect(screen.queryByTestId("task-history")).toBeNull());
    fireEvent.click(screen.getByTestId("task-history-undo"));
    // Back in the plain mode, with no leftover pick.
    await screen.findByText("第一讲");
    expect(screen.queryByTestId("task-history-check")).toBeNull();
    expect(screen.getByTestId("task-history-select")).toBeTruthy();
  });

  it("reads the history again when a task event arrives", async () => {
    const { reads } = historyApi([finishedTask("h1", "第一讲")]);
    const routed = globalThis.fetch;
    let push: (text: string) => void = () => undefined;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/api/tasks/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return routed(input, init);
    });
    function Panel() {
      useTaskListRefresh();
      return <TaskPanel open onOpenChange={() => undefined} />;
    }
    renderApp(<Panel />);
    await screen.findByText("第一讲");
    await waitFor(() => expect(reads()).toBe(1));
    // A finished task that is run again leaves the unfinished state and later returns to the history.
    push(`event: task.updated\ndata: ${JSON.stringify({ task: task("h1", { statusProjection: "running" }) })}\nid: 1\n\n`);
    await waitFor(() => expect(reads()).toBe(2));
    push(`event: task.finished\ndata: ${JSON.stringify({ task: task("h1", { statusProjection: "succeeded" }) })}\nid: 2\n\n`);
    await waitFor(() => expect(reads()).toBe(3));
  });
});
