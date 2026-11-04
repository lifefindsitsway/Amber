import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { PlayerController } from "../../../src/web/player/player-controller.tsx";

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
