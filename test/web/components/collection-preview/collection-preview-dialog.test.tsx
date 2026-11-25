import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTION_PREVIEW_FILTER_MIN, COLLECTION_PREVIEW_ITEMS_MAX, COLLECTION_PREVIEW_PER_USER_MAX, IMPORT_BATCH_MAX } from "../../../../src/shared/defaults.ts";
import type { InspectRequest } from "../../../../src/shared/dto/import.ts";
import type { AppError } from "../../../../src/shared/errors.ts";
import { CollectionPreviewDialog } from "../../../../src/web/components/collection-preview/collection-preview-dialog.tsx";
import type { CollectionChoice } from "../../../../src/web/components/collection-preview/state.ts";
import { useCollectionPreview } from "../../../../src/web/components/collection-preview/use-collection-preview.ts";
import { fakeInspect, newEntries, STALE_REPLY, type FakeCollection } from "../../../fixtures/web/collection-preview.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";
import { stubSelectLayout } from "../../../fixtures/web/select.ts";

const LIST = "https://www.youtube.com/playlist?list=PLabcdefghij0123456789";
const SERIES = "https://space.bilibili.com/12345/lists/678?type=season";

beforeEach(stubSelectLayout);

function Harness(props: { urls: string[]; compare?: string; reserved?: number; onConfirm?: (choices: CollectionChoice[]) => void; error?: AppError }) {
  const preview = useCollectionPreview({ compareCollectionId: props.compare, reserved: props.reserved });
  return (
    <>
      <button type="button" data-testid="open" onClick={() => preview.open(props.urls)} />
      <button type="button" data-testid="reread" onClick={() => preview.reread()} />
      <button type="button" data-testid="reset" onClick={() => preview.reset()} />
      <CollectionPreviewDialog preview={preview} onConfirm={props.onConfirm ?? (() => undefined)} submitting={false} error={props.error} {...(props.reserved === undefined ? {} : { reserved: props.reserved })} />
    </>
  );
}

function setup(collections: FakeCollection[], props: Omit<Parameters<typeof Harness>[0], "urls"> = {}) {
  const inspect = fakeInspect(collections);
  const { calls } = mockApi({ "POST /api/contents/inspect": inspect.reply });
  const onConfirm = vi.fn<(choices: CollectionChoice[]) => void>();
  renderApp(<Harness urls={collections.map((collection) => collection.url)} onConfirm={onConfirm} {...props} />);
  fireEvent.click(screen.getByTestId("open"));
  return { inspect, calls, onConfirm };
}

/**
 * Holds the inspect reads `held` picks until released, after `mockApi`: `arrived` lists the
 * bodies of every read sent, `release(index)` lets the held read `index` (in arrival order) on,
 * and `peak()` is the most reads in flight at once.
 */
function holdInspect(held: (body: InspectRequest) => boolean) {
  const real = globalThis.fetch;
  const arrived: InspectRequest[] = [];
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as InspectRequest;
    arrived.push(body);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (held(body)) {
        await new Promise<void>((resolve, reject) => {
          gates.push(resolve);
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return await real(input, init);
    } finally {
      inFlight -= 1;
    }
  });
  return { arrived, release: (index: number) => gates[index]?.(), peak: () => peak };
}

const dialog = (): HTMLElement => screen.getByTestId("collection-preview");
const rows = (): HTMLElement[] => within(dialog()).queryAllByTestId("preview-entry");
const row = (id: string): HTMLElement => {
  const found = rows().find((element) => element.dataset["entryId"] === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};
const chosen = (): string[] => rows().filter((element) => element.dataset["chosen"] === "true").map((element) => element.dataset["entryId"] ?? "");
const box = (id: string): HTMLInputElement => within(row(id)).getByRole("checkbox") as HTMLInputElement;
const loaded = async (count: number): Promise<void> => {
  await waitFor(() => expect(rows()).toHaveLength(count));
};

describe("CollectionPreviewDialog choosing entries", () => {
  it("shows each entry's state with what choosing it does, and picks the ones not imported yet", async () => {
    const { inspect } = setup(
      [
        {
          url: SERIES,
          title: "示例合集",
          pageSize: 50,
          entries: [
            { id: "BV1new", title: "新的一讲", durationMs: 3_600_000, partCount: 3 },
            { id: "BV1lib", title: "已导入的一讲", state: "in_library", durationMs: 720_000 },
            { id: "BV1run", title: "处理中的一讲", state: "processing" },
            { id: "BV1col", title: "已在合集的一讲", state: "in_collection", durationMs: 60_000 },
            { id: "BV1bin", title: "回收站里的一讲", state: "trashed" },
            { id: "BV1gone", state: "unavailable", unavailableReason: "private" },
          ],
        },
      ],
      { compare: "col1" },
    );
    await loaded(6);
    expect(inspect.requests[0]).toEqual({ url: SERIES, collectionId: "col1" });
    expect(screen.getByRole("dialog", { name: "示例合集" })).toBeTruthy();
    // Platform, counts and the known length of what is chosen (one chosen entry has none).
    expect(within(dialog()).getByTestId("preview-summary").textContent).toBe("B 站合集· 共 6 项· 已选 3 项· 已知时长合计约 1 小时 12 分");
    expect(chosen()).toEqual(["BV1new", "BV1lib", "BV1run"]);
    expect(within(row("BV1new")).queryByTestId("preview-entry-state")).toBeNull();
    expect(within(row("BV1new")).getByTestId("preview-entry-parts").textContent).toBe("共 3 个分 P，只导入第 1 个");
    expect(within(row("BV1lib")).getByTestId("preview-entry-state").textContent).toBe("已在资料库");
    expect(row("BV1lib").textContent).toContain("不会重复创建");
    expect(document.getElementById(box("BV1lib").getAttribute("aria-describedby") ?? "")?.textContent).toContain("设置与上次相同且已完成就不再处理，否则按本次设置重新生成");
    expect(row("BV1run").textContent).toContain("处理中沿用正在进行的任务");
    expect(row("BV1col").textContent).toContain("已在此合集无需再加入");
    expect(box("BV1col").disabled).toBe(false);
    expect(box("BV1bin").disabled).toBe(true);
    expect(within(row("BV1bin")).getByRole("link", { name: "打开回收站" }).getAttribute("href")).toBe("/trash");
    expect(box("BV1gone").disabled).toBe(true);
    // Neither a made-up title nor a duration for an entry the platform hides.
    expect(row("BV1gone").textContent).toContain("标题不可见");
    expect(row("BV1gone").textContent).toContain("无法访问平台标为私享");
    // The entries are named by position and title, and described by their state.
    expect(box("BV1new").getAttribute("aria-labelledby")).not.toBeNull();
    expect(document.getElementById(box("BV1new").getAttribute("aria-describedby") ?? "")?.textContent).toBe("新建内容并开始处理");
    // A disabled row does not toggle.
    fireEvent.click(row("BV1bin"));
    expect(chosen()).toEqual(["BV1new", "BV1lib", "BV1run"]);
  });

  it("chooses by clicking a row or its box, and a range with Shift", async () => {
    setup([{ url: LIST, pageSize: 50, entries: [...newEntries(3), { id: "v4", title: "第 4 讲", state: "in_collection" }, { id: "v5", title: "第 5 讲", state: "trashed" }, ...newEntries(2, "v", 6)] }]);
    await loaded(7);
    fireEvent.click(row("v1"));
    expect(box("v1").checked).toBe(false);
    fireEvent.click(box("v1"));
    expect(box("v1").checked).toBe(true);
    // The range from the last clicked row takes the clicked row's new state; v5 cannot be chosen.
    fireEvent.click(row("v2"));
    fireEvent.click(row("v7"), { shiftKey: true });
    expect(chosen()).toEqual(["v1"]);
    fireEvent.click(row("v3"));
    fireEvent.click(row("v7"), { shiftKey: true });
    expect(chosen()).toEqual(["v1", "v3", "v4", "v6", "v7"]);
  });

  it("selects all on screen with a three-state box, and only those not in this collection yet on request", async () => {
    setup([{ url: LIST, pageSize: 50, entries: [...newEntries(2), { id: "v3", title: "第 3 讲", state: "in_collection" }, { id: "v4", title: "第 4 讲", state: "unavailable" }] }]);
    await loaded(4);
    const all = within(dialog()).getByRole("checkbox", { name: "全选" }) as HTMLInputElement;
    expect(within(dialog()).getByTestId("preview-shown-scope").textContent).toBe("在已显示的 4 项中");
    expect(document.getElementById(all.getAttribute("aria-describedby") ?? "")?.textContent).toBe("在已显示的 4 项中");
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(chosen()).toEqual(["v1", "v2", "v3"]);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    fireEvent.click(all);
    expect(chosen()).toEqual([]);
    expect(within(dialog()).getByTestId("preview-none-chosen").textContent).toBe("没有选择内容，这个合集不会导入");
    const onlyOutside = within(dialog()).getByRole("button", { name: "只选还不在此合集里的" }) as HTMLButtonElement;
    expect(onlyOutside.disabled).toBe(false);
    fireEvent.click(onlyOutside);
    expect(chosen()).toEqual(["v1", "v2"]);
    // Clicking again would change nothing, so it says so by being disabled rather than doing nothing.
    expect(onlyOutside.disabled).toBe(true);
    fireEvent.click(all);
    expect(chosen()).toEqual(["v1", "v2", "v3"]);
    expect(onlyOutside.disabled).toBe(false);
  });

  it("counts entries already in the library or being processed as not in this collection, disabled while they are all chosen", async () => {
    setup([
      {
        url: LIST,
        pageSize: 50,
        entries: [
          ...newEntries(2),
          { id: "lib", title: "资料库里的一讲", state: "in_library" },
          { id: "run", title: "处理中的一讲", state: "processing" },
          { id: "col", title: "已在合集的一讲", state: "in_collection" },
        ],
      },
    ]);
    await loaded(5);
    // The defaults already pick every entry not in this collection: nothing for the action to change.
    expect(chosen()).toEqual(["v1", "v2", "lib", "run"]);
    const onlyOutside = within(dialog()).getByRole("button", { name: "只选还不在此合集里的" }) as HTMLButtonElement;
    expect(onlyOutside.disabled).toBe(true);
    // Leaving out one of them and adding the one already in the collection both enable it; it puts the defaults back.
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: /资料库里的一讲/ }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: /已在合集的一讲/ }));
    expect(chosen()).toEqual(["v1", "v2", "run", "col"]);
    expect(onlyOutside.disabled).toBe(false);
    fireEvent.click(onlyOutside);
    expect(chosen()).toEqual(["v1", "v2", "lib", "run"]);
    expect(onlyOutside.disabled).toBe(true);
  });

  it("offers the title filter only past the threshold, and acts on the filtered rows", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(COLLECTION_PREVIEW_FILTER_MIN) }]);
    await loaded(COLLECTION_PREVIEW_FILTER_MIN);
    expect(within(dialog()).queryByTestId("preview-filter")).toBeNull();
  });

  it("filters by title, and select-all then covers only what is shown", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(COLLECTION_PREVIEW_FILTER_MIN + 1) }]);
    await loaded(COLLECTION_PREVIEW_FILTER_MIN + 1);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "全选" }));
    expect(chosen()).toEqual([]);
    fireEvent.change(within(dialog()).getByRole("searchbox", { name: "筛选标题" }), { target: { value: "第 1" } });
    expect(rows().map((element) => element.dataset["entryId"])).toEqual(["v1", "v10", "v11", "v12", "v13", "v14", "v15", "v16", "v17", "v18", "v19"]);
    expect(within(dialog()).getByTestId("preview-shown-scope").textContent).toBe("在已显示的 11 项中");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "全选" }));
    fireEvent.change(within(dialog()).getByRole("searchbox", { name: "筛选标题" }), { target: { value: "" } });
    expect(chosen()).toHaveLength(11);
    fireEvent.change(within(dialog()).getByRole("searchbox", { name: "筛选标题" }), { target: { value: "不存在" } });
    expect(within(dialog()).getByText("已显示的内容里没有标题包含「不存在」的")).toBeTruthy();
  });

  it("holds the submit past the batch limit, in the warning colour, with what to do", async () => {
    const onConfirm = vi.fn();
    setup([{ url: LIST, pageSize: 60, entries: [...newEntries(55, "v", 1)] }], { onConfirm });
    await loaded(55);
    // The defaults stay within the limit.
    expect(chosen()).toHaveLength(IMPORT_BATCH_MAX);
    const submit = within(dialog()).getByTestId<HTMLButtonElement>("preview-submit");
    expect(submit.textContent).toBe(`开始处理 ${IMPORT_BATCH_MAX} 项`);
    expect(submit.disabled).toBe(false);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "全选" }));
    expect(submit.textContent).toBe("开始处理 55 项");
    expect(submit.disabled).toBe(true);
    expect(within(dialog()).getByTestId("preview-chosen-count").className).toContain("text-warn");
    expect(within(dialog()).getByTestId("preview-footer-note").textContent).toBe(`一次最多处理 ${IMPORT_BATCH_MAX} 项，现在共 55 项，请少选 5 项`);
  });

  it("holds the submit when the other links alone are past the limit", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(3) }], { reserved: IMPORT_BATCH_MAX + 10 });
    await loaded(3);
    // No room is left for defaults, and the whole import is counted against the limit.
    expect(chosen()).toEqual([]);
    const submit = within(dialog()).getByTestId<HTMLButtonElement>("preview-submit");
    expect(submit.disabled).toBe(true);
    expect(within(dialog()).getByTestId("preview-chosen-count").className).toContain("text-warn");
    expect(within(dialog()).getByTestId("preview-footer-note").textContent).toBe(`一次最多处理 ${IMPORT_BATCH_MAX} 项，现在共 ${IMPORT_BATCH_MAX + 10} 项，请少选 10 项`);
    fireEvent.click(row("v1"));
    expect(submit.textContent).toBe(`开始处理 ${IMPORT_BATCH_MAX + 11} 项`);
    expect(submit.disabled).toBe(true);
  });

  it("counts the other links of the import against the limit", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(50) }], { reserved: 2 });
    await loaded(50);
    expect(chosen()).toHaveLength(IMPORT_BATCH_MAX - 2);
    expect(within(dialog()).getByTestId<HTMLButtonElement>("preview-submit").textContent).toBe(`开始处理 ${IMPORT_BATCH_MAX} 项`);
    expect(within(dialog()).getByTestId("preview-footer-note").textContent).toBe("合集页里按平台原顺序排列；输入框里另有 2 条链接一并处理");
  });
});

describe("CollectionPreviewDialog pages", () => {
  it("reads more on request with the preview id, keeping the choice across pages", async () => {
    const { inspect, onConfirm } = setup([{ url: LIST, title: "长列表", pageSize: 3, entries: newEntries(7) }]);
    await loaded(3);
    expect(within(dialog()).getByTestId("preview-more").textContent).toBe("已显示 3 项，共 7 项加载更多");
    fireEvent.click(row("v2"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    await loaded(6);
    expect(inspect.requests[1]).toEqual({ url: LIST, previewId: "pv1", offset: 3 });
    // A later page adds nothing to the choice; what was chosen stays.
    expect(chosen()).toEqual(["v1", "v3"]);
    fireEvent.click(row("v5"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    await loaded(7);
    expect(within(dialog()).queryByTestId("preview-more")).toBeNull();
    expect(within(dialog()).queryByTestId("preview-load-all")).toBeNull();
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    expect(onConfirm).toHaveBeenCalledWith([{ url: LIST, entries: ["v1", "v3", "v5"], previewId: "pv1" }]);
  });

  it("reads the next page when the end of the list comes into view", async () => {
    const observed: Array<(records: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (records: Array<{ isIntersecting: boolean }>) => void) {
          observed.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    setup([{ url: LIST, pageSize: 3, entries: newEntries(5) }]);
    await loaded(3);
    observed.at(-1)?.([{ isIntersecting: true }]);
    await loaded(5);
  });

  it("loads every page on request and stops when asked", async () => {
    const { inspect } = setup([{ url: LIST, pageSize: 2, entries: newEntries(9) }]);
    await loaded(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载全部" }));
    await loaded(9);
    expect(inspect.requests.map((request) => request.offset)).toEqual([undefined, 2, 4, 6, 8]);
  });

  it("stops loading all midway", async () => {
    let release: (() => void) | undefined;
    const inspect = fakeInspect([{ url: LIST, pageSize: 2, entries: newEntries(9) }]);
    const { calls } = mockApi({ "POST /api/contents/inspect": inspect.reply });
    const real = globalThis.fetch;
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
      // Every later page waits until released, so "stop" lands while one is in flight.
      if (calls.length >= 1) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return real(input, init);
    });
    renderApp(<Harness urls={[LIST]} />);
    fireEvent.click(screen.getByTestId("open"));
    await loaded(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载全部" }));
    const stop = await within(dialog()).findByRole("button", { name: "停止加载" });
    fireEvent.click(stop);
    await waitFor(() => expect(signals.at(-1)?.aborted).toBe(true));
    release?.();
    expect(rows()).toHaveLength(2);
    expect(await within(dialog()).findByRole("button", { name: "加载全部" })).toBeTruthy();
  });

  it("says when the collection is longer than can be listed, with or without its total", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(3), totalCount: 1500, truncated: true }]);
    await loaded(3);
    expect(within(dialog()).getByTestId("preview-truncated").textContent).toBe(
      `这个合集共 1500 项，这里只能列出前 ${COLLECTION_PREVIEW_ITEMS_MAX} 项。更靠后的视频可以直接粘贴它的链接导入，并在「加入合集」里选这个合集`,
    );
    expect(within(dialog()).getByTestId("preview-summary").textContent).toContain("共 1500 项");
  });

  it("says 「超过」 when the platform does not tell the total", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(3), truncated: true }]);
    await loaded(3);
    expect(within(dialog()).getByTestId("preview-truncated").textContent).toContain(`这个合集超过 ${COLLECTION_PREVIEW_ITEMS_MAX} 项`);
    expect(within(dialog()).getByTestId("preview-summary").textContent).toContain(`超过 ${COLLECTION_PREVIEW_ITEMS_MAX} 项`);
  });

  it("reads the collection again when a later page finds the preview stale, keeping the choice and order without adding to it", async () => {
    const { inspect, onConfirm } = setup([{ url: LIST, pageSize: 2, entries: newEntries(6) }]);
    await loaded(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    await loaded(4);
    fireEvent.click(row("v4"));
    fireEvent.click(row("v1"));
    expect(chosen()).toEqual(["v2", "v4"]);
    fireEvent.mouseDown(within(dialog()).getByTestId("preview-tab-order"));
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "移到最前" })[0] as HTMLElement);
    fireEvent.mouseDown(within(dialog()).getByTestId("preview-tab-select"));
    inspect.expire();
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    // Read again from scratch, then on until v4 is found again.
    await waitFor(() => expect(inspect.requests.slice(3)).toEqual([{ url: LIST }, { url: LIST, previewId: "pv2", offset: 2 }]));
    await loaded(4);
    expect(chosen()).toEqual(["v2", "v4"]);
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    expect(onConfirm).toHaveBeenCalledWith([{ url: LIST, entries: ["v4", "v2"], previewId: "pv2" }]);
  });

  /** A collection of six two-entry pages whose later pages of `pushedOut` previews answer stale. */
  function pushedOutSetup() {
    const inspect = fakeInspect([{ url: LIST, pageSize: 2, entries: newEntries(6) }]);
    const pushedOut = new Set<string>();
    const sent: InspectRequest[] = [];
    mockApi({
      "POST /api/contents/inspect": (call: RecordedCall) => {
        const body = call.body as InspectRequest;
        sent.push(body);
        return body.previewId !== undefined && pushedOut.has(body.previewId) ? STALE_REPLY : inspect.reply(call);
      },
    });
    renderApp(<Harness urls={[LIST]} />);
    fireEvent.click(screen.getByTestId("open"));
    return { inspect, pushedOut, sent };
  }

  it("starts over once when the preview is pushed out while paging on to the chosen entries", async () => {
    const { inspect, pushedOut, sent } = pushedOutSetup();
    await loaded(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    await loaded(4);
    fireEvent.click(row("v4"));
    expect(chosen()).toEqual(["v1", "v2", "v4"]);
    inspect.expire();
    pushedOut.add("pv2");
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(sent.slice(2)).toEqual([
        { url: LIST, previewId: "pv1", offset: 4 },
        { url: LIST },
        { url: LIST, previewId: "pv2", offset: 2 },
        { url: LIST },
        { url: LIST, previewId: "pv3", offset: 2 },
      ]),
    );
    await loaded(4);
    expect(chosen()).toEqual(["v1", "v2", "v4"]);
    expect(within(dialog()).queryByTestId("preview-failed")).toBeNull();
  });

  it("fails with a retry when the preview is pushed out again after starting over, keeping the choice", async () => {
    const { inspect, pushedOut, sent } = pushedOutSetup();
    await loaded(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    await loaded(4);
    fireEvent.click(row("v4"));
    inspect.expire();
    pushedOut.add("pv2");
    pushedOut.add("pv3");
    fireEvent.click(within(dialog()).getByRole("button", { name: "加载更多" }));
    const failed = await within(dialog()).findByTestId("preview-failed");
    expect(failed.textContent).toContain("合集内容已变化或预览已过期");
    // One start over, no more.
    expect(sent.slice(2).filter((body) => body.previewId === undefined)).toHaveLength(2);
    pushedOut.clear();
    fireEvent.click(within(failed).getByRole("button", { name: "重试" }));
    await loaded(4);
    expect(chosen()).toEqual(["v1", "v2", "v4"]);
  });

  it("drops only the chosen entries that are gone after reading again", async () => {
    const collection = { url: LIST, pageSize: 50, entries: newEntries(3) };
    const { inspect, onConfirm } = setup([collection]);
    await loaded(3);
    collection.entries = [{ id: "v0", title: "新加的一讲" }, ...newEntries(1), { id: "v3", title: "第 3 讲", state: "trashed" as const }];
    fireEvent.click(screen.getByTestId("reread"));
    await waitFor(() => expect(inspect.requests).toHaveLength(2));
    await loaded(3);
    expect(chosen()).toEqual(["v1"]);
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    expect(onConfirm).toHaveBeenCalledWith([{ url: LIST, entries: ["v1"], previewId: "pv2" }]);
  });

  it("shows a failed read in the dialog and retries it without the preview id", async () => {
    const inspect = fakeInspect([{ url: LIST, pageSize: 50, entries: newEntries(2) }]);
    inspect.fail({ status: 502, body: { error: { class: "source_unreachable", code: "source_unreachable", retryDisposition: "safe", userMessage: "平台暂时无法访问" } } });
    mockApi({ "POST /api/contents/inspect": inspect.reply });
    renderApp(<Harness urls={[LIST]} />);
    fireEvent.click(screen.getByTestId("open"));
    const failed = await within(dialog()).findByTestId("preview-failed");
    expect(failed.textContent).toContain("平台暂时无法访问");
    expect(within(dialog()).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(true);
    fireEvent.click(within(failed).getByRole("button", { name: "重试" }));
    await loaded(2);
    expect(inspect.requests).toEqual([{ url: LIST }, { url: LIST }]);
  });

  it("shows skeleton rows while reading, and stops the read when closed", async () => {
    const signals: AbortSignal[] = [];
    mockApi({});
    vi.stubGlobal("fetch", (_input: string, init: RequestInit = {}) => {
      if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    renderApp(<Harness urls={[LIST]} />);
    fireEvent.click(screen.getByTestId("open"));
    expect(await within(dialog()).findByTestId("preview-loading")).toBeTruthy();
    expect(signals).toHaveLength(1);
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
    expect(signals[0]?.aborted).toBe(true);
    // Opened again, the read starts over.
    fireEvent.click(screen.getByTestId("open"));
    await waitFor(() => expect(signals).toHaveLength(2));
  });

  it("keeps the choice when closed and opened again", async () => {
    const { inspect } = setup([{ url: LIST, pageSize: 50, entries: newEntries(3) }]);
    await loaded(3);
    fireEvent.click(row("v2"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
    fireEvent.click(screen.getByTestId("open"));
    await loaded(3);
    expect(chosen()).toEqual(["v1", "v3"]);
    expect(inspect.requests).toHaveLength(1);
  });

  it("reads afresh, with new defaults, after the links are reset", async () => {
    const collection = { url: LIST, pageSize: 50, entries: newEntries(3) };
    const { inspect } = setup([collection]);
    await loaded(3);
    fireEvent.click(row("v2"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("collection-preview")).toBeNull());
    fireEvent.click(screen.getByTestId("reset"));
    collection.entries = [...newEntries(1), { id: "v2", title: "第 2 讲", state: "in_collection" }, { id: "v3", title: "第 3 讲", state: "in_collection" }];
    fireEvent.click(screen.getByTestId("open"));
    await waitFor(() => expect(inspect.requests).toHaveLength(2));
    await loaded(3);
    expect(chosen()).toEqual(["v1"]);
  });

  it("shows the import's error in the dialog", async () => {
    setup([{ url: LIST, pageSize: 50, entries: newEntries(1) }], { error: { class: "unknown", code: "unknown", retryDisposition: "outcome_unknown", userMessage: "无法连接后端" } });
    await loaded(1);
    expect(within(dialog()).getByRole("alert").textContent).toContain("无法连接后端");
  });
});

describe("CollectionPreviewDialog with several collections", () => {
  it("goes through them one by one and submits every choice in input order", async () => {
    const { onConfirm } = setup([
      { url: SERIES, title: "合集一", pageSize: 50, entries: newEntries(2, "BV1a") },
      { url: LIST, title: "列表二", pageSize: 50, entries: newEntries(3, "y") },
    ]);
    await loaded(2);
    expect(within(dialog()).getByTestId("preview-step").textContent).toBe("合集 1 / 2");
    expect(within(dialog()).queryByTestId("preview-submit")).toBeNull();
    fireEvent.click(row("BV1a1"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "下一个" }));
    expect(screen.getByRole("dialog", { name: "列表二" })).toBeTruthy();
    await loaded(3);
    expect(within(dialog()).getByTestId("preview-step").textContent).toBe("合集 2 / 2");
    fireEvent.mouseDown(within(dialog()).getByTestId("preview-tab-order"));
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "移到最前" })[0] as HTMLElement);
    const submit = within(dialog()).getByTestId("preview-submit");
    expect(submit.textContent).toBe("开始处理 4 项");
    fireEvent.click(within(dialog()).getByRole("button", { name: "上一个" }));
    expect(screen.getByRole("dialog", { name: "合集一" })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "下一个" }));
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    expect(onConfirm).toHaveBeenCalledWith([
      { url: SERIES, entries: ["BV1a2"], previewId: "pv1" },
      { url: LIST, entries: ["y2", "y1", "y3"], previewId: "pv2" },
    ]);
  });

  it("gives the defaults in input order, whichever collection answers first", async () => {
    const inspect = fakeInspect([
      { url: SERIES, pageSize: 50, entries: newEntries(40, "BV1a") },
      { url: LIST, pageSize: 50, entries: newEntries(30, "y") },
    ]);
    mockApi({ "POST /api/contents/inspect": inspect.reply });
    const gate = holdInspect((body) => body.url === SERIES);
    renderApp(<Harness urls={[SERIES, LIST]} />);
    fireEvent.click(screen.getByTestId("open"));
    // The second collection answers first; its defaults wait for the first one's.
    await waitFor(() => expect(inspect.requests).toEqual([{ url: LIST }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(within(dialog()).getByRole("button", { name: "下一个" }));
    expect(within(dialog()).getByTestId("preview-loading")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "上一个" }));
    gate.release(0);
    await loaded(40);
    expect(chosen()).toHaveLength(40);
    fireEvent.click(within(dialog()).getByRole("button", { name: "下一个" }));
    await loaded(30);
    expect(chosen()).toHaveLength(IMPORT_BATCH_MAX - 40);
  });

  it("reads at most as many collections at a time as the server keeps previews for", async () => {
    const lists = Array.from({ length: COLLECTION_PREVIEW_PER_USER_MAX + 1 }, (_, index) => `https://www.youtube.com/playlist?list=PLabcdefghij012345678${index}`);
    const inspect = fakeInspect(lists.map((url, index) => ({ url, pageSize: 50, entries: newEntries(1, `y${index}-`) })));
    mockApi({ "POST /api/contents/inspect": inspect.reply });
    const gate = holdInspect(() => true);
    renderApp(<Harness urls={lists} />);
    fireEvent.click(screen.getByTestId("open"));
    await waitFor(() => expect(gate.arrived).toHaveLength(COLLECTION_PREVIEW_PER_USER_MAX));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gate.arrived.map((body) => body.url)).toEqual(lists.slice(0, COLLECTION_PREVIEW_PER_USER_MAX));
    gate.release(0);
    await waitFor(() => expect(gate.arrived).toHaveLength(COLLECTION_PREVIEW_PER_USER_MAX + 1));
    for (let index = 1; index <= COLLECTION_PREVIEW_PER_USER_MAX; index += 1) gate.release(index);
    await loaded(1);
    await waitFor(() => expect(within(dialog()).getByTestId("preview-step").textContent).toBe(`合集 1 / ${lists.length}`));
    expect(gate.peak()).toBe(COLLECTION_PREVIEW_PER_USER_MAX);
  });

  it("gives a later collection only the room the earlier ones leave", async () => {
    setup([
      { url: SERIES, pageSize: 50, entries: newEntries(40, "BV1a") },
      { url: LIST, pageSize: 50, entries: newEntries(30, "y") },
    ]);
    await loaded(40);
    fireEvent.click(within(dialog()).getByRole("button", { name: "下一个" }));
    await loaded(30);
    expect(chosen()).toHaveLength(IMPORT_BATCH_MAX - 40);
  });
});

describe("CollectionPreviewDialog processing order", () => {
  it("moves rows with the handle's arrow keys and to the front, restores the platform order, and explains the queue", async () => {
    const { onConfirm } = setup([{ url: LIST, pageSize: 50, entries: [...newEntries(4), { id: "v5", title: "第 5 讲", state: "in_collection" }] }]);
    await loaded(5);
    const orderTab = within(dialog()).getByRole("tab", { name: "处理顺序 · 4" });
    fireEvent.mouseDown(orderTab);
    const order = (): string[] => within(dialog()).getAllByTestId("preview-order-row").map((element) => element.dataset["entryId"] ?? "");
    expect(order()).toEqual(["v1", "v2", "v3", "v4"]);
    const handles = within(dialog()).getAllByRole("button", { name: /调整「.*」的处理顺序/ });
    fireEvent.keyDown(handles[0] as HTMLElement, { key: "ArrowDown" });
    expect(order()).toEqual(["v2", "v1", "v3", "v4"]);
    const last = within(dialog()).getAllByTestId("preview-order-row")[3] as HTMLElement;
    fireEvent.click(within(last).getByRole("button", { name: "移到最前" }));
    expect(order()).toEqual(["v4", "v2", "v1", "v3"]);
    // The moved row's handle takes the focus: its own 「移到最前」 is hidden on the first row.
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("调整「第 4 讲」的处理顺序"));
    expect(within(dialog()).getByTestId("preview-order-note").textContent).toBe(
      "Amber 会按这个顺序把新的处理任务排进队列。系统可能同时处理多项，实际开始和完成的时间还会受已有任务、模型配置和转录等待的影响。",
    );
    expect(within(dialog()).getByTestId("preview-footer-note").textContent).toBe("合集页里按平台原顺序排列");
    fireEvent.click(within(dialog()).getByTestId("preview-submit"));
    expect(onConfirm).toHaveBeenLastCalledWith([{ url: LIST, entries: ["v4", "v2", "v1", "v3"], previewId: "pv1" }]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "恢复平台顺序" }));
    expect(order()).toEqual(["v1", "v2", "v3", "v4"]);
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "恢复平台顺序" }).disabled).toBe(true);
  });

  it("says what to do when nothing is chosen", async () => {
    setup([{ url: LIST, pageSize: 50, entries: [{ id: "v1", title: "第 1 讲", state: "in_collection" }] }]);
    await loaded(1);
    fireEvent.mouseDown(within(dialog()).getByTestId("preview-tab-order"));
    expect(within(dialog()).getByText("还没有选择内容")).toBeTruthy();
    expect(within(dialog()).getByTestId<HTMLButtonElement>("preview-submit").disabled).toBe(true);
  });
});
