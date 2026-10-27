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
});
