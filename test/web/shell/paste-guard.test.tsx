import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { pasteTarget, registerImagePasteHandler, usePasteGuard, type NewPagePrefill } from "../../../src/web/shell/paste-guard.ts";
import { LONG_SHARE, SHORT, UNSUPPORTED, VIDEO_2, WEB_SHARE, WEB_SHARE_LINK, YT_LIST, YT_VIDEO } from "../../fixtures/platform/share-text.ts";

const URL_TEXT = "https://www.youtube.com/watch?v=UF8uR6Z6KLc";

describe("pasteTarget", () => {
  const base = { text: URL_TEXT, activeElement: document.body, dialogOpen: false, pathname: "/library" };

  it("triggers when all four guards hold", () => {
    expect(pasteTarget(base)).toEqual({ prefill: URL_TEXT });
  });

  it("prefills a share text's links alone, one per line, unsupported ones too, with a note of how many", () => {
    expect(pasteTarget({ ...base, text: WEB_SHARE })).toEqual({ prefill: WEB_SHARE_LINK, pasteNote: 1 });
    expect(pasteTarget({ ...base, text: LONG_SHARE })).toEqual({ prefill: [WEB_SHARE_LINK, `${VIDEO_2}?p=3`, YT_VIDEO, UNSUPPORTED, YT_LIST].join("\n"), pasteNote: 5 });
    // Links alone on one line are put one per line, with nothing to point out.
    expect(pasteTarget({ ...base, text: `${YT_VIDEO} ${SHORT}` })).toEqual({ prefill: `${YT_VIDEO}\n${SHORT}` });
  });

  it("leaves text with unsupported links only as an ordinary paste", () => {
    expect(pasteTarget({ ...base, text: `看这个 ${UNSUPPORTED}` })).toBeUndefined();
    expect(pasteTarget({ ...base, text: `${UNSUPPORTED}\nhttps://youtu.be/UF8uR6Z6KLc/` })).toBeUndefined();
  });

  it("keeps an ordinary paste when any guard fails", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editor.append(inner);
    expect(pasteTarget({ ...base, activeElement: input })).toBeUndefined();
    expect(pasteTarget({ ...base, activeElement: document.createElement("textarea") })).toBeUndefined();
    expect(pasteTarget({ ...base, activeElement: inner })).toBeUndefined();
    expect(pasteTarget({ ...base, dialogOpen: true })).toBeUndefined();
    expect(pasteTarget({ ...base, text: "just some words" })).toBeUndefined();
    expect(pasteTarget({ ...base, pathname: "/new" })).toBeUndefined();
  });
});

function Probe() {
  usePasteGuard();
  const location = useLocation();
  const state = location.state as NewPagePrefill | null;
  return <p data-testid="where">{`${location.pathname}|${state?.prefill ?? ""}${state?.pasteNote === undefined ? "" : `|${state.pasteNote}`}`}</p>;
}

function paste(text: string, options: { image?: boolean } = {}): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  const items = options.image === true ? [{ kind: "file", type: "image/png" }] : [];
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text, items } });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

describe("usePasteGuard", () => {
  it("navigates to /new with the link prefilled and swallows the paste", () => {
    render(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    const event = paste(URL_TEXT);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("where").textContent).toBe(`/new|${URL_TEXT}`);
  });

  it("does nothing while a dialog is open", () => {
    render(
      <MemoryRouter initialEntries={["/library"]}>
        <div role="dialog" />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    const event = paste(URL_TEXT);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId("where").textContent).toBe("/library|");
  });

  it("takes a share text to /new with its links and the paste note", () => {
    render(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(paste(WEB_SHARE).defaultPrevented).toBe(true);
    expect(screen.getByTestId("where").textContent).toBe(`/new|${WEB_SHARE_LINK}|1`);
  });

  it("does not jump for text whose only link is unsupported", () => {
    render(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(paste(`看这个 ${UNSUPPORTED}`).defaultPrevented).toBe(false);
    expect(screen.getByTestId("where").textContent).toBe("/library|");
  });
});

describe("usePasteGuard with focus on a dropdown or in a menu", () => {
  function focusIn(markup: string, selector: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = markup;
    document.body.append(host);
    const target = host.querySelector<HTMLElement>(selector) as HTMLElement;
    target.focus();
    expect(document.activeElement).toBe(target);
    return host;
  }

  it.each([
    ["a dropdown trigger", '<button type="button" role="combobox" aria-expanded="false">AI 模型</button>', "button"],
    ["an option of an open list", '<div role="listbox"><div role="option" tabindex="-1" aria-selected="false">gpt-6-sol</div></div>', "[role=option]"],
    ["an item of an open menu", '<div role="menu"><div role="menuitem" tabindex="-1">导出</div></div>', "[role=menuitem]"],
    ["the menu itself", '<div role="menu" tabindex="-1"><div role="menuitem">导出</div></div>', "[role=menu]"],
    ["a combobox text field", '<input role="combobox" aria-expanded="true" />', "input"],
  ])("neither jumps, inserts an image, nor takes the paste: %s", (_name, markup, selector) => {
    const handler = vi.fn(() => true);
    const remove = registerImagePasteHandler(handler);
    const host = focusIn(markup, selector);
    try {
      render(
        <MemoryRouter initialEntries={["/contents/c1"]}>
          <Routes>
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(paste(WEB_SHARE).defaultPrevented).toBe(false);
      expect(paste("").defaultPrevented).toBe(false);
      expect(screen.getByTestId("where").textContent).toBe("/contents/c1|");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      remove();
      host.remove();
    }
  });
});

describe("the image paste handler", () => {
  function pasteWith(text: string): ClipboardEvent {
    return paste(text);
  }

  function renderGuard() {
    render(
      <MemoryRouter initialEntries={["/contents/c1"]}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("is asked only when the paste is no link gesture, and its answer decides the default", () => {
    const seen: Array<{ dialogOpen: boolean }> = [];
    let handles = true;
    const remove = registerImagePasteHandler((_event, context) => {
      seen.push({ dialogOpen: context.dialogOpen });
      return handles;
    });
    try {
      renderGuard();
      // A link wins: the handler is never asked.
      expect(pasteWith(URL_TEXT).defaultPrevented).toBe(true);
      expect(seen).toHaveLength(0);
      expect(screen.getByTestId("where").textContent).toBe(`/new|${URL_TEXT}`);
    } finally {
      remove();
    }
    const again = registerImagePasteHandler((_event, context) => {
      seen.push({ dialogOpen: context.dialogOpen });
      return handles;
    });
    try {
      cleanup();
      renderGuard();
      expect(pasteWith("just some words").defaultPrevented).toBe(true);
      handles = false;
      expect(pasteWith("").defaultPrevented).toBe(false);
      expect(seen).toEqual([{ dialogOpen: false }, { dialogOpen: false }]);
    } finally {
      again();
    }
  });

  it("keeps an image with a link merely mentioned in its text, but still jumps for a line that is a link", () => {
    const handler = vi.fn(() => true);
    const remove = registerImagePasteHandler(handler);
    try {
      renderGuard();
      expect(paste(`详见 ${URL_TEXT} 。`, { image: true }).defaultPrevented).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("where").textContent).toBe("/contents/c1|");
      expect(paste(`配图说明\n${URL_TEXT}`, { image: true }).defaultPrevented).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("where").textContent).toBe(`/new|${URL_TEXT}|1`);
    } finally {
      remove();
    }
  });

  it("is gone once removed, and a stale removal leaves a newer handler in place", () => {
    const calls: string[] = [];
    const removeFirst = registerImagePasteHandler(() => {
      calls.push("first");
      return true;
    });
    const removeSecond = registerImagePasteHandler(() => {
      calls.push("second");
      return true;
    });
    removeFirst();
    renderGuard();
    pasteWith("");
    removeSecond();
    pasteWith("");
    expect(calls).toEqual(["second"]);
  });
});
