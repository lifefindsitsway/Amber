import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ChatComposer, ChatComposerProvider } from "../../../src/web/chat/chat-composer.tsx";
import { CHAT_MESSAGE_MAX_CHARS } from "../../../src/shared/defaults.ts";
import {
  explainIsTruncated,
  explainSelectionQuestion,
  selectionForExplain,
  SelectionToolbar,
  toolbarPosition,
  type SelectionRect,
  type SelectionSnapshot,
} from "../../../src/web/chat/selection-toolbar.tsx";
import { initI18n } from "../../../src/web/i18n.ts";
import { registerSelectionSource, type RegionSelection } from "../../../src/web/ui/selection-source.ts";

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

  it("leaves speaker headers and paragraph times out of a selection across two turns", () => {
    const turns = `<div data-revision-id="r1" data-explainable>
      <div data-turn-key="a"><div role="group" aria-label="陈明" data-turn-header data-reader-meta><button><span aria-hidden="true">陈</span><span id="n1">陈明</span></button></div>
        <p data-reader-text><button data-reading-time>0:00</button><span id="a" data-segment-id="s1">先看召回。</span></p></div>
      <div data-turn-key="b"><div role="group" aria-label="发言人 2" data-turn-header data-reader-meta><span><span aria-hidden="true">2</span><span id="n2">发言人 2</span></span></div>
        <p data-reader-text><button data-reading-time>0:08</button><span id="b" data-segment-id="s2">再看重排序。</span></p></div>
    </div>`;
    const selection = selectIn(turns, ["#n1", 0], ["#b", 6]);
    expect(selection.toString()).toContain("发言人 2");
    expect(selection.toString()).toContain("0:08");
    expect(selectionForExplain(selection)).toEqual({ text: "先看召回。 再看重排序。" });
  });

  it("keeps a chapter title inside the selection, without the heading's play button", () => {
    const chapter = `<div data-revision-id="r1" data-explainable>
      <p data-reader-text><button data-reading-time>0:40</button><span id="a" data-segment-id="s1">先看召回。</span></p>
      <div data-testid="transcript-chapter"><h3 data-testid="chapter-title"><span id="t">正文</span></h3><span><button data-testid="chapter-play" data-reader-meta aria-label="从 1:00 播放">播放</button></span></div>
      <p data-reader-text><button data-reading-time>1:00</button><span id="b" data-segment-id="s2">再看重排序。</span></p>
    </div>`;
    const selection = selectIn(chapter, ["#a", 0], ["#b", 6]);
    expect(selection.toString()).toContain("播放");
    expect(selectionForExplain(selection)).toEqual({ text: "先看召回。 正文 再看重排序。" });
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

describe("explain question cut", () => {
  const t = initI18n().t;
  const room = CHAT_MESSAGE_MAX_CHARS - t("chat.explainSelectionPrompt", { text: "" }).length;
  // With the u flag a class of surrogates matches only unpaired halves.
  const loneSurrogate = /[\uD800-\uDFFF]/u;

  it("never leaves half of a surrogate pair where an emoji straddles the cut", () => {
    // The cut keeps room - 1 units; the emoji's high half sits at the last kept unit.
    const text = `${"长".repeat(room - 2)}😀${"长".repeat(10)}`;
    expect(text.charCodeAt(room - 2)).toBe(0xd83d);
    const question = explainSelectionQuestion(t, text);
    expect(loneSurrogate.test(question)).toBe(false);
    expect(question.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_CHARS);
    expect(question.endsWith(`${"长".repeat(room - 2)}…」`)).toBe(true);
  });

  it("keeps a whole emoji that ends right at the cut, and short text unchanged", () => {
    const text = `${"长".repeat(room - 3)}😀${"长".repeat(10)}`;
    expect(explainSelectionQuestion(t, text).endsWith("😀…」")).toBe(true);
    expect(explainSelectionQuestion(t, "短😀")).toBe("解释一下「短😀」");
  });

  it("says whether the text will be cut", () => {
    expect(explainIsTruncated(t, "长".repeat(room))).toBe(false);
    expect(explainIsTruncated(t, "长".repeat(room + 1))).toBe(true);
  });
});

const box = (top: number, bottom: number, left = 100, right = left + 10): SelectionRect => ({ top, bottom, left, right, width: right - left, height: bottom - top });

describe("toolbarPosition", () => {
  const region = box(100, 500, 50, 650);
  const size = { width: 200, height: 30 };
  const place = (first: SelectionRect | undefined, focus: SelectionRect | undefined, over: Partial<Parameters<typeof toolbarPosition>[0]> = {}) =>
    toolbarPosition({ first, focus, region, size, viewportWidth: 1000, ...over });

  it("sits above the first line when it shows", () => {
    expect(place(box(200, 220), box(400, 420, 300))).toEqual({ top: 164, left: 100, anchor: "first" });
  });

  it("goes below the first line when there is no room above it", () => {
    expect(place(box(120, 140), undefined)).toEqual({ top: 146, left: 100, anchor: "first" });
  });

  it("sits below the released end when the first line is off screen", () => {
    expect(place(box(0, 20), box(300, 320, 400))).toEqual({ top: 326, left: 400, anchor: "focus" });
    expect(place(undefined, box(300, 320, 400))).toEqual({ top: 326, left: 400, anchor: "focus" });
  });

  it("goes above the released end when there is no room below it", () => {
    expect(place(box(0, 20), box(470, 490, 400))).toEqual({ top: 434, left: 400, anchor: "focus" });
  });

  it("falls back to the region's top edge when neither end shows", () => {
    expect(place(box(0, 20), box(600, 620))).toEqual({ top: 108, left: 58, anchor: "region" });
    expect(place(undefined, undefined)).toEqual({ top: 108, left: 58, anchor: "region" });
  });

  it("treats a box that only touches the region's edge as off screen", () => {
    expect(place(box(80, 100), box(500, 520)).anchor).toBe("region");
  });

  it("stays inside the region at every edge", () => {
    // Right: the region's edge, then the viewport's when it is narrower.
    expect(place(box(200, 220, 600), undefined).left).toBe(442);
    expect(place(box(200, 220, 600), undefined, { viewportWidth: 500 }).left).toBe(292);
    // Left.
    expect(place(box(200, 220, 0), undefined).left).toBe(58);
    expect(place(box(200, 220, 0), undefined, { region: box(100, 500, -20, 650) }).left).toBe(8);
    // Bottom: below a tall first line.
    expect(place(box(101, 499), undefined).top).toBe(462);
    // Top: above a tall released end.
    expect(place(undefined, box(110, 490)).top).toBe(108);
  });

  it("keeps to the region's top left corner when the region is smaller than the toolbar", () => {
    expect(place(box(200, 220, 300), undefined, { region: box(100, 500, 50, 150) }).left).toBe(58);
    expect(place(box(105, 115), undefined, { region: box(100, 120, 50, 650) }).top).toBe(108);
  });
});

const BOUNDS = { revisionId: "r1", start: { segmentId: "s1", offset: 0 }, end: { segmentId: "s2", offset: 2 } };

function reading(over: Partial<RegionSelection> = {}): RegionSelection {
  return {
    version: 1,
    text: "先看召回。 再看",
    quote: { transcriptRevisionId: "r1", segmentId: "s1" as never, text: "先看召回。" },
    copyText: "先看召回。\n再看",
    menuCopyText: "先看召回。\n\n再看",
    bounds: BOUNDS,
    sentenceCount: 2,
    crossesGap: true,
    ...over,
  };
}

/** Counts mounts of the extra actions, so a kept snapshot can be told from a new one. */
function Mounted(props: { onMount: () => void }) {
  const { onMount } = props;
  useEffect(onMount, [onMount]);
  return <button type="button" data-testid="extra-action" />;
}

/**
 * A region that keeps its own account of the selection, not marked explainable for the page
 * reading; `prepare` runs before the selection is released.
 */
function renderSourced(read: { current: RegionSelection | undefined }, prepare?: (region: HTMLElement) => void) {
  const composer = new ChatComposer();
  const seen: SelectionSnapshot[] = [];
  const mounts = { count: 0 };
  const onMount = (): void => {
    mounts.count += 1;
  };
  render(
    <ChatComposerProvider composer={composer}>
      <div data-testid="region">
        <p>
          <span id="a">先看召回。</span>
          <span id="b">再看重排序。</span>
        </p>
      </div>
      <SelectionToolbar
        actions={(snapshot) => {
          seen.push(snapshot);
          return <Mounted onMount={onMount} />;
        }}
      />
    </ChatComposerProvider>,
  );
  const region = screen.getByTestId("region");
  onTestFinished(registerSelectionSource(region, { current: { read: () => read.current } }));
  const range = document.createRange();
  range.setStart(document.querySelector("#a")?.firstChild as Text, 0);
  range.setEnd(document.querySelector("#b")?.firstChild as Text, 2);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  prepare?.(region);
  fireEvent.mouseUp(document);
  return { composer, seen, mounts, region };
}

/** Stubs the geometry jsdom lacks: the range's lines, the caret at its focus, the region and the toolbar size. */
function stubGeometry(region: HTMLElement, boxes: { first: SelectionRect | undefined; focus: SelectionRect; region: SelectionRect }) {
  const restore: Array<() => void> = [];
  const stub = (target: object, key: string, descriptor: PropertyDescriptor): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restore.push(() => {
      if (original === undefined) delete (target as Record<string, unknown>)[key];
      else Object.defineProperty(target, key, original);
    });
  };
  const rect = (b: SelectionRect): DOMRect => DOMRect.fromRect({ x: b.left, y: b.top, width: b.width, height: b.height });
  stub(Range.prototype, "getClientRects", {
    value(this: Range) {
      if (this.collapsed) return [rect(boxes.focus)];
      return boxes.first === undefined ? [] : [rect(boxes.first)];
    },
  });
  stub(Range.prototype, "getBoundingClientRect", { value: () => rect(boxes.first ?? boxes.focus) });
  stub(HTMLElement.prototype, "offsetWidth", { get: () => 200 });
  stub(HTMLElement.prototype, "offsetHeight", { get: () => 30 });
  stub(window, "innerWidth", { value: 1000 });
  region.getBoundingClientRect = () => rect(boxes.region);
  onTestFinished(() => {
    for (const undo of restore.reverse()) undo();
  });
}

describe("SelectionToolbar with a region that keeps its own selection", () => {
  it("reads a selection outside every such region off the page, without a version or count", async () => {
    renderToolbar();
    const toolbar = await screen.findByTestId("selection-toolbar");
    expect(toolbar.hasAttribute("data-selection-version")).toBe(false);
    expect(screen.queryByTestId("selection-count")).toBeNull();
  });

  it("explains the region's text and quote, not the page's", async () => {
    const { composer } = renderSourced({ current: reading({ text: "整段文字", quote: { transcriptRevisionId: "r9", segmentId: "s9" as never, text: "整句" } }) });
    fireEvent.click(await screen.findByTestId("selection-explain"));
    expect(composer.snapshot().prefill?.text).toBe("解释一下「整段文字」");
    expect(composer.snapshot().quote).toEqual({ transcriptRevisionId: "r9", segmentId: "s9", text: "整句" });
  });

  it("copies the region's copy text", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderSourced({ current: reading() });
    fireEvent.click(await screen.findByTestId("selection-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("先看召回。\n再看"));
  });

  it("hands the actions the region's bounds, sentence count and gap", async () => {
    const { seen } = renderSourced({ current: reading({ version: 7 }) });
    await screen.findByTestId("extra-action");
    expect(seen.at(-1)).toMatchObject({ bounds: BOUNDS, sentenceCount: 2, crossesGap: true, version: 7 });
    expect(screen.getByTestId("selection-toolbar").getAttribute("data-selection-version")).toBe("7");
  });

  it("shows nothing when the region has nothing to work on", () => {
    renderSourced({ current: undefined });
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("keeps the snapshot for a second release of the same selection and takes a new one for a new selection", async () => {
    const read = { current: reading({ version: 3, text: "第一次" }) };
    const { seen, mounts } = renderSourced(read);
    await screen.findByTestId("extra-action");
    expect(mounts.count).toBe(1);
    // Same version: the same selection, even if a later read were to differ.
    read.current = reading({ version: 3, text: "不该取到" });
    fireEvent.keyUp(document);
    fireEvent.mouseUp(document);
    expect(mounts.count).toBe(1);
    expect(seen.at(-1)?.text).toBe("第一次");
    read.current = reading({ version: 4, text: "第二次" });
    fireEvent.keyUp(document);
    await waitFor(() => expect(mounts.count).toBe(2));
    expect(seen.at(-1)?.text).toBe("第二次");
    expect(screen.getByTestId("selection-toolbar").getAttribute("data-selection-version")).toBe("4");
  });

  it("closes when the region later has nothing to work on", async () => {
    const read: { current: RegionSelection | undefined } = { current: reading() };
    renderSourced(read);
    await screen.findByTestId("selection-toolbar");
    read.current = undefined;
    fireEvent.mouseUp(document);
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("places itself beside the released end when the first line is off screen", async () => {
    renderSourced({ current: reading() }, (region) => stubGeometry(region, { first: box(0, 20), focus: box(300, 320, 400, 400), region: box(100, 500, 50, 650) }));
    const toolbar = await screen.findByTestId("selection-toolbar");
    await waitFor(() => expect(toolbar.style.top).toBe("326px"));
    expect(toolbar.style.left).toBe("400px");
  });

  it("follows the selection to where it lies after the window was resized, keeping the snapshot", async () => {
    const boxes = { first: box(200, 220, 120), focus: box(300, 320, 400, 400), region: box(100, 500, 50, 650) };
    const { mounts } = renderSourced({ current: reading() }, (region) => stubGeometry(region, boxes));
    const toolbar = await screen.findByTestId("selection-toolbar");
    expect(toolbar.style.top).toBe("164px");
    // The pane moved and reflowed: the first line now sits elsewhere.
    boxes.first = box(260, 280, 90);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(toolbar.style.top).toBe("224px"));
    expect(toolbar.style.left).toBe("90px");
    expect(mounts.count).toBe(1);
  });

  it("follows the selection as its region scrolls, down to the region's edge when both ends are out of view", async () => {
    const boxes: { first: SelectionRect | undefined; focus: SelectionRect; region: SelectionRect } = { first: box(200, 220, 120), focus: box(300, 320, 400, 400), region: box(100, 500, 50, 650) };
    const { mounts, region } = renderSourced({ current: reading() }, (element) => stubGeometry(element, boxes));
    const toolbar = await screen.findByTestId("selection-toolbar");
    expect(toolbar.style.top).toBe("164px");
    // Scrolled: the first line left the region, the released end is still in it.
    boxes.first = box(-300, -280, 120);
    boxes.focus = box(150, 170, 400, 400);
    fireEvent.scroll(region);
    await waitFor(() => expect(toolbar.style.top).toBe("176px"));
    // Scrolled on: both ends are out of view.
    boxes.focus = box(-100, -80, 400, 400);
    fireEvent.scroll(region);
    await waitFor(() => expect(toolbar.style.top).toBe("108px"));
    expect(toolbar.style.left).toBe("58px");
    expect(mounts.count).toBe(1);
  });

  it("hands a follow-up the selection's own box while it lies inside the region, and the end in view once it runs beyond", async () => {
    const boxes: { first: SelectionRect | undefined; focus: SelectionRect; region: SelectionRect } = { first: box(200, 220, 120), focus: box(300, 320, 400, 400), region: box(100, 500, 50, 650) };
    const { seen, region } = renderSourced({ current: reading() }, (element) => stubGeometry(element, boxes));
    await screen.findByTestId("selection-toolbar");
    // The stubbed range is as tall as its first line: inside the region, it is its own box.
    expect(seen.at(-1)?.rect).toMatchObject({ top: 200, bottom: 220 });
    // Scrolled: the selection starts far above the region now and the released end is in view.
    boxes.first = box(-3000, -2980, 120);
    fireEvent.scroll(region);
    await waitFor(() => expect(seen.at(-1)?.rect).toMatchObject({ top: 300, bottom: 320, left: 400 }));
  });

  it("stays where it is when something other than its region scrolls", async () => {
    const boxes = { first: box(200, 220, 120), focus: box(300, 320, 400, 400), region: box(100, 500, 50, 650) };
    renderSourced({ current: reading() }, (element) => stubGeometry(element, boxes));
    const toolbar = await screen.findByTestId("selection-toolbar");
    const aside = document.createElement("div");
    document.body.append(aside);
    onTestFinished(() => aside.remove());
    boxes.first = box(260, 280, 90);
    fireEvent.scroll(aside);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(toolbar.style.top).toBe("164px");
  });

  it("does not bring back a toolbar that was dismissed when the window is resized", async () => {
    renderSourced({ current: reading() });
    fireEvent.click(await screen.findByTestId("selection-copy"));
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
    fireEvent(window, new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("places itself above the first line when it shows", async () => {
    renderSourced({ current: reading() }, (region) => stubGeometry(region, { first: box(200, 220, 120), focus: box(300, 320, 400, 400), region: box(100, 500, 50, 650) }));
    const toolbar = await screen.findByTestId("selection-toolbar");
    expect(toolbar.style.top).toBe("164px");
    expect(toolbar.style.left).toBe("120px");
  });

  describe("count hint", () => {
    const t = initI18n().t;
    const room = CHAT_MESSAGE_MAX_CHARS - t("chat.explainSelectionPrompt", { text: "" }).length;

    function open(over: Partial<RegionSelection>, firstShows: boolean): HTMLElement | null {
      renderSourced({ current: reading(over) }, (region) => stubGeometry(region, { first: firstShows ? box(200, 220) : box(0, 20), focus: box(300, 320), region: box(100, 500, 50, 650) }));
      expect(screen.getByTestId("selection-toolbar")).toBeTruthy();
      return screen.queryByTestId("selection-count");
    }

    it("says nothing for one sentence", () => {
      expect(open({ sentenceCount: 1 }, false)).toBeNull();
    });

    it("says nothing when both ends show and explain takes it whole", () => {
      expect(open({ sentenceCount: 3 }, true)).toBeNull();
    });

    it("counts the sentences when an end is off screen", () => {
      const hint = open({ sentenceCount: 3 }, false);
      expect(hint?.textContent).toBe("已选 3 句");
      expect(hint?.parentElement?.firstElementChild).toBe(hint);
    });

    it("says explain takes only the beginning when the text is too long, wherever its ends are", () => {
      expect(open({ sentenceCount: 1, text: "长".repeat(room + 1) }, true)?.textContent).toBe("已选 1 句 · 解释只取开头部分");
    });

    it("says nothing without geometry to tell what shows", () => {
      renderSourced({ current: reading({ sentenceCount: 5 }) });
      expect(screen.getByTestId("selection-toolbar")).toBeTruthy();
      expect(screen.queryByTestId("selection-count")).toBeNull();
    });
  });
});
