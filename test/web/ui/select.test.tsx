import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "../../../src/web/ui/select.tsx";
import { chooseOption, openSelect, selectGroups, selectOptionNames, stubSelectLayout } from "../../fixtures/web/select.ts";

beforeEach(stubSelectLayout);

const PLAIN: Array<SelectOption<string>> = [
  { value: "a", label: "Alpha", icon: <svg data-testid="icon-a" /> },
  { value: "b", label: "Beta", tag: "旧版" },
  { value: "c", label: "Gamma" },
];

function Field(props: { options?: Array<SelectOption<string>>; initial?: string; onChange?: (value: string) => void; extra?: Partial<Parameters<typeof Select<string>>[0]> }) {
  const [value, setValue] = useState<string | undefined>(props.initial);
  return (
    <Select
      ariaLabel="字段"
      value={value}
      options={props.options ?? PLAIN}
      placeholder="请选择"
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
      {...props.extra}
    />
  );
}

const trigger = (): HTMLElement => screen.getByRole("combobox", { name: "字段" });

describe("Select without the newer options", () => {
  it("keeps the form-input trigger, the placeholder and a list as wide as the trigger", async () => {
    render(<Field />);
    expect(trigger().className).toContain("h-9");
    expect(trigger().className).toContain("w-full");
    expect(trigger().textContent).toBe("请选择");
    expect(trigger().hasAttribute("data-placeholder")).toBe(true);
    const listbox = await openSelect(trigger());
    expect(listbox.closest("[class*='w-[var(--radix-select-trigger-width)]']")).not.toBeNull();
    expect(within(listbox).queryAllByRole("group")).toEqual([]);
  });

  it("lists icon, label and tag, and copies the chosen entry into the trigger", async () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    expect(await selectOptionNames(trigger())).toEqual(["Alpha", "Beta, 旧版", "Gamma"]);
    await chooseOption(trigger(), "Alpha");
    expect(onChange).toHaveBeenCalledWith("a");
    expect(trigger().textContent).toBe("Alpha");
    expect(within(trigger()).getByTestId("icon-a")).toBeTruthy();
  });

  it("moves with the keyboard and types ahead on the label", async () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} initial="a" />);
    const listbox = await openSelect(trigger());
    fireEvent.keyDown(listbox, { key: "g" });
    // Radix moves the focus to the match on the next tick.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Gamma"));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Beta, 旧版"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Select with groups, trigger content and sizes", () => {
  const GROUPED: Array<SelectOption<string>> = [
    { value: "none", label: "未设置", dividerAfter: true },
    { value: "p1:m", label: "model-x", group: "Profile 1", valueContent: <span>P1 · model-x</span>, valueTitle: "Profile 1 · model-x" },
    { value: "p2:m", label: "model-x", group: "Profile 2", valueContent: <span>P2 · model-x</span>, valueTitle: "Profile 2 · model-x" },
    { value: "p2:n", label: "model-y", group: "Profile 2" },
  ];

  it("lists runs of the same heading as labelled groups, and a divider after the marked entry", async () => {
    render(<Field options={GROUPED} />);
    expect(await selectGroups(trigger())).toEqual([
      { heading: "Profile 1", options: ["model-x"] },
      { heading: "Profile 2", options: ["model-x", "model-y"] },
    ]);
    const listbox = await openSelect(trigger());
    expect(listbox.querySelectorAll("[role='separator'], .h-px").length).toBeGreaterThan(0);
  });

  it("tells same-named entries apart by group and shows the chosen one's own trigger content and title", async () => {
    const onChange = vi.fn();
    render(<Field options={GROUPED} onChange={onChange} />);
    await chooseOption(trigger(), "model-x", "Profile 2");
    expect(onChange).toHaveBeenCalledWith("p2:m");
    expect(trigger().textContent).toBe("P2 · model-x");
    expect(trigger().getAttribute("title")).toBe("Profile 2 · model-x");
  });

  it("caps a content-wide trigger at its container unless the caller gives a maximum", () => {
    render(<Field extra={{ width: "content" }} />);
    expect(trigger().className).toContain("max-w-full");
  });

  it("sizes the trigger and lets the list fit its entries", async () => {
    render(<Field extra={{ size: "sm", width: "content", menuWidth: "fit", className: "max-w-64" }} />);
    expect(trigger().className).toContain("h-7");
    expect(trigger().className).toContain("text-xs");
    expect(trigger().className).toContain("w-auto");
    expect(trigger().className).toContain("max-w-64");
    expect(trigger().className).not.toContain("max-w-full");
    const listbox = await openSelect(trigger());
    expect(listbox.closest("[class*='w-max']")).not.toBeNull();
  });
});
