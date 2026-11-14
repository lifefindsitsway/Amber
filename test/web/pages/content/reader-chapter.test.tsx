import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterHeading } from "../../../../src/web/pages/content/reader-chapter.tsx";

function show(options: { title?: string; first?: boolean; ms?: number | null } = {}) {
  const onSeek = vi.fn<() => void>();
  const title = options.title ?? "第 2 章 检索与重排序";
  const ms = options.ms === undefined ? 75_000 : options.ms;
  render(<ChapterHeading title={title} first={options.first ?? false} {...(ms === null ? {} : { seek: { ms, onSeek } })} />);
  const root = screen.getByTestId("transcript-chapter");
  return { onSeek, title, root, heading: within(root).getByRole("heading", { level: 3 }) };
}

/** Pretends the user has just finished dragging a selection, as `window.getSelection()` reports it. */
function withSelection(collapsed: boolean) {
  vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: collapsed } as Selection);
}

describe("ChapterHeading", () => {
  it("holds the title as its only text, in a plain h3 and without a time", () => {
    const { root, heading, title } = show();
    expect(root.textContent).toBe(title);
    expect(heading.textContent).toBe(title);
    expect(heading.getAttribute("data-testid")).toBe("chapter-title");
    expect(heading.children.length).toBe(0);
    expect(heading.tagName).toBe("H3");
    expect(heading.hasAttribute("role")).toBe(false);
    expect(heading.hasAttribute("tabindex")).toBe(false);
    expect(root.querySelector("[data-reading-time]")).toBeNull();
    expect(root.hasAttribute("data-reading-time")).toBe(false);
    expect(root.style.fontSize).toBe("");
    expect(heading.hasAttribute("data-reader-text")).toBe(false);
  });

  it("sets the title's type on the heading, not on the row, and gives the play button one title line", () => {
    // jsdom drops a `clamp()` font size, so the size itself is measured in the browser tests.
    const { root, heading } = show();
    expect(heading.style.lineHeight).toBe("1.35");
    expect(root.style.lineHeight).toBe("");
    // The button's slot is one title line tall in the same type, so it cannot make the row taller.
    const slot = within(root).getByTestId("chapter-play").parentElement as HTMLElement;
    expect([slot.style.lineHeight, slot.style.height]).toEqual(["1.35", "1.35em"]);
  });

  it.each([
    [42_000, "从 0:42 播放"],
    [754_000, "从 12:34 播放"],
    [3_723_000, "从 1:02:03 播放"],
  ])("offers a play button outside the heading for %i ms", (ms, name) => {
    const { root, heading } = show({ ms });
    const button = within(root).getByRole("button", { name });
    expect(button.getAttribute("title")).toBe(name);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-testid")).toBe("chapter-play");
    expect(heading.contains(button)).toBe(false);
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // The heading's accessible name is the title alone.
    expect(within(root).getByRole("heading", { level: 3, name: "第 2 章 检索与重排序" })).toBe(heading);
  });

  it("marks the play button as reader meta, not text", () => {
    const { root } = show();
    expect(within(root).getByTestId("chapter-play").getAttribute("data-reader-meta")).toBe("");
  });

  it("keeps the play button focusable while it is hidden, revealed on hover, focus and touch", () => {
    const { root } = show();
    const button = within(root).getByTestId("chapter-play");
    expect(root.className).toContain("group");
    for (const name of ["opacity-0", "group-hover:opacity-100", "focus-visible:opacity-100", "pointer-coarse:opacity-100", "focus-visible:ring-2", "size-6"]) {
      expect(button.className.split(" ")).toContain(name);
    }
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("seeks when the title is clicked", () => {
    const { heading, onSeek } = show();
    expect(heading.className.split(" ")).toContain("cursor-pointer");
    fireEvent.click(heading);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("does not seek when the click on the title ends a text selection", () => {
    const { heading, onSeek } = show();
    withSelection(false);
    fireEvent.click(heading);
    expect(onSeek).not.toHaveBeenCalled();
    withSelection(true);
    fireEvent.click(heading);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("seeks when the play button is clicked", () => {
    const { root, onSeek } = show();
    fireEvent.click(within(root).getByTestId("chapter-play"));
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("seeks when the focused play button is activated from the keyboard", () => {
    const { root, onSeek } = show();
    const button = within(root).getByTestId("chapter-play") as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    // jsdom has no key-to-activation behaviour; a native button turns Enter / Space into a click,
    // which is what `click()` dispatches here.
    button.click();
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("has no button, pointer cursor or seek without a shown section", () => {
    const { root, heading } = show({ ms: null });
    expect(within(root).queryByRole("button")).toBeNull();
    expect(root.querySelector("[data-testid='chapter-play']")).toBeNull();
    expect(heading.className.split(" ")).not.toContain("cursor-pointer");
    expect(() => fireEvent.click(heading)).not.toThrow();
    expect(root.textContent).toBe("第 2 章 检索与重排序");
  });

  it("changes only the top spacing for the first row", () => {
    const { root } = show({ first: false });
    const rest = root.className.split(" ");
    cleanup();
    const { root: firstRoot } = show({ first: true });
    const first = firstRoot.className.split(" ");
    expect(rest).toContain("pt-[1.5em]");
    expect(first).toContain("pt-[0.25em]");
    expect(rest.filter((name) => name !== "pt-[1.5em]")).toEqual(first.filter((name) => name !== "pt-[0.25em]"));
    expect(first).toContain("pb-[0.5em]");
    // No inline spacing: the heading starts at the text's edge.
    expect(first.some((name) => /^(p[xlrse]|m[xlrse])-/.test(name))).toBe(false);
  });
});
