import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, ChatComposerProvider } from "../../../src/web/chat/chat-composer.tsx";
import { CHAT_MESSAGE_MAX_CHARS } from "../../../src/shared/defaults.ts";
import { explainSelectionQuestion, selectionForExplain, SelectionToolbar, type SelectionSnapshot } from "../../../src/web/chat/selection-toolbar.tsx";
import { initI18n } from "../../../src/web/i18n.ts";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  delete (document as unknown as Record<string, unknown>)["execCommand"];
});

function renderToolbar() {
  const composer = new ChatComposer();
  render(
    <ChatComposerProvider composer={composer}>
      <div data-revision-id="r1" data-explainable>
        <span data-segment-id="s1">再看重排序。</span>
      </div>
      <SelectionToolbar />
    </ChatComposerProvider>,
  );
  const text = document.querySelector("[data-segment-id='s1']")?.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 5);
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(document);
  return composer;
}

describe("SelectionToolbar", () => {
  it("quotes the sentence when the selection stays inside it", () => {
    renderToolbar();
    expect(selectionForExplain(window.getSelection())).toEqual({ text: "重排序", quote: { transcriptRevisionId: "r1", segmentId: "s1", text: "再看重排序。" } });
  });

  it("puts the selected text into the question and attaches the quote", async () => {
    const composer = renderToolbar();
    fireEvent.click(await screen.findByTestId("selection-explain"));
    expect(composer.snapshot().prefill?.text).toBe("解释一下「重排序」");
    expect(composer.snapshot().quote?.segmentId).toBe("s1");
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it("copies the selected text and keeps the selection", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderToolbar();
    fireEvent.click(await screen.findByTestId("selection-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("重排序"));
    expect(window.getSelection()?.toString()).toBe("重排序");
  });

  it("keeps the selection when copying falls back to the legacy path", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderToolbar();
    fireEvent.click(await screen.findByTestId("selection-copy"));
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(window.getSelection()?.toString()).toBe("重排序");
  });
});

/** Selects from (startNode, startOffset) to (endNode, endOffset) in what `markup` renders. */
function selectIn(markup: string, from: [string, number], to: [string, number]): Selection {
  document.body.innerHTML = markup;
  const node = (selector: string): Text => document.querySelector(selector)?.firstChild as Text;
  const range = document.createRange();
  range.setStart(node(from[0]), from[1]);
  range.setEnd(node(to[0]), to[1]);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

const READING = `<div data-revision-id="r1" data-explainable><p><button data-reading-time>0:40</button><span id="a" data-segment-id="s1">先看召回。</span>，<span id="b" data-segment-id="s2">再看重排序。</span></p></div>`;

describe("selectionForExplain", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("takes the whole text of a selection across sentences, without the paragraph time, and quotes nothing", () => {
    const selection = selectIn(READING, ["button", 0], ["#b", 6]);
    expect(selection.toString()).toContain("0:40");
    expect(selectionForExplain(selection)).toEqual({ text: "先看召回。，再看重排序。" });
  });

  it("quotes a whole sentence whose drag ends at the start of what follows or starts at the end of what precedes", () => {
    const quoted = { quote: { transcriptRevisionId: "r1", segmentId: "s2", text: "再看重排序。" } };
    const tail = `<div data-revision-id="r1" data-explainable><p><span id="a" data-segment-id="s1">先看召回。</span><span id="b" data-segment-id="s2">再看重排序。</span><span id="c" data-segment-id="s3">最后生成。</span></p></div>`;
    expect(selectionForExplain(selectIn(tail, ["#b", 0], ["#c", 0]))).toMatchObject({ text: "再看重排序。", ...quoted });
    expect(selectionForExplain(selectIn(tail, ["#a", 5], ["#b", 6]))).toMatchObject({ text: "再看重排序。", ...quoted });
  });

  it("quotes nothing when the selection ends in another sentence", () => {
    expect(selectionForExplain(selectIn(READING, ["#a", 2], ["#b", 2]))).toEqual({ text: "召回。，再看" });
  });

  it("drops citation badges from summary text", () => {
    const summary = `<div data-explainable><p><span id="t">讲了重排序 </span><button data-citation="s2">1:15</button><span id="u">。下一步</span><span data-citation="unresolved">引用无法定位</span></p></div>`;
    expect(selectionForExplain(selectIn(summary, ["#t", 0], ["#u", 4]))).toEqual({ text: "讲了重排序。下一步" });
  });

  it("offers nothing outside an explainable region", () => {
    expect(selectionForExplain(selectIn(`<p><span id="x">聊天消息里的字</span></p>`, ["#x", 0], ["#x", 3]))).toBeUndefined();
  });

  it("cuts an overlong selection so the whole question stays within the chat limit", () => {
    const question = explainSelectionQuestion(initI18n().t, "长".repeat(CHAT_MESSAGE_MAX_CHARS));
    expect(question.length).toBe(CHAT_MESSAGE_MAX_CHARS);
    expect(question.endsWith("…」")).toBe(true);
    expect(explainSelectionQuestion(initI18n().t, "短")).toBe("解释一下「短」");
  });
});

describe("SelectionToolbar actions", () => {
  function renderWithActions(markup: "notes" | "plain") {
    const seen: SelectionSnapshot[] = [];
    render(
      <ChatComposerProvider composer={new ChatComposer()}>
        <div data-revision-id="r1" data-explainable {...(markup === "notes" ? { "data-notes": "" } : {})}>
          <span data-segment-id="s1">
            再看<mark>重排</mark>序。
          </span>
        </div>
        <SelectionToolbar
          actions={(snapshot, close) => {
            seen.push(snapshot);
            return (
              <button type="button" data-testid="extra-action" onClick={close}>
                x
              </button>
            );
          }}
        />
      </ChatComposerProvider>,
    );
    const mark = document.querySelector("mark")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(document.querySelector("[data-segment-id='s1']")?.firstChild as Text, 1);
    range.setEnd(mark, 1);
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(document);
    return seen;
  }

  it("hands extra actions a frozen snapshot with sentence bounds in a reading view that takes notes", async () => {
    const seen = renderWithActions("notes");
    expect(await screen.findByTestId("extra-action")).toBeTruthy();
    expect(seen.at(-1)).toMatchObject({ text: "看重", copyText: "看重", bounds: { revisionId: "r1", start: { segmentId: "s1", offset: 1 }, end: { segmentId: "s1", offset: 3 } } });
    // Releasing the mouse on the toolbar itself does not re-take the snapshot.
    const count = seen.length;
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(screen.getByTestId("extra-action"));
    expect(seen.length).toBe(count);
    fireEvent.click(screen.getByTestId("extra-action"));
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("gives no bounds outside a view that takes notes, and keeps explain and copy", async () => {
    const seen = renderWithActions("plain");
    expect(await screen.findByTestId("selection-explain")).toBeTruthy();
    expect(screen.getByTestId("selection-copy")).toBeTruthy();
    expect(seen.at(-1)?.bounds).toBeUndefined();
  });

  it("stays inside the viewport however far right the selection is", async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const geometry = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => DOMRect.fromRect({ x: 480, y: 100, width: 10, height: 20 }) });
    try {
      renderWithActions("notes");
      const toolbar = await screen.findByTestId("selection-toolbar");
      await waitFor(() => expect(toolbar.style.left).toBe("292px"));
      expect(toolbar.style.top).toBe("64px");
    } finally {
      for (const [target, key, descriptor] of [
        [HTMLElement.prototype, "offsetWidth", width],
        [Range.prototype, "getBoundingClientRect", geometry],
      ] as const) {
        if (descriptor === undefined) delete (target as unknown as Record<string, unknown>)[key];
        else Object.defineProperty(target, key, descriptor);
      }
    }
  });
});
