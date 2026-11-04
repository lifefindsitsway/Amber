import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYBACK_RESUME_END_MARGIN_MS, PLAYBACK_RESUME_MIN_MS, PLAYBACK_RESUME_SAVE_MS } from "../../../src/shared/defaults.ts";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { readPlaybackPosition, writePlaybackPosition } from "../../../src/web/player/playback-positions.ts";
import { PlayerController } from "../../../src/web/player/player-controller.tsx";
import { rememberedPosition, usePlaybackResume } from "../../../src/web/player/use-playback-resume.ts";

const DURATION_MS = 3_600_000;
const MIDDLE_MS = PLAYBACK_RESUME_MIN_MS + 120_000;
const END_MS = DURATION_MS - PLAYBACK_RESUME_END_MARGIN_MS;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A page with a local player attached and the recorder watching, for the user `u1`. */
function setup(options: { userId?: string | undefined; durationMs?: number | undefined } = {}) {
  const controller = new PlayerController();
  const detach = controller.attach({ capabilities: CAPABILITIES.local, seek: vi.fn() });
  const hook = renderHook(() =>
    usePlaybackResume(controller, {
      userId: "userId" in options ? options.userId : "u1",
      contentId: "c1",
      durationMs: "durationMs" in options ? options.durationMs : DURATION_MS,
    }),
  );
  const time = (ms: number): void => act(() => controller.reportTime(ms));
  const stored = () => readPlaybackPosition("u1", "c1");
  return { controller, detach, hook, time, stored };
}

describe("usePlaybackResume writing", () => {
  it("writes nothing before the first PLAYBACK_RESUME_MIN_MS", () => {
    const { time, stored, controller } = setup();
    time(PLAYBACK_RESUME_MIN_MS - 1);
    act(() => controller.reportPlayback("pause"));
    expect(stored()).toBeUndefined();
  });

  it("writes the first middle position at once, then at most once per PLAYBACK_RESUME_SAVE_MS", () => {
    const { time, stored } = setup();
    time(MIDDLE_MS);
    expect(stored()).toEqual({ positionMs: MIDDLE_MS, durationMs: DURATION_MS, updatedAt: 1_000_000 });
    vi.setSystemTime(1_000_000 + PLAYBACK_RESUME_SAVE_MS - 1);
    time(MIDDLE_MS + 1_000);
    expect(stored()?.positionMs).toBe(MIDDLE_MS);
    vi.setSystemTime(1_000_000 + PLAYBACK_RESUME_SAVE_MS);
    time(MIDDLE_MS + 2_000);
    expect(stored()).toEqual({ positionMs: MIDDLE_MS + 2_000, durationMs: DURATION_MS, updatedAt: 1_000_000 + PLAYBACK_RESUME_SAVE_MS });
  });

  it("writes the latest position on pause, on the page being hidden or left, and on unmount", () => {
    const { time, stored, controller, hook } = setup();
    time(MIDDLE_MS);
    time(MIDDLE_MS + 1_000);
    expect(stored()?.positionMs).toBe(MIDDLE_MS);
    act(() => controller.reportPlayback("pause"));
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 1_000);

    time(MIDDLE_MS + 2_000);
    // Visible: nothing to save; hidden: save.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 1_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 2_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    time(MIDDLE_MS + 3_000);
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 3_000);

    time(MIDDLE_MS + 4_000);
    hook.unmount();
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 4_000);
  });

  it("writes when the player goes away, and does not describe the next player with its time", () => {
    const { time, stored, detach } = setup();
    time(MIDDLE_MS);
    time(MIDDLE_MS + 1_000);
    detach();
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 1_000);
    // Nothing reported by the next player yet: leaving the page keeps what is stored.
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 1_000);
  });

  it("writes nothing without a user", () => {
    const { time, controller } = setup({ userId: undefined });
    time(MIDDLE_MS);
    act(() => controller.reportPlayback("pause"));
    expect(localStorage.length).toBe(0);
  });

  it("goes on playing when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { time, controller, hook } = setup();
    expect(() => {
      time(MIDDLE_MS);
      act(() => controller.reportPlayback("pause"));
      hook.unmount();
    }).not.toThrow();
  });
});

describe("usePlaybackResume finishing", () => {
  it("deletes the record when the end region is entered and writes nothing more, until the middle is played again", () => {
    const { time, stored, controller } = setup();
    time(MIDDLE_MS);
    expect(stored()).toBeDefined();
    time(END_MS);
    expect(stored()).toBeUndefined();
    // Late callbacks while finished.
    act(() => controller.reportPlayback("pause"));
    window.dispatchEvent(new Event("pagehide"));
    time(END_MS + 5_000);
    expect(stored()).toBeUndefined();
    // The user seeks back and plays on: the middle is observed again.
    vi.setSystemTime(2_000_000);
    time(MIDDLE_MS + 60_000);
    expect(stored()?.positionMs).toBe(MIDDLE_MS + 60_000);
  });

  it("takes the end region from the length a player reports over the Content's own", () => {
    const { time, stored, controller } = setup({ durationMs: 10 * DURATION_MS });
    act(() => controller.reportDuration(DURATION_MS));
    time(MIDDLE_MS);
    expect(stored()).toBeDefined();
    time(END_MS);
    expect(stored()).toBeUndefined();
  });

  it("deletes on ended and ignores the resting time that is reported afterwards, even when the length is unknown", () => {
    const { time, stored, controller } = setup({ durationMs: undefined });
    time(MIDDLE_MS);
    expect(stored()).toBeDefined();
    act(() => controller.reportPlayback("ended"));
    expect(stored()).toBeUndefined();
    time(MIDDLE_MS + 500);
    act(() => controller.reportPlayback("pause"));
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()).toBeUndefined();
    // Replaying from the start and reaching the middle again records again.
    vi.setSystemTime(2_000_000);
    time(1_000);
    time(PLAYBACK_RESUME_MIN_MS + 10_000);
    expect(stored()?.positionMs).toBe(PLAYBACK_RESUME_MIN_MS + 10_000);
  });

  it("deletes on 「从头播放」 and ignores time reports still showing the old position", () => {
    const { time, stored, controller, hook } = setup();
    time(MIDDLE_MS);
    expect(stored()).toBeDefined();
    act(() => controller.restart());
    expect(stored()).toBeUndefined();
    // A report that was already on its way, then page events.
    time(MIDDLE_MS + 300);
    act(() => controller.reportPlayback("pause"));
    window.dispatchEvent(new Event("pagehide"));
    hook.unmount();
    expect(stored()).toBeUndefined();
  });

  it("records again once playback after a restart reaches the middle", () => {
    const { time, stored, controller } = setup();
    time(MIDDLE_MS);
    act(() => controller.restart());
    time(0);
    time(10_000);
    expect(stored()).toBeUndefined();
    vi.setSystemTime(2_000_000);
    time(PLAYBACK_RESUME_MIN_MS + 1);
    expect(stored()?.positionMs).toBe(PLAYBACK_RESUME_MIN_MS + 1);
  });

  it("does not treat the end region of a short Content as something to resume", () => {
    const { time, stored } = setup({ durationMs: PLAYBACK_RESUME_MIN_MS + PLAYBACK_RESUME_END_MARGIN_MS - 10_000 });
    time(PLAYBACK_RESUME_MIN_MS + 1_000);
    expect(stored()).toBeUndefined();
  });
});

describe("usePlaybackResume with an online player", () => {
  /** A page with a YouTube player attached, which does not remember positions. */
  function setupYoutube() {
    const controller = new PlayerController();
    const detach = controller.attach({ capabilities: CAPABILITIES.youtube, seek: vi.fn() });
    const hook = renderHook(() => usePlaybackResume(controller, { userId: "u1", contentId: "c1", durationMs: DURATION_MS }));
    const time = (ms: number): void => act(() => controller.reportTime(ms));
    return { controller, detach, hook, time };
  }

  it("does not write the time of a YouTube player", () => {
    const { time, controller, detach, hook } = setupYoutube();
    time(MIDDLE_MS);
    time(MIDDLE_MS + 1_000);
    act(() => controller.reportPlayback("pause"));
    window.dispatchEvent(new Event("pagehide"));
    detach();
    hook.unmount();
    expect(localStorage.length).toBe(0);
  });

  it("leaves a record written by the local player alone when YouTube plays through to the end", () => {
    writePlaybackPosition("u1", "c1", { positionMs: MIDDLE_MS, durationMs: DURATION_MS, updatedAt: 1 });
    const { time, controller, detach, hook } = setupYoutube();
    time(MIDDLE_MS + 1_000);
    time(END_MS);
    act(() => controller.reportPlayback("ended"));
    act(() => controller.restart());
    detach();
    hook.unmount();
    expect(readPlaybackPosition("u1", "c1")).toEqual({ positionMs: MIDDLE_MS, durationMs: DURATION_MS, updatedAt: 1 });
  });
});

describe("rememberedPosition", () => {
  it("offers a record in the middle and nothing for a missing, early or finished one", () => {
    expect(rememberedPosition("u1", "c1", DURATION_MS)).toBeUndefined();
    writePlaybackPosition("u1", "c1", { positionMs: MIDDLE_MS, durationMs: DURATION_MS, updatedAt: 1 });
    expect(rememberedPosition("u1", "c1", DURATION_MS)).toBe(MIDDLE_MS);
    writePlaybackPosition("u1", "c1", { positionMs: PLAYBACK_RESUME_MIN_MS - 1, updatedAt: 1 });
    expect(rememberedPosition("u1", "c1", DURATION_MS)).toBeUndefined();
    writePlaybackPosition("u1", "c1", { positionMs: END_MS, durationMs: DURATION_MS, updatedAt: 1 });
    expect(rememberedPosition("u1", "c1", DURATION_MS)).toBeUndefined();
    // Judged against the Content's length when the record has none.
    writePlaybackPosition("u1", "c1", { positionMs: END_MS, updatedAt: 1 });
    expect(rememberedPosition("u1", "c1", DURATION_MS)).toBeUndefined();
    expect(rememberedPosition("u1", "c1", undefined)).toBe(END_MS);
  });
});
