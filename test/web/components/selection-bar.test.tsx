import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionBar, useSelectionEscape } from "../../../src/web/components/selection-bar.tsx";
import { ToastProvider } from "../../../src/web/ui/toast.tsx";

/** jsdom has no layout: each element reports the top its test gives it. */
const tops = new Map<string, number>();
const VIEWPORT = 800;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed.length = 0;
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  tops.clear();
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = tops.get(this.dataset["testid"] ?? "") ?? 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Page(props: { count?: number; pager: boolean; onClear?: () => void }) {
  return (
    <ToastProvider>
      <div>
        <SelectionBar count={props.count ?? 2} onClear={props.onClear ?? (() => undefined)} testIdPrefix="demo">
          <button type="button">act</button>
        </SelectionBar>
        {props.pager ? <nav data-testid="pager">pager</nav> : null}
      </div>
    </ToastProvider>
  );
}

const liftOf = (): string => screen.getByTestId("toast-region").style.bottom;

describe("SelectionBar", () => {
  it("shows the count and clears through its own button", () => {
    const onClear = vi.fn();
    render(<Page pager={false} count={3} onClear={onClear} />);
    expect(screen.getByTestId("demo-selection-bar").getAttribute("role")).toBe("region");
    expect(screen.getByTestId("demo-selection-count").textContent).toContain("3");
    fireEvent.click(screen.getByTestId("demo-selection-clear"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("lifts the toasts above the bar and what follows it", () => {
    tops.set("demo-selection-bar", 700);
    render(<Page pager />);
    expect(liftOf()).toContain("100px");
  });

  it("measures again when a sibling below comes or goes", () => {
    tops.set("demo-selection-bar", 700);
    const { rerender } = render(<Page pager />);
    expect(liftOf()).toContain("100px");
    // The pager is gone, so the bar drops to the page foot.
    tops.set("demo-selection-bar", 750);
    rerender(<Page pager={false} />);
    expect(liftOf()).toContain("50px");
  });

  it("watches the bar and its following siblings for size changes", () => {
    tops.set("demo-selection-bar", 700);
    render(<Page pager />);
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer?.observed.map((element) => (element as HTMLElement).dataset["testid"])).toEqual(["demo-selection-bar", "pager"]);
    // The pager wraps onto another line: the bar moves up without any render of the page.
    tops.set("demo-selection-bar", 660);
    act(() => observer?.fire());
    expect(liftOf()).toContain("140px");
  });

  it("follows window resizes and works without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    tops.set("demo-selection-bar", 700);
    render(<Page pager />);
    tops.set("demo-selection-bar", 720);
    fireEvent(window, new Event("resize"));
    expect(liftOf()).toContain("80px");
  });

  it("drops the lift once the bar is gone", () => {
    tops.set("demo-selection-bar", 700);
    const { rerender } = render(<Page pager />);
    expect(liftOf()).toContain("100px");
    rerender(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    expect(liftOf()).not.toContain("100px");
  });
});

describe("useSelectionEscape", () => {
  function Harness(props: { exit: () => void }) {
    useSelectionEscape(true, props.exit);
    return <input aria-label="field" />;
  }

  it("leaves the selection on Esc, but not from a field that takes the key", () => {
    const exit = vi.fn();
    render(<Harness exit={exit} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(exit).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
