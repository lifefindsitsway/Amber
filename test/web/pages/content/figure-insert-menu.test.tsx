import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIGURE_UPLOAD_MAX_BYTES, FIGURES_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import { figureUploadMetaSchema, type FigureDto } from "../../../../src/shared/dto/figure.ts";
import { figureInsertStatus } from "../../../../src/web/pages/content/figure-insert.ts";
import { FigureInsertMenu, statusAlignEnd } from "../../../../src/web/pages/content/figure-insert-menu.tsx";
import type { ReaderFigureApi } from "../../../../src/web/pages/content/figure-context.ts";
import { frameSources } from "../../../../src/web/player/figure-capture.ts";
import { contentRoutes, revision, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { figure, FigurePage, pngFile, steeredApi, targetAfter } from "../../../fixtures/web/figure-insert.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

function show(api: ReaderFigureApi | undefined, list: { items?: FigureDto[]; recentlyDeleted?: FigureDto[] } = {}, extra: Parameters<typeof mockApi>[0] = {}) {
  const created = figure({ id: "NEW" });
  const server = mockApi({
    "GET /api/contents/c1/figures": { body: { items: list.items ?? [], recentlyDeleted: list.recentlyDeleted ?? [], limit: FIGURES_PER_CONTENT_MAX } },
    "POST /api/contents/c1/figures/upload": { status: 201, body: created },
    "POST /api/contents/c1/figures/capture": { status: 201, body: figure({ id: "SHOT", source: "capture", capturedAtMs: 5_000 }) },
    ...extra,
  });
  renderApp(
    <FigurePage api={api}>
      <FigureInsertMenu />
    </FigurePage>,
  );
  return server;
}

const trigger = () => screen.getByTestId("figure-insert");
const openMenu = async () => {
  fireEvent.keyDown(trigger(), { key: "Enter" });
  return screen.findByTestId("figure-insert-menu");
};
const posts = (calls: RecordedCall[], suffix: string) => calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

function pick(file: File): void {
  const input = screen.getByTestId<HTMLInputElement>("figure-insert-file");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

// Inserts report through a page-wide store; each test starts with nothing said.
afterEach(() => figureInsertStatus.clear());

describe("FigureInsertMenu", () => {
  const reasonOf = (): string | null | undefined => document.getElementById(trigger().getAttribute("aria-describedby") ?? "")?.textContent;

  it("is off while the text is still loading, saying so rather than that there is no transcript", async () => {
    show(undefined, {}, { ...contentRoutes(), "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } } });
    expect(trigger()).toHaveProperty("disabled", true);
    expect(reasonOf()).toBe("正在加载原文…");
    expect(trigger().getAttribute("title")).toBe("正在加载原文…");
  });

  it("is off with the reason when the text failed to load", async () => {
    show(undefined, {}, { ...contentRoutes(), "GET /api/transcript/revisions/r1/segments": { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } } });
    await waitFor(() => expect(reasonOf()).toBe("原文加载失败，暂时不能插图"));
    expect(trigger()).toHaveProperty("disabled", true);
  });

  it("is off with the reason when the text has no paragraph to put a figure by", async () => {
    show(undefined, {}, { ...contentRoutes(), "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: [] } } });
    await waitFor(() => expect(reasonOf()).toBe("这一版原文没有段落，无法插图"));
  });

  it("fixes the paragraph when the menu opens: an upload goes there even after playback moved on", async () => {
    const { api, state } = steeredApi(targetAfter("s3", 30_000));
    const server = show(api);
    const menu = await openMenu();
    expect(api.captureTarget).toHaveBeenCalledTimes(1);
    // Playback follows on to another paragraph while the menu is open and the file is picked.
    state.target = targetAfter("s9", 90_000);
    expect(within(menu).getByText("PNG、JPEG、WebP，不超过 20 MB")).toBeTruthy();
    expect(within(menu).getByTestId("figure-insert-paste-hint").textContent).toBe("也可以直接粘贴图片（Ctrl+V）");
    fireEvent.click(within(menu).getByTestId("figure-insert-upload"));
    pick(pngFile());
    await waitFor(() => expect(posts(server.calls, "/figures/upload")).toHaveLength(1));
    const [call] = posts(server.calls, "/figures/upload");
    expect(call?.form?.map(([name]) => name)).toEqual(["meta", "file"]);
    const meta = figureUploadMetaSchema.parse(JSON.parse(call?.form?.[0]?.[1] as string));
    expect(meta.placement).toEqual(targetAfter("s3", 30_000).placement);
    await waitFor(() => expect(api.revealFigure).toHaveBeenCalledWith("NEW"));
    expect((await screen.findByTestId("figure-insert-status")).textContent).toBe("已插入图片");
  });

  it("says why a file is refused before sending it: not a PNG, JPEG or WebP by its bytes, or too big", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const server = show(api);
    fireEvent.click(within(await openMenu()).getByTestId("figure-insert-upload"));
    // Named and typed as a PNG, but a text file.
    pick(new File(["not an image"], "伪装.png", { type: "image/png" }));
    // Said in the live region that is there all along and announces at once.
    const alerts = screen.getByTestId("figure-insert-alerts");
    expect(alerts.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(alerts.textContent).toBe("只支持 PNG、JPEG、WebP 图片"));
    fireEvent.click(within(await openMenu()).getByTestId("figure-insert-upload"));
    pick(new File([new Uint8Array(FIGURE_UPLOAD_MAX_BYTES + 1)], "大图.png", { type: "image/png" }));
    await waitFor(() => expect(alerts.textContent).toBe("只支持 PNG、JPEG、WebP 图片图片超过 20 MB，无法插入"));
    expect(posts(server.calls, "/figures/upload")).toHaveLength(0);
    // Each is dismissed by its own button; the regions stay.
    for (const button of within(alerts).getAllByRole("button", { name: "关闭" })) fireEvent.click(button);
    expect(screen.getByTestId("figure-insert-alerts").textContent).toBe("");
    expect(screen.getByTestId("figure-insert-progress").getAttribute("aria-live")).toBe("polite");
  });

  it("says the server's refusal in words", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    show(api, {}, {
      "POST /api/contents/c1/figures/upload": {
        status: 400,
        body: { error: { class: "invalid_request", code: "invalid_request.figure_image", retryDisposition: "never", userMessage: "", details: { reason: "too_many_pixels" } } },
      },
    });
    fireEvent.click(within(await openMenu()).getByTestId("figure-insert-upload"));
    pick(pngFile());
    await waitFor(() => expect(screen.getByTestId("figure-insert-status").textContent).toBe("图片尺寸过大，请缩小后再试"));
  });

  it("keeps two uploads at once apart, each with its own cancel, and reads the list again after a cancel", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const signals: AbortSignal[] = [];
    let listReads = 0;
    const fetch = vi.fn((_input: string, init: RequestInit = {}) => {
      if (init.method === "POST") {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      listReads += 1;
      return Promise.resolve(new Response(JSON.stringify({ items: [], recentlyDeleted: [], limit: FIGURES_PER_CONTENT_MAX }), { headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetch);
    renderApp(
      <FigurePage api={api}>
        <FigureInsertMenu />
      </FigurePage>,
    );
    fireEvent.click(within(await openMenu()).getByTestId("figure-insert-upload"));
    pick(pngFile("一.png"));
    fireEvent.click(within(await openMenu()).getByTestId("figure-insert-upload"));
    pick(pngFile("二.png"));
    await waitFor(() => expect(screen.getAllByTestId("figure-insert-cancel")).toHaveLength(2));
    expect(screen.getByTestId("figure-insert-progress").textContent).toBe("正在上传图片…取消正在上传图片…取消");
    const reads = listReads;
    fireEvent.click(screen.getAllByTestId("figure-insert-cancel")[0] as HTMLElement);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    await waitFor(() => expect(screen.getByTestId("figure-insert-progress").textContent).toBe("已取消上传正在上传图片…取消"));
    // The server may have stored it just before the cancel arrived: the list is read again.
    await waitFor(() => expect(listReads).toBeGreaterThan(reads));
    expect(api.revealFigure).not.toHaveBeenCalled();
  });

  it("captures the frame that was on screen when the menu opened, placed by its time", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    let atMs = 5_000;
    const clear = frameSources.set({ kind: "video", contentId: "c1", request: () => ({ assetId: "A1", atMs }), capture: vi.fn() });
    try {
      const server = show(api);
      const menu = await openMenu();
      atMs = 9_000;
      fireEvent.click(within(menu).getByTestId("figure-insert-capture"));
      await waitFor(() => expect(posts(server.calls, "/figures/capture")).toHaveLength(1));
      expect(posts(server.calls, "/figures/capture")[0]?.body).toEqual({ assetId: "A1", atMs: 5_000, widthRatio: 0.7, placement: targetAfter("t5000", 5_000).placement });
      await waitFor(() => expect(api.revealFigure).toHaveBeenCalledWith("SHOT"));
    } finally {
      clear();
    }
  });

  it("offers no capture without a picture, and says why", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    show(api);
    let menu = await openMenu();
    expect(within(menu).getByTestId("figure-insert-capture").getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByTestId("figure-insert-capture").textContent).toContain("本地播放视频时才能截取画面");
    fireEvent.keyDown(menu, { key: "Escape" });
    const clear = frameSources.set({ kind: "audio", contentId: "c1" });
    try {
      menu = await openMenu();
      expect(within(menu).getByTestId("figure-insert-capture").textContent).toContain("当前播放的文件没有画面，不能截图");
    } finally {
      act(() => clear());
    }
  });

  it("lists the recently deleted figures and brings one back, revealing it", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const gone = figure({ id: "GONE", source: "capture", capturedAtMs: 83_000, caption: "板书", deletedAt: 1_790_000_000_000 });
    const server = show(api, { recentlyDeleted: [gone, figure({ id: "OLD", deletedAt: 1_789_000_000_000 })] }, { "POST /api/figures/GONE/restore": { body: { ...gone, deletedAt: undefined, version: 2 } } });
    const menu = await openMenu();
    await within(menu).findByText("最近删除（2）");
    const recent = within(menu).getByTestId("figure-insert-recent");
    recent.focus();
    fireEvent.keyDown(recent, { key: "ArrowRight" });
    const list = await screen.findByTestId("figure-insert-recent-list");
    const items = within(list).getAllByTestId("figure-insert-restore");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["恢复插图：截图 · 1:23 · 板书", "恢复插图：图片"]);
    fireEvent.click(items[0] as HTMLElement);
    await waitFor(() => expect(posts(server.calls, "/figures/GONE/restore")).toHaveLength(1));
    await waitFor(() => expect(api.revealFigure).toHaveBeenCalledWith("GONE"));
  });

  it("says why 「最近删除」 is off when there is nothing to restore", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    show(api);
    const recent = within(await openMenu()).getByTestId("figure-insert-recent");
    await waitFor(() => expect(recent.textContent).toBe("最近删除（0）没有最近删除的插图"));
    expect(recent.getAttribute("aria-disabled")).toBe("true");
  });

  it("turns inserting off at the cap, saying so", async () => {
    const { api } = steeredApi(targetAfter("s1", 0));
    const full = Array.from({ length: FIGURES_PER_CONTENT_MAX }, () => figure());
    show(api, { items: full });
    const menu = await openMenu();
    expect((await within(menu).findByTestId("figure-insert-limit")).textContent).toBe(`插图已达 ${FIGURES_PER_CONTENT_MAX} 张上限（最近删除的也计在内）`);
    expect(screen.getByTestId("figure-insert-upload").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("statusAlignEnd", () => {
  it("decides from where the box would start under the button, whatever the alignment shown now", () => {
    // Button at 100, toolbar ending at 400: a 250 px box fits, a 320 px one goes under the button's end.
    expect(statusAlignEnd(100, 250, 400)).toBe(false);
    expect(statusAlignEnd(100, 320, 400)).toBe(true);
    expect(statusAlignEnd(100, 300, 400)).toBe(false);
  });
});
