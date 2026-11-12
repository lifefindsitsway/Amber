import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../../src/web/commands.ts";
import { Omnibox } from "../../../src/web/shell/omnibox.tsx";
import { baseRoutes, collection, content } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const SEGMENT = "01JABCDEFGHJKMNPQRSTVWXYZ3";

function context(): CommandContext {
  return { navigate: vi.fn(), toggleTheme: vi.fn(), openShortcutHelp: vi.fn() };
}

// jsdom lacks the layout APIs cmdk touches.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe("Omnibox", () => {
  it("lists recent items before anything is typed", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/contents": { body: { items: [content("x1", { title: "检索增强生成" })], total: 1 } },
      "GET /api/collections": { body: { items: [collection("k1", "检索课程")] } },
    });
    const ctx = context();
    renderApp(<Omnibox open onOpenChange={() => undefined} context={ctx} />);
    fireEvent.click(await screen.findByText("检索课程"));
    expect(ctx.navigate).toHaveBeenCalledWith("/collections/k1");
  });

  it("searches everything for typed text and opens a sentence hit where it is", async () => {
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/search": {
        body: {
          contents: [{ contentId: "x1", title: "检索增强生成", matchedIn: "title", snippet: "检索增强生成", ranges: [{ start: 0, end: 2 }] }],
          segments: [
            {
              contentId: "x2",
              contentTitle: "操作系统",
              transcriptRevisionId: "r2",
              segmentId: SEGMENT,
              startMs: 75_000,
              snippet: "这里也用到检索",
              ranges: [{ start: 5, end: 7 }],
            },
          ],
          summaries: [],
          collections: [],
        },
      },
    });
    const ctx = context();
    const onOpenChange = vi.fn();
    renderApp(<Omnibox open onOpenChange={onOpenChange} context={ctx} />);
    const input = await screen.findByPlaceholderText("搜索内容与合集，输入 > 执行命令");
    fireEvent.change(input, { target: { value: "检索" } });
    expect(await screen.findByText("字幕命中")).toBeTruthy();
    expect(screen.getByText("内容")).toBeTruthy();
    expect(screen.getByText("操作系统 · 1:15")).toBeTruthy();
    const search = calls.find((call) => call.path.startsWith("/api/search"));
    expect(new URL(search?.path ?? "", "http://x").searchParams.get("scope")).toBe("global");
    expect(new URL(search?.path ?? "", "http://x").searchParams.get("q")).toBe("检索");

    fireEvent.click(screen.getByText("这里也用到", { exact: false }));
    expect(ctx.navigate).toHaveBeenCalledWith(`/contents/x2?tab=transcript&revision=r2&segment=${SEGMENT}&search=${encodeURIComponent("检索")}`);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers the new page when nothing matches", async () => {
    mockApi({ ...baseRoutes(), "GET /api/search": { body: { contents: [], segments: [], summaries: [], collections: [] } } });
    const ctx = context();
    renderApp(<Omnibox open onOpenChange={() => undefined} context={ctx} />);
    const input = await screen.findByPlaceholderText("搜索内容与合集，输入 > 执行命令");
    fireEvent.change(input, { target: { value: "不存在的词" } });
    fireEvent.click(await screen.findByText("粘贴视频链接，新建总结"));
    expect(ctx.navigate).toHaveBeenCalledWith("/new");
  });

  it("switches to the command registry on > and shows bound shortcuts", async () => {
    mockApi(baseRoutes());
    const ctx = context();
    renderApp(<Omnibox open onOpenChange={() => undefined} context={ctx} />);
    const input = await screen.findByTestId("omnibox");
    fireEvent.change(input.querySelector("input") as HTMLInputElement, { target: { value: ">主题" } });
    const item = await screen.findByText("切换主题");
    fireEvent.click(item);
    expect(ctx.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("opens the notes page from the command registry", async () => {
    mockApi(baseRoutes());
    const ctx = context();
    renderApp(<Omnibox open onOpenChange={() => undefined} context={ctx} />);
    const input = await screen.findByTestId("omnibox");
    fireEvent.change(input.querySelector("input") as HTMLInputElement, { target: { value: ">笔记" } });
    fireEvent.click(await screen.findByText("笔记"));
    expect(ctx.navigate).toHaveBeenCalledWith("/notes");
  });

  it("opens the trash from the command registry", async () => {
    mockApi(baseRoutes());
    const ctx = context();
    renderApp(<Omnibox open onOpenChange={() => undefined} context={ctx} />);
    const input = await screen.findByTestId("omnibox");
    fireEvent.change(input.querySelector("input") as HTMLInputElement, { target: { value: ">回收站" } });
    fireEvent.click(await screen.findByText("回收站"));
    expect(ctx.navigate).toHaveBeenCalledWith("/trash");
  });

  it("shows the new-summary shortcut next to its command", async () => {
    mockApi(baseRoutes());
    renderApp(<Omnibox open onOpenChange={() => undefined} context={context()} />);
    const box = await screen.findByTestId("omnibox");
    fireEvent.change(box.querySelector("input") as HTMLInputElement, { target: { value: ">" } });
    expect((await screen.findByText("新总结")).parentElement?.textContent).toContain("Ctrl+Shift+O");
  });
});

describe("Omnibox speakers", () => {
  it("names sentence speakers (muted 未核对 when unreviewed), flags changed summaries and lists name matches as their own group", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /api/search": {
        body: {
          contents: [],
          segments: [
            { contentId: "x2", contentTitle: "操作系统", transcriptRevisionId: "r2", segmentId: SEGMENT, startMs: 75_000, snippet: "陈明讲调度", ranges: [], speaker: { id: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, confirmed: true } },
            { contentId: "x3", contentTitle: "编译原理", transcriptRevisionId: "r3", segmentId: "01JABCDEFGHJKMNPQRSTVWXYZ4", startMs: 1_000, snippet: "陈明也在", ranges: [], speaker: { id: "sp9", ordinal: 2, colorIndex: 1, confirmed: false } },
          ],
          summaries: [
            { contentId: "x2", contentTitle: "操作系统", artifactId: "a1", templateId: "summary.core", summaryRevisionId: "sr1", snippet: "陈明的观点", ranges: [], speakerContextState: "attribution_changed" },
            { contentId: "x3", contentTitle: "编译原理", artifactId: "a2", templateId: "summary.core", summaryRevisionId: "sr2", snippet: "陈明的另一观点", ranges: [], speakerContextState: "consistent" },
          ],
          collections: [],
          speakers: [
            { contentId: "x2", contentTitle: "操作系统", speakerId: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, sentences: 40 },
            { contentId: "x3", contentTitle: "编译原理", speakerId: "sp5", ordinal: 1, name: "陈明", colorIndex: 0, sentences: 3 },
          ],
        },
      },
    });
    const ctx = context();
    renderApp(<Omnibox open onOpenChange={() => undefined} context={ctx} />);
    fireEvent.change(await screen.findByPlaceholderText("搜索内容与合集，输入 > 执行命令"), { target: { value: "陈明" } });
    const group = await screen.findByTestId("omnibox-group-speakers");
    expect(group.textContent).toContain("发言人（姓名匹配）");
    const speakers = screen.getAllByTestId("hit-speaker");
    expect(speakers.map((item) => [item.getAttribute("data-confirmed"), item.lastElementChild?.textContent])).toEqual([
      ["true", "陈明"],
      ["false", "发言人 2未核对"],
    ]);
    expect(screen.getAllByTestId("hit-basis-changed")).toHaveLength(1);
    // The same name in two Contents stays two entries.
    expect(group.textContent).toContain("操作系统 · 40 句");
    expect(group.textContent).toContain("编译原理 · 3 句");
    fireEvent.click(screen.getByText("编译原理 · 3 句"));
    expect(ctx.navigate).toHaveBeenCalledWith("/contents/x3?tab=transcript&speaker=sp5");
  });
});
