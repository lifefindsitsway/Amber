import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlainDescription } from "../../../src/web/components/plain-description.tsx";

/** jsdom lays nothing out: heights come from this fake, keyed on the classes that clip. */
const CLAMP_PX = 60;
const SCROLL_CAP_PX = 120;
let contentPx = 20;
let resize: (() => void) | undefined;

beforeEach(() => {
  contentPx = 20;
  resize = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => contentPx);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    if (this.classList.contains("line-clamp-3")) return Math.min(contentPx, CLAMP_PX);
    if (this.classList.contains("overflow-y-auto")) return Math.min(contentPx, SCROLL_CAP_PX);
    return contentPx;
  });
});

const LONG = "第一段介绍\n第二段 https://example.com/a，还有 http://b.example.com/x\n\n第三段\n第四段\n第五段";

function renderDescription(text: string, options: { truncated?: boolean; px?: number } = {}) {
  contentPx = options.px ?? contentPx;
  return render(<PlainDescription text={text} truncated={options.truncated ?? false} maxChars={10000} />);
}

describe("PlainDescription", () => {
  it("renders nothing for empty text", () => {
    const { container } = renderDescription("");
    expect(container.innerHTML).toBe("");
  });

  it("shows short text without a toggle and with its links", () => {
    renderDescription("简介 https://example.com/a。", { px: 20 });
    expect(screen.queryByTestId("content-description-toggle")).toBeNull();
    const link = screen.getByRole("link", { name: "https://example.com/a" });
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("collapses long text behind 「展开」 with no links in the DOM", () => {
    const { container } = renderDescription(LONG, { px: 200 });
    const toggle = screen.getByTestId("content-description-toggle");
    expect(toggle.textContent).toBe("展开");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByTestId("content-description-text").className).toContain("line-clamp-3");
    expect(screen.getByTestId("content-description-text").textContent).toBe(LONG);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("expands to a focusable scrolling region with links and 「收起」, then collapses back", () => {
    const { container } = renderDescription(LONG, { px: 200 });
    fireEvent.click(screen.getByTestId("content-description-toggle"));
    const toggle = screen.getByTestId("content-description-toggle");
    expect(toggle.textContent).toBe("收起");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/a", "http://b.example.com/x"]);
    const region = screen.getByRole("region", { name: "视频简介" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.contains(screen.getByTestId("content-description-text"))).toBe(true);
    expect(screen.getByTestId("content-description-text").className).not.toContain("line-clamp-3");

    fireEvent.click(toggle);
    expect(screen.getByTestId("content-description-toggle").textContent).toBe("展开");
    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("is not a focusable region when the expanded text fits without scrolling", () => {
    renderDescription(LONG, { px: 100 });
    fireEvent.click(screen.getByTestId("content-description-toggle"));
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByTestId("content-description-toggle").textContent).toBe("收起");
  });

  it("shows the truncation note only when expanded and truncated", () => {
    renderDescription(LONG, { px: 200, truncated: true });
    expect(screen.queryByTestId("content-description-truncated")).toBeNull();
    fireEvent.click(screen.getByTestId("content-description-toggle"));
    const note = screen.getByTestId("content-description-truncated");
    expect(note.textContent).toBe("原简介较长，这里只保留了前 10000 个字符");
    expect(screen.getByRole("region").contains(note)).toBe(true);
  });

  it("omits the truncation note when the text is complete", () => {
    renderDescription(LONG, { px: 200, truncated: false });
    fireEvent.click(screen.getByTestId("content-description-toggle"));
    expect(screen.queryByTestId("content-description-truncated")).toBeNull();
  });

  it("re-checks the overflow when the width changes", () => {
    const { container } = renderDescription(LONG, { px: 40 });
    expect(screen.queryByTestId("content-description-toggle")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(2);
    contentPx = 200;
    act(() => resize?.());
    expect(screen.getByTestId("content-description-toggle").textContent).toBe("展开");
    expect(container.querySelector("a")).toBeNull();
    contentPx = 40;
    act(() => resize?.());
    expect(screen.queryByTestId("content-description-toggle")).toBeNull();
  });

  it("still measures once where ResizeObserver does not exist", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    renderDescription(LONG, { px: 200 });
    expect(screen.getByTestId("content-description-toggle").textContent).toBe("展开");
  });

  it("keeps line breaks and source order in its text", () => {
    const text = "مرحبا بكم https://example.com/ar في القناة\nسطر ثان";
    renderDescription(text, { px: 20 });
    const block = screen.getByTestId("content-description-text");
    expect(block.textContent).toBe(text);
    expect(block.className).toContain("whitespace-pre-wrap");
    expect(block.className).toContain("[unicode-bidi:plaintext]");
    expect(screen.getByRole("link").textContent).toBe("https://example.com/ar");
  });

  it("only ever puts http(s) hrefs on its links", () => {
    const { container } = renderDescription("javascript:alert(1) mailto:a@b.c ftp://x.org https://ok.example.com <a href=x>", { px: 20 });
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://ok.example.com/"]);
    expect(links.every((link) => link.getAttribute("rel") === "noopener noreferrer")).toBe(true);
    expect(screen.getByTestId("content-description-text").textContent).toContain("<a href=x>");
  });
});
