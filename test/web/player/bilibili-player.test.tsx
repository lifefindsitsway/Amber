import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BilibiliPlayer } from "../../../src/web/player/bilibili-player.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";

describe("BilibiliPlayer", () => {
  it("reloads the iframe with t= on seek and shows a loading state until it loads", () => {
    const controller = new PlayerController();
    render(
      <PlayerControllerProvider controller={controller}>
        <BilibiliPlayer source={{ kind: "bilibili", bvid: "BV1" }} />
      </PlayerControllerProvider>,
    );
    fireEvent.load(screen.getByTestId("player-bilibili"));
    expect(screen.queryByTestId("player-loading")).toBeNull();
    act(() => controller.seek(90_000));
    expect(new URL(screen.getByTestId("player-bilibili").getAttribute("src") ?? "").searchParams.get("t")).toBe("90");
    expect(screen.getByTestId("player-loading")).toBeTruthy();
    expect(controller.capabilities.timeTracking).toBe("unsupported");
  });

  it("reloads again when a seek lands on the same second, so the loading state clears", () => {
    const controller = new PlayerController();
    render(
      <PlayerControllerProvider controller={controller}>
        <BilibiliPlayer source={{ kind: "bilibili", bvid: "BV1" }} />
      </PlayerControllerProvider>,
    );
    fireEvent.load(screen.getByTestId("player-bilibili"));
    act(() => controller.seek(351_000));
    const first = screen.getByTestId("player-bilibili");
    fireEvent.load(first);
    expect(screen.queryByTestId("player-loading")).toBeNull();

    act(() => controller.seek(351_400));
    const second = screen.getByTestId("player-bilibili");
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe(first.getAttribute("src"));
    expect(screen.getByTestId("player-loading")).toBeTruthy();
    fireEvent.load(second);
    expect(screen.queryByTestId("player-loading")).toBeNull();
  });

  describe("remembered position", () => {
    const show = (controller: PlayerController) =>
      render(
        <PlayerControllerProvider controller={controller}>
          <BilibiliPlayer source={{ kind: "bilibili", bvid: "BV1" }} />
        </PlayerControllerProvider>,
      );
    const srcParams = (): URLSearchParams => new URL(screen.getByTestId("player-bilibili").getAttribute("src") ?? "").searchParams;

    it("neither positions nor starts the embed by itself, and offers nothing", () => {
      const controller = new PlayerController();
      controller.offerResume(754_000);
      show(controller);
      expect(srcParams().has("t")).toBe(false);
      expect(srcParams().get("autoplay")).toBe("0");
      expect(controller.resumeNotice).toBeUndefined();
      expect(screen.queryByTestId("bili-resume")).toBeNull();
      expect(screen.queryByRole("button", { name: "继续播放" })).toBeNull();
    });

    it("still reloads at a position the user jumps to", () => {
      const controller = new PlayerController();
      controller.offerResume(754_000);
      show(controller);
      act(() => controller.seek(30_000));
      expect(screen.queryByTestId("bili-resume")).toBeNull();
      expect(srcParams().get("t")).toBe("30");
    });
  });
});
