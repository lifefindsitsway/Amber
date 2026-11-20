import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SuggestionInput } from "../../../src/web/ui/suggestion-input.tsx";

const SIZES = ["32K", "64K", "128K", "1M"] as const;

function Field(props: { initial?: string; onKeyDown?: () => void; suggestions?: readonly string[] }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <SuggestionInput
      aria-label="窗口"
      value={value}
      onValueChange={setValue}
      suggestions={props.suggestions ?? SIZES}
      listLabel="常用值"
      onKeyDown={props.onKeyDown}
    />
  );
}

const input = (): HTMLInputElement => screen.getByRole<HTMLInputElement>("combobox", { name: "窗口" });
const options = (): string[] => within(screen.getByRole("listbox", { name: "常用值" }))
  .getAllByRole("option")
  .map((option) => option.textContent ?? "");

describe("SuggestionInput", () => {
  it("stays closed until asked, then lists each entry once", () => {
    render(<Field />);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.pointerDown(input(), { button: 0 });
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(options()).toEqual(["32K", "64K", "128K", "1M"]);
  });

  it("opens from the chevron and keeps the focus in the input", () => {
    render(<Field />);
    input().focus();
    fireEvent.click(screen.getByRole("button", { name: "常用值" }));
    expect(options()).toHaveLength(4);
    expect(document.activeElement).toBe(input());
    fireEvent.click(screen.getByRole("button", { name: "常用值" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("narrows to the entries the typed text starts and hides when none is left", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "1" } });
    expect(options()).toEqual(["128K", "1M"]);
    fireEvent.change(input(), { target: { value: "128000" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves with the arrows, fills on Enter without letting Enter through", () => {
    const outer = vi.fn();
    render(<Field onKeyDown={outer} />);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[3]?.dataset["highlighted"]).toBe("");
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    expect(input().value).toBe("1M");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    // Closed, Enter is the surrounding form's again.
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("fills a clicked entry and marks the current value", () => {
    render(<Field initial="64K" />);
    fireEvent.pointerDown(input(), { button: 0 });
    expect(screen.getByRole("option", { name: "64K" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "128K" }));
    expect(input().value).toBe("128K");
  });

  it("closes only itself on Esc", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(event) => (event.key === "Escape" ? outer() : undefined)}>
        <Field />
      </div>,
    );
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("is a plain text field with nothing to suggest", () => {
    render(<Field suggestions={[]} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    const field = screen.getByRole("textbox", { name: "窗口" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
