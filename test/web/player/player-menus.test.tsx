import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PLAYBACK_RATES, PLAYER_MENU_CONTENT_CLASS, PLAYER_MENU_ITEM_CLASS, PlaybackRateMenu, PlayerSettingsMenu, QualityMenu } from "../../../src/web/player/player-menus.tsx";
import type { LoopCollectionChoice } from "../../../src/web/player/list-loop.ts";
import type { EndBehavior, PlayerSettings } from "../../../src/web/player/player-settings.ts";

function open(trigger: HTMLElement): void {
  fireEvent.keyDown(trigger, { key: "Enter" });
}

/**
 * The control-bar menus: dark, as wide as their content, no check marks; the chosen item is
 * coloured by its checked state, which the radio / checkbox roles also expose.
 */
function expectPlayerMenu(menu: HTMLElement): void {
  expect(menu.className).toContain(PLAYER_MENU_CONTENT_CLASS);
  expect(menu.className).not.toContain("min-w-40");
  expect(menu.querySelector("svg")).toBeNull();
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.className).toContain(PLAYER_MENU_ITEM_CLASS);
    expect(item.className.split(" ")).toContain("data-[state=checked]:text-accent");
    expect(item.dataset.state === "checked").toBe(item.getAttribute("aria-checked") === "true");
  }
}

function RateHarness(props: { onRate: (rate: number) => void; onOpenChange: (open: boolean) => void }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [rate, setRate] = useState(1);
  return (
    <div ref={setRoot} data-testid="player-root">
      <PlaybackRateMenu
        rate={rate}
        container={root}
        onOpenChange={props.onOpenChange}
        onRate={(next) => {
          props.onRate(next);
          setRate(next);
        }}
      />
    </div>
  );
}

function SettingsHarness(props: { onOpenChange: (open: boolean) => void; spy: (change: Partial<PlayerSettings>) => void; collections?: string[]; onChoose?: (id: string) => void }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [endBehavior, setEndBehavior] = useState<EndBehavior>("pause");
  const [autoplay, setAutoplay] = useState(false);
  const [chosen, setChosen] = useState(props.collections?.[0] ?? "");
  const loopCollection: LoopCollectionChoice | undefined =
    props.collections === undefined
      ? undefined
      : {
          options: props.collections.map((id) => ({ id, name: `合集 ${id}` })),
          value: chosen,
          choose: (id) => {
            props.onChoose?.(id);
            setChosen(id);
          },
        };
  const settings: PlayerSettings = {
    endBehavior,
    autoplay,
    setEndBehavior: (value) => {
      props.spy({ endBehavior: value });
      setEndBehavior(value);
    },
    setAutoplay: (value) => {
      props.spy({ autoplay: value });
      setAutoplay(value);
    },
  };
  return (
    <div ref={setRoot} data-testid="player-root">
      <PlayerSettingsMenu settings={settings} container={root} onOpenChange={props.onOpenChange} loopCollection={loopCollection} />
    </div>
  );
}

describe("PlaybackRateMenu", () => {
  it("labels the normal speed by name and others by value, inside the player", () => {
    const onRate = vi.fn();
    const onOpenChange = vi.fn();
    render(<RateHarness onRate={onRate} onOpenChange={onOpenChange} />);
    const trigger = screen.getByTestId("player-rate");
    expect(trigger.textContent).toBe("倍速");
    open(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const menu = within(screen.getByTestId("player-root")).getByTestId("player-rate-menu");
    expectPlayerMenu(menu);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["2.0x", "1.5x", "1.25x", "1.0x", "0.75x", "0.5x"]);
    expect(PLAYBACK_RATES).toEqual([2, 1.5, 1.25, 1, 0.75, 0.5]);
    // Speeds are centred, as in the bilibili player.
    for (const item of within(menu).getAllByRole("menuitemradio")) expect(item.className.split(" ")).toContain("justify-center");
    expect(within(menu).getByRole("menuitemradio", { name: "1.0x" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "1.25x" }));
    expect(onRate).toHaveBeenCalledWith(1.25);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("player-rate").textContent).toBe("1.25x");
    // A whole rate keeps one decimal on the button too.
    open(screen.getByTestId("player-rate"));
    fireEvent.click(within(screen.getByTestId("player-rate-menu")).getByRole("menuitemradio", { name: "2.0x" }));
    expect(onRate).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId("player-rate").textContent).toBe("2.0x");
  });
});

describe("PlayerSettingsMenu", () => {
  it("offers the end behaviours and autoplay inside the player and changes the settings", () => {
    const onOpenChange = vi.fn();
    const spy = vi.fn();
    render(<SettingsHarness onOpenChange={onOpenChange} spy={spy} />);
    const trigger = screen.getByRole("button", { name: "设置" });
    open(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const menu = within(screen.getByTestId("player-root")).getByTestId("player-settings-menu");
    expectPlayerMenu(menu);
    // The play modes carry no heading; the group is still named for assistive technology.
    expect(within(menu).queryByText("播放方式")).toBeNull();
    expect(within(menu).getByRole("group", { name: "播放方式" })).toBeTruthy();
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["播完暂停", "单集循环", "列表循环"]);
    expect(within(menu).getByRole("menuitemradio", { name: "播完暂停" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "列表循环" }));
    expect(spy).toHaveBeenLastCalledWith({ endBehavior: "loop_list" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    open(screen.getByTestId("player-settings"));
    const reopened = within(screen.getByTestId("player-root")).getByTestId("player-settings-menu");
    expect(within(reopened).getByRole("menuitemradio", { name: "列表循环" }).getAttribute("aria-checked")).toBe("true");
    const autoplay = within(reopened).getByRole("menuitemcheckbox", { name: "自动播放" });
    expect(autoplay.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(autoplay);
    expect(spy).toHaveBeenLastCalledWith({ autoplay: true });
  });

  it("lets a Content in several collections pick the one to loop, keeping the menu open on 列表循环", () => {
    const onOpenChange = vi.fn();
    const spy = vi.fn();
    const onChoose = vi.fn();
    render(<SettingsHarness onOpenChange={onOpenChange} spy={spy} collections={["colA", "colB"]} onChoose={onChoose} />);
    open(screen.getByTestId("player-settings"));
    const menu = within(screen.getByTestId("player-root")).getByTestId("player-settings-menu");
    // The collection group appears only once the list loop is the play mode.
    expect(within(menu).queryByText("循环合集")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "列表循环" }));
    expect(spy).toHaveBeenLastCalledWith({ endBehavior: "loop_list" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const still = within(screen.getByTestId("player-root")).getByTestId("player-settings-menu");
    expect(within(still).getByText("循环合集")).toBeTruthy();
    expectPlayerMenu(still);
    expect(within(still).getByRole("menuitemradio", { name: "合集 colA" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(still).getByRole("menuitemradio", { name: "合集 colB" }));
    expect(onChoose).toHaveBeenCalledWith("colB");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    open(screen.getByTestId("player-settings"));
    const reopened = within(screen.getByTestId("player-root")).getByTestId("player-settings-menu");
    expect(within(reopened).getByRole("menuitemradio", { name: "合集 colB" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("QualityMenu", () => {
  const SOURCES = [
    { assetId: "hd", label: "1080P" },
    { assetId: "sd", label: "720P" },
    { assetId: "old", label: "未知画质" },
  ];

  function QualityHarness(props: { onSelect: (assetId: string) => void; onOpenChange: (open: boolean) => void }) {
    const [root, setRoot] = useState<HTMLDivElement | null>(null);
    return (
      <div ref={setRoot} data-testid="player-root">
        <QualityMenu sources={SOURCES} activeId="sd" onSelect={props.onSelect} container={root} onOpenChange={props.onOpenChange} />
      </div>
    );
  }

  it("names the loaded quality, lists every source in order with it marked, and asks for another one", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(<QualityHarness onSelect={onSelect} onOpenChange={onOpenChange} />);
    const trigger = screen.getByTestId("player-quality");
    expect(trigger.textContent).toBe("720P");
    expect(trigger.getAttribute("aria-label")).toBe("清晰度");
    open(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const menu = within(screen.getByTestId("player-root")).getByTestId("player-quality-menu");
    expectPlayerMenu(menu);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["1080P", "720P", "未知画质"]);
    expect(within(menu).getByTestId("player-quality-item-sd").getAttribute("aria-checked")).toBe("true");
    // The loaded one is not a switch.
    fireEvent.click(within(menu).getByTestId("player-quality-item-sd"));
    expect(onSelect).not.toHaveBeenCalled();
    open(screen.getByTestId("player-quality"));
    fireEvent.click(within(screen.getByTestId("player-quality-menu")).getByTestId("player-quality-item-hd"));
    expect(onSelect).toHaveBeenCalledWith("hd");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
