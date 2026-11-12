import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { useTaskNotifications } from "../../../src/web/desktop/task-notifications.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn<(options: { title: string; body: string }) => void>(),
}));

vi.mock("@tauri-apps/plugin-notification", () => plugin);
vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

/** A task stream the test writes frames into. */
function stream() {
  let push: ((text: string) => void) | undefined;
  vi.stubGlobal("fetch", async (input: string) => {
    if (String(input).endsWith("/api/tasks/events")) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
          },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  });
  let seq = 0;
  return {
    opened: () => push !== undefined,
    frame: (type: string, task: object) => {
      seq += 1;
      push?.(`event: ${type}\ndata: ${JSON.stringify({ task })}\nid: ${seq}\n\n`);
    },
  };
}

function Notifier() {
  useTaskNotifications();
  return null;
}

const TASK = { id: "t1", kind: "burn", contentId: "c1", targetTitle: "第一讲", createdAt: 1 };

beforeEach(() => {
  fakeShell.desktop = true;
  for (const mock of Object.values(plugin)) mock.mockReset();
  plugin.isPermissionGranted.mockResolvedValue(false);
  plugin.requestPermission.mockResolvedValue("granted");
});

async function mounted(): Promise<(type: string, task: object) => void> {
  const { opened, frame } = stream();
  render(
    <ApiProvider client={new ApiClient({ baseUrl: "" }, "local")} queryClient={createQueryClient()}>
      <Notifier />
    </ApiProvider>,
  );
  // The stream opens once the desktop check resolved and the hook subscribed.
  await vi.waitFor(() => expect(opened()).toBe(true));
  return frame;
}

describe("useTaskNotifications", () => {
  it("notifies a finished task while the window is not focused, asking for permission first", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const frame = await mounted();
    frame("task.updated", { ...TASK, statusProjection: "running" });
    frame("task.finished", { ...TASK, statusProjection: "succeeded", finishedAt: 2 });
    await vi.waitFor(() => expect(plugin.sendNotification).toHaveBeenCalledTimes(1));
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "第一讲", body: "导出字幕视频：已完成" });
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("names an untitled task by its kind and stays quiet while the window has focus", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    plugin.isPermissionGranted.mockResolvedValue(true);
    const frame = await mounted();
    frame("task.finished", { id: "t2", kind: "cache_media", statusProjection: "failed", createdAt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    focus.mockReturnValue(false);
    frame("task.finished", { id: "t2", kind: "cache_media", statusProjection: "failed", createdAt: 1 });
    await vi.waitFor(() => expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "缓存视频", body: "缓存视频：失败" }));
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("names a transcription made only to compare speakers with as such, not as a re-transcription", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    plugin.isPermissionGranted.mockResolvedValue(true);
    const frame = await mounted();
    frame("task.finished", { ...TASK, kind: "retranscribe", comparison: true, statusProjection: "failed", finishedAt: 2 });
    await vi.waitFor(() => expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "第一讲", body: "对比转录：失败" }));
  });
});
