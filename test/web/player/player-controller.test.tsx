import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider, usePlayRange } from "../../../src/web/player/player-controller.tsx";

describe("PlayerController", () => {
  it("applies a seek requested before any player attached", () => {
    const controller = new PlayerController();
    controller.seek(5_000);
    const seek = vi.fn();
    controller.attach({ capabilities: CAPABILITIES.youtube, seek });
    expect(seek).toHaveBeenCalledWith(5_000);
  });

  it("exposes time only for players that track it", () => {
    const controller = new PlayerController();
    const detach = controller.attach({ capabilities: CAPABILITIES.bilibili, seek: vi.fn() });
    controller.reportTime(1_000);
    expect(controller.currentTimeMs()).toBeUndefined();
    detach();
    controller.attach({ capabilities: CAPABILITIES.local, seek: vi.fn() });
    controller.reportTime(1_000);
    expect(controller.currentTimeMs()).toBe(1_000);
  });

  it("falls back to no capabilities after detaching", () => {
    const controller = new PlayerController();
    const detach = controller.attach({ capabilities: CAPABILITIES.youtube, seek: vi.fn() });
    detach();
    expect(controller.capabilities).toEqual(CAPABILITIES.none);
  });

  it("is a no-op for a seek no player can perform, and does not keep it for the next one", () => {
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.none, seek: vi.fn() });
    controller.seek(1_000);
    const seek = vi.fn();
    controller.attach({ capabilities: CAPABILITIES.local, seek });
    expect(seek).not.toHaveBeenCalled();
  });
});

describe("PlayerController seek priority", () => {
  const local = () => ({ capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn() });

  it("never lets a lower request replace a higher pending one", () => {
    const controller = new PlayerController();
    controller.request(120_000, "user");
    controller.request(60_000, "carry");
    controller.request(30_000, "resume");
    const driver = local();
    controller.attach(driver);
    expect(driver.seek.mock.calls).toEqual([[120_000]]);

    const second = new PlayerController();
    second.request(30_000, "resume");
    second.request(60_000, "carry");
    second.request(45_000, "resume");
    const other = local();
    second.attach(other);
    expect(other.seek.mock.calls).toEqual([[60_000]]);
    // The same rank replaces: the later pick is the one that counts.
    const third = new PlayerController();
    third.request(1_000, "user");
    third.request(2_000, "user");
    const last = local();
    third.attach(last);
    expect(last.seek.mock.calls).toEqual([[2_000]]);
  });

  it("voids the remembered position once the user (or a deep link) chose where to be", () => {
    const seeked = new PlayerController();
    seeked.offerResume(300_000);
    seeked.seek(5_000);
    seeked.offerResume(300_000);
    const driver = local();
    seeked.attach(driver);
    expect(driver.seek.mock.calls).toEqual([[5_000]]);

    const deepLinked = new PlayerController();
    deepLinked.suppressResume();
    deepLinked.offerResume(300_000);
    const untouched = local();
    deepLinked.attach(untouched);
    expect(untouched.seek).not.toHaveBeenCalled();
    expect(deepLinked.resumeNotice).toBeUndefined();

    const late = new PlayerController();
    late.offerResume(300_000);
    late.suppressResume();
    const other = local();
    late.attach(other);
    expect(other.seek).not.toHaveBeenCalled();
  });

  it("places the first player that can read time at the remembered position, once, and says so", () => {
    const controller = new PlayerController();
    controller.offerResume(754_000);
    const first = local();
    const detach = controller.attach(first);
    expect(first.seek.mock.calls).toEqual([[754_000]]);
    expect(controller.resumeNotice).toBe(754_000);
    detach();
    const second = local();
    controller.attach(second);
    expect(second.seek).not.toHaveBeenCalled();
    controller.dismissResumeNotice();
    expect(controller.resumeNotice).toBeUndefined();
  });

  it("does not apply a remembered position that a carried one outranks", () => {
    const controller = new PlayerController();
    controller.offerResume(300_000);
    controller.request(90_000, "carry");
    const driver = local();
    controller.attach(driver);
    expect(driver.seek.mock.calls).toEqual([[90_000]]);
    expect(controller.resumeNotice).toBeUndefined();
  });

  it("carries the time of a player that went away to the next one that can read time", () => {
    const controller = new PlayerController();
    const first = local();
    const detach = controller.attach(first);
    controller.reportTime(70_000);
    detach();
    const youtube = { capabilities: CAPABILITIES.youtube, seek: vi.fn() };
    const detachYoutube = controller.attach(youtube);
    expect(youtube.seek.mock.calls).toEqual([[70_000]]);
    controller.reportTime(80_000);
    detachYoutube();
    const back = local();
    controller.attach(back);
    expect(back.seek.mock.calls).toEqual([[80_000]]);
  });

  it("never carries a position into the Bilibili embed (it would reload with autoplay) and drops it there", () => {
    const controller = new PlayerController();
    const detach = controller.attach(local());
    controller.reportTime(70_000);
    detach();
    const bilibili = { capabilities: CAPABILITIES.bilibili, seek: vi.fn() };
    const detachBilibili = controller.attach(bilibili);
    expect(bilibili.seek).not.toHaveBeenCalled();
    detachBilibili();
    const youtube = { capabilities: CAPABILITIES.youtube, seek: vi.fn() };
    controller.attach(youtube);
    expect(youtube.seek).not.toHaveBeenCalled();
  });

  it("does not hand the remembered position to a YouTube or Bilibili driver, only to the local one", () => {
    const controller = new PlayerController();
    controller.offerResume(300_000);
    const youtube = { capabilities: CAPABILITIES.youtube, seek: vi.fn() };
    const detachYoutube = controller.attach(youtube);
    expect(youtube.seek).not.toHaveBeenCalled();
    expect(controller.resumeNotice).toBeUndefined();
    detachYoutube();
    const bilibili = { capabilities: CAPABILITIES.bilibili, seek: vi.fn() };
    const detachBilibili = controller.attach(bilibili);
    expect(bilibili.seek).not.toHaveBeenCalled();
    detachBilibili();
    const driver = local();
    controller.attach(driver);
    expect(driver.seek.mock.calls).toEqual([[300_000]]);
    expect(controller.resumeNotice).toBe(300_000);
  });

  it("keeps the remembered position waiting while an online driver mounts and unmounts", () => {
    const controller = new PlayerController();
    const youtube = { capabilities: CAPABILITIES.youtube, seek: vi.fn() };
    const detachYoutube = controller.attach(youtube);
    controller.offerResume(300_000);
    expect(youtube.seek).not.toHaveBeenCalled();
    detachYoutube();
    const driver = local();
    controller.attach(driver);
    expect(driver.seek.mock.calls).toEqual([[300_000]]);
  });

  it("restarts from 0 and playing, telling listeners first", () => {
    const controller = new PlayerController();
    const events: string[] = [];
    controller.onPlayback((event) => events.push(event));
    controller.offerResume(300_000);
    const driver = local();
    controller.attach(driver);
    controller.restart();
    expect(events).toEqual(["restart"]);
    expect(driver.seek.mock.calls).toEqual([[300_000], [0]]);
    expect(driver.play).toHaveBeenCalledOnce();
    expect(controller.resumeNotice).toBeUndefined();
  });

  it("tells listeners about playback state and the player going away", () => {
    const controller = new PlayerController();
    const events: string[] = [];
    controller.onPlayback((event) => events.push(event));
    const detach = controller.attach(local());
    controller.reportPlayback("play");
    controller.reportPlayback("pause");
    controller.reportPlayback("ended");
    detach();
    expect(events).toEqual(["play", "pause", "ended", "detach"]);
    controller.reportDuration(600_000);
    expect(controller.durationMs()).toBe(600_000);
  });
});

describe("PlayerController.playRange", () => {
  const driverOf = (capabilities = CAPABILITIES.local) => ({ capabilities, seek: vi.fn(), play: vi.fn(), pause: vi.fn() });
  /** A controller on a fake clock with a local-like player attached, the range 10 s–14 s started and playing. */
  function playing() {
    let now = 0;
    const controller = new PlayerController({ now: () => now });
    const driver = driverOf();
    controller.attach(driver);
    controller.playRange(10_000, 14_000);
    controller.reportPlayback("play");
    const tick = (ms: number, timeMs: number): void => {
      now += ms;
      controller.reportTime(timeMs);
    };
    tick(0, 10_000);
    return { controller, driver, tick };
  }

  it("jumps to the start, plays, and pauses once playback reaches the end", () => {
    const { controller, driver, tick } = playing();
    expect(driver.seek.mock.calls).toEqual([[10_000]]);
    expect(driver.play).toHaveBeenCalledOnce();
    expect(controller.playingRange()).toMatchObject({ startMs: 10_000, endMs: 14_000 });
    tick(250, 10_250);
    tick(3_000, 13_250);
    expect(driver.pause).not.toHaveBeenCalled();
    tick(800, 14_050);
    expect(driver.pause).toHaveBeenCalledOnce();
    expect(controller.playingRange()).toBeUndefined();
    // The pause that follows is ours; playback is the user's again and nothing pauses later.
    controller.reportPlayback("pause");
    controller.reportPlayback("play");
    tick(5_000, 19_050);
    expect(driver.pause).toHaveBeenCalledOnce();
  });

  it("ignores times from before the jump landed", () => {
    let now = 0;
    const controller = new PlayerController({ now: () => now });
    const driver = driverOf();
    controller.attach(driver);
    controller.reportTime(300_000);
    controller.playRange(10_000, 14_000);
    // The old position, still reported once after the jump was asked for.
    now += 250;
    controller.reportTime(300_250);
    expect(driver.pause).not.toHaveBeenCalled();
    expect(controller.playingRange()).toBeDefined();
    now += 250;
    controller.reportTime(10_000);
    now += 4_000;
    controller.reportTime(14_000);
    expect(driver.pause).toHaveBeenCalledOnce();
  });

  it("replays the sentence already playing: a report of the old time inside the range is not the landing", () => {
    let now = 0;
    const controller = new PlayerController({ now: () => now });
    const driver = driverOf(CAPABILITIES.youtube);
    controller.attach(driver);
    controller.reportPlayback("play");
    controller.reportTime(1_000);
    now += 250;
    controller.reportTime(3_000);
    now += 250;
    controller.playRange(1_000, 5_000);
    // A poll taken before the seek is reflected, then the jump's own time.
    controller.reportTime(3_200);
    now += 250;
    controller.reportTime(1_000);
    expect(controller.playingRange()).toMatchObject({ startMs: 1_000, endMs: 5_000 });
    for (let ms = 1_250; ms <= 5_250; ms += 250) {
      now += 250;
      controller.reportTime(ms);
    }
    expect(driver.pause).toHaveBeenCalledOnce();
    expect(controller.playingRange()).toBeUndefined();
  });

  it("lands on a first report that playback carried past the start, as far as the fastest rate allows", () => {
    let now = 0;
    const controller = new PlayerController({ now: () => now });
    const driver = driverOf(CAPABILITIES.youtube);
    controller.attach(driver);
    controller.reportPlayback("play");
    controller.playRange(10_000, 14_000);
    // A polling player at double speed: its first report comes a poll after the seek landed.
    now += 400;
    controller.reportTime(10_700);
    now += 250;
    controller.reportTime(11_200);
    now += 1_500;
    controller.reportTime(14_200);
    expect(driver.pause).toHaveBeenCalledOnce();
  });

  it.each([
    ["a seek from the page (another sentence, a citation)", (controller: PlayerController) => controller.seek(50_000)],
    ["a pause by the user", (controller: PlayerController) => controller.reportPlayback("pause")],
    ["another range", (controller: PlayerController) => controller.playRange(30_000, 32_000)],
    ["the restart button", (controller: PlayerController) => controller.restart()],
    ["the caller going away", (controller: PlayerController) => controller.cancelRange()],
    ["the end of the media", (controller: PlayerController) => controller.reportPlayback("ended")],
  ])("drops the pending pause on %s", (_name, act) => {
    const { controller, driver, tick } = playing();
    act(controller);
    const next = controller.playingRange();
    tick(250, 13_000);
    tick(1_500, 14_500);
    if (next === undefined) {
      expect(driver.pause).not.toHaveBeenCalled();
    } else {
      // A new range only pauses at its own end.
      expect(next).toMatchObject({ startMs: 30_000 });
      expect(driver.pause).not.toHaveBeenCalled();
    }
  });

  it("drops the pending pause when the player goes away or another one attaches", () => {
    const first = playing();
    first.controller.attach(driverOf());
    expect(first.controller.playingRange()).toBeUndefined();

    let now = 0;
    const controller = new PlayerController({ now: () => now });
    const driver = driverOf();
    const detach = controller.attach(driver);
    controller.playRange(10_000, 14_000);
    detach();
    expect(controller.playingRange()).toBeUndefined();
    const next = driverOf();
    controller.attach(next);
    now += 5_000;
    controller.reportTime(14_500);
    expect(next.pause).not.toHaveBeenCalled();
  });

  it("drops the pending pause on a seek made inside the player: backwards, or further ahead than playback goes", () => {
    const back = playing();
    back.tick(250, 11_000);
    back.tick(250, 10_100);
    back.tick(4_000, 14_100);
    expect(back.driver.pause).not.toHaveBeenCalled();

    const ahead = playing();
    ahead.tick(250, 10_250);
    // 250 ms of wall clock cannot carry playback 3 s ahead, not even at the fastest rate.
    ahead.tick(250, 13_250);
    ahead.tick(1_000, 14_250);
    expect(ahead.driver.pause).not.toHaveBeenCalled();

    // A slow tick (a throttled background poll) at double speed is still playback.
    const fast = playing();
    fast.tick(1_000, 12_000);
    fast.tick(1_000, 14_000);
    expect(fast.driver.pause).toHaveBeenCalledOnce();
  });

  it("does not treat a pause before playback began as the user's", () => {
    let now = 0;
    const controller = new PlayerController({ now: () => now });
    const driver = driverOf(CAPABILITIES.youtube);
    controller.attach(driver);
    controller.reportPlayback("pause");
    controller.playRange(10_000, 14_000);
    // An embed settling after the jump while still paused.
    controller.reportPlayback("pause");
    controller.reportPlayback("play");
    now += 250;
    controller.reportTime(10_000);
    now += 4_000;
    controller.reportTime(14_000);
    expect(driver.pause).toHaveBeenCalledOnce();
  });

  it("treats a pause as the user's when the player was already playing", () => {
    const controller = new PlayerController();
    const driver = driverOf();
    controller.attach(driver);
    controller.reportPlayback("play");
    controller.playRange(10_000, 14_000);
    controller.reportPlayback("pause");
    expect(controller.playingRange()).toBeUndefined();
  });

  it("leaves following the time alone: reading it never cancels or seeks", () => {
    const { controller, driver, tick } = playing();
    tick(250, 10_250);
    expect(controller.currentTimeMs()).toBe(10_250);
    expect(controller.playingRange()).toBeDefined();
    expect(driver.seek).toHaveBeenCalledOnce();
  });

  it("only jumps with a player that cannot pause or tell its time", () => {
    const controller = new PlayerController();
    const bilibili = { capabilities: CAPABILITIES.bilibili, seek: vi.fn() };
    controller.attach(bilibili);
    expect(controller.rangePlayback).toBe("jump");
    controller.playRange(10_000, 14_000);
    expect(bilibili.seek.mock.calls).toEqual([[10_000]]);
    expect(controller.playingRange()).toBeUndefined();

    // A player declaring range playback but offering no pause only jumps too.
    const other = new PlayerController();
    other.attach({ capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn() });
    expect(other.rangePlayback).toBe("jump");
    other.playRange(1_000, 2_000);
    expect(other.playingRange()).toBeUndefined();

    expect(new PlayerController().rangePlayback).toBe("unsupported");
    const local = new PlayerController();
    local.attach(driverOf());
    expect(local.rangePlayback).toBe("play");
  });

  it("keeps the jump for a player that attaches later, without a pause to make", () => {
    const controller = new PlayerController();
    controller.playRange(10_000, 14_000);
    expect(controller.playingRange()).toBeUndefined();
    const driver = driverOf();
    controller.attach(driver);
    expect(driver.seek.mock.calls).toEqual([[10_000]]);
  });
});

describe("usePlayRange", () => {
  function Caller() {
    const { mode, playing, playRange } = usePlayRange();
    return (
      <div>
        <span data-testid="mode">{mode}</span>
        <span data-testid="playing">{playing === undefined ? "" : `${playing.startMs}-${playing.endMs}`}</span>
        <button onClick={() => playRange(10_000, 14_000)}>start</button>
      </div>
    );
  }
  function Host(props: { controller: PlayerController }) {
    const [shown, setShown] = useState(true);
    return (
      <PlayerControllerProvider controller={props.controller}>
        {shown ? <Caller /> : null}
        <button onClick={() => setShown(false)}>hide</button>
      </PlayerControllerProvider>
    );
  }

  it("names the mode, shows the range playing and cancels its own range on unmount", () => {
    const controller = new PlayerController();
    const driver = { capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
    act(() => {
      controller.attach(driver);
    });
    render(<Host controller={controller} />);
    expect(screen.getByTestId("mode").textContent).toBe("play");
    fireEvent.click(screen.getByText("start"));
    expect(screen.getByTestId("playing").textContent).toBe("10000-14000");
    fireEvent.click(screen.getByText("hide"));
    expect(controller.playingRange()).toBeUndefined();
  });

  it("leaves a range it did not start alone on unmount", () => {
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() });
    render(<Host controller={controller} />);
    fireEvent.click(screen.getByText("start"));
    act(() => {
      controller.playRange(20_000, 22_000);
    });
    fireEvent.click(screen.getByText("hide"));
    expect(controller.playingRange()).toMatchObject({ startMs: 20_000 });
  });

  it("drops the pending pause when the page switches to another content and its controller", () => {
    let now = 0;
    const driverOf = () => ({ capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() });
    const first = new PlayerController({ now: () => now });
    const firstDriver = driverOf();
    const second = new PlayerController({ now: () => now });
    const secondDriver = driverOf();
    act(() => {
      first.attach(firstDriver);
      second.attach(secondDriver);
    });
    const { rerender } = render(
      <PlayerControllerProvider controller={first}>
        <Caller />
      </PlayerControllerProvider>,
    );
    fireEvent.click(screen.getByText("start"));
    act(() => {
      first.reportPlayback("play");
      first.reportTime(10_000);
    });
    expect(first.playingRange()).toMatchObject({ startMs: 10_000, endMs: 14_000 });
    // Another content: the page provides that content's controller to the same view.
    rerender(
      <PlayerControllerProvider controller={second}>
        <Caller />
      </PlayerControllerProvider>,
    );
    expect(first.playingRange()).toBeUndefined();
    // Even with the old player still reporting, reaching the old range's end pauses nothing.
    act(() => {
      now += 250;
      first.reportTime(10_250);
      now += 4_000;
      first.reportTime(14_250);
    });
    expect(firstDriver.pause).not.toHaveBeenCalled();
    // The new content's player is left as it was: no range, no jump, no pause.
    expect(second.playingRange()).toBeUndefined();
    expect(screen.getByTestId("playing").textContent).toBe("");
    act(() => {
      second.reportTime(14_250);
    });
    expect(secondDriver.seek).not.toHaveBeenCalled();
    expect(secondDriver.pause).not.toHaveBeenCalled();
  });

  it("reads 「跳到」 mode for Bilibili and nothing without a provider", () => {
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.bilibili, seek: vi.fn() });
    const { unmount } = render(<Host controller={controller} />);
    expect(screen.getByTestId("mode").textContent).toBe("jump");
    unmount();
    render(<Caller />);
    expect(screen.getByTestId("mode").textContent).toBe("unsupported");
    fireEvent.click(screen.getByText("start"));
  });
});
