import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { pasteTarget, registerImagePasteHandler, usePasteGuard, type NewPagePrefill } from "../../../src/web/shell/paste-guard.ts";

const URL_TEXT = "https://www.youtube.com/watch?v=UF8uR6Z6KLc";

describe("pasteTarget", () => {
  const base = { text: URL_TEXT, activeElement: document.body, dialogOpen: false, pathname: "/library" };

  it("triggers when all four guards hold", () => {
    expect(pasteTarget(base)).toBe(URL_TEXT);
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
  return <p data-testid="where">{`${location.pathname}|${(location.state as NewPagePrefill | null)?.prefill ?? ""}`}</p>;
}

function paste(text: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
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
