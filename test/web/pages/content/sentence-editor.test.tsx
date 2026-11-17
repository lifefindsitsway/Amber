import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { DRAFT_BATCH_UNDO_DEPTH } from "../../../../src/shared/defaults.ts";
import { INITIAL_SCROLL_ATTRIBUTE, type InitialScroll, type InitialScrollOutcome } from "../../../../src/web/pages/content/edit-position.ts";
import { isChineseLanguage, SentenceEditor, withTexts, type SentenceEditorHandle } from "../../../../src/web/pages/content/sentence-editor.tsx";
import type { DraftSyncSnapshot } from "../../../../src/web/pages/content/use-draft-sync.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

interface Item {
  id: string;
  text: string;
  paragraphStart?: boolean;
}

const SAVED: DraftSyncSnapshot = { phase: "editing", save: "saved", version: 1, conflict: undefined, unsaved: false };
const keyOf = (item: Item): string => item.id;
const header = (_item: Item, index: number): string => String(index + 1);
const label = (_item: Item, index: number): string => `s${index + 1}`;

function Harness(props: { texts: string[]; deleteWholeSentences?: boolean; onItems?: (items: readonly Item[]) => void }) {
  const [items, setItems] = useState<readonly Item[]>(() => props.texts.map((text, index) => ({ id: `s${index + 1}`, text })));
  return (
    <SentenceEditor
      items={items}
      onItemsChange={(next) => {
        setItems(next);
        props.onItems?.(next);
      }}
      keyOf={keyOf}
      renderHeader={header}
      textLabel={label}
      layout="compact"
      fillers
      deleteWholeSentences={props.deleteWholeSentences ?? true}
      sync={SAVED}
      onRetry={vi.fn()}
      onLoadLatest={vi.fn()}
      onKeepMine={vi.fn()}
      onDiscard={vi.fn()}
      onExit={vi.fn()}
      onCommit={vi.fn()}
      busy={false}
    />
  );
}

function setup(texts: string[], options: { deleteWholeSentences?: boolean } = {}) {
  mockApi({});
  const onItems = vi.fn();
  renderApp(<Harness texts={texts} onItems={onItems} {...options} />);
  return { onItems };
}

const values = (): string[] => screen.getAllByRole("textbox").filter((element) => element.tagName === "TEXTAREA").map((element) => (element as HTMLTextAreaElement).value);

function openFind(): HTMLInputElement {
  fireEvent.click(screen.getByTestId("editor-find-toggle"));
  return screen.getByTestId("find-query") as HTMLInputElement;
}

describe("withTexts", () => {
  it("keeps unchanged items as the same objects and drops removed sentences", () => {
    const items = [{ id: "a", text: "一" }, { id: "b", text: "二" }, { id: "c", text: "三" }];
    const next = withTexts(items, ["一", "贰", "三"], new Set([2]));
    expect(next).toEqual([{ id: "a", text: "一" }, { id: "b", text: "贰" }]);
    expect(next[0]).toBe(items[0]);
  });

  it("knows Chinese drafts", () => {
    expect(isChineseLanguage("zh-CN")).toBe(true);
    expect(isChineseLanguage("zh")).toBe(true);
    expect(isChineseLanguage("en")).toBe(false);
    expect(isChineseLanguage(undefined)).toBe(false);
  });
});

describe("SentenceEditor find and replace", () => {
  it("replaces every 闫学通 with 阎学通 in one undoable step", () => {
    const { onItems } = setup(["闫学通说，闫学通认为", "无关的句子", "还是闫学通"]);
    const query = openFind();
    fireEvent.change(query, { target: { value: "闫学通" } });
    expect(screen.getByTestId("find-counter").textContent).toBe("1/3");
    expect(screen.getByTestId("find-current-context").textContent).toContain("闫学通");
    expect(screen.getByTestId("find-current-context").querySelector("strong")?.textContent).toBe("闫学通");
    fireEvent.click(screen.getByTestId("find-replace-toggle"));
    fireEvent.change(screen.getByTestId("find-replacement"), { target: { value: "阎学通" } });
    fireEvent.click(screen.getByTestId("find-replace-all"));
    expect(values()).toEqual(["阎学通说，阎学通认为", "无关的句子", "还是阎学通"]);
    expect(screen.getByTestId("find-counter").textContent).toBe("无结果");
    // The untouched sentence stays the very same item.
    const [before, after] = [onItems.mock.calls.length, onItems.mock.lastCall?.[0] as Item[]];
    expect(before).toBe(1);
    expect(after[1]?.text).toBe("无关的句子");
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(values()).toEqual(["闫学通说，闫学通认为", "无关的句子", "还是闫学通"]);
    expect((screen.getByTestId("editor-undo") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does nothing for an empty query, and respects case when asked", () => {
    setup(["Rag rag RAG"]);
    const query = openFind();
    expect(screen.getByTestId("find-counter").textContent).toBe("");
    fireEvent.change(query, { target: { value: "rag" } });
    expect(screen.getByTestId("find-counter").textContent).toBe("1/3");
    fireEvent.click(screen.getByTestId("find-case"));
    expect(screen.getByTestId("find-counter").textContent).toBe("1/1");
  });

  it("marks hit sentences, outlines the current one, and keeps focus in the find box until Tab", () => {
    setup(["甲乙", "丙丁", "乙丙"]);
    const query = openFind();
    query.focus();
    fireEvent.change(query, { target: { value: "乙" } });
    const rows = screen.getByTestId("sentence-rows").querySelectorAll("li");
    expect([...rows].map((row) => row.getAttribute("data-has-hit"))).toEqual(["true", null, "true"]);
    expect(rows[0]?.getAttribute("data-current-hit")).toBe("true");
    fireEvent.click(screen.getByTestId("find-next"));
    expect(rows[2]?.getAttribute("data-current-hit")).toBe("true");
    expect(document.activeElement).toBe(query);
    fireEvent.keyDown(query, { key: "Tab" });
    const input = within(rows[2] as HTMLElement).getByRole("textbox") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]);
    // Enter moves to the next hit, wrapping around.
    query.focus();
    fireEvent.keyDown(query, { key: "Enter" });
    expect(rows[0]?.getAttribute("data-current-hit")).toBe("true");
  });

  it("replaces or deletes only the checked results", () => {
    setup(["好，嗯，开始", "嗯，结束", "嗯嗯"]);
    const query = openFind();
    fireEvent.change(query, { target: { value: "嗯" } });
    fireEvent.click(screen.getByTestId("find-expand"));
    const boxes = within(screen.getByTestId("find-result-list")).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true, true]);
    fireEvent.click(boxes[3] as HTMLInputElement);
    fireEvent.click(screen.getByTestId("find-delete-selected"));
    expect(values()).toEqual(["好，开始", "结束", "嗯"]);
  });

  it("keeps at most the configured number of batch undos", () => {
    setup(["a"]);
    fireEvent.change(openFind(), { target: { value: "a" } });
    fireEvent.click(screen.getByTestId("find-replace-toggle"));
    fireEvent.change(screen.getByTestId("find-replacement"), { target: { value: "a" } });
    for (let i = 0; i < DRAFT_BATCH_UNDO_DEPTH + 3; i += 1) fireEvent.click(screen.getByTestId("find-replace-all"));
    let undone = 0;
    while (!(screen.getByTestId("editor-undo") as HTMLButtonElement).disabled) {
      fireEvent.click(screen.getByTestId("editor-undo"));
      undone += 1;
    }
    expect(undone).toBe(DRAFT_BATCH_UNDO_DEPTH);
  });

  it("opens with Ctrl+F or Ctrl+H only inside the editor and never while composing", () => {
    setup(["一句"]);
    const row = screen.getByRole("textbox");
    fireEvent.keyDown(document.body, { key: "f", code: "KeyF", ctrlKey: true });
    expect(screen.queryByTestId("find-panel")).toBeNull();
    fireEvent.keyDown(row, { key: "f", code: "KeyF", ctrlKey: true, isComposing: true });
    expect(screen.queryByTestId("find-panel")).toBeNull();
    act(() => {
      fireEvent.keyDown(row, { key: "f", code: "KeyF", ctrlKey: true });
    });
    expect(screen.getByTestId("find-panel")).toBeTruthy();
    expect(screen.queryByTestId("find-replacement")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("find-query"), { key: "Escape" });
    expect(screen.queryByTestId("find-panel")).toBeNull();
    fireEvent.keyDown(row, { key: "h", code: "KeyH", ctrlKey: true });
    expect(screen.getByTestId("find-replacement")).toBeTruthy();
  });

  it("lets the browser skip off-screen rows", () => {
    setup(["一句"]);
    expect(screen.getByTestId("sentence-rows").querySelector("li")?.className).toContain("[content-visibility:auto]");
  });
});

describe("SentenceEditor filler cleanup", () => {
  const TEXTS = ["嗯，我们开始吧。", "嗯。", "你说呢？", "那个啊，就是", "啊，呃……"];

  function openFillers() {
    openFind();
    fireEvent.click(screen.getByTestId("find-mode-filler"));
  }

  it("picks no word at first; a picked word checks only its high-confidence hits", () => {
    setup(TEXTS);
    openFillers();
    expect(screen.queryByTestId("filler-hits")).toBeNull();
    expect((screen.getByTestId("filler-review") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("filler-word-嗯").textContent).toBe("嗯 1");
    fireEvent.click(screen.getByTestId("filler-word-呢"));
    const hits = screen.getByTestId("filler-hits");
    expect(hits.querySelector("li")?.getAttribute("data-confidence")).toBe("maybe");
    expect((within(hits).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("filler-word-嗯"));
    const boxes = within(screen.getByTestId("filler-hits")).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect((screen.getByTestId("filler-whole") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("filler-whole").parentElement?.textContent).toBe("整句只有语气词：2 句（删除整句）");
  });

  it("previews the deletion and applies exactly that, sentences included, undoably", () => {
    setup(TEXTS);
    openFillers();
    fireEvent.click(screen.getByTestId("filler-word-嗯"));
    fireEvent.click(screen.getByTestId("filler-word-啊"));
    fireEvent.click(screen.getByTestId("filler-whole"));
    fireEvent.click(screen.getByTestId("filler-review"));
    expect(screen.getByTestId("filler-preview").textContent).toBe("将删除 2 处 · 整句 2 句");
    expect(values()).toEqual(TEXTS);
    fireEvent.click(screen.getByTestId("filler-apply"));
    expect(values()).toEqual(["我们开始吧。", "你说呢？", "那个，就是"]);
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(values()).toEqual(TEXTS);
  });

  it("never deletes a translation's sentence, saying such sentences are skipped", () => {
    setup(TEXTS, { deleteWholeSentences: false });
    openFillers();
    expect(screen.queryByTestId("filler-whole")).toBeNull();
    expect(screen.getByTestId("filler-whole-skipped").textContent).toBe("译文需逐句对应，此类句子已跳过（2 句）");
    fireEvent.click(screen.getByTestId("filler-word-嗯"));
    fireEvent.click(screen.getByTestId("filler-review"));
    expect(screen.getByTestId("filler-preview").textContent).toBe("将删除 1 处 · 整句 0 句");
    fireEvent.click(screen.getByTestId("filler-apply"));
    expect(values()).toEqual(["我们开始吧。", "嗯。", "你说呢？", "那个啊，就是", "啊，呃……"]);
  });
});

describe("SentenceEditor extensions", () => {
  interface ExtraProps {
    texts: string[];
    layout?: "compact" | "bilingual";
    visible?: ReadonlySet<number>;
    withLead?: boolean;
    toolbarExtra?: ReactNode;
    rowActions?: (item: Item, index: number) => ReactNode;
    onItems?: (items: readonly Item[]) => void;
    handle?: { current: SentenceEditorHandle<Item> | null };
    busy?: boolean;
  }

  function Extended(props: ExtraProps) {
    const [items, setItems] = useState<readonly Item[]>(() => props.texts.map((text, index) => ({ id: `s${index + 1}`, text })));
    const ownHandle = useRef<SentenceEditorHandle<Item>>(null);
    return (
      <SentenceEditor
        items={items}
        onItemsChange={(next) => {
          setItems(next);
          props.onItems?.(next);
        }}
        keyOf={keyOf}
        renderHeader={header}
        textLabel={label}
        layout={props.layout ?? "compact"}
        fillers
        deleteWholeSentences
        sync={SAVED}
        onRetry={vi.fn()}
        onLoadLatest={vi.fn()}
        onKeepMine={vi.fn()}
        onDiscard={vi.fn()}
        onExit={vi.fn()}
        onCommit={vi.fn()}
        busy={props.busy ?? false}
        {...(props.withLead === true ? { renderLead: (item: Item) => <button type="button" data-testid={`lead-${item.id}`}>lead {item.id}</button> } : {})}
        {...(props.visible === undefined ? {} : { visible: props.visible })}
        {...(props.toolbarExtra === undefined ? {} : { toolbarExtra: props.toolbarExtra })}
        {...(props.rowActions === undefined ? {} : { rowActions: props.rowActions })}
        handleRef={props.handle ?? ownHandle}
      />
    );
  }

  function render(props: ExtraProps) {
    mockApi({});
    return renderApp(<Extended {...props} />);
  }

  const rowTexts = (): string[] => [...screen.getByTestId("sentence-rows").querySelectorAll("li")].map((row) => (row.querySelector("textarea") as HTMLTextAreaElement).value);

  it("renders nothing extra without the new props", () => {
    render({ texts: ["一", "二"] });
    expect(document.querySelector("[data-row-control]")).toBeNull();
    expect(screen.queryByTestId("find-scope-note")).toBeNull();
    expect(screen.queryByTestId("row-actions")).toBeNull();
    const row = screen.getByTestId("sentence-rows").querySelector("li") as HTMLElement;
    expect(row.firstElementChild?.className).toBe("flex items-start gap-2");
    expect(row.firstElementChild?.children).toHaveLength(2);
  });

  it("puts the lead column before the input in both layouts", () => {
    const view = render({ texts: ["一", "二"], withLead: true });
    const compact = screen.getByTestId("sentence-rows").querySelector("li") as HTMLElement;
    const children = [...(compact.firstElementChild?.children ?? [])];
    expect(children).toHaveLength(3);
    expect(children[1]?.querySelector('[data-testid="lead-s1"]')).not.toBeNull();
    expect(children[2]?.tagName).toBe("TEXTAREA");
    view.unmount();

    render({ texts: ["一", "二"], withLead: true, layout: "bilingual" });
    const bilingual = screen.getByTestId("sentence-rows").querySelector("li") as HTMLElement;
    const lead = bilingual.querySelector('[data-testid="lead-s1"]') as HTMLElement;
    const input = bilingual.querySelector("textarea") as HTMLElement;
    expect(lead.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows only the visible sentences, keeping their original numbers", () => {
    render({ texts: ["甲", "乙", "丙", "丁"], visible: new Set([1, 3]) });
    expect(rowTexts()).toEqual(["乙", "丁"]);
    expect(screen.getByLabelText("s2")).toBeTruthy();
    expect(screen.queryByLabelText("s1")).toBeNull();
  });

  it("edits a visible sentence by its original index", () => {
    const onItems = vi.fn();
    render({ texts: ["甲", "乙", "丙", "丁"], visible: new Set([1, 3]), onItems });
    fireEvent.change(screen.getByLabelText("s4"), { target: { value: "丁丁" } });
    const next = onItems.mock.lastCall?.[0] as Item[];
    expect(next.map((item) => item.text)).toEqual(["甲", "乙", "丙", "丁丁"]);
  });

  it("finds and replaces only inside the visible sentences, and says so", () => {
    const onItems = vi.fn();
    render({ texts: ["闫一", "闫二", "闫三", "闫四"], visible: new Set([1, 3]), onItems });
    const query = openFind();
    expect(screen.getByTestId("find-scope-note").textContent).toBe("仅在当前筛选的 2 句中查找与替换");
    fireEvent.change(query, { target: { value: "闫" } });
    expect(screen.getByTestId("find-counter").textContent).toBe("1/2");
    fireEvent.click(screen.getByTestId("find-replace-toggle"));
    fireEvent.change(screen.getByTestId("find-replacement"), { target: { value: "阎" } });
    fireEvent.click(screen.getByTestId("find-replace-all"));
    const next = onItems.mock.lastCall?.[0] as Item[];
    expect(next.map((item) => item.text)).toEqual(["闫一", "阎二", "闫三", "阎四"]);
    // One undo restores the whole draft, hidden sentences included.
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect((onItems.mock.lastCall?.[0] as Item[]).map((item) => item.text)).toEqual(["闫一", "闫二", "闫三", "闫四"]);
  });

  it("limits the filler cleanup to the visible sentences too", () => {
    const onItems = vi.fn();
    render({ texts: ["嗯，甲", "嗯，乙", "嗯，丙"], visible: new Set([1]), onItems });
    fireEvent.click(screen.getByTestId("editor-find-toggle"));
    fireEvent.click(screen.getByTestId("find-mode-filler"));
    fireEvent.click(screen.getByTestId("filler-word-嗯"));
    fireEvent.click(screen.getByTestId("filler-review"));
    expect(screen.getByTestId("filler-preview").textContent).toBe("将删除 1 处 · 整句 0 句");
    fireEvent.click(screen.getByTestId("filler-apply"));
    expect((onItems.mock.lastCall?.[0] as Item[]).map((item) => item.text)).toEqual(["嗯，甲", "乙", "嗯，丙"]);
  });

  it("edits 3 of 50 filtered sentences in a 2,888-sentence draft and leaves the other 2,885 untouched", () => {
    const texts = Array.from({ length: 2888 }, (_, index) => `第 ${index + 1} 句`);
    const filtered = new Set(Array.from({ length: 50 }, (_, at) => at * 57 + 3));
    const onItems = vi.fn();
    render({ texts, visible: filtered, onItems });
    expect(screen.getByTestId("sentence-rows").querySelectorAll("li")).toHaveLength(50);
    const edited = [3, 3 + 57 * 20, 3 + 57 * 49];
    for (const index of edited) fireEvent.change(screen.getByLabelText(`s${index + 1}`), { target: { value: `改过 ${index}` } });
    const last = onItems.mock.lastCall?.[0] as Item[];
    expect(last).toHaveLength(2888);
    const original = texts.map((text, index) => ({ id: `s${index + 1}`, text }));
    const changed = last.flatMap((item, index) => (item.text === original[index]?.text ? [] : [index]));
    expect(changed).toEqual(edited);
    expect(last.filter((item, index) => !edited.includes(index) && item.text === original[index]?.text && item.id === original[index]?.id)).toHaveLength(2885);
    // Rows that were not edited are still the very objects the editor was given.
    const first = onItems.mock.calls[0]?.[0] as Item[];
    expect(last.filter((item, index) => !edited.includes(index) && item === first[index])).toHaveLength(2885);
  });

  it("renders the extra toolbar controls after the find control and the row actions for the active sentence", () => {
    render({
      texts: ["甲", "乙"],
      toolbarExtra: <button type="button" data-testid="extra">更多</button>,
      rowActions: (_item, index) => <button type="button" data-testid="row-action">在此拆分 {index + 1}</button>,
    });
    const find = screen.getByTestId("editor-find-toggle");
    expect(find.compareDocumentPosition(screen.getByTestId("extra")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("row-action")).toBeNull();
    fireEvent.focus(screen.getByLabelText("s2"));
    expect(screen.getAllByTestId("row-action")).toHaveLength(1);
    expect(screen.getByTestId("row-action").textContent).toBe("在此拆分 2");
    fireEvent.focus(screen.getByLabelText("s1"));
    expect(screen.getByTestId("row-action").textContent).toBe("在此拆分 1");
  });

  it("does not take the focus when a control of the lead column is clicked", () => {
    render({ texts: ["甲", "乙"], withLead: true });
    const input = screen.getByLabelText("s1");
    fireEvent.click(screen.getByTestId("lead-s1"));
    expect(document.activeElement).not.toBe(input);
    // Elsewhere in the row it does, as before.
    fireEvent.click(screen.getByTestId("sentence-rows").querySelector("li") as HTMLElement);
    expect(document.activeElement).toBe(input);
  });

  describe("handle", () => {
    it("applies a batch as one undoable step named for the undo control", () => {
      const handle = { current: null as SentenceEditorHandle<Item> | null };
      const onItems = vi.fn();
      render({ texts: ["甲", "乙"], handle, onItems });
      const next: Item[] = [{ id: "s1", text: "甲" }, { id: "s2", text: "乙" }, { id: "s3", text: "新" }];
      act(() => handle.current?.applyBatch(next, "指定发言人"));
      expect(onItems).toHaveBeenLastCalledWith(next);
      expect(rowTexts()).toEqual(["甲", "乙", "新"]);
      const undo = screen.getByTestId("editor-undo") as HTMLButtonElement;
      expect(undo.disabled).toBe(false);
      expect(undo.getAttribute("aria-label")).toBe("撤销：指定发言人");
      fireEvent.click(undo);
      expect(rowTexts()).toEqual(["甲", "乙"]);
      expect(undo.disabled).toBe(true);
      expect(undo.getAttribute("title")).toBe("撤销上一次批量修改（全部替换、删除所选、语气词清理）");
    });

    it("refuses a batch while the editor is busy", () => {
      const handle = { current: null as SentenceEditorHandle<Item> | null };
      const onItems = vi.fn();
      render({ texts: ["甲"], handle, onItems, busy: true });
      act(() => handle.current?.applyBatch([{ id: "s1", text: "乙" }], "指定发言人"));
      expect(onItems).not.toHaveBeenCalled();
      expect(rowTexts()).toEqual(["甲"]);
    });

    it("keeps at most DRAFT_BATCH_UNDO_DEPTH batches", () => {
      const handle = { current: null as SentenceEditorHandle<Item> | null };
      render({ texts: ["0"], handle });
      for (let step = 1; step <= DRAFT_BATCH_UNDO_DEPTH + 5; step += 1) {
        act(() => handle.current?.applyBatch([{ id: "s1", text: String(step) }], `step ${step}`));
      }
      let undone = 0;
      while (!(screen.getByTestId("editor-undo") as HTMLButtonElement).disabled) {
        fireEvent.click(screen.getByTestId("editor-undo"));
        undone += 1;
      }
      expect(undone).toBe(DRAFT_BATCH_UNDO_DEPTH);
      expect(rowTexts()).toEqual(["5"]);
    });

    it("focuses a sentence by its original index, and leaves a hidden one alone", () => {
      const handle = { current: null as SentenceEditorHandle<Item> | null };
      const scrolled = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrolled;
      onTestFinished(() => {
        Element.prototype.scrollIntoView = original;
      });
      render({ texts: ["甲", "乙", "丙"], handle, visible: new Set([1, 2]) });
      act(() => handle.current?.focusSentence(2));
      expect(document.activeElement).toBe(screen.getByLabelText("s3"));
      expect(scrolled).toHaveBeenCalled();
      (document.activeElement as HTMLElement).blur();
      act(() => handle.current?.focusSentence(0));
      expect(document.activeElement).toBe(document.body);
    });
  });
});

describe("SentenceEditor initial scroll", () => {
  /** Animation frames run only when the test says so. */
  function manualFrames() {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 1;
    const request = vi.fn((callback: FrameRequestCallback) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => queue.delete(handle));
    const run = (count: number): void => {
      for (let at = 0; at < count; at += 1) {
        const pending = [...queue.values()];
        queue.clear();
        act(() => pending.forEach((callback) => callback(0)));
      }
    };
    return { request, run, pending: () => queue.size };
  }

  const control: { setOpening?: (value: InitialScroll | undefined) => void } = {};

  function Opening(props: {
    texts: string[];
    initialScroll?: InitialScroll;
    visible?: ReadonlySet<number>;
    onItems?: (items: readonly Item[]) => void;
    onDone?: (outcome: InitialScrollOutcome | "none") => void;
  }) {
    const [items, setItems] = useState<readonly Item[]>(() => props.texts.map((text, index) => ({ id: `s${index + 1}`, text })));
    const [opening, setOpening] = useState(props.initialScroll);
    control.setOpening = setOpening;
    return (
      <SentenceEditor
        items={items}
        onItemsChange={(next) => {
          setItems(next);
          props.onItems?.(next);
        }}
        keyOf={keyOf}
        renderHeader={header}
        textLabel={label}
        layout="compact"
        fillers
        deleteWholeSentences
        sync={SAVED}
        onRetry={vi.fn()}
        onLoadLatest={vi.fn()}
        onKeepMine={vi.fn()}
        onDiscard={vi.fn()}
        onExit={vi.fn()}
        onCommit={vi.fn()}
        busy={false}
        {...(props.visible === undefined ? {} : { visible: props.visible })}
        {...(opening === undefined ? {} : { initialScroll: opening })}
        {...(props.onDone === undefined ? {} : { onInitialScrollDone: props.onDone })}
      />
    );
  }

  function open(props: Parameters<typeof Opening>[0]) {
    mockApi({});
    const onItems = vi.fn();
    renderApp(<Opening onItems={onItems} {...props} />);
    return { onItems, list: screen.getByTestId("sentence-rows") };
  }

  const TEXTS = ["甲句", "乙句", "丙句", "丁句"];

  it("does nothing without an initial scroll", () => {
    const frames = manualFrames();
    const { list } = open({ texts: TEXTS });
    frames.run(5);
    expect(list.hasAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe(false);
    expect(frames.request).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("settles on the sentence and says so, leaving the focus alone unless asked", () => {
    const frames = manualFrames();
    const { list } = open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: false } });
    expect(list.hasAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe(false);
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("settled");
    expect(document.activeElement).toBe(document.body);
  });

  it("puts the cursor at the start of the sentence when asked, without editing anything", () => {
    const frames = manualFrames();
    const { list, onItems } = open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: true } });
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("settled");
    const input = screen.getByLabelText("s3") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(0);
    expect(input.value).toBe("丙句");
    expect(onItems).not.toHaveBeenCalled();
  });

  it("scrolls the list so the row's top sits at the offset below the list's top", () => {
    const frames = manualFrames();
    const LIST_TOP = 100;
    const ROW = 40;
    const PADDING = 8;
    const scrolls = new WeakMap<Element, number>();
    Object.defineProperty(HTMLOListElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLOListElement) {
        return scrolls.get(this) ?? 0;
      },
      set(this: HTMLOListElement, value: number) {
        scrolls.set(this, Math.min(Math.max(value, 0), this.scrollHeight - this.clientHeight));
      },
    });
    Object.defineProperty(HTMLOListElement.prototype, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLOListElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLOListElement) {
        return this.children.length * ROW + 2 * PADDING;
      },
    });
    onTestFinished(() => {
      for (const key of ["scrollTop", "clientHeight", "scrollHeight"]) Reflect.deleteProperty(HTMLOListElement.prototype, key);
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const index = this.getAttribute("data-sentence-index");
      if (this instanceof HTMLOListElement) return DOMRect.fromRect({ x: 0, y: LIST_TOP, width: 400, height: 300 });
      if (index === null || this.parentElement === null) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
      const top = LIST_TOP + PADDING + Number(index) * ROW - (this.parentElement as HTMLOListElement).scrollTop;
      return DOMRect.fromRect({ x: 0, y: top, width: 400, height: ROW });
    });
    const texts = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 句`);
    const { list } = open({ texts, initialScroll: { index: 30, offset: 120, focus: false } });
    // The first correction happens before the first paint.
    expect(list.scrollTop).toBe(PADDING + 30 * ROW - 120);
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("settled");
    const row = list.querySelector('[data-sentence-index="30"]') as HTMLElement;
    expect(row.getBoundingClientRect().top - LIST_TOP).toBe(120);
  });

  it("cancels without moving the focus when an editable element already has it", () => {
    const frames = manualFrames();
    const outside = document.createElement("input");
    document.body.append(outside);
    onTestFinished(() => outside.remove());
    outside.focus();
    const { list } = open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: true } });
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("cancelled");
    expect(document.activeElement).toBe(outside);
  });

  it("cancels on a key pressed during the loop and never takes the focus", () => {
    const frames = manualFrames();
    const { list } = open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: true } });
    frames.run(1);
    fireEvent.keyDown(document.body, { key: "PageDown" });
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("cancelled");
    expect(frames.pending()).toBe(0);
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("cancelled");
    expect(document.activeElement).toBe(document.body);
  });

  it("cancels on a wheel over the list", () => {
    const frames = manualFrames();
    const { list } = open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: true } });
    fireEvent.wheel(list);
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("cancelled");
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves a sentence the filter hides, or one out of range, alone", () => {
    const frames = manualFrames();
    const { list } = open({ texts: TEXTS, visible: new Set([0, 1]), initialScroll: { index: 2, offset: 0, focus: true } });
    frames.run(3);
    expect(list.hasAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe(false);
    expect(document.activeElement).toBe(document.body);
    cleanup();
    const again = open({ texts: TEXTS, initialScroll: { index: 9, offset: 0, focus: true } });
    frames.run(3);
    expect(again.list.hasAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe(false);
    expect(frames.request).not.toHaveBeenCalled();
  });

  it("starts once per mount: a later value neither restarts nor refocuses", () => {
    const frames = manualFrames();
    const { list } = open({ texts: TEXTS });
    act(() => control.setOpening?.({ index: 1, offset: 0, focus: false }));
    frames.run(3);
    expect(list.getAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe("settled");
    const requested = frames.request.mock.calls.length;
    act(() => control.setOpening?.({ index: 3, offset: 0, focus: true }));
    frames.run(3);
    expect(frames.request.mock.calls.length).toBe(requested);
    expect(document.activeElement).toBe(document.body);
  });

  it("tells the caller how the opening went, once", () => {
    const frames = manualFrames();
    const onDone = vi.fn();
    open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: false }, onDone });
    expect(onDone).not.toHaveBeenCalled();
    frames.run(5);
    expect(onDone.mock.calls).toEqual([["settled"]]);
  });

  it("tells the caller the opening was a cancel when the user acted first", () => {
    const frames = manualFrames();
    const onDone = vi.fn();
    const { list } = open({ texts: TEXTS, initialScroll: { index: 2, offset: 0, focus: true }, onDone });
    fireEvent.wheel(list);
    frames.run(3);
    expect(onDone.mock.calls).toEqual([["cancelled"]]);
  });

  it("says there was no opening at once when there is no target, or its row is not shown", () => {
    const frames = manualFrames();
    const none = vi.fn();
    open({ texts: TEXTS, onDone: none });
    expect(none.mock.calls).toEqual([["none"]]);
    // A target arriving later is not an opening any more; it is not reported again.
    act(() => control.setOpening?.({ index: 1, offset: 0, focus: false }));
    frames.run(3);
    expect(none.mock.calls).toEqual([["none"]]);
    cleanup();
    const hidden = vi.fn();
    open({ texts: TEXTS, visible: new Set([0, 1]), initialScroll: { index: 2, offset: 0, focus: true }, onDone: hidden });
    expect(hidden.mock.calls).toEqual([["none"]]);
  });

  it("stops on unmount without reporting", () => {
    const frames = manualFrames();
    mockApi({});
    const onDone = vi.fn();
    const view = renderApp(<Opening texts={TEXTS} initialScroll={{ index: 2, offset: 0, focus: true }} onDone={onDone} />);
    const list = screen.getByTestId("sentence-rows");
    expect(frames.pending()).toBe(1);
    view.unmount();
    expect(frames.pending()).toBe(0);
    expect(list.hasAttribute(INITIAL_SCROLL_ATTRIBUTE)).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("SentenceEditor paragraphs and undo history", () => {
  function Paragraphed(props: { items: Item[]; starts?: boolean[]; visible?: ReadonlySet<number>; handle?: { current: SentenceEditorHandle<Item> | null }; onItems?: (items: readonly Item[]) => void }) {
    const [items, setItems] = useState<readonly Item[]>(props.items);
    const ownHandle = useRef<SentenceEditorHandle<Item>>(null);
    return (
      <SentenceEditor
        items={items}
        onItemsChange={(next) => {
          setItems(next);
          props.onItems?.(next);
        }}
        keyOf={keyOf}
        renderHeader={header}
        textLabel={label}
        layout="compact"
        fillers
        deleteWholeSentences
        sync={SAVED}
        onRetry={vi.fn()}
        onLoadLatest={vi.fn()}
        onKeepMine={vi.fn()}
        onDiscard={vi.fn()}
        onExit={vi.fn()}
        onCommit={vi.fn()}
        busy={false}
        handleRef={props.handle ?? ownHandle}
        {...(props.starts === undefined ? {} : { paragraphStarts: props.starts })}
        {...(props.visible === undefined ? {} : { visible: props.visible })}
      />
    );
  }

  const row = (index: number): HTMLElement => document.querySelector(`[data-sentence-index="${index}"]`) as HTMLElement;

  it("spaces a row that opens a paragraph and describes it as one, but not the first row shown", () => {
    mockApi({});
    const items = ["一", "二", "三", "四"].map((text, index) => ({ id: `s${index + 1}`, text }));
    renderApp(<Paragraphed items={items} starts={[true, false, true, false]} />);
    expect(row(0).className).toContain("my-0.5");
    expect(row(1).className).toContain("my-0.5");
    expect(row(2).className).toContain("mt-5");
    expect(row(2).getAttribute("data-paragraph-start")).toBe("true");
    expect(row(1).hasAttribute("data-paragraph-start")).toBe(false);
    expect(screen.getByLabelText("s3").getAttribute("aria-description")).toBe("段首");
    expect(screen.getByLabelText("s2").hasAttribute("aria-description")).toBe(false);
    cleanup();
    mockApi({});
    renderApp(<Paragraphed items={items} starts={[true, false, true, false]} visible={new Set([2, 3])} />);
    expect(row(2).className).toContain("my-0.5");
    expect(row(2).getAttribute("data-paragraph-start")).toBe("true");
  });

  it("spaces a shown row after hidden rows of which one opened a paragraph", () => {
    mockApi({});
    const items = ["一", "二", "三", "四"].map((text, index) => ({ id: `s${index + 1}`, text }));
    // Rows 1 and 3 shown; row 2 (hidden) opens a paragraph, so row 3 is not in row 1's paragraph.
    renderApp(<Paragraphed items={items} starts={[true, false, true, false]} visible={new Set([1, 3])} />);
    expect(row(1).className).toContain("my-0.5");
    expect(row(3).className).toContain("mt-5");
    expect(row(3).hasAttribute("data-paragraph-start")).toBe(false);
  });

  it("shows no paragraphs without starts (a translation)", () => {
    mockApi({});
    renderApp(<Paragraphed items={[{ id: "s1", text: "一" }, { id: "s2", text: "二" }]} />);
    expect(document.querySelector("[data-paragraph-start]")).toBeNull();
    expect(document.querySelector("[aria-description]")).toBeNull();
  });

  it("hands the start of a deleted paragraph opener to the next sentence kept, and undoes to the snapshot", () => {
    mockApi({});
    const onItems = vi.fn();
    const items: Item[] = [
      { id: "s1", text: "开头。", paragraphStart: true },
      { id: "s2", text: "嗯。", paragraphStart: true },
      { id: "s3", text: "第二段。", paragraphStart: false },
      { id: "s4", text: "接着。", paragraphStart: false },
    ];
    renderApp(<Paragraphed items={items} starts={items.map((item) => item.paragraphStart === true)} onItems={onItems} />);
    openFind();
    fireEvent.click(screen.getByTestId("find-mode-filler"));
    fireEvent.click(screen.getByTestId("filler-whole"));
    fireEvent.click(screen.getByTestId("filler-review"));
    fireEvent.click(screen.getByTestId("filler-apply"));
    const deleted = onItems.mock.lastCall?.[0] as Item[];
    expect(deleted.map((item) => [item.id, item.paragraphStart])).toEqual([
      ["s1", true],
      ["s3", true],
      ["s4", false],
    ]);
    // Untouched sentences stay the same objects.
    expect(deleted[2]).toBe(items[3]);
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(onItems.mock.lastCall?.[0]).toEqual(items);
  });

  it("answers whether an undo step holds something, and drops the newest such step with everything older", () => {
    mockApi({});
    const handle: { current: SentenceEditorHandle<Item> | null } = { current: null };
    renderApp(<Paragraphed items={[{ id: "s1", text: "零" }]} handle={handle} />);
    const step = (text: string): void => act(() => handle.current?.applyBatch([{ id: "s1", text }], text));
    step("一");
    step("二");
    step("三");
    // The stack now holds 零, 一, 二 (what each step replaced).
    const holds = (text: string) => (items: readonly Item[]) => items[0]?.text === text;
    expect(handle.current?.hasUndo(holds("一"))).toBe(true);
    expect(handle.current?.hasUndo(holds("三"))).toBe(false);
    act(() => handle.current?.dropUndo(holds("一")));
    expect(handle.current?.hasUndo(holds("零"))).toBe(false);
    expect(handle.current?.hasUndo(holds("一"))).toBe(false);
    expect(handle.current?.hasUndo(holds("二"))).toBe(true);
    // Dropping what is not there changes nothing.
    act(() => handle.current?.dropUndo(holds("九")));
    expect(handle.current?.hasUndo(holds("二"))).toBe(true);
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(values()).toEqual(["二"]);
    expect((screen.getByTestId("editor-undo") as HTMLButtonElement).disabled).toBe(true);
  });
});
