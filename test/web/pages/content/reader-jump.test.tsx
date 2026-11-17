import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderJumpButtons } from "../../../../src/web/pages/content/reader-jump.tsx";
import type { LocateButton } from "../../../../src/web/pages/content/reader-locate.ts";
import { READER_COLUMN_CLASS, READER_SCROLLER_CLASS } from "../../../../src/web/pages/content/reader-sentences.tsx";

function show() {
  const onTop = vi.fn<() => void>();
  const onBottom = vi.fn<() => void>();
  render(<ReaderJumpButtons onTop={onTop} onBottom={onBottom} />);
  return { onTop, onBottom, top: screen.getByRole("button", { name: "去顶部" }), bottom: screen.getByRole("button", { name: "去底部" }) };
}

describe("ReaderJumpButtons", () => {
  it("renders both buttons with their names and calls their handlers", () => {
    const { onTop, onBottom, top, bottom } = show();
    expect(top.getAttribute("data-testid")).toBe("reader-to-top");
    expect(bottom.getAttribute("data-testid")).toBe("reader-to-bottom");
    expect(top.getAttribute("title")).toBe("去顶部");
    expect(bottom.getAttribute("title")).toBe("去底部");
    fireEvent.click(top);
    expect(onTop).toHaveBeenCalledTimes(1);
    expect(onBottom).not.toHaveBeenCalled();
    fireEvent.click(bottom);
    expect(onBottom).toHaveBeenCalledTimes(1);
    expect(onTop).toHaveBeenCalledTimes(1);
  });

  it("keeps both buttons in one box", () => {
    const { top, bottom } = show();
    expect(top.parentElement).not.toBeNull();
    expect(top.parentElement).toBe(bottom.parentElement);
    expect(top.parentElement?.children.length).toBe(2);
  });

  it("places the box in a still copy of the scroller that lets pointer input through", () => {
    const { top } = show();
    const box = top.parentElement as HTMLElement;
    const layer = box.parentElement as HTMLElement;
    const classes = layer.className.split(" ");
    for (const name of [READER_SCROLLER_CLASS, "absolute", "inset-0", "overflow-hidden", "pointer-events-none", "z-20"]) expect(classes).toContain(name);
    expect(layer.querySelector(`.${READER_COLUMN_CLASS}`)).toBeNull();
    const boxClasses = box.className.split(" ");
    for (const name of ["pointer-events-auto", "absolute", "right-[8px]", "bottom-[16px]"]) expect(boxClasses).toContain(name);
  });

  describe("定位到播放位置", () => {
    function showLocate(state: Omit<LocateButton, "onLocate">) {
      const onLocate = vi.fn<() => void>();
      render(<ReaderJumpButtons onTop={() => undefined} onBottom={() => undefined} locate={{ ...state, onLocate }} />);
      return { onLocate, locate: screen.getByRole("button", { name: "定位到播放位置" }) };
    }

    it("is not there without a player that tells the time", () => {
      show();
      expect(screen.queryByTestId("reader-locate")).toBeNull();
    });

    it("sits between the other two, in the same box, the same size", () => {
      const { locate } = showLocate({ waiting: false, showsAll: false });
      const box = locate.parentElement as HTMLElement;
      expect([...box.children].map((child) => child.getAttribute("data-testid"))).toEqual(["reader-to-top", "reader-locate", "reader-to-bottom"]);
      const classes = (element: Element): string[] => element.className.split(" ").filter((name) => name.startsWith("size-") || name.startsWith("rounded"));
      expect(classes(locate)).toEqual(classes(screen.getByTestId("reader-to-top")));
      expect(locate.querySelector("svg")).not.toBeNull();
    });

    it("when ready, is named and titled 定位到播放位置 and locates on click", () => {
      const { locate, onLocate } = showLocate({ waiting: false, showsAll: false });
      expect(locate.getAttribute("title")).toBe("定位到播放位置");
      expect(locate.hasAttribute("aria-disabled")).toBe(false);
      fireEvent.click(locate);
      expect(onLocate).toHaveBeenCalledTimes(1);
    });

    it("while waiting for a time, keeps its place disabled with the reason, and ignores clicks", () => {
      const { locate, onLocate } = showLocate({ waiting: true, showsAll: false });
      expect(locate.getAttribute("aria-disabled")).toBe("true");
      expect(locate.getAttribute("title")).toBe("还没有播放位置，开始播放后可用");
      // Still focusable, so the reason can be reached from the keyboard too.
      expect((locate as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(locate);
      expect(onLocate).not.toHaveBeenCalled();
    });

    it("says it will show every speaker when the filter hides the playing sentence", () => {
      const { locate, onLocate } = showLocate({ waiting: false, showsAll: true });
      expect(locate.getAttribute("title")).toBe("定位到播放位置（将显示全部发言人）");
      fireEvent.click(locate);
      expect(onLocate).toHaveBeenCalledTimes(1);
    });
  });
});
