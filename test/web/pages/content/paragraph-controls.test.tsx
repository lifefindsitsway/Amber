import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SPEAKER_SPLIT_MIN_MS } from "../../../../src/shared/defaults.ts";
import type { TranscriptSegmentDto } from "../../../../src/shared/dto/transcript.ts";
import type { ParagraphStartInfo } from "../../../../src/shared/paragraph-marks.ts";
import { isParagraphShortcut, paragraphAction } from "../../../../src/web/pages/content/paragraph-controls.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";
import { editorRoutes, mockApi, puts, renderSpeakerEditor, talk } from "../../../fixtures/web/speaker-editor.tsx";

describe("paragraphAction", () => {
  const infos: ParagraphStartInfo[] = [{ start: true, mergeBlock: "first" }, { start: false }, { start: true }, { start: true, mergeBlock: "chapter" }, { start: true, mergeBlock: "speaker" }, { start: false }];

  it("offers 「另起一段」 where no paragraph starts and 「并入上一段」 where one does", () => {
    expect(paragraphAction(infos, undefined, 1)).toEqual({ kind: "split" });
    expect(paragraphAction(infos, undefined, 2)).toEqual({ kind: "merge" });
    expect(paragraphAction(infos, undefined, 9)).toBeUndefined();
  });

  it("is off at the first sentence, a chapter start and a change of speaker, saying which", () => {
    expect(paragraphAction(infos, undefined, 0)).toEqual({ kind: "merge", blocked: "first" });
    expect(paragraphAction(infos, undefined, 3)).toEqual({ kind: "merge", blocked: "chapter" });
    expect(paragraphAction(infos, undefined, 4)).toEqual({ kind: "merge", blocked: "speaker" });
  });

  it("is off while the sentence before is hidden by a filter", () => {
    expect(paragraphAction(infos, new Set([1, 2, 5]), 1)).toEqual({ kind: "split", blocked: "hidden" });
    expect(paragraphAction(infos, new Set([1, 2, 5]), 2)).toEqual({ kind: "merge" });
    expect(paragraphAction(infos, new Set([2, 5]), 2)).toEqual({ kind: "merge", blocked: "hidden" });
    // A start that never merges keeps its own reason.
    expect(paragraphAction(infos, new Set([4]), 4)).toEqual({ kind: "merge", blocked: "speaker" });
  });
});

describe("isParagraphShortcut", () => {
  const key = (overrides: Partial<Parameters<typeof isParagraphShortcut>[0]>) =>
    isParagraphShortcut({ key: "Enter", code: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 13, ...overrides });

  it("is Ctrl+Enter or ⌘+Enter, and nothing else", () => {
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({ metaKey: true })).toBe(true);
    expect(key({ ctrlKey: true, code: "NumpadEnter" })).toBe(true);
    expect(key({})).toBe(false);
    expect(key({ ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key({ ctrlKey: true, altKey: true })).toBe(false);
    expect(key({ ctrlKey: true, key: "a", code: "KeyA" })).toBe(false);
  });

  it("never fires while an input method is composing", () => {
    expect(key({ ctrlKey: true, isComposing: true })).toBe(false);
    expect(key({ ctrlKey: true, keyCode: 229 })).toBe(false);
  });
});

/** talk() — speakers A A B B B A — with proofreading's paragraphs: 1, 2 | 3, 4 | 5 | 6. */
function marked(): TranscriptSegmentDto[] {
  const starts = [true, false, true, false, true, true];
  return talk().map((item, index) => ({ ...item, paragraphStart: starts[index] as boolean }));
}

const rowStarts = (): number[] =>
  [...document.querySelectorAll<HTMLElement>("[data-sentence-index]")].flatMap((row) => (row.hasAttribute("data-paragraph-start") ? [Number(row.dataset["sentenceIndex"])] : []));

async function activate(text: string): Promise<HTMLTextAreaElement> {
  const input = (await screen.findByDisplayValue(text)) as HTMLTextAreaElement;
  fireEvent.focus(input);
  return input;
}

const lastPut = async (calls: Parameters<typeof puts>[0], count: number) => {
  await waitFor(() => expect(puts(calls)).toHaveLength(count), { timeout: 3000 });
  return puts(calls)[count - 1]?.segments ?? [];
};

describe("paragraph editing in the transcript editor", () => {
  it("opens a proofread transcript with its paragraphs explicit, splits and merges as single undoable steps", async () => {
    const { calls } = mockApi(editorRoutes(marked()));
    renderSpeakerEditor();
    await activate("第4句内容。");
    expect(rowStarts()).toEqual([0, 2, 4, 5]);
    const action = screen.getByTestId("paragraph-action");
    expect(action.textContent).toContain("从这句另起一段");
    expect(action.textContent).toContain("Ctrl+Enter");
    fireEvent.click(action);
    expect(rowStarts()).toEqual([0, 2, 3, 4, 5]);
    expect(screen.getByTestId("paragraph-action").textContent).toContain("并入上一段");
    expect(screen.getByTestId("editor-undo").getAttribute("aria-label")).toBe("撤销：另起一段");
    expect((await lastPut(calls, 1)).map((item) => item["paragraphStart"])).toEqual([true, false, true, true, true, true]);
    // The same sentence back into its paragraph.
    fireEvent.click(screen.getByTestId("paragraph-action"));
    expect(rowStarts()).toEqual([0, 2, 4, 5]);
    expect(screen.getByTestId("editor-undo").getAttribute("aria-label")).toBe("撤销：合并段落");
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(rowStarts()).toEqual([0, 2, 3, 4, 5]);
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(rowStarts()).toEqual([0, 2, 4, 5]);
    expect((screen.getByTestId("editor-undo") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles with Ctrl+Enter in the sentence, never with plain Enter or while composing", async () => {
    mockApi(editorRoutes(marked()));
    renderSpeakerEditor();
    const input = await activate("第5句内容。");
    expect(rowStarts()).toContain(4);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true, keyCode: 229 });
    expect(rowStarts()).toContain(4);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(rowStarts()).not.toContain(4);
    expect(screen.getByTestId("paragraph-status").textContent).toContain("已并入上一段");
    fireEvent.keyDown(input, { key: "Enter", code: "NumpadEnter", metaKey: true });
    expect(rowStarts()).toContain(4);
  });

  it("disables the action at the first sentence and at a change of speaker, saying why next to it", async () => {
    mockApi(editorRoutes(marked()));
    renderSpeakerEditor();
    await activate("第1句内容。");
    expect((screen.getByTestId("paragraph-action") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("paragraph-blocked").textContent).toBe("这是全文第一段");
    expect(screen.getByTestId("paragraph-action").getAttribute("aria-describedby")).toBe(screen.getByTestId("paragraph-blocked").id);
    const third = await activate("第3句内容。");
    expect(screen.getByTestId("paragraph-blocked").textContent).toBe("这里换了发言人，不同发言人总是分段");
    // The shortcut does nothing there either, and says why.
    fireEvent.keyDown(third, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(rowStarts()).toContain(2);
    expect(screen.getByTestId("paragraph-status").textContent).toContain("这里换了发言人，不同发言人总是分段");
  });

  it("treats a chapter start as a paragraph start that cannot be merged", async () => {
    const chapters = {
      revisions: [],
      current: {
        id: "ch1",
        artifactId: "a-ch",
        origin: { kind: "platform" },
        chapters: [
          { startMs: 0, endMs: 4_000, title: "开场" },
          { startMs: 4_000, endMs: 24_000, title: "正文" },
        ],
        quality: "normal",
        qualityReasons: [],
        stale: false,
        createdAt: 1,
      },
    };
    mockApi({ ...editorRoutes(marked()), "GET /api/contents/c1/chapters": { body: chapters } });
    renderSpeakerEditor();
    await activate("第2句内容。");
    expect(rowStarts()).toEqual([0, 1, 2, 4, 5]);
    expect(screen.getByTestId("paragraph-blocked").textContent).toBe("这里是章节开头，章节之间总是分段");
  });

  it("shows an unproofread transcript's paragraphs as the reading view does, and freezes them on the first paragraph action", async () => {
    // Long pauses open paragraphs in a transcript without marks: after the second sentence.
    const base = [
      segment("u1", 0, 0, 3_000, "第一句。"),
      segment("u2", 1, 3_000, 6_000, "第二句。"),
      segment("u3", 2, 10_000, 13_000, "第三句。"),
      segment("u4", 3, 13_000, 16_000, "第四句。"),
      segment("u5", 4, 16_000, 19_000, "第五句。"),
    ];
    const { calls } = mockApi(editorRoutes(base, []));
    renderSpeakerEditor();
    const fourth = await activate("第四句。");
    expect(rowStarts()).toEqual([0, 2]);
    // Typing changes nothing about paragraphs: the draft still has none of its own.
    fireEvent.change(fourth, { target: { value: "第四句改了。" } });
    expect((await lastPut(calls, 1)).every((item) => !("paragraphStart" in item))).toBe(true);
    fireEvent.click(screen.getByTestId("paragraph-action"));
    expect(rowStarts()).toEqual([0, 2, 3]);
    expect((await lastPut(calls, 2)).map((item) => item["paragraphStart"])).toEqual([true, false, true, true, false]);
    // One undo takes back the action and the freezing with it.
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(rowStarts()).toEqual([0, 2]);
    expect((await lastPut(calls, 3)).every((item) => !("paragraphStart" in item))).toBe(true);
  });

  it("splits a sentence of a draft without speakers, without speaker pickers, and can start a paragraph at the right half", async () => {
    const TEXT = "前半句内容后半句内容";
    const base = [segment("u1", 0, 0, 10_000, TEXT), segment("u2", 1, 10_000, 10_000 + SPEAKER_SPLIT_MIN_MS, "很短。")];
    const { calls } = mockApi(editorRoutes(base, []));
    renderSpeakerEditor();
    const input = await activate(TEXT);
    input.setSelectionRange(5, 5);
    fireEvent(document, new Event("selectionchange"));
    const control = await screen.findByTestId("split-control");
    expect(within(control).queryByTestId("split-speaker-left")).toBeNull();
    expect(within(control).queryByTestId("split-speaker-right")).toBeNull();
    expect(screen.queryByTestId("speaker-lead")).toBeNull();
    fireEvent.change(screen.getByTestId("split-time"), { target: { value: "4200" } });
    fireEvent.click(screen.getByTestId("split-right-starts"));
    fireEvent.click(screen.getByTestId("split-button"));
    await screen.findByDisplayValue("后半句内容");
    expect(rowStarts()).toEqual([0, 1]);
    const sent = await lastPut(calls, 1);
    expect(sent.map((item) => [item["text"], item["startMs"], item["endMs"], item["paragraphStart"]])).toEqual([
      ["前半句内容", 0, 4_200, true],
      ["后半句内容", 4_200, 10_000, true],
      ["很短。", 10_000, 10_000 + SPEAKER_SPLIT_MIN_MS, false],
    ]);
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(await screen.findByDisplayValue(TEXT)).toBeTruthy();
    expect(rowStarts()).toEqual([0]);
  });

  it("says why a sentence without speakers is too short to split, without mentioning speakers", async () => {
    const base = [segment("u1", 0, 0, 10_000, "长句子内容"), segment("u2", 1, 10_000, 10_000 + SPEAKER_SPLIT_MIN_MS, "很短。")];
    mockApi(editorRoutes(base, []));
    renderSpeakerEditor();
    await activate("很短。");
    expect(screen.getByTestId("split-disabled-reason").textContent).toBe(`句子短于 ${SPEAKER_SPLIT_MIN_MS * 2} 毫秒，不能拆成两半`);
  });

  it("fills in a saved draft's inherited paragraphs without saving it", async () => {
    const drafted = marked().map((item) => ({ id: item.id, startMs: item.startMs, endMs: item.endMs, text: item.text, sourceSegmentIds: [item.id], speakerId: item.speakerId ?? null }));
    // The third sentence was deleted in this draft: its paragraph start goes to the fourth.
    drafted.splice(2, 1);
    const { calls } = mockApi({
      ...editorRoutes(marked()),
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version: 4, segments: drafted, updatedAt: 1 } },
    });
    renderSpeakerEditor();
    const input = await activate("第4句内容。");
    expect(rowStarts()).toEqual([0, 2, 3, 4]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(puts(calls)).toHaveLength(0);
    fireEvent.change(input, { target: { value: "第4句改过。" } });
    expect((await lastPut(calls, 1)).map((item) => item["paragraphStart"])).toEqual([true, false, true, true, true]);
  });
});
