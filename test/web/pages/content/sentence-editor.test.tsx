import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DRAFT_BATCH_UNDO_DEPTH } from "../../../../src/shared/defaults.ts";
import { isChineseLanguage, SentenceEditor, withTexts } from "../../../../src/web/pages/content/sentence-editor.tsx";
import type { DraftSyncSnapshot } from "../../../../src/web/pages/content/use-draft-sync.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

interface Item {
  id: string;
  text: string;
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
