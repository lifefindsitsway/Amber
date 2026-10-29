import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESIZE_EDGES, useFloatingBox, type BoxRect, type ResizeEdge } from "../../../src/web/ui/use-floating-box.ts";

const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;

function Harness(props: { rect: BoxRect; onCommit: (rect: BoxRect) => void }) {
  const [rect, setRect] = useState(props.rect);
  const floating = useFloatingBox({
    rect,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    onCommit: (next) => {
      props.onCommit(next);
      setRect(next);
    },
  });
  return (
    <div data-testid="box" style={floating.box} data-active={floating.active ?? ""}>
      <header data-testid="bar" {...floating.moveHandle}>
        <span role="button" tabIndex={0} data-testid="grip" onKeyDown={floating.onKeyDown} />
        <button type="button" data-testid="bar-button" />
        <div role="menu" data-testid="bar-menu" />
      </header>
      {RESIZE_EDGES.map((edge) => (
        <div key={edge} data-testid={`edge-${edge}`} {...floating.resizeHandle(edge)} />
      ))}
    </div>
  );
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function resizeWindow(width: number, height: number): void {
  setViewport(width, height);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

const shown = (): BoxRect => {
  const style = screen.getByTestId("box").style;
  return { left: parseFloat(style.left), top: parseFloat(style.top), width: parseFloat(style.width), height: parseFloat(style.height) };
};

const active = (): string => screen.getByTestId("box").getAttribute("data-active") ?? "";

function setup(rect: BoxRect) {
  const onCommit = vi.fn<(rect: BoxRect) => void>();
  const view = render(<Harness rect={rect} onCommit={onCommit} />);
  return { onCommit, ...view };
}

/** Presses on `element`, moves by (dx, dy) from there, and releases unless told not to. */
function drag(element: Element, dx: number, dy: number, options: { pointerId?: number; release?: boolean } = {}): void {
  const pointerId = options.pointerId ?? 1;
  fireEvent.pointerDown(element, { pointerId, button: 0, clientX: 500, clientY: 500 });
  fireEvent.pointerMove(element, { pointerId, clientX: 500 + dx, clientY: 500 + dy });
  if (options.release !== false) fireEvent.pointerUp(element, { pointerId, clientX: 500 + dx, clientY: 500 + dy });
}

beforeEach(() => {
  setViewport(1200, 800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFloatingBox", () => {
  it("moves the box by its bar, covers the page meanwhile and commits on release", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    const bar = screen.getByTestId("bar");
    drag(bar, 50, 20, { release: false });
    expect(active()).toBe("move");
    expect(shown()).toEqual({ left: 150, top: 120, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 550, clientY: 520 });
    expect(active()).toBe("");
    expect(onCommit.mock.calls).toEqual([[{ left: 150, top: 120, width: 400, height: 300 }]]);
    expect(shown()).toEqual({ left: 150, top: 120, width: 400, height: 300 });
  });

  it("keeps the box inside the viewport while it is dragged past an edge", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    drag(screen.getByTestId("bar"), -500, 2000);
    expect(onCommit.mock.calls).toEqual([[{ left: 0, top: 500, width: 400, height: 300 }]]);
  });

  it("does not move when pressed on a control in the bar, nor commit a press that moved nothing", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    drag(screen.getByTestId("bar-button"), 50, 20);
    drag(screen.getByTestId("bar-menu"), 50, 20);
    expect(shown()).toEqual({ left: 100, top: 100, width: 400, height: 300 });
    drag(screen.getByTestId("bar"), 0, 0);
    expect(onCommit).not.toHaveBeenCalled();
    // A secondary button never starts a gesture.
    fireEvent.pointerDown(screen.getByTestId("bar"), { pointerId: 1, button: 2, clientX: 0, clientY: 0 });
    expect(active()).toBe("");
  });

  it("follows only the first pointer of a gesture", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    const bar = screen.getByTestId("bar");
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerDown(bar, { pointerId: 2, button: 0, clientX: 600, clientY: 600 });
    fireEvent.pointerMove(bar, { pointerId: 2, clientX: 700, clientY: 700 });
    expect(shown().left).toBe(100);
    fireEvent.pointerUp(bar, { pointerId: 2, clientX: 700, clientY: 700 });
    expect(active()).toBe("move");
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 510, clientY: 510 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 510, clientY: 510 });
    expect(onCommit.mock.calls).toEqual([[{ left: 110, top: 110, width: 400, height: 300 }]]);
  });

  it("puts the box back where the gesture began on pointercancel", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    const bar = screen.getByTestId("bar");
    drag(bar, 80, 80, { release: false });
    fireEvent.pointerCancel(bar, { pointerId: 1 });
    expect(active()).toBe("");
    expect(shown()).toEqual({ left: 100, top: 100, width: 400, height: 300 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 580, clientY: 580 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("puts the box back on Escape, before anything else on the page sees the key", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    const elsewhere = vi.fn();
    document.addEventListener("keydown", elsewhere);
    const edge = screen.getByTestId("edge-se");
    drag(edge, 80, 80, { release: false });
    expect(active()).toBe("se");
    expect(shown()).toEqual({ left: 100, top: 100, width: 480, height: 380 });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(elsewhere).not.toHaveBeenCalled();
    expect(active()).toBe("");
    expect(shown()).toEqual({ left: 100, top: 100, width: 400, height: 300 });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 700, clientY: 700 });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 700, clientY: 700 });
    expect(onCommit).not.toHaveBeenCalled();
    document.removeEventListener("keydown", elsewhere);
  });

  it("moves the edge or corner of each handle, the opposite edges staying put", () => {
    const start: BoxRect = { left: 400, top: 300, width: 500, height: 400 };
    const expected: Record<ResizeEdge, BoxRect> = {
      n: { left: 400, top: 330, width: 500, height: 370 },
      s: { left: 400, top: 300, width: 500, height: 430 },
      e: { left: 400, top: 300, width: 530, height: 400 },
      w: { left: 430, top: 300, width: 470, height: 400 },
      ne: { left: 400, top: 330, width: 530, height: 370 },
      nw: { left: 430, top: 330, width: 470, height: 370 },
      se: { left: 400, top: 300, width: 530, height: 430 },
      sw: { left: 430, top: 300, width: 470, height: 430 },
    };
    for (const edge of RESIZE_EDGES) {
      const { onCommit, unmount } = setup(start);
      drag(screen.getByTestId(`edge-${edge}`), 30, 30);
      expect(onCommit.mock.calls, edge).toEqual([[expected[edge]]]);
      unmount();
    }
  });

  it("never resizes below the minimum size, the opposite edge staying put", () => {
    const start: BoxRect = { left: 400, top: 300, width: 500, height: 400 };
    const shrunk: Record<ResizeEdge, BoxRect> = {
      n: { left: 400, top: 420, width: 500, height: MIN_HEIGHT },
      s: { left: 400, top: 300, width: 500, height: MIN_HEIGHT },
      e: { left: 400, top: 300, width: MIN_WIDTH, height: 400 },
      w: { left: 540, top: 300, width: MIN_WIDTH, height: 400 },
      ne: { left: 400, top: 420, width: MIN_WIDTH, height: MIN_HEIGHT },
      nw: { left: 540, top: 420, width: MIN_WIDTH, height: MIN_HEIGHT },
      se: { left: 400, top: 300, width: MIN_WIDTH, height: MIN_HEIGHT },
      sw: { left: 540, top: 300, width: MIN_WIDTH, height: MIN_HEIGHT },
    };
    // Each handle pushed far inwards.
    const inwards: Record<ResizeEdge, [number, number]> = {
      n: [0, 1000],
      s: [0, -1000],
      e: [-1000, 0],
      w: [1000, 0],
      ne: [-1000, 1000],
      nw: [1000, 1000],
      se: [-1000, -1000],
      sw: [1000, -1000],
    };
    for (const edge of RESIZE_EDGES) {
      const { onCommit, unmount } = setup(start);
      const [dx, dy] = inwards[edge];
      drag(screen.getByTestId(`edge-${edge}`), dx, dy);
      expect(onCommit.mock.calls, edge).toEqual([[shrunk[edge]]]);
      unmount();
    }
  });

  it("stops a resize at the viewport's edge", () => {
    const { onCommit } = setup({ left: 400, top: 300, width: 500, height: 400 });
    drag(screen.getByTestId("edge-nw"), -1000, -1000);
    expect(onCommit.mock.calls).toEqual([[{ left: 0, top: 0, width: 900, height: 700 }]]);
  });

  it("fits a viewport smaller than the minimum size, its top row in sight", () => {
    setViewport(300, 200);
    setup({ left: -40, top: -40, width: 480, height: 400 });
    expect(shown()).toEqual({ left: 0, top: 0, width: 300, height: 200 });
  });

  it("clamps the box back into a smaller window without committing, and restores it in a larger one", () => {
    const { onCommit } = setup({ left: 700, top: 400, width: 480, height: 360 });
    expect(shown()).toEqual({ left: 700, top: 400, width: 480, height: 360 });
    resizeWindow(800, 600);
    expect(shown()).toEqual({ left: 320, top: 240, width: 480, height: 360 });
    resizeWindow(300, 200);
    expect(shown()).toEqual({ left: 0, top: 0, width: 300, height: 200 });
    resizeWindow(1200, 800);
    expect(shown()).toEqual({ left: 700, top: 400, width: 480, height: 360 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("moves by 16 px per arrow key on the grip, and resizes by 16 px with Shift", () => {
    const { onCommit } = setup({ left: 100, top: 100, width: 400, height: 300 });
    const grip = screen.getByTestId("grip");
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(grip, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(grip, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(grip, { key: "Enter" });
    expect(onCommit.mock.calls).toEqual([
      [{ left: 116, top: 100, width: 400, height: 300 }],
      [{ left: 116, top: 116, width: 400, height: 300 }],
      [{ left: 100, top: 116, width: 400, height: 300 }],
      [{ left: 100, top: 100, width: 400, height: 300 }],
      [{ left: 100, top: 100, width: 416, height: 300 }],
      [{ left: 100, top: 100, width: 416, height: 316 }],
      [{ left: 100, top: 100, width: 416, height: 300 }],
      [{ left: 100, top: 100, width: 400, height: 300 }],
    ]);
  });

  it("drops a gesture in progress with the component", () => {
    const { onCommit, unmount } = setup({ left: 100, top: 100, width: 400, height: 300 });
    drag(screen.getByTestId("bar"), 40, 40, { release: false });
    unmount();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 600, clientY: 600 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 600, clientY: 600 });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
