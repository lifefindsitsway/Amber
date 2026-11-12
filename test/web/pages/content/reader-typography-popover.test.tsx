import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READER_FONT_NAME_MAX_CHARS,
  READER_FONT_SIZE_DEFAULT,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_LINE_HEIGHT_DEFAULT,
} from "../../../../src/shared/defaults.ts";
import type { BundledFontFace } from "../../../../src/web/bundled-fonts.ts";
import { READER_LINE_HEIGHT_OPTIONS, READER_TYPOGRAPHY_DEFAULTS, type ReaderTypography } from "../../../../src/shared/reader-typography.ts";
import { ReaderTypographyPopover, type ReaderTypographyChange } from "../../../../src/web/pages/content/reader-typography-popover.tsx";
import { stubResizeObserver } from "../../../fixtures/web/speaker-fetch.ts";

/** Merges a change the way the stored preference does: a field set to undefined is removed. */
function merged(previous: ReaderTypography, change: ReaderTypographyChange): ReaderTypography {
  const next: Record<string, unknown> = { ...previous, ...change };
  for (const [key, field] of Object.entries(next)) if (field === undefined) delete next[key];
  return next as ReaderTypography;
}

/** A font loader the test settles by hand: each call waits until `settle(face, ok)`. */
function manualFonts() {
  const waiting: Array<{ face: BundledFontFace; resolve: (ok: boolean) => void }> = [];
  const loadFont = vi.fn(
    (face: BundledFontFace) =>
      new Promise<boolean>((resolve) => {
        waiting.push({ face, resolve });
      }),
  );
  const settle = async (face: BundledFontFace, ok: boolean): Promise<void> => {
    const index = waiting.findIndex((entry) => entry.face === face);
    const [entry] = waiting.splice(index, 1);
    await act(async () => entry?.resolve(ok));
  };
  return { loadFont, settle };
}

function Harness(props: {
  initial?: Partial<ReaderTypography>;
  speakerMode?: boolean;
  loadFont?: (face: BundledFontFace) => Promise<boolean>;
  fontUnavailable?: boolean;
  fontLoading?: boolean;
  onRetryFont?: () => void;
  onChange?: (change: ReaderTypographyChange) => void;
  onReset?: () => void;
}) {
  const [value, setValue] = useState<ReaderTypography>({ ...READER_TYPOGRAPHY_DEFAULTS, ...props.initial });
  return (
    <ReaderTypographyPopover
      value={value}
      speakerMode={props.speakerMode ?? true}
      loadFont={props.loadFont ?? (() => Promise.resolve(true))}
      {...(props.fontUnavailable === undefined ? {} : { fontUnavailable: props.fontUnavailable })}
      {...(props.fontLoading === undefined ? {} : { fontLoading: props.fontLoading })}
      {...(props.onRetryFont === undefined ? {} : { onRetryFont: props.onRetryFont })}
      onChange={(change) => {
        props.onChange?.(change);
        setValue((previous) => merged(previous, change));
      }}
      onReset={() => {
        props.onReset?.();
        setValue({ ...READER_TYPOGRAPHY_DEFAULTS });
      }}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(props: Parameters<typeof Harness>[0] = {}) {
  stubResizeObserver();
  render(<Harness {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
  return await screen.findByTestId("reader-typography-popover");
}

describe("ReaderTypographyPopover", () => {
  it("shows the Aa trigger, named for assistive technology, and the current size in px", async () => {
    const popover = await open();
    expect(screen.getByRole("button", { name: "Aa 阅读排版" }).textContent).toBe("Aa");
    expect(within(popover).getByTestId("reader-font-size-value").textContent).toBe(`${READER_FONT_SIZE_DEFAULT} px`);
    const slider = within(popover).getByRole("slider", { name: "字号" }) as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual([String(READER_FONT_SIZE_MIN), String(READER_FONT_SIZE_MAX), "1", String(READER_FONT_SIZE_DEFAULT)]);
    expect(slider.getAttribute("aria-valuetext")).toBe(`${READER_FONT_SIZE_DEFAULT} px`);
    expect(popover.getAttribute("aria-label")).toBe("阅读排版");
  });

  it("steps the size by one with the − and + buttons and by the slider, and keeps it inside the bounds", async () => {
    const onChange = vi.fn();
    const popover = await open({ onChange });
    fireEvent.click(within(popover).getByRole("button", { name: "增大字号" }));
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: READER_FONT_SIZE_DEFAULT + 1 });
    fireEvent.click(within(popover).getByRole("button", { name: "减小字号" }));
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: READER_FONT_SIZE_DEFAULT });
    fireEvent.change(within(popover).getByRole("slider"), { target: { value: "24" } });
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 24 });
    expect(within(popover).getByTestId("reader-font-size-value").textContent).toBe("24 px");
    // Out-of-range input from the control is clamped before it reaches the preference.
    fireEvent.change(within(popover).getByRole("slider"), { target: { value: "99" } });
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: READER_FONT_SIZE_MAX });
  });

  it("disables − at the smallest size and + at the largest", async () => {
    const small = await open({ initial: { fontSize: READER_FONT_SIZE_MIN } });
    expect((within(small).getByRole("button", { name: "减小字号" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(small).getByRole("button", { name: "增大字号" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables + at the largest size", async () => {
    const large = await open({ initial: { fontSize: READER_FONT_SIZE_MAX } });
    expect((within(large).getByRole("button", { name: "增大字号" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the five line heights as one choice and applies the picked one", async () => {
    const onChange = vi.fn();
    const popover = await open({ onChange });
    const radios = within(within(popover).getByTestId("reader-line-heights")).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(READER_LINE_HEIGHT_OPTIONS.map(String));
    expect(within(popover).getByTestId("reader-line-heights").textContent).toBe("1.51.61.71.82.0");
    expect(radios.find((radio) => radio.checked)?.value).toBe(String(READER_LINE_HEIGHT_DEFAULT));
    fireEvent.click(radios[4] as HTMLInputElement);
    expect(onChange).toHaveBeenLastCalledWith({ lineHeight: 2 });
    expect((within(within(popover).getByTestId("reader-line-heights")).getAllByRole("radio") as HTMLInputElement[]).find((radio) => radio.checked)?.value).toBe("2");
  });

  it("offers the speaker switch only in speaker mode, and flips it", async () => {
    const onChange = vi.fn();
    const popover = await open({ onChange });
    const toggle = within(popover).getByRole("switch", { name: "显示发言人" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ showSpeakers: false });
  });

  it("leaves the speaker switch out when the text is not read by speakers", async () => {
    const popover = await open({ speakerMode: false });
    expect(within(popover).queryByRole("switch")).toBeNull();
  });

  it("restores the defaults", async () => {
    const onReset = vi.fn();
    const popover = await open({ initial: { fontSize: 28, lineHeight: 1.5, showSpeakers: false }, onReset });
    fireEvent.click(within(popover).getByRole("button", { name: "恢复默认" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(within(popover).getByTestId("reader-font-size-value").textContent).toBe(`${READER_FONT_SIZE_DEFAULT} px`);
    expect((within(popover).getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });

  it("restores the default font on 恢复默认", async () => {
    const popover = await open({ initial: { font: "kai" } });
    expect(checkedFont(popover)).toBe("kai");
    fireEvent.click(within(popover).getByRole("button", { name: "恢复默认" }));
    expect(checkedFont(popover)).toBe("default");
  });

  it("is operable by keyboard: native controls in a popover that Escape closes", async () => {
    const popover = await open();
    const controls = within(popover).getAllByRole("button").concat(within(popover).getAllByRole("slider"), within(popover).getAllByRole("radio"), within(popover).getAllByRole("switch"));
    expect(within(popover).getAllByRole("radio")).toHaveLength(10);
    for (const control of controls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByTestId("reader-typography-popover")).toBeNull();
  });
});

/** The font choice whose radio is checked. */
function checkedFont(popover: HTMLElement): string | undefined {
  return (within(within(popover).getByTestId("reader-fonts")).getAllByRole("radio") as HTMLInputElement[]).find((radio) => radio.checked)?.value;
}

/**
 * Lays text out as if exactly the fonts in `installed` existed: a probe whose family list
 * starts with an installed name measures wider than one in a generic family alone.
 */
function installedFonts(installed: readonly string[]): void {
  const width = function (this: HTMLElement): number {
    const first = this.style.fontFamily.split(",")[0]?.trim().replace(/^"|"$/gu, "") ?? "";
    return installed.includes(first) ? 130 : 100;
  };
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => 80);
}

describe("ReaderTypographyPopover font group", () => {
  it("comes first, offers the five fonts in order and starts at 默认", async () => {
    const popover = await open();
    const group = within(popover).getByRole("group", { name: "字体" });
    expect(popover.querySelector("fieldset")).toBe(group);
    expect(within(popover).getByTestId("reader-fonts").textContent).toBe("默认黑体宋体楷体自选");
    expect((within(group).getAllByRole("radio") as HTMLInputElement[]).map((radio) => radio.value)).toEqual(["default", "sans", "serif", "kai", "custom"]);
    expect(checkedFont(popover)).toBe("default");
    expect(within(popover).queryByTestId("reader-custom-font")).toBeNull();
  });

  it("reads a bundled face first and switches only once it is ready, showing the read on its segment", async () => {
    const onChange = vi.fn();
    const fonts = manualFonts();
    const popover = await open({ onChange, loadFont: fonts.loadFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "宋体" }));
    expect(fonts.loadFont).toHaveBeenCalledWith("serif");
    expect(onChange).not.toHaveBeenCalled();
    expect(checkedFont(popover)).toBe("default");
    const loading = within(popover).getByRole("radio", { name: "宋体（加载中）" });
    expect(loading.closest("label")?.getAttribute("aria-busy")).toBe("true");
    await fonts.settle("serif", true);
    expect(onChange).toHaveBeenLastCalledWith({ font: "serif" });
    expect(checkedFont(popover)).toBe("serif");
    expect(within(popover).getByRole("radio", { name: "宋体" }).closest("label")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps the font in use and says so when a face cannot be read; the next pick tries again", async () => {
    const onChange = vi.fn();
    const fonts = manualFonts();
    const popover = await open({ initial: { font: "sans" }, onChange, loadFont: fonts.loadFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "楷体" }));
    await fonts.settle("kai", false);
    expect(onChange).not.toHaveBeenCalled();
    expect(checkedFont(popover)).toBe("sans");
    expect(within(popover).getByTestId("reader-font-failed").textContent).toBe("字体加载失败");
    fireEvent.click(within(popover).getByRole("radio", { name: "楷体" }));
    expect(within(popover).queryByTestId("reader-font-failed")).toBeNull();
    await fonts.settle("kai", true);
    expect(onChange).toHaveBeenLastCalledWith({ font: "kai" });
    expect(checkedFont(popover)).toBe("kai");
  });

  it("applies only the latest pick when an earlier read settles later", async () => {
    const onChange = vi.fn();
    const fonts = manualFonts();
    const popover = await open({ onChange, loadFont: fonts.loadFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "宋体" }));
    fireEvent.click(within(popover).getByRole("radio", { name: "楷体" }));
    await fonts.settle("kai", true);
    await fonts.settle("serif", true);
    expect(onChange.mock.calls).toEqual([[{ font: "kai" }]]);
    fireEvent.click(within(popover).getByRole("radio", { name: "黑体" }));
    fireEvent.click(within(popover).getByRole("radio", { name: "默认" }));
    await fonts.settle("sans", true);
    expect(onChange.mock.calls.slice(1)).toEqual([[{ font: undefined }]]);
    expect(checkedFont(popover)).toBe("default");
  });

  it("still applies a face whose read finishes after the popover closed", async () => {
    const onChange = vi.fn();
    const fonts = manualFonts();
    const popover = await open({ onChange, loadFont: fonts.loadFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "宋体" }));
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByTestId("reader-typography-popover")).toBeNull();
    await fonts.settle("serif", true);
    expect(onChange).toHaveBeenLastCalledWith({ font: "serif" });
  });

  it("says the stored face could not be read", async () => {
    const popover = await open({ initial: { font: "kai" }, fontUnavailable: true });
    expect(within(popover).getByTestId("reader-font-failed").textContent).toBe("字体加载失败");
  });

  it("reads the stored face again when its checked segment is clicked after a failure", async () => {
    const onRetryFont = vi.fn();
    const onChange = vi.fn();
    const popover = await open({ initial: { font: "kai" }, fontUnavailable: true, onRetryFont, onChange });
    fireEvent.click(within(popover).getByRole("radio", { name: "楷体" }));
    expect(onRetryFont).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the read on the checked segment while the stored face is being read, and no failure", async () => {
    const onRetryFont = vi.fn();
    const popover = await open({ initial: { font: "kai" }, fontLoading: true, onRetryFont });
    const loading = within(popover).getByRole("radio", { name: "楷体（加载中）" });
    expect((loading as HTMLInputElement).checked).toBe(true);
    expect(loading.closest("label")?.getAttribute("aria-busy")).toBe("true");
    expect(loading.closest("label")?.querySelector("svg")).not.toBeNull();
    expect(within(popover).getByRole("radio", { name: "默认" }).closest("label")?.hasAttribute("aria-busy")).toBe(false);
    expect(within(popover).queryByTestId("reader-font-failed")).toBeNull();
    // Clicking it while it is being read starts no second read.
    fireEvent.click(loading);
    expect(onRetryFont).not.toHaveBeenCalled();
  });

  it("moves the read to a newly picked face while the stored one is still being read", async () => {
    const fonts = manualFonts();
    const popover = await open({ initial: { font: "kai" }, fontLoading: true, loadFont: fonts.loadFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "宋体" }));
    expect(within(popover).getByRole("radio", { name: "宋体（加载中）" }).closest("label")?.getAttribute("aria-busy")).toBe("true");
    expect(within(popover).getByRole("radio", { name: "楷体" }).closest("label")?.hasAttribute("aria-busy")).toBe(false);
    await fonts.settle("serif", true);
    expect(checkedFont(popover)).toBe("serif");
  });

  it("does not re-read a stored face that loaded", async () => {
    const onRetryFont = vi.fn();
    const popover = await open({ initial: { font: "kai" }, onRetryFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "楷体" }));
    expect(onRetryFont).not.toHaveBeenCalled();
  });

  it("switches to the default and to 自选 at once, without reading anything", async () => {
    const onChange = vi.fn();
    const loadFont = vi.fn(() => Promise.resolve(true));
    const popover = await open({ initial: { font: "serif" }, onChange, loadFont });
    fireEvent.click(within(popover).getByRole("radio", { name: "默认" }));
    expect(onChange).toHaveBeenLastCalledWith({ font: undefined });
    fireEvent.click(within(popover).getByRole("radio", { name: "自选" }));
    expect(onChange).toHaveBeenLastCalledWith({ font: "custom" });
    expect(loadFont).not.toHaveBeenCalled();
    expect(checkedFont(popover)).toBe("custom");
  });

  it("takes a custom name under the group and hints whether this machine has it", async () => {
    installedFonts(["霞鹜文楷", "Source Han Serif SC"]);
    const onChange = vi.fn();
    const popover = await open({ initial: { font: "custom" }, onChange });
    const input = within(popover).getByRole("textbox", { name: "本机字体名" }) as HTMLInputElement;
    const status = within(popover).getByTestId("reader-custom-font-status");
    expect(input.value).toBe("");
    expect(status.textContent).toBe("");

    fireEvent.change(input, { target: { value: " 霞鹜文楷 " } });
    expect(onChange).toHaveBeenLastCalledWith({ customFont: "霞鹜文楷" });
    expect(status.textContent).toBe("已找到");
    fireEvent.change(input, { target: { value: "No Such Font" } });
    expect(onChange).toHaveBeenLastCalledWith({ customFont: "No Such Font" });
    expect(status.textContent).toBe("未检测到，仍可使用；本机没有这个字体时显示默认字体");
    expect(input.getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ customFont: undefined });
    expect(status.textContent).toBe("");
  });

  it("shows the stored custom name and refuses a name with characters a CSS value cannot hold, or one too long", async () => {
    installedFonts([]);
    const onChange = vi.fn();
    const popover = await open({ initial: { font: "custom", customFont: "Kaiti" }, onChange });
    const input = within(popover).getByRole("textbox", { name: "本机字体名" }) as HTMLInputElement;
    const status = within(popover).getByTestId("reader-custom-font-status");
    expect(input.value).toBe("Kaiti");
    for (const bad of ['Ka"iti', "Kai'ti", "Kai\\ti", "Kai;ti", "Kai{ti", "Kai}ti", "Kai,ti", "Kai\u0007ti", "x".repeat(READER_FONT_NAME_MAX_CHARS + 1)]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(status.textContent, bad).toBe(`字体名最多 ${READER_FONT_NAME_MAX_CHARS} 个字符，不能含引号、反斜杠、分号、花括号、逗号或控制字符`);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.value).toBe(bad);
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "x".repeat(READER_FONT_NAME_MAX_CHARS) } });
    expect(onChange).toHaveBeenLastCalledWith({ customFont: "x".repeat(READER_FONT_NAME_MAX_CHARS) });
  });
});
