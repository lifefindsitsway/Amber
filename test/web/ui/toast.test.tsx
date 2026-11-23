import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_DISMISS_MS } from "../../../src/shared/defaults.ts";
import { ToastProvider, useToast, useToastOffset, type ToastOptions } from "../../../src/web/ui/toast.tsx";

function Trigger(props: { options: ToastOptions; testId?: string }) {
  const toast = useToast();
  return (
    <button type="button" data-testid={props.testId ?? "show"} onClick={() => toast.show(props.options)}>
      show
    </button>
  );
}

const toasts = (): HTMLElement[] => screen.queryAllByTestId("toast");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toasts", () => {
  it("shows a toast in a polite live region and dismisses it after the standard delay", () => {
    render(
      <ToastProvider>
        <Trigger options={{ tone: "success", message: "已保存" }} />
      </ToastProvider>,
    );
    const region = screen.getByRole("region", { name: "通知" });
    expect(region.querySelector("[aria-live='polite']")).not.toBeNull();
    fireEvent.click(screen.getByTestId("show"));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.textContent).toContain("已保存");
    expect(toasts()[0]?.getAttribute("data-tone")).toBe("success");
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS - 1));
    expect(toasts()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(toasts()).toHaveLength(0);
  });

  it("keeps a persistent toast until it is closed", () => {
    render(
      <ToastProvider>
        <Trigger options={{ tone: "info", message: "已导出", persistent: true }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId("show"));
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS * 5));
    expect(toasts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    expect(toasts()).toHaveLength(0);
  });

  it("pauses while hovered or focused and resumes with the time that was left", () => {
    render(
      <ToastProvider>
        <Trigger options={{ tone: "success", message: "已移到回收站" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId("show"));
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS / 2));
    fireEvent.mouseEnter(screen.getByTestId("toast"));
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS * 3));
    expect(toasts()).toHaveLength(1);
    fireEvent.mouseLeave(screen.getByTestId("toast"));
    fireEvent.focus(screen.getByTestId("toast-dismiss"));
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS * 3));
    expect(toasts()).toHaveLength(1);
    fireEvent.blur(screen.getByTestId("toast-dismiss"));
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS / 2 - 1));
    expect(toasts()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(toasts()).toHaveLength(0);
  });

  it("keeps at most three, dropping the oldest", () => {
    function Many() {
      const toast = useToast();
      return (
        <button type="button" data-testid="many" onClick={() => ["一", "二", "三", "四"].forEach((message) => toast.show({ tone: "info", message }))}>
          many
        </button>
      );
    }
    render(
      <ToastProvider>
        <Many />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId("many"));
    expect(toasts().map((toast) => toast.textContent?.replace(/\s/g, ""))).toEqual(["二", "三", "四"]);
  });

  it("never drops the newest; among the older ones the oldest transient goes first, persistent ones last", () => {
    function Mixed(props: { testId: string; items: Array<[string, boolean]> }) {
      const toast = useToast();
      return (
        <button type="button" data-testid={props.testId} onClick={() => props.items.forEach(([message, persistent]) => toast.show({ tone: "info", message, persistent }))}>
          mixed
        </button>
      );
    }
    render(
      <ToastProvider>
        <Mixed
          testId="mixed"
          items={[
            ["常驻一", true],
            ["短暂一", false],
            ["短暂二", false],
            ["短暂三", false],
            ["短暂四", false],
          ]}
        />
        <Mixed
          testId="all-persistent"
          items={[
            ["常驻二", true],
            ["常驻三", true],
            ["常驻四", true],
          ]}
        />
        <Mixed testId="one-transient" items={[["短暂五", false]]} />
      </ToastProvider>,
    );
    const texts = (): Array<string | undefined> => toasts().map((toast) => toast.textContent?.replace(/\s/g, ""));
    fireEvent.click(screen.getByTestId("mixed"));
    expect(texts()).toEqual(["常驻一", "短暂三", "短暂四"]);
    // The persistent one outlives the transient ones' delay as well.
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_MS));
    expect(texts()).toEqual(["常驻一"]);
    // Only persistent toasts left beyond the limit: the oldest of them goes.
    fireEvent.click(screen.getByTestId("all-persistent"));
    expect(texts()).toEqual(["常驻二", "常驻三", "常驻四"]);
    // A transient one arriving among persistent ones stays visible: the oldest persistent goes.
    fireEvent.click(screen.getByTestId("one-transient"));
    expect(texts()).toEqual(["常驻三", "常驻四", "短暂五"]);
  });

  it("runs the action and closes the toast", () => {
    const onClick = vi.fn();
    render(
      <ToastProvider>
        <Trigger options={{ tone: "success", message: "已删除", action: { label: "撤销", onClick } }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId("show"));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(0);
  });

  it("is a no-op without a provider", () => {
    render(<Trigger options={{ tone: "success", message: "已保存" }} />);
    expect(() => fireEvent.click(screen.getByTestId("show"))).not.toThrow();
    expect(toasts()).toHaveLength(0);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("lifts above a bar the page pins to the bottom while it is shown", () => {
    function Bar(props: { height: number | undefined }) {
      useToastOffset(props.height);
      return null;
    }
    const { rerender } = render(
      <ToastProvider>
        <Bar height={56} />
      </ToastProvider>,
    );
    const region = screen.getByTestId("toast-region");
    expect(region.style.bottom).toContain("56px");
    rerender(
      <ToastProvider>
        <Bar height={undefined} />
      </ToastProvider>,
    );
    expect(region.style.bottom).not.toContain("56px");
  });
});
