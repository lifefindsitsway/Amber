import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBTITLE_FONT_SIZE_MAX, SUBTITLE_FONT_SIZE_MIN, SUBTITLE_PLACEMENT_Y_BP } from "../../../src/shared/defaults.ts";
import { BASIS_POINTS, defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import { SubtitleEditor } from "../../../src/web/player/subtitle-editor.tsx";
import type { SubtitleTrackModel } from "../../../src/web/player/subtitle-overlay.tsx";
import {
  hasPlacementOverride,
  readAppearance,
  readDefaultPlacement,
  readPlacement,
  resetSubtitlePrefsMemory,
  subtitlePrefKeys,
  useSubtitlePrefs,
  type SubtitleDisplayMode,
} from "../../../src/web/player/subtitle-prefs.ts";

function Panel(props: { mode?: SubtitleDisplayMode; onPreview?: () => void; onStop?: () => void }) {
  const prefs = useSubtitlePrefs("u1", "c1");
  const [editing, setEditing] = useState(true);
  const model: SubtitleTrackModel = {
    mode: props.mode ?? "bilingual",
    setMode: () => undefined,
    originals: [],
    originalId: undefined,
    setOriginal: () => undefined,
    translations: [],
    translationId: undefined,
    translationLocked: false,
    followTranslation: () => undefined,
    lockTranslation: () => undefined,
    goTranslate: () => undefined,
    status: "ready",
    retry: () => undefined,
    slices: [],
    fontFallback: true,
    appearance: prefs.appearance,
    setAppearance: prefs.setAppearance,
    resetAppearance: prefs.resetAppearance,
    placement: prefs.placement,
    placementOverridden: prefs.placementOverridden,
    setPlacement: prefs.setPlacement,
    setDefaultPlacement: prefs.setDefaultPlacement,
    resetPlacement: prefs.resetPlacement,
    editing,
    startEditing: () => setEditing(true),
    stopEditing: () => {
      setEditing(false);
      props.onStop?.();
    },
  };
  return editing ? <SubtitleEditor model={model} side="right" top={8} maxHeight={300} onPreview={props.onPreview ?? (() => undefined)} /> : null;
}

beforeEach(() => {
  localStorage.clear();
  resetSubtitlePrefsMemory();
});

describe("SubtitleEditor", () => {
  it("writes appearance changes at once: size, colour by picker, hex and swatch, outline and background", () => {
    render(<Panel />);
    const size = screen.getByTestId("subtitle-original-size") as HTMLInputElement;
    expect([size.min, size.max]).toEqual([String(SUBTITLE_FONT_SIZE_MIN), String(SUBTITLE_FONT_SIZE_MAX)]);
    fireEvent.change(size, { target: { value: "60" } });
    expect(readAppearance("u1").original.fontSize).toBe(60);
    fireEvent.change(screen.getByTestId("subtitle-original-color-picker"), { target: { value: "#12ab34" } });
    expect(readAppearance("u1").original.color).toBe("#12AB34");
    const hex = screen.getByTestId("subtitle-translation-color-hex") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "#00f" } });
    expect(readAppearance("u1").translation.color).toBe(defaultSubtitleAppearance().translation.color);
    fireEvent.change(hex, { target: { value: "#0000ff" } });
    expect(readAppearance("u1").translation.color).toBe("#0000FF");
    fireEvent.click(screen.getByTestId("subtitle-outline-color-swatch-00FFFF"));
    fireEvent.click(screen.getByTestId("subtitle-outline-enabled"));
    fireEvent.click(screen.getByTestId("subtitle-background-enabled"));
    fireEvent.change(screen.getByTestId("subtitle-background-opacity"), { target: { value: "80" } });
    fireEvent.click(screen.getByTestId("subtitle-order-translation_first"));
    const appearance = readAppearance("u1");
    expect(appearance.outline).toMatchObject({ enabled: false, color: "#00FFFF" });
    expect(appearance.background).toMatchObject({ enabled: true, opacityPct: 80 });
    expect(appearance.bilingualOrder).toBe("translation_first");
    expect(screen.getByTestId("subtitle-font-fallback").textContent).toBe("预览字体与导出不同");
  });

  it("shows only the lines the mode shows", () => {
    render(<Panel mode="original" />);
    expect(screen.queryByTestId("subtitle-original-size")).not.toBeNull();
    expect(screen.queryByTestId("subtitle-translation-size")).toBeNull();
    expect(screen.queryByTestId("subtitle-order-original_first")).toBeNull();
  });

  it("offers the background box scope only for bilingual subtitles and keeps the other box settings", () => {
    const { unmount } = render(<Panel mode="translation" />);
    expect(screen.queryByTestId("subtitle-background-scope-both")).toBeNull();
    unmount();
    render(<Panel />);
    expect(screen.getByRole("radiogroup", { name: "范围" })).toBeTruthy();
    const scope = (value: string) => screen.getByTestId(`subtitle-background-scope-${value}`) as HTMLInputElement;
    expect([scope("both").checked, scope("original").checked, scope("translation").checked]).toEqual([true, false, false]);
    fireEvent.click(screen.getByTestId("subtitle-background-enabled"));
    fireEvent.change(screen.getByTestId("subtitle-background-padding"), { target: { value: "20" } });
    fireEvent.click(scope("translation"));
    expect(readAppearance("u1").background).toEqual({ ...defaultSubtitleAppearance().background, enabled: true, padding: 20, scope: "translation" });
    expect([scope("both").checked, scope("translation").checked]).toEqual([false, true]);
    expect(scope("translation").closest("label")?.textContent).toBe("仅译文");
  });

  it("offers speaker labels as a group of its own, storing the mode and dropping the key altogether when off", () => {
    render(<Panel mode="original" />);
    const group = screen.getByTestId("subtitle-speaker-section");
    expect(group.querySelector("legend")?.textContent).toBe("发言人");
    expect([...group.querySelectorAll("label")].map((label) => label.textContent)).toEqual(["不显示", "换人时", "每条"]);
    expect((screen.getByTestId("subtitle-speaker-off") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("subtitle-speaker-change"));
    expect(readAppearance("u1").speaker).toBe("change");
    fireEvent.click(screen.getByTestId("subtitle-speaker-every"));
    expect(readAppearance("u1").speaker).toBe("every");
    expect((screen.getByTestId("subtitle-speaker-every") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("subtitle-speaker-off"));
    expect("speaker" in readAppearance("u1")).toBe(false);
    // Stored exactly as an appearance from before speaker labels existed.
    expect(JSON.parse(localStorage.getItem(subtitlePrefKeys.appearance("u1")) as string)).toEqual(defaultSubtitleAppearance());
  });

  it("puts the speaker group seventh, after the position", () => {
    render(<Panel mode="bilingual" />);
    const legends = [...document.querySelectorAll("fieldset > legend")].map((legend) => legend.textContent);
    expect(legends).toHaveLength(7);
    expect(legends[5]).toBe("位置");
    expect(legends[6]).toBe("发言人");
    expect(screen.getByTestId("subtitle-speaker-section").querySelector("legend")?.textContent).toBe(legends[6]);
  });

  it("places by preset and by typed percentages, with the anchor each preset implies", () => {
    render(<Panel />);
    fireEvent.click(screen.getByTestId("subtitle-preset-top"));
    expect(readPlacement("u1", "c1")).toEqual({ version: 1, xBp: BASIS_POINTS / 2, yBp: BASIS_POINTS - SUBTITLE_PLACEMENT_Y_BP, anchor: "top" });
    fireEvent.click(screen.getByTestId("subtitle-preset-center"));
    expect(readPlacement("u1", "c1").anchor).toBe("center");
    fireEvent.change(screen.getByTestId("subtitle-position-x"), { target: { value: "12.5" } });
    fireEvent.change(screen.getByTestId("subtitle-position-y"), { target: { value: "140" } });
    expect(readPlacement("u1", "c1")).toEqual({ version: 1, xBp: 1250, yBp: BASIS_POINTS, anchor: "center" });
  });

  it("sets and resets the default position and resets the style without touching any position", () => {
    render(<Panel />);
    const resetPosition = screen.getByTestId("subtitle-reset-position") as HTMLButtonElement;
    expect(resetPosition.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("subtitle-preset-top"));
    const top = readPlacement("u1", "c1");
    fireEvent.click(screen.getByTestId("subtitle-set-default-position"));
    expect(readDefaultPlacement("u1")).toEqual(top);

    fireEvent.click(screen.getByTestId("subtitle-preset-bottomRight"));
    expect(hasPlacementOverride("u1", "c1")).toBe(true);
    fireEvent.click(screen.getByTestId("subtitle-reset-position"));
    expect(hasPlacementOverride("u1", "c1")).toBe(false);
    // Without its override the Content follows the user's default, not the system one.
    expect(readPlacement("u1", "c1")).toEqual(top);
    expect(top).not.toEqual(defaultSubtitlePlacement());

    fireEvent.click(screen.getByTestId("subtitle-preset-center"));
    fireEvent.change(screen.getByTestId("subtitle-original-size"), { target: { value: "90" } });
    fireEvent.click(screen.getByTestId("subtitle-reset-style"));
    expect(readAppearance("u1")).toEqual(defaultSubtitleAppearance());
    expect(readPlacement("u1", "c1").anchor).toBe("center");
    expect(readDefaultPlacement("u1")).toEqual(top);
  });

  it("leaves on 「完成」 or Escape inside it, keeps its keys to itself, and collapses to a button", () => {
    const onStop = vi.fn();
    const outer = vi.fn();
    const preview = vi.fn();
    const { rerender } = render(
      <div onKeyDown={outer}>
        <Panel onStop={onStop} onPreview={preview} />
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId("subtitle-preset-top"), { key: " " });
    expect(outer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("subtitle-preview"));
    expect(preview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("subtitle-editor-collapse"));
    expect(screen.queryByTestId("subtitle-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("subtitle-editor-expand"));
    expect(screen.getByTestId("subtitle-editor").getAttribute("data-side")).toBe("right");
    expect(screen.getByTestId("subtitle-editor").style.maxHeight).toBe("300px");
    fireEvent.keyDown(screen.getByTestId("subtitle-position-x"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("subtitle-editor")).toBeNull();

    rerender(<div key="again"><Panel onStop={onStop} /></div>);
    act(() => fireEvent.click(screen.getByTestId("subtitle-editor-done")));
    expect(onStop).toHaveBeenCalledTimes(2);
  });
});
