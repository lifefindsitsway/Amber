import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  openTargetOf,
  useContentActions,
  type ContentActionOptions,
  type ContentActionSurface,
  type ContentActionTarget,
} from "../../../src/web/components/use-content-actions.tsx";
import type { MenuHit } from "../../../src/web/ui/context-menu.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const PLATFORM: ContentActionTarget = { id: "c1", title: "第一讲", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
const LOCAL: ContentActionTarget = { id: "c2", title: "本地文件" };

/** Lists one menu's rows as buttons ("—" for a separator) next to the shared dialogs. */
function Probe(props: { surface: ContentActionSurface; content: ContentActionTarget; options?: ContentActionOptions }) {
  const actions = useContentActions();
  const location = useLocation();
  return (
    <>
      <ul>
        {actions.entries(props.surface, props.content, props.options).map((entry, index) =>
          entry === "separator" ? (
            <li key={`separator-${index}`}>—</li>
          ) : (
            <li key={entry.id}>
              <button type="button" data-testid={`action-${entry.id}`} onClick={entry.onSelect}>
                {entry.label}
              </button>
            </li>
          ),
        )}
      </ul>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      {actions.dialogs}
    </>
  );
}

const rows = (): string[] => screen.getAllByRole("listitem").map((item) => item.textContent ?? "");

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>)["clipboard"];
});

describe("useContentActions", () => {
  it("offers open only in the right-click menu, in one shared order with the 「⋯」 menu, deleting last and set apart", () => {
    mockApi({});
    const { unmount } = renderApp(<Probe surface="context" content={PLATFORM} />);
    expect(rows()).toEqual(["打开", "复制来源链接", "—", "重命名", "置顶", "合集归属", "—", "删除"]);
    unmount();
    renderApp(<Probe surface="overflow" content={PLATFORM} />);
    expect(rows()).toEqual(["复制来源链接", "重命名", "置顶", "合集归属", "—", "删除"]);
  });

  it("gives the library row's 「⋯」 menu every row action, notes included, deleting last", async () => {
    mockApi({ "GET /api/collections": { body: { items: [] } }, "GET /api/contents/c1": { body: { id: "c1", source: { kind: "youtube" }, processingStatus: "succeeded", collections: [], createdAt: 1, updatedAt: 1, media: [] } } });
    const { unmount } = renderApp(<Probe surface="row" content={PLATFORM} />, { route: "/library" });
    expect(rows()).toEqual(["复制来源链接", "—", "重命名", "置顶", "合集归属", "笔记", "—", "删除"]);
    fireEvent.click(screen.getByTestId("action-membership"));
    expect(await screen.findByRole("dialog", { name: "管理合集" })).toBeTruthy();
    unmount();
    renderApp(<Probe surface="row" content={{ ...PLATFORM, pinnedAt: 3 }} />, { route: "/library" });
    expect(rows()).toEqual(["复制来源链接", "—", "重命名", "取消置顶", "合集归属", "笔记", "—", "删除"]);
    fireEvent.click(screen.getByTestId("action-notes"));
    expect(screen.getByTestId("where").textContent).toBe("/notes?contentId=c1");
  });

  it("has no source link for a local file and offers unpin for a pinned Content", () => {
    mockApi({});
    const { unmount } = renderApp(<Probe surface="context" content={{ ...LOCAL, pinnedAt: 5 }} />);
    expect(rows()).toEqual(["打开", "—", "重命名", "取消置顶", "合集归属", "—", "删除"]);
    unmount();
    renderApp(<Probe surface="overflow" content={LOCAL} />);
    expect(rows()).toEqual(["重命名", "置顶", "合集归属", "—", "删除"]);
  });

  it("copies the canonical source URL", async () => {
    mockApi({});
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderApp(<Probe surface="overflow" content={PLATFORM} />);
    fireEvent.click(screen.getByTestId("action-copy-source-url"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PLATFORM.sourceUrl));
  });

  it("confirms the copy in a toast, adding the expiry note only for a platform whose links expire", async () => {
    mockApi({});
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const XHS_URL = "https://www.xiaohongshu.com/explore/64f0c0ffee0000000000abcd?xsec_token=TESTONLY_token1";
    const cases: [ContentActionTarget, string][] = [
      [{ ...PLATFORM, sourceKind: "youtube" }, "已复制来源链接"],
      [{ id: "c3", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD", sourceKind: "bilibili" }, "已复制来源链接"],
      [{ id: "c4", sourceUrl: "https://www.douyin.com/video/7300000000000000001", sourceKind: "douyin" }, "已复制来源链接"],
      [{ id: "c5", sourceUrl: XHS_URL, sourceKind: "xiaohongshu" }, "已复制来源链接链接里的访问参数会过期，过期后需要在平台里重新分享"],
    ];
    for (const [content, message] of cases) {
      const { unmount } = renderApp(<Probe surface="overflow" content={content} />);
      fireEvent.click(screen.getByTestId("action-copy-source-url"));
      const toast = await screen.findByTestId("toast");
      expect(writeText).toHaveBeenLastCalledWith(content.sourceUrl);
      expect(toast.textContent).toBe(message);
      expect(within(toast).queryByTestId("copied-source-url-expiry") !== null).toBe(content.sourceKind === "xiaohongshu");
      unmount();
    }
  });

  it("shows no toast when nothing reached the clipboard", async () => {
    mockApi({});
    const writeText = vi.fn(async () => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    onTestFinished(() => {
      delete (document as unknown as Record<string, unknown>)["execCommand"];
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderApp(<Probe surface="overflow" content={{ ...PLATFORM, sourceKind: "youtube" }} />);
    fireEvent.click(screen.getByTestId("action-copy-source-url"));
    await waitFor(() => expect(execCommand).toHaveBeenCalled());
    // Let the copy settle before looking: a toast would follow it within the same turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("opens the Content's page, or the place it was asked to open", () => {
    mockApi({});
    const { unmount } = renderApp(<Probe surface="context" content={PLATFORM} />, { route: "/library" });
    fireEvent.click(screen.getByTestId("action-open"));
    expect(screen.getByTestId("where").textContent).toBe("/contents/c1");
    unmount();
    renderApp(<Probe surface="context" content={PLATFORM} options={{ openTo: "/contents/c1?tab=transcript&segment=s1" }} />, { route: "/library" });
    fireEvent.click(screen.getByTestId("action-open"));
    expect(screen.getByTestId("where").textContent).toBe("/contents/c1?tab=transcript&segment=s1");
  });

  it("pins through the API and opens the shared delete dialog", async () => {
    const { calls } = mockApi({
      "PATCH /api/contents/c2": { body: { id: "c2", source: { kind: "local" }, processingStatus: "succeeded", collections: [], createdAt: 1, updatedAt: 1 } },
      "POST /api/contents/trash-plan": { body: { items: [{ contentId: "c2", title: "本地文件", state: "ready" }] } },
    });
    renderApp(<Probe surface="context" content={LOCAL} />);
    fireEvent.click(screen.getByTestId("action-pin"));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ pinned: true }));
    fireEvent.click(screen.getByTestId("action-delete"));
    const dialog = await screen.findByRole("dialog", { name: "删除这条内容？" });
    expect(dialog.textContent).toContain("本地文件");
    await waitFor(() => expect(calls.find((call) => call.path === "/api/contents/trash-plan")?.body).toEqual({ contentIds: ["c2"] }));
  });
});

describe("openTargetOf", () => {
  const hit = (href: string, kind: "internal" | "external"): MenuHit => {
    const element = document.createElement("a");
    return { target: element, anchor: { href, kind, element } };
  };

  it("follows a link into the same Content and nothing else", () => {
    const origin = window.location.origin;
    expect(openTargetOf(hit(`${origin}/contents/c1?tab=transcript&segment=s1#x`, "internal"), "c1")).toBe("/contents/c1?tab=transcript&segment=s1#x");
    expect(openTargetOf(hit(`${origin}/collections/k1`, "internal"), "c1")).toBeUndefined();
    expect(openTargetOf(hit("https://www.youtube.com/watch?v=x", "external"), "c1")).toBeUndefined();
    expect(openTargetOf({ target: document.body }, "c1")).toBeUndefined();
  });
});
