import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderJumpButtons } from "../../../../src/web/pages/content/reader-jump.tsx";
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
});
