import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ChatComposer, ChatComposerProvider } from "../../../../src/web/chat/chat-composer.tsx";
import { initI18n } from "../../../../src/web/i18n.ts";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { explainSelectionEntries, useSentenceMenu, type SentenceData } from "../../../../src/web/pages/content/sentence-menu.tsx";
import { ContextMenuHost, type MenuHit } from "../../../../src/web/ui/context-menu.tsx";
import { registerSelectionSource, type RegionSelection } from "../../../../src/web/ui/selection-source.ts";
import { pageState } from "../../../fixtures/web/reader-speakers.tsx";

const t = initI18n().t;

const READ: RegionSelection = {
  version: 1,
  text: "正文 先看召回。",
  quote: { transcriptRevisionId: "r1", segmentId: "s1" as never, text: "先看召回。" },
  copyText: "正文\n先看召回。",
  menuCopyText: "正文\n\n先看召回。",
  sentenceCount: 1,
  crossesGap: false,
};

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
});

describe("explainSelectionEntries", () => {
  const target = (): Element => document.body;

  it("offers nothing when the region answering for the selection has nothing to work on", () => {
    expect(explainSelectionEntries({ target: target(), selection: { text: "陈明", region: null } }, t, vi.fn())).toEqual([]);
  });

  it("explains the region's text and quote, without reading the page", () => {
    const explain = vi.fn();
    const entries = explainSelectionEntries({ target: target(), selection: { text: READ.menuCopyText, region: READ } }, t, explain);
    expect(entries.map((entry) => entry.id)).toEqual(["explain-selection"]);
    entries[0]?.onSelect();
    expect(explain).toHaveBeenCalledWith(READ.quote, "解释一下「正文 先看召回。」");
  });

  it("quotes nothing when the region's selection spans sentences", () => {
    const explain = vi.fn();
    const { quote: _quote, ...spanning } = READ;
    explainSelectionEntries({ target: target(), selection: { text: "x", region: spanning } }, t, explain)[0]?.onSelect();
    expect(explain).toHaveBeenCalledWith(undefined, "解释一下「正文 先看召回。」");
  });

  it("reads the page when no region answers", () => {
    document.body.innerHTML = `<div data-revision-id="r1" data-explainable><span data-segment-id="s1">再看重排序。</span></div>`;
    onTestFinished(() => {
      document.body.innerHTML = "";
    });
    const node = document.querySelector("[data-segment-id]")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 5);
    window.getSelection()?.addRange(range);
    const explain = vi.fn();
    const hit: MenuHit = { target: target(), selection: { text: "重排序" } };
    explainSelectionEntries(hit, t, explain)[0]?.onSelect();
    expect(explain).toHaveBeenCalledWith({ transcriptRevisionId: "r1", segmentId: "s1", text: "再看重排序。" }, "解释一下「重排序」");
    expect(explainSelectionEntries({ target: target() }, t, vi.fn())).toEqual([]);
  });
});

const SENTENCES: Record<string, SentenceData> = { s1: { text: "先看召回。", startMs: 0 } };

function SentenceList(props: { onChangeSpeaker?: (segmentId: string) => void }) {
  const ref = useSentenceMenu<HTMLDivElement>((id) => SENTENCES[id], { explainSentence: false, ...(props.onChangeSpeaker === undefined ? {} : { onChangeSpeaker: props.onChangeSpeaker }) });
  return (
    <div ref={ref} data-testid="list" data-revision-id="r1" data-explainable>
      <h3 data-testid="title">正文</h3>
      <p>
        <span data-segment-id="s1">先看召回。</span>
      </p>
    </div>
  );
}

function mount(withComposer = true, onChangeSpeaker?: (segmentId: string) => void) {
  const list = <SentenceList {...(onChangeSpeaker === undefined ? {} : { onChangeSpeaker })} />;
  render(
    <MemoryRouter>
      <ContextMenuHost blockNative={false}>
        <ContentPageProvider value={pageState()}>{withComposer ? <ChatComposerProvider composer={new ChatComposer()}>{list}</ChatComposerProvider> : list}</ContentPageProvider>
      </ContextMenuHost>
    </MemoryRouter>,
  );
}

/** Selects the title through the sentence; with `read`, the list answers for the selection itself. */
function selectAll(read?: RegionSelection): void {
  const list = screen.getByTestId("list");
  if (read !== undefined) onTestFinished(registerSelectionSource(list, { current: { read: () => read } }));
  const title = screen.getByTestId("title").firstChild as Text;
  const sentence = document.querySelector("[data-segment-id='s1']")?.firstChild as Text;
  const range = document.createRange();
  range.setStart(title, 0);
  range.setEnd(sentence, 5);
  window.getSelection()?.addRange(range);
}

/** Right-clicks `element` with the caret inside the selection; reports the menu's row ids, or undefined when the browser menu stays. */
function rightClick(element: Element): string[] | undefined {
  const node = element.firstChild as Text;
  (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: node, offset: 1 });
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  if (!event.defaultPrevented) return undefined;
  return screen.getAllByRole("menuitem").map((item) => item.getAttribute("data-testid")?.replace("context-menu-item-", "") ?? "");
}

describe("useSentenceMenu", () => {
  it("offers the selection rows off a sentence inside a selection its region answers for", () => {
    mount();
    selectAll(READ);
    expect(rightClick(screen.getByTestId("title"))).toEqual(["copy-selection", "explain-selection"]);
  });

  it("offers only copy selection there without a chat input", () => {
    mount(false);
    selectAll(READ);
    expect(rightClick(screen.getByTestId("title"))).toEqual(["copy-selection"]);
  });

  it("leaves the browser menu off a sentence when no region answers, or the region has nothing to work on", () => {
    mount();
    selectAll();
    expect(rightClick(screen.getByTestId("title"))).toBeUndefined();
    window.getSelection()?.removeAllRanges();
    onTestFinished(registerSelectionSource(screen.getByTestId("list"), { current: { read: () => undefined } }));
    selectAll();
    expect(rightClick(screen.getByTestId("title"))).toBeUndefined();
  });

  it("keeps the sentence rows, in order, on a sentence inside the selection", () => {
    mount();
    selectAll(READ);
    expect(rightClick(document.querySelector("[data-segment-id='s1']") as Element)).toEqual(["copy-selection", "explain-selection", "play-from-here", "copy-sentence", "copy-sentence-with-time"]);
  });

  it("offers 「更改发言人…」 for the right-clicked sentence only where the view can change it", () => {
    const changeSpeaker = vi.fn();
    mount(true, changeSpeaker);
    const sentence = document.querySelector("[data-segment-id='s1']") as Element;
    expect(rightClick(sentence)).toEqual(["play-from-here", "copy-sentence", "copy-sentence-with-time", "change-speaker"]);
    expect(screen.getByTestId("context-menu-item-change-speaker").textContent).toContain("更改发言人…");
    act(() => {
      screen.getByTestId("context-menu-item-change-speaker").click();
    });
    expect(changeSpeaker).toHaveBeenCalledWith("s1");
  });

  it("has no 「更改发言人…」 without the way to change it", () => {
    mount();
    expect(rightClick(document.querySelector("[data-segment-id='s1']") as Element)).toEqual(["play-from-here", "copy-sentence", "copy-sentence-with-time"]);
  });
});
