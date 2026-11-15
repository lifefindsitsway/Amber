import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenuHost, isTextEditableTarget, linkAt, selectionAt, useContextMenuTarget, type MenuHit, type MenuModel, type MenuProvider } from "../../../src/web/ui/context-menu.tsx";
import { registerSelectionSource, type RegionSelection } from "../../../src/web/ui/selection-source.ts";

function Target(props: { provide: MenuProvider; testId?: string; children?: React.ReactNode }) {
  const ref = useContextMenuTarget<HTMLDivElement>(props.provide);
  return (
    <div ref={ref} data-testid={props.testId ?? "target"}>
      {props.children ?? "object"}
    </div>
  );
}

function host(ui: React.ReactNode, blockNative = false) {
  return render(
    <MemoryRouter>
      <ContextMenuHost blockNative={blockNative}>{ui}</ContextMenuHost>
    </MemoryRouter>,
  );
}

const objectMenu = (onSelect = vi.fn()): MenuModel => ({ kind: "object", href: "/contents/c1", entries: [{ id: "rename", label: "重命名", onSelect }] });

/** Fires a right click and reports whether the default (browser menu) was prevented. */
function rightClick(element: Element, init: MouseEventInit & { pointerType?: string } = {}): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init });
  if (init.pointerType !== undefined) Object.defineProperty(event, "pointerType", { value: init.pointerType });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
});

describe("ContextMenuHost on the web", () => {
  it("leaves places without an object to the browser", () => {
    host(<p data-testid="blank">blank</p>);
    expect(rightClick(screen.getByTestId("blank"))).toBe(false);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("opens the object's menu, adds open-in-new-tab and runs the chosen action", () => {
    const onSelect = vi.fn();
    host(<Target provide={() => objectMenu(onSelect)} />);
    expect(rightClick(screen.getByTestId("target"))).toBe(true);
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["在新标签页中打开", "重命名"]);
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("asks outer objects when the inner one declines, without preventing the default first", () => {
    host(
      <Target provide={() => objectMenu()} testId="outer">
        <Target provide={() => undefined} testId="inner">
          gap
        </Target>
      </Target>,
    );
    expect(rightClick(screen.getByTestId("inner"))).toBe(true);
    expect(screen.getByTestId("context-menu-item-rename")).toBeTruthy();
  });

  it("keeps a declining list's native menu", () => {
    host(<Target provide={() => undefined} />);
    expect(rightClick(screen.getByTestId("target"))).toBe(false);
  });

  it("skips text objects for touch input but not row objects", () => {
    host(
      <>
        <Target provide={() => ({ kind: "text", entries: [{ id: "copy", label: "复制", onSelect: vi.fn() }] })} testId="text" />
        <Target provide={() => objectMenu()} testId="row" />
      </>,
    );
    expect(rightClick(screen.getByTestId("text"), { pointerType: "touch" })).toBe(false);
    expect(rightClick(screen.getByTestId("text"), { pointerType: "mouse" })).toBe(true);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
    });
    expect(rightClick(screen.getByTestId("row"), { pointerType: "touch" })).toBe(true);
  });

  it("uses the exact href of a link under the pointer", () => {
    host(
      <Target provide={() => objectMenu()}>
        <a href="/contents/c1?tab=transcript&segment=s1" data-testid="deep">
          hit
        </a>
      </Target>,
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    rightClick(screen.getByTestId("deep"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["在新标签页中打开", "复制链接地址", "重命名"]);
    fireEvent.click(screen.getByTestId("context-menu-item-open-new-tab"));
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/contents/c1?tab=transcript&segment=s1`, "_blank", "noopener");
  });

  it("puts the selection first when the click falls inside it", () => {
    host(
      <Target provide={(hit) => ({ ...objectMenu(), selectionEntries: hit.selection === undefined ? [] : [{ id: "explain", label: "解释选中内容", onSelect: vi.fn() }] })}>
        <span data-testid="text">hello world</span>
      </Target>,
    );
    const text = screen.getByTestId("text").firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: text, offset: 2 });
    rightClick(screen.getByTestId("text"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["复制选中内容", "解释选中内容", "在新标签页中打开", "重命名"]);
  });

  it("returns focus to the right-clicked element only when no action moved it", async () => {
    function WithDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Target provide={() => ({ kind: "object", entries: [{ id: "noop", label: "noop", onSelect: () => undefined }, { id: "dialog", label: "dialog", onSelect: () => setOpen(true) }] })}>
            <button type="button" data-testid="row-button">
              row
            </button>
          </Target>
          {open ? <input data-testid="dialog-input" autoFocus /> : null}
        </>
      );
    }
    host(<WithDialog />);
    const button = screen.getByTestId("row-button");
    button.focus();
    rightClick(button);
    fireEvent.click(screen.getByTestId("context-menu-item-noop"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(button);
    rightClick(button);
    fireEvent.click(screen.getByTestId("context-menu-item-dialog"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(screen.getByTestId("dialog-input"));
  });

  it("keeps the anchor out of the tab order and away from assistive tech", () => {
    host(<Target provide={() => objectMenu()} />);
    rightClick(screen.getByTestId("target"));
    const anchor = screen.getByTestId("context-menu-anchor");
    expect(anchor.getAttribute("tabindex")).toBe("-1");
    expect(anchor.getAttribute("aria-hidden")).toBe("true");
    expect(anchor.style.pointerEvents).toBe("none");
  });

  it("follows a registered element that is replaced by another node", () => {
    function Swapping() {
      const [second, setSecond] = useState(false);
      const ref = useContextMenuTarget<HTMLElement>(() => objectMenu());
      return second ? (
        <section ref={ref} data-testid="second">
          b
        </section>
      ) : (
        <div ref={ref} data-testid="first" onClick={() => setSecond(true)}>
          a
        </div>
      );
    }
    host(<Swapping />);
    fireEvent.click(screen.getByTestId("first"));
    expect(rightClick(screen.getByTestId("second"))).toBe(true);
  });

  it("runs actions on the data captured at right-click time", () => {
    function Rows() {
      const [rows, setRows] = useState(["a"]);
      const ref = useContextMenuTarget<HTMLUListElement>((hit) => {
        const id = hit.target.closest<HTMLElement>("[data-row]")?.dataset["row"];
        return id === undefined ? undefined : { kind: "text", entries: [{ id: "pick", label: "pick", onSelect: () => picked(id) }] };
      });
      return (
        <ul ref={ref}>
          {rows.map((row) => (
            <li key={row} data-row={row} data-testid={`row-${row}`} onClick={() => setRows(["b"])}>
              {row}
            </li>
          ))}
        </ul>
      );
    }
    const picked = vi.fn();
    host(<Rows />);
    rightClick(screen.getByTestId("row-a"));
    // The row unmounts while the menu is open (a virtual list scrolling, for example).
    act(() => {
      screen.getByTestId("row-a").click();
    });
    fireEvent.click(screen.getByTestId("context-menu-item-pick"));
    expect(picked).toHaveBeenCalledWith("a");
  });
});

describe("ContextMenuHost in the desktop client", () => {
  it("suppresses the WebView menu everywhere but opens nothing without context", () => {
    host(<p data-testid="blank">blank</p>, true);
    expect(rightClick(screen.getByTestId("blank"))).toBe(true);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("offers open-in-browser for external links and no new tab for objects", () => {
    host(
      <Target provide={() => objectMenu()}>
        <a href="https://example.com/a" target="_blank" rel="noreferrer" data-testid="external">
          x
        </a>
      </Target>,
      true,
    );
    rightClick(screen.getByTestId("external"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["在浏览器中打开", "复制链接地址", "重命名"]);
  });

  it("offers no link rows for in-app links: only the object's rows, or nothing at all", () => {
    host(
      <>
        <Target provide={() => objectMenu()}>
          <a href="/contents/c1" data-testid="inside">
            x
          </a>
        </Target>
        <a href="/new" data-testid="nav">
          新总结
        </a>
      </>,
      true,
    );
    rightClick(screen.getByTestId("inside"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名"]);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
    });
    expect(rightClick(screen.getByTestId("nav"))).toBe(true);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("keeps the in-app link under the pointer for the object's own use", () => {
    let seen: MenuHit["anchor"];
    host(
      <Target
        provide={(hit) => {
          seen = hit.anchor;
          return objectMenu();
        }}
      >
        <a href="/contents/c1?segment=s1" data-testid="deep">
          x
        </a>
      </Target>,
      true,
    );
    rightClick(screen.getByTestId("deep"));
    expect(seen).toMatchObject({ kind: "internal", href: `${window.location.origin}/contents/c1?segment=s1` });
  });

  it("leaves text fields to the system edit menu", () => {
    host(<input data-testid="field" />, true);
    expect(rightClick(screen.getByTestId("field"))).toBe(false);
  });
});

describe("helpers", () => {
  it("treats only text-entry controls as editable", () => {
    const make = (html: string): Element => {
      const box = document.createElement("div");
      box.innerHTML = html;
      document.body.append(box);
      return box.firstElementChild as Element;
    };
    expect(isTextEditableTarget(make('<input type="text">'))).toBe(true);
    expect(isTextEditableTarget(make("<input>"))).toBe(true);
    expect(isTextEditableTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isTextEditableTarget(make('<div contenteditable="true"><span>x</span></div>').firstElementChild as Element)).toBe(true);
    expect(isTextEditableTarget(make('<input type="range">'))).toBe(false);
    expect(isTextEditableTarget(make('<input type="checkbox">'))).toBe(false);
    expect(isTextEditableTarget(make("<select><option>a</option></select>"))).toBe(false);
  });

  it("classifies links", () => {
    const anchor = (html: string): Element => {
      const box = document.createElement("div");
      box.innerHTML = html;
      return box.firstElementChild as Element;
    };
    const origin = "http://app.test";
    expect(linkAt(anchor('<a href="/contents/1">a</a>'), origin)?.kind).toBe("internal");
    expect(linkAt(anchor('<a href="https://x.test/">a</a>'), origin)?.kind).toBe("external");
    expect(linkAt(anchor('<a href="/x" target="_blank">a</a>'), origin)?.kind).toBe("external");
    expect(linkAt(anchor('<a href="mailto:a@b.test">a</a>'), origin)?.kind).toBe("mailto");
  });

  it("does not count a click on an unselected part of a partly selected element as inside the selection", () => {
    const span = document.createElement("span");
    span.textContent = "abcdefghij";
    document.body.append(span);
    const text = span.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: text, offset: 7 });
    expect(selectionAt(1, 1)).toBeUndefined();
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: text, offset: 1 });
    expect(selectionAt(1, 1)).toEqual({ text: "abc" });
    delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
    expect(selectionAt(1, 1)).toBeUndefined();
  });
});

describe("selectionAt with a region that keeps its own selection", () => {
  const read: RegionSelection = { version: 1, text: "甲 乙 丙", copyText: "甲\n乙\n丙", menuCopyText: "甲\n\n乙\n\n丙", sentenceCount: 3, crossesGap: false };

  /** Selects `text` inside a registered region and points the caret at `pointAt`. */
  function selectInRegion(text: string, answer: RegionSelection | undefined, pointAt = 1) {
    const region = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = text;
    region.append(span);
    document.body.append(region);
    const undo = registerSelectionSource(region, { current: { read: () => answer } });
    const node = span.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, text.length);
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: node, offset: pointAt });
    return () => {
      undo();
      region.remove();
    };
  }

  it("takes the region's menu copy text and reading", () => {
    const done = selectInRegion("甲乙", read);
    expect(selectionAt(1, 1)).toEqual({ text: "甲\n\n乙\n\n丙", region: read });
    done();
  });

  it("keeps the page's text and marks a region with nothing to work on", () => {
    const done = selectInRegion("陈明", undefined);
    expect(selectionAt(1, 1)).toEqual({ text: "陈明", region: null });
    done();
  });

  it("answers for a region's selection even when the page holds no text of it", () => {
    const done = selectInRegion("   ", read);
    expect(selectionAt(1, 1)).toEqual({ text: read.menuCopyText, region: read });
    done();
  });

  it("still requires the point to lie inside the selection", () => {
    const span = document.createElement("span");
    span.textContent = "外面";
    document.body.append(span);
    const done = selectInRegion("甲乙", read);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: span.firstChild, offset: 1 });
    expect(selectionAt(1, 1)).toBeUndefined();
    done();
    span.remove();
  });

  it("opens the region's menu for a keyboard menu whose point is off screen, inside the region", () => {
    host(
      <Target provide={(hit) => (hit.selection?.region == null ? undefined : { kind: "text", entries: [] })} testId="reader">
        <span data-testid="text">甲乙</span>
      </Target>,
    );
    const reader = screen.getByTestId("reader");
    const undo = registerSelectionSource(reader, { current: { read: () => read } });
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 200, width: 400, height: 300 });
    const node = screen.getByTestId("text").firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 2);
    window.getSelection()?.addRange(range);
    // The browser reports the selection's start, far above the window, and the page as target.
    expect(rightClick(document.documentElement, { clientX: 150, clientY: -2000 })).toBe(true);
    expect(screen.getByTestId("context-menu-item-copy-selection")).toBeTruthy();
    const anchor = screen.getByTestId("context-menu-anchor");
    expect(anchor.style.left).toBe("150px");
    expect(anchor.style.top).toBe("208px");
    undo();
  });

  it("leaves an off-screen point alone when no region keeps a selection", () => {
    host(<Target provide={() => objectMenu()} />);
    expect(rightClick(document.documentElement, { clientX: 150, clientY: -2000 })).toBe(false);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("puts the region's text into copy selection", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    host(
      <Target provide={() => objectMenu()}>
        <span data-testid="text">甲乙</span>
      </Target>,
    );
    const element = screen.getByTestId("text");
    const undo = registerSelectionSource(element, { current: { read: () => read } });
    const node = element.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 2);
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: node, offset: 1 });
    rightClick(element);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-selection"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(read.menuCopyText));
    undo();
  });
});
