import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";

/**
 * jsdom lacks the layout and pointer-capture calls Radix menus make; call in `beforeEach` of a
 * file that opens a menu-style dropdown.
 */
export function stubSelectLayout(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}

/** Opens a menu-style dropdown from the keyboard and returns its list. */
export async function openSelect(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("listbox");
}

/** Closes an open list with Esc and waits until it is gone. */
export async function closeSelect(listbox: HTMLElement): Promise<void> {
  fireEvent.keyDown(listbox, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** The names of the entries, in order, closing the list again. */
export async function selectOptionNames(trigger: HTMLElement): Promise<string[]> {
  const listbox = await openSelect(trigger);
  const names = within(listbox)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  await closeSelect(listbox);
  return names;
}

/** The group headings with the entries under each, closing the list again. */
export async function selectGroups(trigger: HTMLElement): Promise<Array<{ heading: string; options: string[] }>> {
  const listbox = await openSelect(trigger);
  const groups = within(listbox)
    .queryAllByRole("group")
    .map((group) => ({
      heading: document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent ?? "",
      options: within(group)
        .getAllByRole("option")
        .map((option) => option.textContent ?? ""),
    }));
  await closeSelect(listbox);
  return groups;
}

/**
 * Picks an entry by its accessible name, as a user would: open, click, wait for the list to
 * close. With `group`, the entry is looked up under that heading only (two profiles may list
 * the same model).
 */
export async function chooseOption(trigger: HTMLElement, name: string | RegExp, group?: string): Promise<void> {
  const listbox = await openSelect(trigger);
  let scope: HTMLElement = listbox;
  if (group !== undefined) {
    const found = within(listbox)
      .getAllByRole("group")
      .find((element) => document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent === group);
    if (found === undefined) throw new Error(`no group "${group}" in the list`);
    scope = found;
  }
  fireEvent.click(within(scope).getByRole("option", { name }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
