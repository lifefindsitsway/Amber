import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYBACK_RESUME_NOTICE_MS } from "../../../src/shared/defaults.ts";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { ResumeNotice } from "../../../src/web/player/resume-notice.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A controller whose local player was just placed at 12:34 by the remembered position. */
function resumed() {
  const controller = new PlayerController();
  const driver = { capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn() };
  controller.offerResume(754_000);
  controller.attach(driver);
  render(
    <PlayerControllerProvider controller={controller}>
      <ResumeNotice />
    </PlayerControllerProvider>,
  );
  return { controller, driver };
}

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("ResumeNotice", () => {
  it("renders nothing until a remembered position was applied", () => {
    const controller = new PlayerController();
    render(
      <PlayerControllerProvider controller={controller}>
        <ResumeNotice />
      </PlayerControllerProvider>,
    );
    expect(screen.queryByTestId("resume-notice")).toBeNull();
  });

  it("names the position and offers 「从头播放」", () => {
    resumed();
    const notice = screen.getByTestId("resume-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("已从 12:34 继续播放·从头播放");
    expect(screen.getByRole("button", { name: "从头播放" })).toBeTruthy();
  });

  it("fades after PLAYBACK_RESUME_NOTICE_MS and then leaves", () => {
    const { controller } = resumed();
    const notice = screen.getByTestId("resume-notice");
    advance(PLAYBACK_RESUME_NOTICE_MS - 1);
    expect(notice.className).toContain("opacity-100");
    advance(1);
    expect(notice.className).toContain("opacity-0");
    expect(controller.resumeNotice).toBe(754_000);
    advance(400);
    expect(screen.queryByTestId("resume-notice")).toBeNull();
    expect(controller.resumeNotice).toBeUndefined();
  });

  it("holds the timer while hovered and starts over when the pointer leaves", () => {
    resumed();
    const notice = screen.getByTestId("resume-notice");
    advance(PLAYBACK_RESUME_NOTICE_MS - 100);
    fireEvent.mouseEnter(notice);
    advance(PLAYBACK_RESUME_NOTICE_MS * 3);
    expect(screen.getByTestId("resume-notice").className).toContain("opacity-100");
    fireEvent.mouseLeave(notice);
    advance(PLAYBACK_RESUME_NOTICE_MS - 1);
    expect(screen.getByTestId("resume-notice").className).toContain("opacity-100");
    advance(1);
    expect(screen.getByTestId("resume-notice").className).toContain("opacity-0");
  });

  it("holds the timer while focus is inside, and lets go when focus leaves", () => {
    resumed();
    const restart = screen.getByRole("button", { name: "从头播放" });
    act(() => restart.focus());
    advance(PLAYBACK_RESUME_NOTICE_MS * 3);
    expect(screen.getByTestId("resume-notice").className).toContain("opacity-100");
    fireEvent.blur(restart, { relatedTarget: document.body });
    advance(PLAYBACK_RESUME_NOTICE_MS);
    expect(screen.getByTestId("resume-notice").className).toContain("opacity-0");
  });

  it("stays while the pointer is away but focus is still inside", () => {
    resumed();
    const notice = screen.getByTestId("resume-notice");
    act(() => screen.getByRole("button", { name: "从头播放" }).focus());
    fireEvent.mouseEnter(notice);
    fireEvent.mouseLeave(notice);
    advance(PLAYBACK_RESUME_NOTICE_MS * 2);
    expect(screen.getByTestId("resume-notice").className).toContain("opacity-100");
  });

  it("restarts from the beginning on 「从头播放」 and goes away", () => {
    const { controller, driver } = resumed();
    fireEvent.click(screen.getByRole("button", { name: "从头播放" }));
    expect(driver.seek).toHaveBeenLastCalledWith(0);
    expect(driver.play).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("resume-notice")).toBeNull();
    expect(controller.resumeNotice).toBeUndefined();
  });

  it("closes on Escape from the keyboard", () => {
    resumed();
    const restart = screen.getByRole("button", { name: "从头播放" });
    act(() => restart.focus());
    fireEvent.keyDown(restart, { key: "Escape" });
    expect(screen.queryByTestId("resume-notice")).toBeNull();
  });
});
