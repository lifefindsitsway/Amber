import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import { SubtitleMenu } from "../../../src/web/player/subtitle-menu.tsx";
import type { SubtitleTrackModel } from "../../../src/web/player/subtitle-overlay.tsx";

function model(overrides: Partial<SubtitleTrackModel> = {}): SubtitleTrackModel {
  return {
    mode: "off",
    setMode: vi.fn(),
    originals: [
      { id: "r1", label: "平台字幕（当前）" },
      { id: "r2", label: "校对稿" },
    ],
    originalId: "r1",
    setOriginal: vi.fn(),
    translations: [],
    translationId: undefined,
    translationLocked: false,
    followTranslation: vi.fn(),
    lockTranslation: vi.fn(),
    goTranslate: vi.fn(),
    status: "off",
    retry: vi.fn(),
    slices: [],
    fontFallback: false,
    appearance: defaultSubtitleAppearance(),
    setAppearance: vi.fn(),
    resetAppearance: vi.fn(),
    placement: defaultSubtitlePlacement(),
    placementOverridden: false,
    setPlacement: vi.fn(),
    setDefaultPlacement: vi.fn(),
    resetPlacement: vi.fn(),
    editing: false,
    startEditing: vi.fn(),
    stopEditing: vi.fn(),
    ...overrides,
  };
}

function open(value: SubtitleTrackModel, onOpenChange?: (open: boolean) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  render(<SubtitleMenu model={value} container={container} {...(onOpenChange === undefined ? {} : { onOpenChange })} />);
  fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
  const menu = screen.getByTestId("player-subtitles-menu");
  expect(container.contains(menu)).toBe(true);
  return menu;
}

describe("SubtitleMenu", () => {
  it("offers the four display modes, the original revisions and 「去翻译」 without a translation", () => {
    const value = model();
    const onOpenChange = vi.fn();
    open(value, onOpenChange);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["关闭", "仅原文", "仅译文", "双语", "平台字幕（当前）", "校对稿"]);
    expect(screen.getByTestId("player-subtitles-mode-off").getAttribute("aria-checked")).toBe("true");
    // Without a translation only the original can be shown.
    expect(screen.getByTestId("player-subtitles-mode-translation").hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByTestId("player-subtitles-mode-bilingual").hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByText("该版本还没有译文")).toBeTruthy();
    fireEvent.click(screen.getByTestId("player-subtitles-go-translate"));
    expect(value.goTranslate).toHaveBeenCalledTimes(1);
  });

  it("switches mode, revision and translation, and enters the editor", () => {
    const value = model({ mode: "original", translations: [{ language: "en", label: "英语", currentId: "t1", history: [] }], translationId: "t1", fontFallback: true });
    open(value);
    expect(screen.getByTestId("player-subtitles").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("player-subtitles-mode-bilingual"));
    expect(value.setMode).toHaveBeenCalledWith("bilingual");
    fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
    expect(screen.queryByTestId("player-subtitles-go-translate")).toBeNull();
    expect(screen.getByText("预览字体与导出不同")).toBeTruthy();
    fireEvent.click(screen.getByTestId("player-subtitles-original-r2"));
    expect(value.setOriginal).toHaveBeenCalledWith("r2");
    fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
    expect(screen.getByTestId("player-subtitles-follow-en").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("player-subtitles-history-en")).toBeNull();
    fireEvent.click(screen.getByTestId("player-subtitles-edit"));
    expect(value.startEditing).toHaveBeenCalledTimes(1);
  });

  it("follows a language with 「（当前）」 and locks a version from its 「历史版本」", () => {
    const translations = [
      {
        language: "en",
        label: "英语",
        currentId: "t3",
        history: [
          { id: "t2", label: "人工编辑 · 英语 · 10-02 09:00" },
          { id: "t1", label: "翻译 · 英语 · 10-01 08:00" },
        ],
      },
      { language: "ja", label: "日语", currentId: "j1", history: [] },
    ];
    const value = model({ mode: "bilingual", translations, translationId: "t3" });
    const menu = open(value);
    expect(screen.getByTestId("player-subtitles-follow-en").textContent).toBe("英语（当前）");
    expect(screen.getByTestId("player-subtitles-follow-en").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("player-subtitles-follow-ja").textContent).toBe("日语（当前）");
    // History stays folded until asked for; opening it keeps the menu open.
    const toggle = screen.getByTestId("player-subtitles-history-en");
    expect(toggle.textContent).toBe("历史版本（2）");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("player-subtitles-translation-t1")).toBeNull();
    fireEvent.click(toggle);
    expect(menu.isConnected).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "英语的历史版本" })).toBeTruthy();
    expect(screen.getByTestId("player-subtitles-translation-t2").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("player-subtitles-translation-t1"));
    expect(value.lockTranslation).toHaveBeenCalledWith("t1");
    fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("player-subtitles-follow-ja"));
    expect(value.followTranslation).toHaveBeenCalledWith("ja");
  });

  it("opens with a locked version's history expanded and marked, the language not followed", () => {
    const translations = [{ language: "en", label: "英语", currentId: "t3", history: [{ id: "t1", label: "翻译 · 英语 · 10-01 08:00" }] }];
    open(model({ mode: "translation", translations, translationId: "t1", translationLocked: true }));
    expect(screen.getByTestId("player-subtitles-follow-en").getAttribute("aria-checked")).toBe("false");
    const locked = screen.getByTestId("player-subtitles-translation-t1");
    expect(locked.getAttribute("aria-checked")).toBe("true");
    expect(locked.textContent).toContain("已锁定");
    expect(screen.getAllByTestId("player-subtitles-locked")).toHaveLength(1);
  });

  it("reaches the history toggle and its versions with the keyboard", async () => {
    const translations = [{ language: "en", label: "英语", currentId: "t3", history: [{ id: "t1", label: "翻译 · 英语 · 10-01 08:00" }] }];
    const value = model({ mode: "translation", translations, translationId: "t3" });
    open(value);
    const toggle = screen.getByTestId("player-subtitles-history-en");
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const item = screen.getByTestId("player-subtitles-translation-t1");
    fireEvent.keyDown(toggle, { key: "ArrowDown" });
    // Radix moves roving focus on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: "Enter" });
    expect(value.lockTranslation).toHaveBeenCalledWith("t1");
  });
});
