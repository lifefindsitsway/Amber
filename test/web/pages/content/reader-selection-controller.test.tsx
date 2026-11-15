import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { RESTORE_MAX_FRAMES, useReaderSelection, type ReaderSelectionHandle, type ReaderSelectionInput } from "../../../../src/web/pages/content/reader-selection-controller.ts";
import type { ReaderPoint, ReaderSelectionRead, SelectionRow } from "../../../../src/web/pages/content/reader-selection.ts";
import { copyText } from "../../../../src/web/ui/clipboard.ts";
import { selectionSourceAt, type RegionSelection } from "../../../../src/web/ui/selection-source.ts";

// The reading of rows is faked: these tests are about when the controller reads and what it does
// with the answer, not about the text itself.
const fake = vi.hoisted(() => ({
  read: undefined as ((rows: readonly SelectionRow[], anchor: ReaderPoint, focus: ReaderPoint) => ReaderSelectionRead | undefined) | undefined,
  has: undefined as ((rows: readonly SelectionRow[], point: ReaderPoint) => boolean) | undefined,
  readCalls: 0,
  hasCalls: 0,
}));

vi.mock("../../../../src/web/pages/content/reader-selection.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/web/pages/content/reader-selection.ts")>();
  return {
    ...original,
    readSelection: (rows: readonly SelectionRow[], anchor: ReaderPoint, focus: ReaderPoint) => {
      fake.readCalls += 1;
      return fake.read?.(rows, anchor, focus);
    },
    hasPoint: (rows: readonly SelectionRow[], point: ReaderPoint) => {
      fake.hasCalls += 1;
      return fake.has?.(rows, point) ?? false;
    },
  };
});

/** Covers the rows from the earlier end's row to the later one's, as the real reading would. */
function defaultRead(rows: readonly SelectionRow[], anchor: ReaderPoint, focus: ReaderPoint): ReaderSelectionRead | undefined {
  const a = rows.findIndex((row) => row.key === anchor.rowKey);
  const f = rows.findIndex((row) => row.key === focus.rowKey);
  if (a < 0 || f < 0) return undefined;
  return { firstRow: Math.min(a, f), lastRow: Math.max(a, f), explainText: "解释的字", copyText: "数据里的字", sentenceCount: 2, crossesGap: false };
}

beforeEach(() => {
  fake.read = defaultRead;
  fake.has = (rows, point) => rows.some((row) => row.key === point.rowKey);
  fake.readCalls = 0;
  fake.hasCalls = 0;
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

/** The fixture of the DOM helpers' tests: a chapter, a turn's paragraph with two sentences, a gap bar and a paragraph. */
const READER = `
<div id="box">
<div data-row-key="chapter:0" data-row-index="0" id="r0"><div><h3 id="title" data-reader-part="title">开场白</h3></div></div>
<div data-row-key="k1" data-row-index="1" id="r1"><div id="turn"><div><button><span id="name" data-reader-part="speaker">林老师</span></button></div><div><p id="p1"><button id="time" data-reader-part="time">0:00</button><span id="a" data-segment-id="s1">先看<mark id="mark">召回</mark><span id="run">😀的</span>做法。</span> <span id="b" data-segment-id="s2">Then rerank.</span></p></div></div></div>
<div data-row-key="gap:s3" data-row-index="2" id="r2"><div><button id="gap" data-reader-part="gap">略过 11 秒</button></div></div>
<div data-row-key="k4" data-row-index="3" id="r3"><p id="p2"><button data-reader-part="time">0:30</button><span id="c" data-segment-id="s4">最后生成。</span></p></div>
</div>`;

const ROWS: SelectionRow[] = [
  { key: "chapter:0", kind: "chapter", title: "开场白" },
  { key: "k1", kind: "paragraph", time: "0:00", marked: false, speaker: { name: "林老师", named: true }, sentences: [{ id: "s1", text: "先看召回😀的做法。" }, { id: "s2", text: "Then rerank." }] },
  { key: "gap:s3", kind: "gap", label: "略过 11 秒" },
  { key: "k4", kind: "paragraph", time: "0:30", marked: false, sentences: [{ id: "s4", text: "最后生成。" }] },
];

const BASE: ReaderSelectionInput = { revisionId: "rev-1", viewKey: "view-1", rows: ROWS, skipped: "（略过）" };

interface Mounted {
  list: HTMLElement;
  handle: () => ReaderSelectionHandle;
  /** Every `pinnedKeys` value the host rendered with, in order. */
  pinHistory: (readonly string[])[];
  /** Re-renders with the given input changes (or none, as the player does). */
  update: (input?: Partial<ReaderSelectionInput>) => void;
  unmount: () => void;
}

function mount(): Mounted {
  let latest: ReaderSelectionHandle | undefined;
  let setInput: ((input: ReaderSelectionInput) => void) | undefined;
  const pinHistory: (readonly string[])[] = [];
  function Harness() {
    const [input, set] = useState(BASE);
    setInput = set;
    const handle = useReaderSelection(input);
    latest = handle;
    pinHistory.push(handle.pinnedKeys);
    return (
      <div id="host" onMouseDown={handle.onMouseDown}>
        <div id="list" ref={handle.scrollerRef} dangerouslySetInnerHTML={{ __html: READER }} />
      </div>
    );
  }
  const view = render(
    <>
      <Harness />
      <div id="other">
        <span id="outside">别处的一句。</span>
        <input id="field" defaultValue="输入框" />
      </div>
    </>,
  );
  let current = BASE;
  return {
    list: $("#list"),
    handle: () => latest as ReaderSelectionHandle,
    pinHistory,
    update: (input = {}) => {
      current = { ...current, ...input };
      const next = current;
      act(() => setInput?.({ ...next }));
    },
    unmount: () => view.unmount(),
  };
}

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;
const text = (selector: string): Text => $(selector).firstChild as Text;

function select(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): void {
  act(() => {
    window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function selectionChanged(): void {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function readOf(list: HTMLElement): RegionSelection | undefined {
  return selectionSourceAt(list)?.source.read();
}

/** Re-renders the rows' nodes as a layout change does: fresh nodes, same text. */
function replaceRow(id: string): HTMLElement {
  const old = $(id);
  const fresh = old.cloneNode(true) as HTMLElement;
  old.replaceWith(fresh);
  return fresh;
}

function copyEvent(): { event: Event; setData: ReturnType<typeof vi.fn> } {
  const setData = vi.fn();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData } });
  return { event, setData };
}

describe("following the browser selection", () => {
  it("takes a new selection inside the list as a new version and pins the row it lies in", () => {
    const { list, handle } = mount();
    select(text("#mark"), 1, text("#b"), 4);
    const read = readOf(list);
    expect(read?.version).toBe(1);
    expect(handle().pinnedKeys).toEqual(["k1"]);
    select(text("#title"), 1, text("#c"), 2);
    expect(readOf(list)?.version).toBe(2);
    expect(handle().pinnedKeys).toEqual(["chapter:0", "k4"]);
  });

  it("pins the two end rows of a selection, anchor first, once when both ends share a row", () => {
    const { handle } = mount();
    select(text("#c"), 2, text("#title"), 1);
    expect(handle().pinnedKeys).toEqual(["k4", "chapter:0"]);
    select(text("#a"), 0, text("#b"), 3);
    expect(handle().pinnedKeys).toEqual(["k1"]);
    // A Shift+press on a third row moves the far end there: once the selection has moved, its two rows are the pins.
    select(text("#title"), 1, text("#c"), 2);
    fireEvent.mouseDown($("#b"), { button: 0, shiftKey: true });
    select(text("#title"), 1, text("#b"), 2);
    fireEvent.mouseUp($("#b"));
    expect(handle().pinnedKeys).toEqual(["chapter:0", "k1"]);
  });

  it("keeps the version, the read and the pins when the selection did not change", () => {
    const { list, handle, pinHistory } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    const read = readOf(list);
    const pins = handle().pinnedKeys;
    const renders = pinHistory.length;
    // A released modifier key, a context menu: selectionchange with the same selection.
    selectionChanged();
    selectionChanged();
    expect(readOf(list)).toBe(read);
    expect(read?.version).toBe(1);
    expect(handle().pinnedKeys).toBe(pins);
    expect(pinHistory.length).toBe(renders);
    expect(fake.readCalls).toBe(1);
  });

  it("keeps the version when a copy moves the selection away and puts it back before selectionchange is handled", async () => {
    const { list } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    const read = readOf(list);
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const execCommand = vi.fn(() => {
      // While copying, the selection is in the scratch textarea, not in the reader.
      expect(window.getSelection()?.anchorNode).not.toBe(text("#mark"));
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      await act(async () => {
        expect(await copyText("复制的字")).toBe(true);
      });
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
    expect(execCommand).toHaveBeenCalledOnce();
    selectionChanged();
    expect(readOf(list)).toBe(read);
    expect(readOf(list)?.version).toBe(1);
  });

  it("pins the row of a caret but has no selection to read", () => {
    const { list, handle } = mount();
    select(text("#c"), 2, text("#c"), 2);
    expect(handle().pinnedKeys).toEqual(["k4"]);
    expect(readOf(list)).toBeUndefined();
    expect(fake.readCalls).toBe(0);
  });

  it("has no selection to read when one end lies outside the list, and pins only the inside end", () => {
    const { list, handle } = mount();
    select(text("#b"), 2, text("#outside"), 3);
    expect(handle().pinnedKeys).toEqual(["k1"]);
    expect(readOf(list)).toBeUndefined();
    select(text("#outside"), 1, text("#c"), 1);
    expect(handle().pinnedKeys).toEqual(["k4"]);
    expect(readOf(list)).toBeUndefined();
  });

  it("drops the selection and the pins when the document has none", () => {
    const { list, handle } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(handle().pinnedKeys).toEqual([]);
    expect(readOf(list)).toBeUndefined();
  });
});

describe("pressing in the list", () => {
  it("pins the pressed row before the selection moves", () => {
    const { handle } = mount();
    fireEvent.mouseDown($("#mark"), { button: 0 });
    expect(handle().pinnedKeys).toEqual(["k1"]);
    fireEvent.mouseUp($("#mark"));
  });

  it("keeps the row of a caret pinned under a press elsewhere, so a Shift+press can extend from it", () => {
    const { handle } = mount();
    select(text("#title"), 1, text("#title"), 1);
    fireEvent.mouseDown($("#c"), { button: 0, shiftKey: true });
    expect(handle().pinnedKeys).toEqual(["chapter:0", "k4"]);
    fireEvent.mouseUp($("#c"));
    // The caret is in the pressed row: one pin.
    select(text("#c"), 1, text("#c"), 1);
    fireEvent.mouseDown($("#p2"), { button: 0, shiftKey: true });
    expect(handle().pinnedKeys).toEqual(["k4"]);
    fireEvent.mouseUp($("#p2"));
    // The selection is outside the list: only the pressed row.
    select(text("#outside"), 1, text("#outside"), 1);
    fireEvent.mouseDown($("#a"), { button: 0, shiftKey: true });
    expect(handle().pinnedKeys).toEqual(["k1"]);
    fireEvent.mouseUp($("#a"));
  });

  it("keeps both end rows of a selection pinned under a press, inside the selection or elsewhere", () => {
    const { handle } = mount();
    // A row unmounted under the press would take the selection's end out of the document, and
    // the browser would have no selection left to turn into a caret.
    select(text("#title"), 1, text("#c"), 2);
    fireEvent.mouseDown($("#title"), { button: 0 });
    expect(handle().pinnedKeys).toEqual(["chapter:0", "k4"]);
    fireEvent.mouseUp($("#title"));
    fireEvent.mouseDown($("#b"), { button: 0 });
    expect(handle().pinnedKeys).toEqual(["chapter:0", "k4", "k1"]);
    // The click put a caret in the pressed row: the old ends are released.
    select(text("#b"), 2, text("#b"), 2);
    fireEvent.mouseUp($("#b"));
    expect(handle().pinnedKeys).toEqual(["k1"]);
  });

  it("ignores other buttons and presses outside a row", () => {
    const { handle } = mount();
    select(text("#c"), 1, text("#c"), 1);
    fireEvent.mouseDown($("#a"), { button: 2 });
    fireEvent.mouseUp($("#a"));
    expect(handle().pinnedKeys).toEqual(["k4"]);
    fireEvent.mouseDown($("#box"), { button: 0 });
    fireEvent.mouseUp($("#box"));
    fireEvent.mouseDown($("#host"), { button: 0 });
    fireEvent.mouseUp($("#host"));
    expect(handle().pinnedKeys).toEqual(["k4"]);
  });
});

describe("following the rows", () => {
  it("does no reading work on a render that changed nothing", () => {
    const { list, handle, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    readOf(list);
    const pins = handle().pinnedKeys;
    update();
    update();
    expect(fake.readCalls).toBe(1);
    expect(fake.hasCalls).toBe(0);
    expect(handle().pinnedKeys).toBe(pins);
    expect(readOf(list)?.version).toBe(1);
  });

  it("clears the selection and the browser's ranges when the view changes", () => {
    const { list, handle, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    update({ viewKey: "view-2" });
    expect(readOf(list)).toBeUndefined();
    expect(handle().pinnedKeys).toEqual([]);
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it("leaves a browser selection outside the list alone when the view changes", () => {
    const { update } = mount();
    select(text("#outside"), 1, text("#outside"), 3);
    update({ viewKey: "view-2" });
    expect(window.getSelection()?.toString()).toBe("处的");
  });

  it("gives a new version when the rows change and both ends are still in them", () => {
    const { list, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    const before = readOf(list);
    update({ rows: [...ROWS] });
    const after = readOf(list);
    expect(after?.version).toBe(2);
    expect(after).not.toBe(before);
    expect(fake.readCalls).toBe(2);
  });

  it("clears the selection when the rows no longer hold an end", () => {
    const { list, handle, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    update({ rows: ROWS.filter((row) => row.key !== "k4") });
    expect(readOf(list)).toBeUndefined();
    expect(handle().pinnedKeys).toEqual([]);
    expect(window.getSelection()?.rangeCount).toBe(0);
  });
});

describe("putting the selection back after its nodes were replaced", () => {
  it("restores it by sentence and offset on the next commit, keeping the version", () => {
    const { list, update } = mount();
    select(text("#mark"), 1, text("#b"), 4);
    expect(window.getSelection()?.toString()).toBe("回😀的做法。 Then");
    replaceRow("#r1");
    expect(window.getSelection()?.toString()).not.toBe("回😀的做法。 Then");
    update();
    const selection = window.getSelection() as Selection;
    expect(selection.toString()).toBe("回😀的做法。 Then");
    expect(selection.anchorNode?.isConnected).toBe(true);
    expect($("#r1").contains(selection.anchorNode)).toBe(true);
    // The selectionchange the restore causes finds the same selection.
    selectionChanged();
    expect(readOf(list)?.version).toBe(1);
  });

  it("does not bring back a selection that was removed on purpose before its nodes were replaced", () => {
    const { list, update, handle } = mount();
    select(text("#mark"), 1, text("#b"), 2);
    // An action finished with the selection and its result re-renders the row, before the
    // selectionchange of the removal has been dispatched.
    act(() => window.getSelection()?.removeAllRanges());
    replaceRow("#r1");
    update();
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(readOf(list)).toBeUndefined();
    expect(handle().pinnedKeys).toEqual([]);
  });

  it("restores it from selectionchange instead of reading what the browser was left with", () => {
    const { list } = mount();
    select(text("#c"), 4, text("#mark"), 1);
    const selected = window.getSelection()?.toString();
    replaceRow("#r1");
    replaceRow("#r3");
    expect(window.getSelection()?.toString()).not.toBe(selected);
    selectionChanged();
    const selection = window.getSelection() as Selection;
    expect(selection.toString()).toBe(selected);
    expect($("#r3").contains(selection.anchorNode)).toBe(true);
    expect(readOf(list)?.version).toBe(1);
  });

  it("reads what the browser has while a button is held down", () => {
    const { list } = mount();
    select(text("#mark"), 1, text("#b"), 4);
    fireEvent.mouseDown($("#b"), { button: 0 });
    replaceRow("#r1");
    select(text("#a"), 0, text("#b"), 2);
    fireEvent.mouseUp($("#b"));
    expect(readOf(list)?.version).toBe(2);
  });

  it("retries on later frames while an end's row is not mounted yet", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { list, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    const selected = window.getSelection()?.toString();
    const k4 = $("#r3");
    replaceRow("#r1");
    k4.remove();
    update();
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(readOf(list)?.version).toBe(1);
    // Back where it was, as the list mounts the pinned row again.
    ($("#r2").nextSibling as ChildNode).after(k4.cloneNode(true));
    act(() => vi.advanceTimersToNextFrame());
    const selection = window.getSelection() as Selection;
    expect(selection.toString()).toBe(selected);
    selectionChanged();
    expect(readOf(list)?.version).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up and clears the selection when the row never comes back", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { list, handle, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    replaceRow("#r1");
    $("#r3").remove();
    update();
    for (let frame = 1; frame < RESTORE_MAX_FRAMES; frame += 1) act(() => vi.advanceTimersToNextFrame());
    expect(readOf(list)?.version).toBe(1);
    act(() => vi.advanceTimersToNextFrame());
    expect(readOf(list)).toBeUndefined();
    expect(handle().pinnedKeys).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abandons a pending restore when the user presses to make a new selection", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { list, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    const k4 = $("#r3");
    replaceRow("#r1");
    k4.remove();
    update();
    fireEvent.mouseDown(document.body, { button: 0 });
    // The press puts the caret where the user clicked: nothing is selected any more.
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(document.body);
    expect(readOf(list)).toBeUndefined();
    const setBaseAndExtent = vi.spyOn(window.getSelection() as Selection, "setBaseAndExtent");
    ($("#r2").nextSibling as ChildNode).after(k4.cloneNode(true));
    act(() => vi.advanceTimersToNextFrame());
    update();
    expect(setBaseAndExtent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying once a new selection is made", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { list, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    replaceRow("#r1");
    $("#r3").remove();
    update();
    expect(vi.getTimerCount()).toBe(1);
    update({ viewKey: "view-2" });
    expect(vi.getTimerCount()).toBe(0);
    select(text("#a"), 0, text("#b"), 2);
    expect(readOf(list)?.version).toBe(2);
  });
});

describe("reading the selection", () => {
  it("takes the browser's own string when it holds the whole selection: trimmed to copy, raw for the menu", () => {
    const { list } = mount();
    // Ends in the space between the sentences, which reads as the start of the second one.
    select(text("#a"), 0, $("#a").nextSibling as Text, 1);
    expect(window.getSelection()?.toString()).toBe("先看召回😀的做法。 ");
    expect(readOf(list)).toEqual({ version: 1, text: "解释的字", copyText: "先看召回😀的做法。", menuCopyText: "先看召回😀的做法。 ", sentenceCount: 2, crossesGap: false });
  });

  it("writes both copy texts from the data when a covered row is not mounted", () => {
    const { list } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    $("#r2").remove();
    expect(readOf(list)).toMatchObject({ copyText: "数据里的字", menuCopyText: "数据里的字" });
  });

  it("writes both copy texts from the data while the nodes under the selection are gone and it cannot be put back yet", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { list, update } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    replaceRow("#r1");
    $("#r3").remove();
    update();
    // The browser was left with whatever survived; the selection read is still the user's.
    expect(readOf(list)).toMatchObject({ version: 1, copyText: "数据里的字", menuCopyText: "数据里的字" });
  });

  it("catches up with a selection whose selectionchange has not been dispatched yet", () => {
    const { list } = mount();
    select(text("#a"), 0, text("#a"), 2);
    expect(readOf(list)?.version).toBe(1);
    // A mouseup or a key can overtake the queued event: the read still answers for what is selected now.
    act(() => window.getSelection()?.setBaseAndExtent(text("#mark"), 1, text("#b"), 4));
    expect(readOf(list)?.version).toBe(2);
    // The event arriving afterwards finds the same selection.
    selectionChanged();
    expect(readOf(list)?.version).toBe(2);
  });

  it("carries the quote and the bounds as the region's ids, and leaves them out when absent", () => {
    const { list } = mount();
    fake.read = (rows, anchor, focus) => ({
      ...(defaultRead(rows, anchor, focus) as ReaderSelectionRead),
      quote: { id: "s1", text: "先看召回😀的做法。" },
      bounds: { start: { segmentId: "s1", offset: 2 }, end: { segmentId: "s1", offset: 4 } },
    });
    select(text("#mark"), 0, text("#mark"), 2);
    const read = readOf(list);
    expect(read?.quote).toEqual({ transcriptRevisionId: "rev-1", segmentId: "s1", text: "先看召回😀的做法。" });
    expect(read?.bounds).toEqual({ revisionId: "rev-1", start: { segmentId: "s1", offset: 2 }, end: { segmentId: "s1", offset: 4 } });
    fake.read = defaultRead;
    select(text("#mark"), 0, text("#b"), 2);
    const plain = readOf(list) as RegionSelection;
    expect("quote" in plain).toBe(false);
    expect("bounds" in plain).toBe(false);
  });

  it("has nothing to offer when only names, times or gap labels are selected", () => {
    const { list } = mount();
    fake.read = (rows, anchor, focus) => ({ ...(defaultRead(rows, anchor, focus) as ReaderSelectionRead), explainText: "" });
    select(text("#name"), 0, text("#time"), 2);
    expect(readOf(list)).toBeUndefined();
    expect(readOf(list)).toBeUndefined();
    expect(fake.readCalls).toBe(1);
  });

  it("reads once per version", () => {
    const { list } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    expect(fake.readCalls).toBe(0);
    const first = readOf(list);
    expect(readOf(list)).toBe(first);
    expect(fake.readCalls).toBe(1);
    select(text("#mark"), 0, text("#c"), 2);
    expect(readOf(list)).not.toBe(first);
    expect(fake.readCalls).toBe(2);
  });
});

describe("Ctrl+C", () => {
  it("lets the browser copy a selection it holds in full", () => {
    mount();
    select(text("#mark"), 1, text("#c"), 2);
    const { event, setData } = copyEvent();
    $("#a").dispatchEvent(event);
    expect(setData).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("writes the selection from the data when a covered row is not mounted", () => {
    mount();
    select(text("#mark"), 1, text("#c"), 2);
    $("#r2").remove();
    const { event, setData } = copyEvent();
    $("#a").dispatchEvent(event);
    expect(setData).toHaveBeenCalledWith("text/plain", "数据里的字");
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes over once a covered row unmounts after an intact read, with the string read while intact", () => {
    const { list } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    expect(readOf(list)?.menuCopyText).toBe(window.getSelection()?.toString());
    const intactText = window.getSelection()?.toString();
    $("#r2").remove();
    const { event, setData } = copyEvent();
    $("#a").dispatchEvent(event);
    // The cached read keeps the browser's string from when it held everything.
    expect(setData).toHaveBeenCalledWith("text/plain", intactText);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves copies alone without a logical selection or with nothing to explain", () => {
    mount();
    select(text("#b"), 1, text("#outside"), 2);
    const first = copyEvent();
    $("#b").dispatchEvent(first.event);
    expect(first.setData).not.toHaveBeenCalled();
    expect(first.event.defaultPrevented).toBe(false);
    fake.read = (rows, anchor, focus) => ({ ...(defaultRead(rows, anchor, focus) as ReaderSelectionRead), explainText: "" });
    select(text("#name"), 0, text("#c"), 2);
    $("#r2").remove();
    const second = copyEvent();
    $("#name").dispatchEvent(second.event);
    expect(second.setData).not.toHaveBeenCalled();
    expect(second.event.defaultPrevented).toBe(false);
  });

  it("never sees a copy that starts outside the list", () => {
    mount();
    select(text("#mark"), 1, text("#c"), 2);
    $("#r2").remove();
    const { event, setData } = copyEvent();
    $("#field").dispatchEvent(event);
    expect(setData).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("going away", () => {
  it("removes its listeners and its selection source on unmount", () => {
    const { list, handle, pinHistory, unmount } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    expect(readOf(list)).toBeDefined();
    const pins = handle().pinnedKeys;
    unmount();
    expect(selectionSourceAt(list)).toBeUndefined();
    // The old list back in the document: nothing listens to it any more.
    document.body.append(list);
    const renders = pinHistory.length;
    select(text("#a"), 0, text("#a"), 2);
    fireEvent.mouseDown($("#a"), { button: 0 });
    fireEvent.mouseUp($("#a"));
    $("#r2").remove();
    const { event, setData } = copyEvent();
    $("#a").dispatchEvent(event);
    expect(setData).not.toHaveBeenCalled();
    expect(pinHistory.length).toBe(renders);
    expect(handle().pinnedKeys).toBe(pins);
    expect(fake.readCalls).toBe(1);
    list.remove();
  });

  it("drops the browser's ranges with the list when a selection was held in it, so its actions close", () => {
    const { unmount } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    unmount();
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it("leaves a browser selection outside the list alone when the list goes away", () => {
    const { unmount } = mount();
    const apart = document.createElement("p");
    apart.textContent = "页面别处的字";
    document.body.append(apart);
    onTestFinished(() => apart.remove());
    select(apart.firstChild as Text, 0, apart.firstChild as Text, 2);
    unmount();
    expect(window.getSelection()?.toString()).toBe("页面");
  });

  it("cancels a pending restore on unmount", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { update, unmount } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    replaceRow("#r1");
    $("#r3").remove();
    update();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("with the real reading of rows", () => {
  type ReaderSelectionModule = typeof import("../../../../src/web/pages/content/reader-selection.ts");
  let real: ReaderSelectionModule;

  beforeEach(async () => {
    real = await vi.importActual<ReaderSelectionModule>("../../../../src/web/pages/content/reader-selection.ts");
    fake.read = (rows, anchor, focus) => real.readSelection(rows, anchor, focus, { skipped: BASE.skipped });
    fake.has = (rows, point) => real.hasPoint(rows, point);
  });

  it("quotes a selection inside one sentence and gives its bounds", () => {
    const { list } = mount();
    select(text("#mark"), 0, text("#run"), 2);
    expect(readOf(list)).toEqual({
      version: 1,
      text: "召回😀",
      quote: { transcriptRevisionId: "rev-1", segmentId: "s1", text: "先看召回😀的做法。" },
      copyText: "召回😀",
      menuCopyText: "召回😀",
      bounds: { revisionId: "rev-1", start: { segmentId: "s1", offset: 2 }, end: { segmentId: "s1", offset: 6 } },
      sentenceCount: 1,
      crossesGap: false,
    });
  });

  it("writes a selection across an unmounted row from the rows' data", () => {
    const { list } = mount();
    select(text("#mark"), 1, text("#c"), 2);
    $("#r2").remove();
    const read = readOf(list);
    const expected = real.readSelection(ROWS, { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 3 }, { rowKey: "k4", part: "sentence", segmentId: "s4", offset: 2 }, { skipped: BASE.skipped });
    expect(expected?.copyText).toContain("略过 11 秒");
    expect(read).toMatchObject({ text: expected?.explainText, copyText: expected?.copyText, menuCopyText: expected?.copyText, sentenceCount: 3, crossesGap: true });
    expect(read?.text).toContain(BASE.skipped);
  });

  it("clears the selection when the rows lose the sentence an end lies in", () => {
    const { list, update } = mount();
    select(text("#mark"), 1, text("#b"), 4);
    const k1 = ROWS[1] as Extract<SelectionRow, { kind: "paragraph" }>;
    update({ rows: ROWS.map((row) => (row === k1 ? { ...k1, sentences: k1.sentences.slice(0, 1) } : row)) });
    expect(readOf(list)).toBeUndefined();
  });
});
