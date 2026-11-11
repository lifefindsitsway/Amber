import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { READER_FONT_SIZE_DEFAULT, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN, READER_LINE_HEIGHT_DEFAULT } from "../../../../src/shared/defaults.ts";
import { READER_LINE_HEIGHT_OPTIONS, READER_TYPOGRAPHY_DEFAULTS, type ReaderTypography } from "../../../../src/shared/reader-typography.ts";
import { ReaderTypographyPopover, type ReaderTypographyChange } from "../../../../src/web/pages/content/reader-typography-popover.tsx";
import { stubResizeObserver } from "../../../fixtures/web/speaker-fetch.ts";

function Harness(props: { initial?: Partial<ReaderTypography>; speakerMode?: boolean; onChange?: (change: ReaderTypographyChange) => void; onReset?: () => void }) {
  const [value, setValue] = useState<ReaderTypography>({ ...READER_TYPOGRAPHY_DEFAULTS, ...props.initial });
  return (
    <ReaderTypographyPopover
      value={value}
      speakerMode={props.speakerMode ?? true}
      onChange={(change) => {
        props.onChange?.(change);
        setValue((previous) => ({ ...previous, ...change }));
      }}
      onReset={() => {
        props.onReset?.();
        setValue({ ...READER_TYPOGRAPHY_DEFAULTS });
      }}
    />
  );
}

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
    const radios = within(popover).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(READER_LINE_HEIGHT_OPTIONS.map(String));
    expect(within(popover).getByTestId("reader-line-heights").textContent).toBe("1.51.61.71.82.0");
    expect(radios.find((radio) => radio.checked)?.value).toBe(String(READER_LINE_HEIGHT_DEFAULT));
    fireEvent.click(radios[4] as HTMLInputElement);
    expect(onChange).toHaveBeenLastCalledWith({ lineHeight: 2 });
    expect((within(popover).getAllByRole("radio") as HTMLInputElement[]).find((radio) => radio.checked)?.value).toBe("2");
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

  it("is operable by keyboard: native controls in a popover that Escape closes", async () => {
    const popover = await open();
    const controls = within(popover).getAllByRole("button").concat(within(popover).getAllByRole("slider"), within(popover).getAllByRole("radio"), within(popover).getAllByRole("switch"));
    for (const control of controls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByTestId("reader-typography-popover")).toBeNull();
  });
});
