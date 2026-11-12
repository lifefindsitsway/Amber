import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRASH_RETENTION_DAYS } from "../../../src/shared/defaults.ts";
import type { TrashItemDto } from "../../../src/shared/dto/trash.ts";
import type { ContentEvent } from "../../../src/web/api/content-events.ts";
import { useContentEvents } from "../../../src/web/api/context.tsx";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { noteKeys } from "../../../src/web/notes/note-keys.ts";
import { nextCountdownChange, trashCountdown, TrashPage } from "../../../src/web/pages/trash-page.tsx";
import { content } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 2, 0, 0);

function item(id: string, overrides: Partial<TrashItemDto> = {}): TrashItemDto {
  const trashedAt = overrides.trashedAt ?? NOW - DAY;
  return {
    id,
    title: `讲次 ${id}`,
    source: { kind: "youtube" },
    trashedAt,
    purgeAt: trashedAt + TRASH_RETENTION_DAYS * DAY,
    expired: false,
    mediaBytes: 1536 * 1024,
    ...overrides,
  };
}

function list(items: TrashItemDto[], extra: { total?: number } = {}) {
  return { body: { items, total: extra.total ?? items.length } };
}

/** `count` synthetic entries `c1`…`cN`, newest deletion first. */
const many = (count: number): TrashItemDto[] => Array.from({ length: count }, (_, index) => item(`c${index + 1}`));

/** Answers one numbered page of `entries` the way the server does. */
function paged(entries: () => TrashItemDto[]) {
  return (call: RecordedCall) => {
    const query = new URL(call.path, "http://localhost").searchParams;
    const limit = Number(query.get("limit"));
    const at = (Number(query.get("page")) - 1) * limit;
    const all = entries();
    return list(all.slice(at, at + limit), { total: all.length });
  };
}

const listReads = (calls: RecordedCall[]) => calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/trash")).length;
const listPaths = (calls: RecordedCall[]) => calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/trash")).map((call) => call.path);
const rowIds = () => screen.getAllByTestId("trash-row").map((row) => row.dataset["contentId"]);

let locations: string[] = [];

/** Exposes the query cache and records content events published in this tab. */
function Probe(props: { onClient?: (client: QueryClient) => void; events?: ContentEvent[] }) {
  props.onClient?.(useQueryClient());
  const contentEvents = useContentEvents();
  const { events } = props;
  useEffect(() => contentEvents.subscribe((event) => void events?.push(event)), [contentEvents, events]);
  const location = useLocation();
  locations.push(`${location.pathname}${location.search}`);
  return null;
}

function page(props: { onClient?: (client: QueryClient) => void; events?: ContentEvent[] } = {}) {
  return (
    <>
      <Probe {...props} />
      <TrashPage />
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
  locations = [];
  localStorage.clear();
});

describe("trash countdown", () => {
  const at = (purgeAt: number, expired = false) => ({ purgeAt, expired });

  it("rounds whole days up, says less than a day in the last day, and expired from purgeAt on", () => {
    expect(trashCountdown(at(NOW + TRASH_RETENTION_DAYS * DAY), NOW)).toBe(TRASH_RETENTION_DAYS);
    expect(trashCountdown(at(NOW + 2 * DAY - 1), NOW)).toBe(2);
    expect(trashCountdown(at(NOW + DAY + 1), NOW)).toBe(2);
    expect(trashCountdown(at(NOW + DAY), NOW)).toBe("lessThanDay");
    expect(trashCountdown(at(NOW + DAY - 1), NOW)).toBe("lessThanDay");
    // purgeAt − 1 ms
    expect(trashCountdown(at(NOW + 1), NOW)).toBe("lessThanDay");
    expect(trashCountdown(at(NOW), NOW)).toBe("expired");
    expect(trashCountdown(at(NOW - 1), NOW)).toBe("expired");
    // The server's word wins even when this clock is behind.
    expect(trashCountdown(at(NOW + DAY, true), NOW)).toBe("expired");
  });

  it("finds the nearest moment any countdown text changes", () => {
    expect(nextCountdownChange([at(NOW + TRASH_RETENTION_DAYS * DAY)], NOW)).toBe(DAY);
    expect(nextCountdownChange([at(NOW + 2 * DAY + 500)], NOW)).toBe(500);
    expect(nextCountdownChange([at(NOW + DAY + 1)], NOW)).toBe(1);
    expect(nextCountdownChange([at(NOW + DAY)], NOW)).toBe(DAY);
    expect(nextCountdownChange([at(NOW + 700)], NOW)).toBe(700);
    expect(nextCountdownChange([at(NOW + 3 * DAY + 900), at(NOW + 5 * DAY + 300)], NOW)).toBe(300);
    expect(nextCountdownChange([at(NOW - 1), at(NOW + DAY, true)], NOW)).toBeUndefined();
  });
});

describe("TrashPage", () => {
  it("shows the empty state with 清空回收站 disabled", async () => {
    mockApi({ "GET /api/trash": list([]) });
    renderApp(page(), { route: "/trash" });
    expect((await screen.findByTestId("trash-empty")).textContent).toContain("回收站是空的");
    expect(screen.getByTestId("trash-page").textContent).toContain(`回收站中的内容保留 ${TRASH_RETENTION_DAYS} 天，到期自动彻底删除；在此期间媒体文件仍占用存储空间。`);
    expect((screen.getByTestId("trash-empty-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists entries with their source, duration, deletion time, media size and countdown; expired ones cannot be restored", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    mockApi({
      "GET /api/trash": list([
        item("c1", { durationMs: 65_000, trashedAt: NOW }),
        item("c2", { title: undefined as never, source: { kind: "bilibili" }, trashedAt: NOW - TRASH_RETENTION_DAYS * DAY, expired: true, mediaBytes: 0 }),
      ]),
    });
    renderApp(page(), { route: "/trash" });
    const rows = await screen.findAllByTestId("trash-row");
    expect(rows.map((row) => row.dataset["contentId"])).toEqual(["c1", "c2"]);
    const [fresh, expired] = rows as [HTMLElement, HTMLElement];
    expect(fresh.textContent).toContain("讲次 c1");
    expect(fresh.textContent).toMatch(/YouTube · 1:05 · 删除于 .+ · 媒体 1\.5 MB/u);
    expect(within(fresh).getByTestId("trash-status").textContent).toBe(`${TRASH_RETENTION_DAYS} 天后彻底删除`);
    expect((within(fresh).getByTestId("trash-restore") as HTMLButtonElement).disabled).toBe(false);
    expect(expired.textContent).toContain("未命名内容");
    expect(expired.textContent).toContain("B 站");
    expect(expired.textContent).toContain("媒体 0 B");
    expect(within(expired).getByTestId("trash-status").textContent).toBe("已到期，等待清理");
    expect((within(expired).getByTestId("trash-restore") as HTMLButtonElement).disabled).toBe(true);
    expect((within(expired).getByTestId("trash-purge") as HTMLButtonElement).disabled).toBe(false);
    // Trashed Contents cannot be opened.
    expect(within(screen.getByTestId("trash-page")).queryAllByRole("link")).toHaveLength(0);
    expect((screen.getByTestId("trash-empty-all") as HTMLButtonElement).disabled).toBe(false);
  });

  it("updates the countdown on its own at the next boundary, down to expired", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW, shouldAdvanceTime: true });
    mockApi({
      "GET /api/trash": list([item("c1", { purgeAt: NOW + DAY + 60_000 }), item("c2", { purgeAt: NOW + 3 * DAY + 120_000 })]),
    });
    renderApp(page(), { route: "/trash" });
    const status = async (id: string) => within((await screen.findAllByTestId("trash-row")).find((row) => row.dataset["contentId"] === id) as HTMLElement).getByTestId("trash-status");
    expect((await status("c1")).textContent).toBe("2 天后彻底删除");
    expect((await status("c2")).textContent).toBe("4 天后彻底删除");
    // Each act lets React commit, so the next timer is set from the new time.
    const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await advance(60_000);
    expect((await status("c1")).textContent).toBe("不到 1 天后彻底删除");
    expect((await status("c2")).textContent).toBe("4 天后彻底删除");
    await advance(60_000);
    expect((await status("c2")).textContent).toBe("3 天后彻底删除");
    await advance(DAY);
    expect((await status("c1")).textContent).toBe("已到期，等待清理");
    const row = (await screen.findAllByTestId("trash-row"))[0] as HTMLElement;
    expect((within(row).getByTestId("trash-restore") as HTMLButtonElement).disabled).toBe(true);
  });

  it("restores an entry, says so, refreshes the views it returns to and tells other tabs", async () => {
    let restored = false;
    const { calls } = mockApi({
      // Trashed now by the real clock: this test does not fake time, and an expired row cannot be restored.
      "GET /api/trash": () => list(restored ? [] : [item("c1", { trashedAt: Date.now() })]),
      "POST /api/trash/c1/restore": () => {
        restored = true;
        return { body: content("c1", { title: "讲次 c1" }) };
      },
    });
    let client: QueryClient | undefined;
    const events: ContentEvent[] = [];
    renderApp(page({ onClient: (value) => (client = value), events }), { route: "/trash" });
    const row = (await screen.findAllByTestId("trash-row"))[0] as HTMLElement;
    client?.setQueryData(queryKeys.contentsAll, { items: [] });
    client?.setQueryData(noteKeys.groups, { items: [] });
    fireEvent.click(within(row).getByTestId("trash-restore"));
    expect((await screen.findByTestId("trash-notice")).textContent).toBe("已恢复「讲次 c1」");
    expect(await screen.findByTestId("trash-empty")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/trash/c1/restore"]);
    expect(listReads(calls)).toBe(2);
    expect(client?.getQueryState(queryKeys.contentsAll)?.isInvalidated).toBe(true);
    expect(client?.getQueryState(noteKeys.groups)?.isInvalidated).toBe(true);
    expect(events).toEqual([{ type: "restored", contentId: "c1" }]);
  });

  it("shows why a restore was refused inside the row", async () => {
    mockApi({
      // Trashed now by the real clock, as above: the refusal must come from the server, not from a disabled button.
      "GET /api/trash": list([item("c1", { trashedAt: Date.now() })]),
      "POST /api/trash/c1/restore": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.trash_expired", retryDisposition: "never", userMessage: "这条内容在回收站中已到期，不能再恢复" } },
      },
    });
    const events: ContentEvent[] = [];
    renderApp(page({ events }), { route: "/trash" });
    const row = (await screen.findAllByTestId("trash-row"))[0] as HTMLElement;
    fireEvent.click(within(row).getByTestId("trash-restore"));
    expect(await within(row).findByText("这条内容在回收站中已到期，不能再恢复")).toBeTruthy();
    expect(screen.queryByTestId("trash-notice")).toBeNull();
    expect(events).toEqual([]);
  });

  it("purges one entry after confirming: its caches and remembered card go, other tabs hear of it", async () => {
    let purged = false;
    const { calls } = mockApi({
      "GET /api/trash": () => list(purged ? [item("c2")] : [item("c1"), item("c2")]),
      "DELETE /api/trash/c1": () => {
        purged = true;
        return { status: 204 };
      },
    });
    let client: QueryClient | undefined;
    const events: ContentEvent[] = [];
    localStorage.setItem("amber.cache.dismissed.c1", "task-1");
    localStorage.setItem("amber.cache.dismissed.c2", "task-2");
    renderApp(page({ onClient: (value) => (client = value), events }), { route: "/trash" });
    const row = (await screen.findAllByTestId("trash-row"))[0] as HTMLElement;
    client?.setQueryData(queryKeys.content("c1"), { id: "c1" });
    client?.setQueryData(noteKeys.content("c1"), { items: [] });
    client?.setQueryData(queryKeys.content("c2"), { id: "c2" });
    fireEvent.click(within(row).getByTestId("trash-purge"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("彻底删除这条内容？");
    expect(dialog.textContent).toContain("将彻底删除「讲次 c1」及其字幕、总结、笔记等全部产出物，无法恢复；本地原文件不会被删除。");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "彻底删除" }));
    await waitFor(() => expect(screen.getAllByTestId("trash-row")).toHaveLength(1));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/trash/c1"]);
    expect(client?.getQueryData(queryKeys.content("c1"))).toBeUndefined();
    expect(client?.getQueryData(noteKeys.content("c1"))).toBeUndefined();
    expect(client?.getQueryData(queryKeys.content("c2"))).toEqual({ id: "c2" });
    expect(localStorage.getItem("amber.cache.dismissed.c1")).toBeNull();
    expect(localStorage.getItem("amber.cache.dismissed.c2")).toBe("task-2");
    expect(events).toEqual([{ type: "purged", contentId: "c1" }]);
    localStorage.removeItem("amber.cache.dismissed.c2");
  });

  it("keeps the purge dialog open with the server's reason when the purge is refused", async () => {
    mockApi({
      "GET /api/trash": list([item("c1")]),
      "DELETE /api/trash/c1": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.chat_inflight", retryDisposition: "never", userMessage: "这条内容还有正在生成的对话回答，请稍后再试" } },
      },
    });
    const events: ContentEvent[] = [];
    renderApp(page({ events }), { route: "/trash" });
    fireEvent.click(within((await screen.findAllByTestId("trash-row"))[0] as HTMLElement).getByTestId("trash-purge"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "彻底删除" }));
    expect(await within(dialog).findByText("这条内容还有正在生成的对话回答，请稍后再试")).toBeTruthy();
    expect(events).toEqual([]);
  });

  it("empties the trash after confirming; entries that failed are counted and the list still refreshes", async () => {
    let emptied = false;
    const { calls } = mockApi({
      "GET /api/trash": () => list(emptied ? [item("c2")] : [item("c1"), item("c2"), item("c3")], { total: emptied ? 1 : 3 }),
      "DELETE /api/trash": () => {
        emptied = true;
        return { body: { purgedIds: ["c1", "c3"], failed: [{ contentId: "c2", code: "conflict.chat_inflight" }] } };
      },
    });
    const events: ContentEvent[] = [];
    localStorage.setItem("amber.cache.dismissed.c3", "task-3");
    renderApp(page({ events }), { route: "/trash" });
    await screen.findAllByTestId("trash-row");
    fireEvent.click(screen.getByTestId("trash-empty-all"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("清空回收站？");
    expect(dialog.textContent).toContain("将彻底删除回收站中的全部 3 条内容");
    fireEvent.click(within(dialog).getByRole("button", { name: "清空回收站" }));
    expect((await screen.findByTestId("trash-notice")).textContent).toBe("1 条未能删除，请稍后再试");
    await waitFor(() => expect(screen.getAllByTestId("trash-row").map((row) => row.dataset["contentId"])).toEqual(["c2"]));
    expect(listReads(calls)).toBe(2);
    expect(events).toEqual([
      { type: "purged", contentId: "c1" },
      { type: "purged", contentId: "c3" },
    ]);
    expect(localStorage.getItem("amber.cache.dismissed.c3")).toBeNull();
  });

  it("reads one numbered page at a time, moves with the pager and scrolls the list back to the top", async () => {
    const { calls } = mockApi({ "GET /api/trash": paged(() => many(12)) });
    renderApp(page(), { route: "/trash" });
    await screen.findAllByTestId("trash-row");
    expect(rowIds()).toEqual(many(10).map((entry) => entry.id));
    expect(listPaths(calls)).toEqual(["/api/trash?limit=10&page=1"]);
    expect(screen.queryByText("加载更多")).toBeNull();
    expect(screen.getByText("第 1 / 2 页").getAttribute("aria-current")).toBe("page");
    const scroller = screen.getByTestId("trash-page").querySelector(".overflow-auto") as HTMLElement;
    scroller.scrollTop = 300;

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(rowIds()).toEqual(["c11", "c12"]));
    expect(listPaths(calls)).toEqual(["/api/trash?limit=10&page=1", "/api/trash?limit=10&page=2"]);
    expect(locations.at(-1)).toBe("/trash?page=2&pageSize=10");
    expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
    expect(scroller.scrollTop).toBe(0);
  });

  it("shows loading, not the previous page's rows, while the next page is on its way", async () => {
    mockApi({ "GET /api/trash": paged(() => many(12)) });
    const answered = globalThis.fetch;
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      String(input).includes("page=2") ? new Promise<Response>((resolve) => (release = () => resolve(answered(input, init)))) : answered(input, init),
    );
    renderApp(page(), { route: "/trash" });
    await screen.findAllByTestId("trash-row");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.queryAllByTestId("trash-row")).toHaveLength(0);
    expect(screen.getByRole("status")).toBeTruthy();
    // The pager stays, showing the page asked for.
    expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
    release?.();
    await waitFor(() => expect(rowIds()).toEqual(["c11", "c12"]));
  });

  it("re-reads only the page on screen every minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: NOW, shouldAdvanceTime: true });
    const { calls } = mockApi({ "GET /api/trash": paged(() => many(12)) });
    renderApp(page(), { route: "/trash" });
    await screen.findAllByTestId("trash-row");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(rowIds()).toEqual(["c11", "c12"]));
    const reads = (n: number) => listPaths(calls).filter((path) => path.endsWith(`page=${n}`)).length;
    expect([reads(1), reads(2)]).toEqual([1, 1]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    await waitFor(() => expect(reads(2)).toBe(2));
    expect(reads(1)).toBe(1);
  });

  it("asks to empty the whole trash by the server's total, not the rows on this page", async () => {
    mockApi({ "GET /api/trash": paged(() => many(23)) });
    renderApp(page(), { route: "/trash" });
    await screen.findAllByTestId("trash-row");
    expect(screen.getAllByTestId("trash-row")).toHaveLength(10);
    fireEvent.click(screen.getByTestId("trash-empty-all"));
    expect((await screen.findByRole("dialog")).textContent).toContain("将彻底删除回收站中的全部 23 条内容");
  });

  it("moves to the last page when a purge empties the page on screen", async () => {
    let entries = many(11);
    const { calls } = mockApi({
      "GET /api/trash": paged(() => entries),
      "DELETE /api/trash/c11": () => {
        entries = many(10);
        return { status: 204 };
      },
    });
    renderApp(page(), { route: "/trash?page=2&pageSize=10" });
    await waitFor(() => expect(rowIds()).toEqual(["c11"]));
    fireEvent.click(within(screen.getByTestId("trash-row")).getByTestId("trash-purge"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "彻底删除" }));
    await waitFor(() => expect(rowIds()).toEqual(many(10).map((entry) => entry.id)));
    await waitFor(() => expect(locations.at(-1)).toBe("/trash?pageSize=10"));
    expect(screen.queryByTestId("trash-empty")).toBeNull();
    expect(listPaths(calls).at(-1)).toBe("/api/trash?limit=10&page=1");
    // Everything fits one page now; the pager stays.
    expect(within(screen.getByRole("navigation", { name: "分页" })).getByText("第 1 / 1 页")).toBeTruthy();
  });
});
