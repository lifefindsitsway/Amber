import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FEEDBACK_MS } from "../../../src/shared/defaults.ts";
import { CopyLabel, useCopyFeedback } from "../../../src/web/ui/copy-feedback.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useCopyFeedback", () => {
  it("shows as copied for COPY_FEEDBACK_MS after a copy, then reverts by itself", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { result } = renderHook(() => useCopyFeedback());
    expect(result.current.copied).toBe(false);
    await act(async () => void (await result.current.copy("a")));
    expect(result.current.copied).toBe(true);
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1));
    expect(result.current.copied).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.copied).toBe(false);
  });

  it("starts the wait over when copying again while it shows", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => void (await result.current.copy("a")));
    expect(result.current.copied).toBe(true);
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1));
    await act(async () => void (await result.current.copy("b")));
    expect(writeText).toHaveBeenLastCalledWith("b");
    // The first wait would have ended here; the second copy restarted it.
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1));
    expect(result.current.copied).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.copied).toBe(false);
  });

  it("does not show as copied when nothing was copied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    document.execCommand = vi.fn(() => false);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => useCopyFeedback());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy("a");
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });

  it("cancels the wait on unmount", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { result, unmount } = renderHook(() => useCopyFeedback());
    await act(async () => void (await result.current.copy("a")));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CopyLabel", () => {
  it("keeps both texts laid out but names the button only by the one shown", () => {
    const { rerender } = render(
      <button type="button">
        <CopyLabel copied={false} label="复制" />
      </button>,
    );
    const button = screen.getByRole("button", { name: "复制" });
    expect(button.textContent).toBe("复制已复制");
    rerender(
      <button type="button">
        <CopyLabel copied label="复制" />
      </button>,
    );
    expect(screen.getByRole("button", { name: "已复制" })).toBe(button);
    expect(button.textContent).toBe("复制已复制");
    expect(button.querySelector("svg.text-ok")).not.toBeNull();
  });
});
