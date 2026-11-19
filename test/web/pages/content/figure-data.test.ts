import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../../src/web/api/context.tsx";
import { FIGURE_WIDTH_DEFAULT, FIGURE_WIDTH_MIN_RATIO } from "../../../../src/shared/defaults.ts";
import { FIGURE_WIDTH_PREF_KEY } from "../../../../src/shared/danmaku-prefs.ts";
import type { FigureDto, FigureListDto } from "../../../../src/shared/dto/figure.ts";
import { inFigureOrder, mergeFigure, parseFigureWidth, useFigureActions, rememberedFigureWidth, rememberFigureWidth } from "../../../../src/web/pages/content/figure-data.ts";

function figure(id: string, overrides: Partial<FigureDto> = {}): FigureDto {
  return {
    id,
    contentId: "c1",
    source: "upload",
    placement: { displayMs: 0, anchor: null, sortKey: 0 },
    widthRatio: 0.7,
    image: { width: 2, height: 1, bytes: 10, sha256: "b".repeat(64) },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => localStorage.clear());

describe("mergeFigure", () => {
  const list: FigureListDto = { items: [figure("a"), figure("b")], recentlyDeleted: [figure("old", { deletedAt: 5 })], limit: 100 };

  it("replaces a live figure with its newer version", () => {
    const next = mergeFigure(list, figure("a", { version: 2, caption: "新" }));
    expect(next.items.find((item) => item.id === "a")?.caption).toBe("新");
    expect(next.items).toHaveLength(2);
  });

  it("moves a deleted figure to the recently deleted ones, newest first, and back when restored", () => {
    const deleted = mergeFigure(list, figure("a", { version: 1, deletedAt: 9 }));
    expect(deleted.items.map((item) => item.id)).toEqual(["b"]);
    expect(deleted.recentlyDeleted.map((item) => item.id)).toEqual(["a", "old"]);
    const restored = mergeFigure(deleted, figure("a", { version: 1 }));
    expect(restored.items.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(restored.recentlyDeleted.map((item) => item.id)).toEqual(["old"]);
  });

  it("ignores a version older than the cached one", () => {
    const newer = mergeFigure(list, figure("a", { version: 3, caption: "新" }));
    expect(mergeFigure(newer, figure("a", { version: 2, caption: "旧" }))).toBe(newer);
  });

  it("adds a figure it did not have", () => {
    expect(mergeFigure(list, figure("c")).items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("remembered width", () => {
  it("accepts only widths a figure can have", () => {
    expect(parseFigureWidth("0.4")).toBe(0.4);
    expect(parseFigureWidth(String(FIGURE_WIDTH_MIN_RATIO))).toBe(FIGURE_WIDTH_MIN_RATIO);
    expect(parseFigureWidth("0.1")).toBeUndefined();
    expect(parseFigureWidth("1.5")).toBeUndefined();
    expect(parseFigureWidth("宽")).toBeUndefined();
    expect(parseFigureWidth("")).toBeUndefined();
    expect(parseFigureWidth(null)).toBeUndefined();
  });

  it("gives new figures the default until the user sets a width, then that width", () => {
    expect(rememberedFigureWidth()).toBe(FIGURE_WIDTH_DEFAULT);
    rememberFigureWidth(0.55);
    expect(localStorage.getItem(FIGURE_WIDTH_PREF_KEY)).toBe("0.55");
    expect(rememberedFigureWidth()).toBe(0.55);
    rememberFigureWidth(3);
    expect(rememberedFigureWidth()).toBe(0.55);
    localStorage.setItem(FIGURE_WIDTH_PREF_KEY, "garbage");
    expect(rememberedFigureWidth()).toBe(FIGURE_WIDTH_DEFAULT);
  });
});

describe("inFigureOrder", () => {
  it("runs a figure's changes one after another, a failure not stopping the next, other figures not waiting", async () => {
    const queue = { chains: new Map<string, Promise<unknown>>() };
    const log: string[] = [];
    let release: () => void = () => undefined;
    const first = inFigureOrder(queue, "a", () => new Promise<void>((resolve) => { log.push("a1"); release = resolve; }));
    const second = inFigureOrder(queue, "a", async () => { log.push("a2"); throw new Error("refused"); });
    const third = inFigureOrder(queue, "a", async () => { log.push("a3"); });
    await inFigureOrder(queue, "b", async () => { log.push("b1"); });
    expect(log).toEqual(["a1", "b1"]);
    release();
    await first;
    await expect(second).rejects.toThrow("refused");
    await third;
    expect(log).toEqual(["a1", "b1", "a2", "a3"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.chains.size).toBe(0);
  });
});

describe("useFigureActions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("queues the changes of one figure from every part of the page: a restore from the insert menu waits for the reading view's delete", async () => {
    const sent: string[] = [];
    const answers: Array<(body: unknown) => void> = [];
    vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
      sent.push(`${init.method ?? "GET"} ${String(input)}`);
      return new Promise<Response>((resolve) => answers.push((body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))));
    });
    const queryClient = createQueryClient();
    const wrapper = (props: { children: ReactNode }) => createElement(ApiProvider, { client: new ApiClient({ baseUrl: "" }, "local"), queryClient, children: props.children });
    // Two components of one page, each with its own hook.
    const reader = renderHook(() => useFigureActions("c1"), { wrapper }).result;
    const menu = renderHook(() => useFigureActions("c1"), { wrapper }).result;
    const removed = reader.current.remove("F");
    const restored = menu.current.restore("F");
    await waitFor(() => expect(sent).toEqual(["DELETE /api/figures/F"]));
    answers[0]?.(figure("F", { contentId: "c1", deletedAt: 9 }));
    expect((await removed).kind).toBe("saved");
    await waitFor(() => expect(sent).toEqual(["DELETE /api/figures/F", "POST /api/figures/F/restore"]));
    answers[1]?.(figure("F", { contentId: "c1" }));
    expect((await restored).kind).toBe("saved");
  });

  it("names its own last version in the next change, so two quick moves never conflict with each other", async () => {
    const bodies: unknown[] = [];
    let version = 1;
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      version += 1;
      return new Response(JSON.stringify(figure("F", { contentId: "c1", version })), { status: 200, headers: { "content-type": "application/json" } });
    });
    const queryClient = createQueryClient();
    const wrapper = (props: { children: ReactNode }) => createElement(ApiProvider, { client: new ApiClient({ baseUrl: "" }, "local"), queryClient, children: props.children });
    const actions = renderHook(() => useFigureActions("c1"), { wrapper }).result;
    // Both sent from what the screen showed: version 1.
    const first = actions.current.patch({ id: "F", version: 1 }, { widthRatio: 0.4 });
    const second = actions.current.patch({ id: "F", version: 1 }, { widthRatio: 1 });
    await Promise.all([first, second]);
    expect(bodies).toEqual([{ widthRatio: 0.4, version: 1 }, { widthRatio: 1, version: 2 }]);
  });
});
