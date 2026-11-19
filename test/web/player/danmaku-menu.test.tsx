import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DANMAKU_FETCH_COOLDOWN_MS } from "../../../src/shared/defaults.ts";
import { DANMAKU_PREFS_KEY } from "../../../src/shared/danmaku-prefs.ts";
import type { ContentDanmakuSummary, DanmakuSnapshot } from "../../../src/shared/dto/danmaku.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { createDanmakuOpenState, DanmakuMenu } from "../../../src/web/player/danmaku-menu.tsx";
import { mockApi } from "../../fixtures/web/render.tsx";

let contentSeq = 0;
const snapshot = (count: number, fetchedAt = 1_790_000_000_000): DanmakuSnapshot => ({
  fetchedAt,
  count,
  items: Array.from({ length: count }, (_, index) => ({ timeMs: index * 1000, mode: "scroll" as const, color: 0xffffff, weight: 5, text: `第 ${index} 条` })),
});

function show(summary: ContentDanmakuSummary, routes: Parameters<typeof mockApi>[0]) {
  // A fresh Content per test: opening fetches once per Content and page.
  contentSeq += 1;
  const contentId = `C${contentSeq}`;
  const prefixed = Object.fromEntries(Object.entries(routes).map(([key, reply]) => [key.replace(":id", contentId), reply]));
  const api = mockApi(prefixed);
  const opened: boolean[] = [];
  render(
    <ApiProvider client={new ApiClient({ baseUrl: "" }, "server")} queryClient={createQueryClient()}>
      <DanmakuMenu contentId={contentId} summary={summary} container={null} onOpenChange={(open) => opened.push(open)} />
    </ApiProvider>,
  );
  const fetches = () => api.calls.filter((call) => call.method === "POST" && call.path.endsWith("/danmaku/fetch")).length;
  return { api, opened, fetches };
}

const open = () => fireEvent.click(screen.getByTestId("player-danmaku"));
const button = () => screen.getByTestId<HTMLButtonElement>("player-danmaku-update");

beforeEach(() => localStorage.clear());

describe("DanmakuMenu", () => {
  it("fetches once on the first opening of a Content that never fetched, and says how many came", async () => {
    const { opened, fetches } = show({}, {
      "GET /api/contents/:id/danmaku": { body: { supported: true } },
      "POST /api/contents/:id/danmaku/fetch": { body: { result: "fetched", snapshot: snapshot(3) } },
    });
    open();
    await waitFor(() => expect(opened.at(-1)).toBe(true));
    await waitFor(() => expect(screen.getByTestId("player-danmaku-status").textContent).toBe("已获取 3 条弹幕"));
    await waitFor(() => expect(screen.getByTestId("player-danmaku-summary").textContent).toMatch(/^已获取 3 条 · 更新于 /u));
    // Closing and opening again asks nothing more; the outcome is still there.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("player-danmaku-popover")).toBeNull());
    open();
    expect((await screen.findByTestId("player-danmaku-status")).textContent).toBe("已获取 3 条弹幕");
    expect(fetches()).toBe(1);
    // The update button waits out the cooldown and says for how long; how much of it is left depends on how long the test took.
    expect(button().disabled).toBe(true);
    const wait = Number((await screen.findByTestId("player-danmaku-cooldown")).textContent?.match(/^(\d+) 秒后可再次更新$/u)?.[1]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(DANMAKU_FETCH_COOLDOWN_MS / 1000);
  });

  it("opens from outside through a shared state, and from the picture's corner when anchored there", async () => {
    contentSeq += 1;
    const contentId = `C${contentSeq}`;
    mockApi({ [`GET /api/contents/${contentId}/danmaku`]: { body: { supported: true, snapshot: snapshot(1) } } });
    const state = createDanmakuOpenState();
    const container = document.createElement("div");
    container.tabIndex = 0;
    document.body.append(container);
    const opened: boolean[] = [];
    render(
      <ApiProvider client={new ApiClient({ baseUrl: "" }, "server")} queryClient={createQueryClient()}>
        <DanmakuMenu
          contentId={contentId}
          summary={{ fetchedAt: 1, count: 1 }}
          container={container}
          onOpenChange={(open) => opened.push(open)}
          openState={state}
          anchor={{ x: 0, y: 0, width: 300, height: 170 }}
        />
      </ApiProvider>,
    );
    // No bar button: the popover hangs from a point above the picture's bottom right corner.
    expect(screen.queryByTestId("player-danmaku")).toBeNull();
    const anchor = screen.getByTestId("player-danmaku-anchor");
    expect([anchor.style.left, anchor.style.top]).toEqual(["292px", "122px"]);
    act(() => state.set(true));
    expect(await screen.findByTestId("player-danmaku-popover")).toBeTruthy();
    await waitFor(() => expect(opened.at(-1)).toBe(true));
    // Escape closes it and leaves the focus with the player.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("player-danmaku-popover")).toBeNull());
    expect(state.get()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(container));
    container.remove();
  });

  it("does not fetch on opening when a snapshot exists, and fetches only on 「更新弹幕」", async () => {
    const { fetches } = show({ fetchedAt: 1, count: 2 }, {
      "GET /api/contents/:id/danmaku": { body: { supported: true, snapshot: snapshot(2) } },
      "POST /api/contents/:id/danmaku/fetch": { body: { result: "empty", snapshot: snapshot(0) } },
    });
    open();
    await waitFor(() => expect(screen.getByTestId("player-danmaku-summary").textContent).toMatch(/^已获取 2 条/u));
    expect(fetches()).toBe(0);
    fireEvent.click(screen.getByTestId("player-danmaku-update"));
    await waitFor(() => expect(screen.getByTestId("player-danmaku-status").textContent).toBe("这个视频没有弹幕"));
    expect(screen.getByTestId("player-danmaku-summary").textContent).toMatch(/^已获取 0 条/u);
  });

  it("says a failure kept the last snapshot, with the reason the server gave", async () => {
    show({ fetchedAt: 1, count: 2 }, {
      "GET /api/contents/:id/danmaku": { body: { supported: true, snapshot: snapshot(2) } },
      "POST /api/contents/:id/danmaku/fetch": {
        body: { result: "failed", snapshot: snapshot(2), error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "平台暂时无法访问" } },
      },
    });
    open();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(screen.getByTestId("player-danmaku-update"));
    await waitFor(() => expect(screen.getByTestId("player-danmaku-status").textContent).toBe("获取失败（平台暂时无法访问），已保留上次的弹幕"));
    expect(screen.getByTestId("player-danmaku-summary").textContent).toMatch(/^已获取 2 条/u);
  });

  it("turns a refused request into the wait the server asked for", async () => {
    show({ fetchedAt: 1, count: 2 }, {
      "GET /api/contents/:id/danmaku": { body: { supported: true, snapshot: snapshot(2) } },
      "POST /api/contents/:id/danmaku/fetch": {
        status: 429,
        body: { error: { class: "rate_limited", code: "rate_limited.danmaku_cooldown", retryDisposition: "never", userMessage: "", details: { retryAfterMs: 12_000 } } },
      },
    });
    open();
    fireEvent.click(screen.getByTestId("player-danmaku-update"));
    await waitFor(() => expect(screen.getByTestId("player-danmaku-status").textContent).toBe("刚刚更新过弹幕，请稍后再试"));
    expect(screen.getByTestId("player-danmaku-cooldown").textContent).toMatch(/^1[12] 秒后可再次更新$/u);
    expect(button().disabled).toBe(true);
  });

  it("keeps the preferences in local storage, danmaku off until switched on", async () => {
    show({ fetchedAt: 1, count: 0 }, { "GET /api/contents/:id/danmaku": { body: { supported: true, snapshot: snapshot(0) } } });
    open();
    const toggle = screen.getByRole<HTMLInputElement>("switch", { name: "显示弹幕" });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByTestId("player-danmaku-density"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByTestId("player-danmaku-opacity"), { target: { value: "0.6" } });
    fireEvent.change(screen.getByTestId("player-danmaku-font-scale"), { target: { value: "1.5" } });
    expect(JSON.parse(localStorage.getItem(DANMAKU_PREFS_KEY) ?? "{}")).toEqual({ enabled: true, density: 0.5, opacity: 0.6, fontScale: 1.5 });
    expect(screen.getByTestId("player-danmaku").getAttribute("data-active")).toBe("true");
    await act(async () => undefined);
  });
});
