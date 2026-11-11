import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useLocation } from "react-router";
import { BREAKPOINT_DRAWER_PX, NOTE_SPAN_MAX_SEGMENTS, PARAGRAPH_GAP_MS, READER_FONT_SIZE_DEFAULT, READER_LINE_HEIGHT_DEFAULT } from "../../../../src/shared/defaults.ts";
import { READER_TYPOGRAPHY_DEFAULTS, type ReaderTypography } from "../../../../src/shared/reader-typography.ts";
import type { NoteViewDto } from "../../../../src/shared/dto/note.ts";
import { selectionForExplain } from "../../../../src/web/chat/selection-toolbar.tsx";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { changedSegments } from "../../../../src/web/pages/content/transcript-tab.tsx";
import { CITED_SEGMENT_ID, contentDetail, contentRoutes, revision, segment, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { note } from "../../../fixtures/web/note-data.ts";
import { mountReader, SPEAKER_SEGMENTS, speakerRoutes, TYPOGRAPHY_KEY } from "../../../fixtures/web/reader-speakers.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";

describe("changedSegments", () => {
  const parent = [segment("p1", 0, 0, 1_000, "原文一"), segment("p2", 1, 1_000, 2_000, "原文二")];

  it("marks sentences whose text differs from their sources, attributed by revision kind", () => {
    const corrected = [segment("c1", 0, 0, 1_000, "原文一", { sourceSegmentIds: ["p1"] }), segment("c2", 1, 1_000, 2_000, "改过二", { sourceSegmentIds: ["p2"] })];
    expect([...changedSegments(revision("rc", { kind: "corrected", parentRevisionId: "rp" }), corrected, parent)]).toEqual([["c2", "ai"]]);
    expect([...changedSegments(revision("rm", { kind: "manual", parentRevisionId: "rp" }), corrected, parent)]).toEqual([["c2", "user"]]);
  });

  it("does not count punctuation a proofreading pass restored as an AI change, while a manual revision is compared strictly", () => {
    const punctuated = [segment("c1", 0, 0, 1_000, "原文一。", { sourceSegmentIds: ["p1"] }), segment("c2", 1, 1_000, 2_000, "原文，二！", { sourceSegmentIds: ["p2"] })];
    expect(changedSegments(revision("rc", { kind: "corrected", parentRevisionId: "rp" }), punctuated, parent).size).toBe(0);
    expect([...changedSegments(revision("rm", { kind: "manual", parentRevisionId: "rp" }), punctuated, parent)]).toEqual([["c1", "user"], ["c2", "user"]]);
    const merged = [segment("c3", 0, 0, 2_000, "原文一，原文二。", { sourceSegmentIds: ["p1", "p2"] })];
    expect(changedSegments(revision("rc", { kind: "corrected", parentRevisionId: "rp" }), merged, parent).size).toBe(0);
    const reworded = [segment("c4", 0, 0, 1_000, "原文—。", { sourceSegmentIds: ["p1"] }), segment("c5", 1, 1_000, 2_000, "原文二的 50%", { sourceSegmentIds: ["p2"] })];
    expect([...changedSegments(revision("rc", { kind: "corrected", parentRevisionId: "rp" }), reworded, parent)]).toEqual([["c4", "ai"], ["c5", "ai"]]);
  });

  it("reports nothing for root revisions", () => {
    expect(changedSegments(revision("r1"), parent, []).size).toBe(0);
  });
});

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
});

describe("TranscriptTab with a search query", () => {
  it("marks the terms in the reading view and selects the hit sentence", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, {
      route: `/contents/c1?tab=transcript&revision=r1&segment=${CITED_SEGMENT_ID}&search=${encodeURIComponent("重排")}`,
      path: "/contents/:id",
    });
    // The first test in this file also pays for loading the content page; under a full parallel run that alone can pass the default second.
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    const sentence = await waitFor(() => {
      const element = reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`);
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(sentence.getAttribute("aria-current")).toBe("true");
    expect([...reader.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["重排"]);
  });
});

describe("TranscriptTab reading view", () => {
  it("separates unpunctuated sentences with a space outside the clickable text and runs punctuated ones on, in the view and the copy", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const unpunctuated = [segment("u1", 0, 0, 4_000, "今天讲检索"), segment("u2", 1, 4_000, 8_000, "先看向量库"), ...SEGMENTS.slice(2)];
    mockApi({ ...contentRoutes(), "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: unpunctuated } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    const reader = await screen.findByTestId("transcript-reader");
    const first = await waitFor(() => {
      const element = reader.querySelector("[data-segment-id='u1']")?.closest("p");
      expect(element).not.toBeNull();
      return element as HTMLParagraphElement;
    });
    expect(first.textContent).toBe("0:00今天讲检索 先看向量库");
    expect([...first.querySelectorAll("[data-segment-id]")].map((node) => node.textContent)).toEqual(["今天讲检索", "先看向量库"]);
    const second = reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)?.closest("p");
    expect(second?.textContent).toBe("1:15再看重排序。");
    // The fixture's current chapters head the reading view and go into the copy as their own lines.
    expect(within(reader).getAllByTestId("transcript-chapter").map((heading) => heading.textContent)).toEqual(["0:00开场", "1:00正文"]);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("开场\n\n今天讲检索 先看向量库\n\n正文\n\n再看重排序。");
  });

  it("runs a proofread CJK sentence that spans two time slices on without a space, where an unmarked revision keeps one", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const sentences = (marks?: [boolean, boolean]) => [
      segment("m1", 0, 0, 4_000, "但这样就等于你同时拒绝了你的老师", marks === undefined ? {} : { paragraphStart: marks[0] }),
      segment("m2", 1, 4_000, 8_000, "和牛逼的网课，进入恶性循环。", marks === undefined ? {} : { paragraphStart: marks[1] }),
    ];
    const read = async (items: ReturnType<typeof sentences>) => {
      writeText.mockClear();
      mockApi({
        ...contentRoutes(),
        "GET /api/contents/c1/chapters": { body: { revisions: [] } },
        "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items } },
      });
      const view = renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
      const reader = await screen.findByTestId("transcript-reader");
      const paragraph = await waitFor(() => {
        const element = reader.querySelector("[data-segment-id='m1']")?.closest("p");
        expect(element).not.toBeNull();
        return element as HTMLParagraphElement;
      });
      const text = paragraph.textContent;
      fireEvent.click(screen.getByRole("button", { name: "复制" }));
      view.unmount();
      return { text, copied: writeText.mock.calls[0]?.[0] };
    };

    expect(await read(sentences([true, false]))).toEqual({
      text: "0:00但这样就等于你同时拒绝了你的老师和牛逼的网课，进入恶性循环。",
      copied: "但这样就等于你同时拒绝了你的老师和牛逼的网课，进入恶性循环。",
    });
    expect(await read(sentences())).toEqual({
      text: "0:00但这样就等于你同时拒绝了你的老师 和牛逼的网课，进入恶性循环。",
      copied: "但这样就等于你同时拒绝了你的老师 和牛逼的网课，进入恶性循环。",
    });
  });

  it("reads without headings when the Content has no chapters, and copies the paragraphs alone", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mockApi({ ...contentRoutes(), "GET /api/contents/c1/chapters": { body: { revisions: [] } } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    const reader = await screen.findByTestId("transcript-reader");
    await waitFor(() => expect(reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)).not.toBeNull());
    expect(within(reader).queryAllByTestId("transcript-chapter")).toEqual([]);
    expect(screen.queryByTestId("transcript-chapters-stale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("今天讲检索。先看向量库。\n\n再看重排序。");
  });

  it("seeks to the first sentence under a chapter heading when its time is clicked", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    const reader = await screen.findByTestId("transcript-reader");
    const headings = await within(reader).findAllByTestId("transcript-chapter");
    fireEvent.click(within(headings[1] as HTMLElement).getByRole("button", { name: "1:00" }));
    await waitFor(() => expect(reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)?.getAttribute("aria-current")).toBe("true"));
    expect(reader.querySelector("[data-segment-id='s1']")?.getAttribute("aria-current")).toBeNull();
  });

  it("says the chapters are based on an older transcript when they are stale", async () => {
    const routes = contentRoutes();
    const chapters = (routes["GET /api/contents/c1/chapters"] as { body: { current: Record<string, unknown>; revisions: unknown[] } }).body;
    mockApi({
      ...routes,
      "GET /api/contents/c1/chapters": {
        body: { ...chapters, current: { ...chapters.current, origin: { kind: "ai", transcriptRevisionId: "r0" }, stale: true, staleReason: "transcript_changed" } },
      },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    expect((await screen.findByTestId("transcript-chapters-stale")).textContent).toBe("章节基于旧版原文生成，可能已过期，可按需重新生成");
    expect((await screen.findAllByTestId("transcript-chapter")).length).toBe(2);
  });
});

describe("TranscriptTab chapter outline and jump buttons", () => {
  async function open(routes: Parameters<typeof mockApi>[0] = contentRoutes()) {
    mockApi(routes);
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    const reader = await screen.findByTestId("transcript-reader");
    await waitFor(() => expect(reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)).not.toBeNull());
    return reader;
  }

  // Radix starts listening for outside presses a tick after the layer mounts, and a non-modal
  // popover only dismisses once the press completes as a click.
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  it("sits between AI proofreading and editing, and lists the reader's own chapter headings", async () => {
    const reader = await open();
    const toolbar = screen.getByTestId("chapter-outline").parentElement as HTMLElement;
    const labels = within(toolbar).getAllByRole("button").map((button) => button.textContent);
    expect(labels.indexOf("章节")).toBe(labels.indexOf("AI 校对") + 1);
    expect(labels.indexOf("编辑")).toBe(labels.indexOf("章节") + 1);
    fireEvent.click(screen.getByTestId("chapter-outline"));
    expect(screen.getByText("章节目录（2）")).toBeTruthy();
    const items = within(screen.getByTestId("chapter-outline-list")).getAllByTestId("chapter-outline-item");
    expect(items.map((item) => item.textContent)).toEqual(within(reader).getAllByTestId("transcript-chapter").map((heading) => heading.textContent));
  });

  it("puts the picked chapter heading at the top of the reader and closes, without seeking", async () => {
    const reader = await open();
    const heading = within(reader).getAllByTestId("transcript-chapter")[1]?.closest("[data-row-index]") as HTMLElement;
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 400, height: 300 });
    heading.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 340, width: 400, height: 30 });
    fireEvent.click(screen.getByTestId("chapter-outline"));
    fireEvent.click(screen.getAllByTestId("chapter-outline-item")[1] as HTMLElement);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
    expect(reader.scrollTop).toBe(240);
    expect(reader.querySelector("[aria-current]")).toBeNull();
  });

  it("closes on a press outside, and a click on a sentence still selects it", async () => {
    const reader = await open();
    fireEvent.click(screen.getByTestId("chapter-outline"));
    await settle();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();

    fireEvent.click(screen.getByTestId("chapter-outline"));
    await settle();
    const sentence = reader.querySelector("[data-segment-id='s2']") as HTMLElement;
    fireEvent.pointerDown(sentence);
    fireEvent.click(sentence);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
    await waitFor(() => expect(sentence.getAttribute("aria-current")).toBe("true"));
  });

  it("is disabled when the Content has no chapters", async () => {
    await open({ ...contentRoutes(), "GET /api/contents/c1/chapters": { body: { revisions: [] } } });
    const trigger = screen.getByTestId("chapter-outline") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("尚无章节");
  });

  it("jumps the reader to its top and bottom from the floating buttons", async () => {
    const reader = await open();
    Object.defineProperty(reader, "scrollHeight", { configurable: true, value: 1_234 });
    const toBottom = screen.getByRole("button", { name: "去底部" });
    expect(toBottom.title).toBe("去底部");
    fireEvent.click(toBottom);
    expect(reader.scrollTop).toBe(1_234);
    fireEvent.click(screen.getByRole("button", { name: "去顶部" }));
    expect(reader.scrollTop).toBe(0);
  });
});

/** Fires a right click and reports whether the browser menu was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const menuLabels = (): Array<string | null> => screen.getAllByRole("menuitem").map((item) => item.textContent);

describe("TranscriptTab context menu", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    delete (document as unknown as Record<string, unknown>)["caretPositionFromPoint"];
  });

  async function open() {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { calls } = mockApi(contentRoutes());
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" },
    );
    const reader = await screen.findByTestId("transcript-reader");
    return { reader, writeText, calls };
  }

  it("offers play, copy and copy with time on a sentence, copying from the data; explaining needs a selection here", async () => {
    const { reader, writeText } = await open();
    const cited = await waitFor(() => reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`) as HTMLElement);
    expect(rightClick(cited)).toBe(true);
    expect(menuLabels()).toEqual(["从这里播放", "复制这句", "复制这句（带时间）"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("再看重排序。"));
    rightClick(cited);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence-with-time"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("[1:15] 再看重排序。"));
  });

  it("plays from the sentence the same way a click does", async () => {
    const { reader } = await open();
    const second = await waitFor(() => reader.querySelector("[data-segment-id='s2']") as HTMLElement);
    rightClick(second);
    fireEvent.click(screen.getByTestId("context-menu-item-play-from-here"));
    await waitFor(() => expect(reader.querySelector("[data-segment-id='s2']")?.getAttribute("aria-current")).toBe("true"));
  });

  it("leaves a right click between sentences to the browser", async () => {
    const { reader } = await open();
    await waitFor(() => expect(reader.querySelector("[data-segment-id='s1']")).not.toBeNull());
    const paragraphTime = within(reader).getAllByRole("button", { name: "0:00" }).at(-1) as HTMLElement;
    expect(rightClick(paragraphTime)).toBe(false);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("explains a selection inside one sentence with its text and a quote of the sentence, without sending", async () => {
    const { reader, calls } = await open();
    const cited = await waitFor(() => reader.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`) as HTMLElement);
    const text = cited.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: text, offset: 3 });
    expect(selectionForExplain(window.getSelection())?.quote?.segmentId).toBe(CITED_SEGMENT_ID);
    rightClick(cited);
    expect(menuLabels()).toEqual(["复制选中内容", "解释选中内容", "从这里播放", "复制这句", "复制这句（带时间）"]);
    fireEvent.click(screen.getByTestId("context-menu-item-explain-selection"));
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("解释一下「重排序」"));
    expect(screen.getByTestId("chat-quote").textContent).toContain("再看重排序。");
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("explains a selection across sentences with all of its text and no quote", async () => {
    const { reader } = await open();
    const first = await waitFor(() => reader.querySelector("[data-segment-id='s1']") as HTMLElement);
    const second = reader.querySelector("[data-segment-id='s2']") as HTMLElement;
    const range = document.createRange();
    range.setStart(first.firstChild as Text, 2);
    range.setEnd(second.firstChild as Text, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    (document as unknown as Record<string, unknown>)["caretPositionFromPoint"] = () => ({ offsetNode: second.firstChild, offset: 1 });
    rightClick(second);
    fireEvent.click(screen.getByTestId("context-menu-item-explain-selection"));
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("解释一下「讲检索。先看向」"));
    expect(screen.queryByTestId("chat-quote")).toBeNull();
  });
});

/** The router's query string, so a test can tell whether a click sought (`segment=`). */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function select(node: Node, start: number, end: number, endNode: Node = node): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

const placedOn = (segmentId: string, startOffset: number, endOffset: number, exact = true): NoteViewDto => ({ segments: [{ segmentId, startOffset, endOffset }], exact });

describe("TranscriptTab notes", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  async function openReader(routes: Parameters<typeof mockApi>[0] = {}, firstId = "s1") {
    const api = mockApi({ ...contentRoutes(), "POST /api/contents/c1/notes": { status: 201, body: note("n9") }, ...routes });
    renderApp(
      <>
        <ContentPage />
        <LocationProbe />
      </>,
      { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" },
    );
    const reader = await screen.findByTestId("transcript-reader");
    const first = await waitFor(() => {
      const element = reader.querySelector(`[data-segment-id='${firstId}']`);
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    return { ...api, reader, first };
  }

  it("creates an underline and a highlight from a selection, each with its own idempotency key and the remembered colours", async () => {
    const { calls, first } = await openReader();
    expect(first.closest("[data-notes]")?.getAttribute("data-revision-id")).toBe("r1");
    select(first.firstChild as Text, 2, 4);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-note-underline"));
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).toBeNull());
    select(first.firstChild as Text, 2, 4);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-note-background"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST").length).toBe(2));
    const posts = calls.filter((call) => call.method === "POST");
    const anchor = { transcriptRevisionId: "r1", startSegmentId: "s1", startOffset: 2, endSegmentId: "s1", endOffset: 4 };
    expect(posts.map((call) => [call.path, call.body])).toEqual([
      ["/api/contents/c1/notes", { ...anchor, mark: "underline", color: "blue" }],
      ["/api/contents/c1/notes", { ...anchor, mark: "background", color: "yellow" }],
    ]);
    expect(posts[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(posts[1]?.headers["idempotency-key"]).not.toBe(posts[0]?.headers["idempotency-key"]);
  });

  it("retries a failed highlight with the same key, and starts a comment as a draft that posts nothing", async () => {
    let posts = 0;
    const { calls, first } = await openReader({
      "POST /api/contents/c1/notes": () => {
        posts += 1;
        return posts === 1
          ? { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } }
          : { status: 201, body: note("n9") };
      },
    });
    select(first.firstChild as Text, 0, 2);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-note-background"));
    fireEvent.click(await screen.findByTestId("selection-note-retry"));
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).toBeNull());
    const sent = calls.filter((call) => call.method === "POST");
    expect(sent.length).toBe(2);
    expect(sent[1]?.headers["idempotency-key"]).toBe(sent[0]?.headers["idempotency-key"]);

    select(first.firstChild as Text, 2, 5);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-note-comment"));
    const compose = await screen.findByTestId("note-compose");
    expect(compose.textContent).toContain("讲检索");
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
    expect(calls.filter((call) => call.method === "POST").length).toBe(2);
  });

  it("disables the note actions with the reason for a selection over too many sentences", async () => {
    const many = Array.from({ length: NOTE_SPAN_MAX_SEGMENTS + 1 }, (_, index) => segment(`m${index}`, index, index * 1_000, index * 1_000 + 900, `第${index}句。`));
    const { reader, first: head } = await openReader(
      {
        "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: many } },
        "GET /api/contents/c1/chapters": { body: { revisions: [] } },
      },
      "m0",
    );
    const tail = reader.querySelector(`[data-segment-id='m${NOTE_SPAN_MAX_SEGMENTS}']`) as HTMLElement;
    select(head.firstChild as Text, 0, 2, tail.firstChild as Text);
    fireEvent.mouseUp(document);
    for (const id of ["selection-note-underline", "selection-note-background", "selection-note-comment"]) {
      const button = (await screen.findByTestId(id)) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(`一条笔记最多跨 ${NOTE_SPAN_MAX_SEGMENTS} 句`);
    }
  });

  it("offers no note actions for a selection in the summary", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=summary", path: "/contents/:id" });
    const text = await screen.findByText(/讲了重排序/u);
    select(text.firstChild as Text, 0, 2);
    fireEvent.mouseUp(document);
    expect(await screen.findByTestId("selection-explain")).toBeTruthy();
    expect(screen.queryByTestId("selection-note-underline")).toBeNull();
  });

  it("marks a note inside its sentence without changing the sentence text, and opening it does not seek", async () => {
    const { reader } = await openReader({
      "GET /api/contents/c1/notes": { body: { items: [note("n1", { startSegmentId: "s2", endSegmentId: "s2", view: placedOn("s2", 2, 4) })] } },
    });
    const sentence = reader.querySelector("[data-segment-id='s2']") as HTMLElement;
    const run = await waitFor(() => within(sentence).getByTestId("note-run"));
    expect(sentence.textContent).toBe("先看向量库。");
    expect(run.textContent).toBe("向量");
    expect(run.getAttribute("data-note-ids")).toBe("n1");
    const before = screen.getByTestId("location").textContent;
    fireEvent.click(run);
    expect(await screen.findByTestId("note-popover")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(before);
    expect(before).not.toContain("segment=");
    expect(sentence.getAttribute("aria-current")).toBeNull();
    // The rest of the sentence still seeks.
    fireEvent.click(sentence);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("segment=s2"));
  });

  it("does not seek on the click that ends a drag selection", async () => {
    const { first } = await openReader();
    select(first.firstChild as Text, 0, 3);
    fireEvent.click(first);
    expect(screen.getByTestId("location").textContent).not.toContain("segment=");
  });

  it("shows a note made on another revision over whole sentences", async () => {
    const { reader } = await openReader({
      "GET /api/contents/c1/notes": { body: { items: [note("n1", { transcriptRevisionId: "r0", view: placedOn("s2", 1, 2, false) })] } },
    });
    const run = await waitFor(() => within(reader.querySelector("[data-segment-id='s2']") as HTMLElement).getByTestId("note-run"));
    expect(run.textContent).toBe("先看向量库。");
  });

  it("counts notes that cannot be placed here and links the notes page, next to the toolbar's note count", async () => {
    await openReader({
      "GET /api/contents/c1/notes": { body: { items: [note("n1", { view: null }), note("n2", { view: placedOn("s1", 0, 2) })] } },
    });
    const unmapped = await screen.findByTestId("transcript-notes-unmapped");
    expect(unmapped.textContent).toBe("1 条笔记在此版本无法定位 · 查看");
    expect(within(unmapped).getByRole("link").getAttribute("href")).toBe("/notes?contentId=c1");
    const link = screen.getByTestId("transcript-notes-link");
    expect(link.textContent).toBe("笔记（2）");
    expect(link.getAttribute("href")).toBe("/notes?contentId=c1");
  });

  it("keeps reading when the notes fail to load, with a retry", async () => {
    const { calls, first } = await openReader({ "GET /api/contents/c1/notes": { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } } });
    const failed = await screen.findByTestId("transcript-notes-failed");
    expect(failed.textContent).toBe("笔记加载失败 · 重试");
    expect(first.textContent).toBe("今天讲检索。");
    const reads = () => calls.filter((call) => call.path.startsWith("/api/contents/c1/notes")).length;
    const before = reads();
    fireEvent.click(within(failed).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("keeps the row a drag started in mounted while the windowed reader scrolls, until the mouse is released", async () => {
    // jsdom has no layout: give every element a height so the virtualizer computes a window.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 400 });
    onTestFinished(() => {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    });
    const step = PARAGRAPH_GAP_MS * 2;
    const many = Array.from({ length: 200 }, (_, index) => segment(`p${index}`, index, index * step, index * step + 1_000, `第${index}段。`));
    mockApi({
      ...contentRoutes(),
      "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: many } },
      "GET /api/contents/c1/chapters": { body: { revisions: [] } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    const reader = await screen.findByTestId("transcript-reader");
    const start = await waitFor(() => reader.querySelector("[data-segment-id='p0']") as HTMLElement);
    const scrollFar = (): void => {
      reader.scrollTop = 100_000;
      fireEvent.scroll(reader);
    };

    fireEvent.mouseDown(start);
    select(start.firstChild as Text, 1, 3);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    scrollFar();
    // The window moved to the end of the list; only the pin keeps the first row.
    await waitFor(() => expect(reader.querySelector("[data-segment-id='p199']")).not.toBeNull());
    expect(reader.querySelector("[data-segment-id='p100']")).toBeNull();
    expect(reader.querySelector("[data-segment-id='p0']")).not.toBeNull();
    fireEvent.mouseUp(document);
    await waitFor(() => expect(reader.querySelector("[data-segment-id='p0']")).toBeNull());
  });
});

describe("TranscriptTab 设为当前", () => {
  const corrected = revision("r2", { kind: "corrected", parentRevisionId: "r1" });
  const translated = revision("t1", { kind: "translated", parentRevisionId: "r1", language: "en" });

  function routes(primary: string, put?: { status: number; body: unknown }) {
    let current = primary;
    const base = contentRoutes();
    const detail = base["GET /api/contents/c1"];
    return {
      ...base,
      "GET /api/contents/c1/transcript/revisions": () => ({ body: { primaryTranscriptRevisionId: current, revisions: [revision("r1"), corrected, translated] } }),
      "GET /api/transcript/revisions/r2/segments": { body: { revision: corrected, items: SEGMENTS } },
      "PUT /api/contents/c1/primary-transcript": (call: { body?: unknown }) => {
        if (put !== undefined) return put;
        current = (call.body as { revisionId: string }).revisionId;
        return { body: detail?.body };
      },
    };
  }

  async function open(picked: string, table: Parameters<typeof mockApi>[0]) {
    const api = mockApi(table);
    renderApp(<ContentPage />, { route: `/contents/c1?tab=transcript&revision=${picked}`, path: "/contents/:id" });
    await screen.findByTestId("transcript-reader");
    return api;
  }

  it("is offered only on a version that is not the current one", async () => {
    await open("r1", routes("r1"));
    await waitFor(() => expect(screen.getByTestId("transcript-version")).toBeTruthy());
    expect(screen.queryByTestId("transcript-set-primary")).toBeNull();
    // Translations are not listed in the reader's version picker at all.
    expect([...(screen.getByTestId("transcript-version") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["r1", "r2"]);
  });

  it("makes the picked version current and reads the revisions again, after which it is no longer offered", async () => {
    const api = await open("r2", routes("r1"));
    const button = await screen.findByTestId("transcript-set-primary");
    expect(button.textContent).toBe("设为当前");
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId("transcript-set-primary")).toBeNull());
    const put = api.calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe("/api/contents/c1/primary-transcript");
    expect(put?.body).toEqual({ revisionId: "r2" });
  });

  it("keeps the button and shows the server's reason when the switch is refused", async () => {
    await open(
      "r2",
      routes("r1", { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "找不到该内容" } } }),
    );
    fireEvent.click(await screen.findByTestId("transcript-set-primary"));
    await waitFor(() => expect(screen.getAllByText(/找不到/).length).toBeGreaterThan(0));
    expect(screen.getByTestId("transcript-set-primary")).toBeTruthy();
  });
});

describe("TranscriptTab version list: history, archive, delete, missing links and the ASR banner", () => {
  // r1 (asr) ← m1 ← m2 (primary); r1 ← m0 ; archived platform p1
  const asr = revision("r1", { kind: "asr", createdAt: 1 });
  const m0 = revision("m0", { kind: "manual", parentRevisionId: "r1", createdAt: 2, deletable: true });
  const m1 = revision("m1", { kind: "manual", parentRevisionId: "r1", createdAt: 3, descendantIds: ["m2"], blockers: { children: 1, draft: 0, notes: 2, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 0 } });
  const m2 = revision("m2", { kind: "manual", parentRevisionId: "m1", createdAt: 4 });
  const p1 = revision("p1", { kind: "platform", createdAt: 5, archived: true, archivedAt: 6 });

  function routes(list: ReturnType<typeof revision>[], primary: string, extra: Parameters<typeof mockApi>[0] = {}) {
    const segments = Object.fromEntries(list.map((item) => [`GET /api/transcript/revisions/${item.id}/segments`, { body: { revision: item, items: SEGMENTS } }]));
    return {
      ...contentRoutes(),
      ...segments,
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: primary, revisions: list } },
      ...extra,
    };
  }

  async function open(route: string, table: Parameters<typeof mockApi>[0]) {
    const api = mockApi(table);
    renderApp(<ContentPage />, { route, path: "/contents/:id" });
    await screen.findByTestId("transcript-reader");
    return api;
  }
  const options = () => [...(screen.getByTestId("transcript-version") as HTMLSelectElement).options].map((option) => option.value);

  it("lists one manual revision and reveals the rest behind the toggles", async () => {
    await open("/contents/c1?tab=transcript", routes([asr, m0, m1, m2, p1], "m2"));
    await waitFor(() => expect(options()).toEqual(["r1", "m2"]));
    const history = screen.getByTestId("revision-history-toggle") as HTMLInputElement;
    expect(history.closest("label")?.textContent).toBe("历史手动修订（2）");
    expect(screen.getByTestId("revision-archived-toggle").closest("label")?.textContent).toBe("显示已归档（1）");
    fireEvent.click(history);
    await waitFor(() => expect(options()).toEqual(["r1", "m0", "m1", "m2"]));
    fireEvent.click(screen.getByTestId("revision-archived-toggle"));
    await waitFor(() => expect(options()).toEqual(["r1", "m0", "m1", "m2", "p1"]));
    expect([...(screen.getByTestId("transcript-version") as HTMLSelectElement).options].at(-1)?.textContent).toContain("已归档");
  });

  it("opens the toggle a deep link needs and says so when the linked revision no longer exists", async () => {
    await open("/contents/c1?tab=transcript&revision=m0", routes([asr, m0, m1, m2, p1], "m2"));
    await waitFor(() => expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("m0"));
    expect((screen.getByTestId("revision-history-toggle") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("revision-missing")).toBeNull();
    expect(screen.queryByTestId("transcript-set-primary")).not.toBeNull();
  });

  it("falls back to the current version with a notice for a deleted revision", async () => {
    await open("/contents/c1?tab=transcript&revision=gone", routes([asr, m2], "m2"));
    expect((await screen.findByTestId("revision-missing")).textContent).toBe("版本不存在或已删除");
    expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("m2");
  });

  it("does not offer 设为当前 on an archived revision", async () => {
    await open("/contents/c1?tab=transcript&revision=p1", routes([asr, m2, p1], "m2"));
    await waitFor(() => expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("p1"));
    expect((screen.getByTestId("revision-archived-toggle") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("transcript-set-primary")).toBeNull();
  });

  it("archives the picked revision from its menu, and the current one offers neither action", async () => {
    const api = await open(
      "/contents/c1?tab=transcript&revision=m0",
      routes([asr, m0, m2], "m2", { "PUT /api/transcript/revisions/m0/archived": { body: { ...m0, archived: true, archivedAt: 9 } } }),
    );
    await waitFor(() => expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("m0"));
    fireEvent.keyDown(screen.getByTestId("revision-actions"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("revision-archive"));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT" && call.path === "/api/transcript/revisions/m0/archived")).toBe(true));
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ archived: true });

    fireEvent.change(screen.getByTestId("transcript-version"), { target: { value: "m2" } });
    await waitFor(() => expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("m2"));
    fireEvent.keyDown(screen.getByTestId("revision-actions"), { key: "Enter" });
    expect((await screen.findByTestId("revision-archive")).getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByTestId("revision-delete").getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByTestId("revision-actions-hint").textContent).toContain("当前稿");
  });

  it("offers only archiving for an ASR original", async () => {
    await open("/contents/c1?tab=transcript&revision=r1", routes([asr, m2], "m2"));
    await waitFor(() => expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("r1"));
    fireEvent.keyDown(screen.getByTestId("revision-actions"), { key: "Enter" });
    await screen.findByTestId("revision-archive");
    expect(screen.queryByTestId("revision-delete")).toBeNull();
  });

  it("deletes a revision with its descendants after listing them and its blockers", async () => {
    const api = await open(
      "/contents/c1?tab=transcript&revision=m1",
      routes([asr, m1, m2, revision("r9", { kind: "corrected", parentRevisionId: "r1", createdAt: 7 })], "r9", { "DELETE /api/transcript/revisions/m1": { status: 204 } }),
    );
    await waitFor(() => expect((screen.getByTestId("transcript-version") as HTMLSelectElement).value).toBe("m1"));
    fireEvent.keyDown(screen.getByTestId("revision-actions"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("revision-delete"));
    const dialog = await screen.findByTestId("revision-delete-dialog");
    expect(within(dialog).getByTestId("revision-blocker-children").textContent).toBe("基于它的版本 1 个");
    expect(within(dialog).getByTestId("revision-blocker-notes").textContent).toBe("笔记 2 条");
    expect((within(dialog).getByTestId("revision-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByTestId("revision-archive-instead")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("revision-delete-descendants"));
    expect(within(dialog).getByTestId("revision-delete-set").querySelectorAll("li")).toHaveLength(2);
    expect(within(dialog).queryByTestId("revision-blocker-children")).toBeNull();
    // Notes on m1 still block.
    expect((within(dialog).getByTestId("revision-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("shows the ASR banner while the user's own transcript is current, switches to it or remembers the dismissal", async () => {
    const later = revision("r5", { kind: "asr", createdAt: new Date(2026, 9, 20, 9, 5).getTime() });
    const api = await open("/contents/c1?tab=transcript", routes([asr, m2, later], "m2", { "PUT /api/contents/c1/primary-transcript": { body: contentDetail() } }));
    const banner = await screen.findByTestId("asr-banner");
    expect(banner.textContent).toContain("已生成新的转录稿（10-20 09:05），当前稿仍是「手动修订");
    fireEvent.click(screen.getByTestId("asr-banner-set-primary"));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ revisionId: "r5" }));
    fireEvent.click(screen.getByTestId("asr-banner-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("asr-banner")).toBeNull());
    expect(localStorage.getItem("amber.transcript.asrBanner.c1")).toBe("r5");
  });

  it("shows the ASR banner over an imported primary when a newer ASR original exists", async () => {
    const imported = revision("i1", { kind: "imported", createdAt: 2 });
    const later = revision("r5", { kind: "asr", createdAt: new Date(2026, 9, 20, 9, 5).getTime() });
    const api = await open("/contents/c1?tab=transcript", routes([asr, imported, later], "i1", { "PUT /api/contents/c1/primary-transcript": { body: contentDetail() } }));
    const banner = await screen.findByTestId("asr-banner");
    expect(banner.textContent).toContain("已生成新的转录稿（10-20 09:05），当前稿仍是「导入字幕");
    fireEvent.click(screen.getByTestId("asr-banner-set-primary"));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({ revisionId: "r5" }));
  });

  it("lists no manual revision and no history toggle when the Content has none", async () => {
    const fixed = revision("c1", { kind: "corrected", parentRevisionId: "r1", createdAt: 2 });
    const imported = revision("i1", { kind: "imported", createdAt: 3 });
    await open("/contents/c1?tab=transcript", routes([asr, fixed, imported], "c1"));
    await waitFor(() => expect(options()).toEqual(["r1", "c1", "i1"]));
    expect(screen.queryByTestId("revision-history-toggle")).toBeNull();
    expect(screen.queryByText(/历史手动修订/)).toBeNull();
  });

  it("keeps a dismissed banner closed for that revision only", async () => {
    localStorage.setItem("amber.transcript.asrBanner.c1", "r5");
    const later = revision("r5", { kind: "asr", createdAt: 10 });
    await open("/contents/c1?tab=transcript", routes([asr, m2, later], "m2"));
    expect(screen.queryByTestId("asr-banner")).toBeNull();
  });
});

describe("TranscriptTab speakers: copy and apply-speakers link", () => {
  async function openSpeakers(language?: string, route = "/contents/c1?tab=transcript&revision=r1") {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mockApi(speakerRoutes(language === undefined ? {} : { language }));
    renderApp(
      <>
        <ContentPage />
        <LocationProbe />
      </>,
      { route, path: "/contents/:id" },
    );
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.querySelector("[data-segment-id='g1']")).not.toBeNull());
    return { reader, writeText };
  }

  const pickCopy = async (id: "transcript-copy-body" | "transcript-copy-speakers") => {
    fireEvent.keyDown(screen.getByTestId("transcript-copy"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId(id));
  };

  it("splits 复制 into the body alone and the body with each turn opening with its speaker's name", async () => {
    const { writeText } = await openSpeakers();
    expect(screen.getByTestId("transcript-copy").textContent).toBe("复制");
    await pickCopy("transcript-copy-body");
    expect(writeText).toHaveBeenLastCalledWith(
      "开场\n\n今天讲检索。先看向量库。\n\n嗯。\n\n对，重排序是第二步，要把粗排的结果再精排一遍。\n\n第二段仍然是他在讲，所以还在同一个发言轮次里。\n\n这一句没有人认领，所以它属于未分配的轮次。\n\n正文\n\n再看重排序，它决定了最终展示给用户的排列顺序。",
    );
    await pickCopy("transcript-copy-speakers");
    expect(writeText).toHaveBeenLastCalledWith(
      "开场\n\n陈明：今天讲检索。先看向量库。\n\n发言人 2：嗯。\n\n陈明：对，重排序是第二步，要把粗排的结果再精排一遍。\n\n第二段仍然是他在讲，所以还在同一个发言轮次里。\n\n这一句没有人认领，所以它属于未分配的轮次。\n\n正文\n\n陈明：再看重排序，它决定了最终展示给用户的排列顺序。",
    );
  });

  it("uses a half-width colon and a space for a revision that is not Chinese", async () => {
    const { writeText } = await openSpeakers("en");
    await pickCopy("transcript-copy-speakers");
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("陈明: 今天讲检索。");
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("发言人 2: 嗯。");
  });

  it("copies with speakers even while the turns are hidden", async () => {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ version: 1, fontSize: 16, lineHeight: 1.7, showSpeakers: false }));
    const { reader, writeText } = await openSpeakers();
    expect(reader.querySelector("[data-turn-key]")).toBeNull();
    await pickCopy("transcript-copy-speakers");
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("陈明：今天讲检索。");
  });

  it("opens the editor for ?applySpeakers=<revision> and spends the parameter", async () => {
    const { calls } = mockApi(speakerRoutes());
    renderApp(
      <>
        <ContentPage />
        <LocationProbe />
      </>,
      { route: "/contents/c1?tab=transcript&revision=r1&applySpeakers=r5", path: "/contents/:id" },
    );
    // The editor replaces the reading view, and the address no longer asks for it.
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("applySpeakers"), { timeout: 5_000 });
    expect(screen.getByTestId("location").textContent).toContain("revision=r1");
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/c1/transcript/draft")).toBe(true), { timeout: 5_000 });
    expect(screen.queryByTestId("transcript-reader")).toBeNull();
  });
});

describe("TranscriptTab keeps the reading position when the typography changes", () => {
  type Change = "font" | "lineHeight" | "speakers";

  type Typography = { fontSize: number; lineHeight: number; turns: boolean };

  /** Where the list sits on screen: its top edge, the height it shows and the padding above its first row. */
  const LIST_TOP = 100;
  const VIEWPORT = 300;
  const PADDING = 8;
  /**
   * A reader stops scrolling a while before reaching for the typography: longer than the list
   * takes to stop counting as scrolling after its last scroll event.
   */
  const READING_PAUSE_MS = 200;

  /** The typography the rows are drawn with, read from the first row's paragraph (or the turn holding it). */
  function typographyOf(reader: HTMLElement): Typography {
    const body = reader.querySelector<HTMLElement>("[data-row-index] p");
    const holder = body?.closest<HTMLElement>("[data-turn-key]") ?? body;
    return {
      fontSize: Number.parseFloat(holder?.style.fontSize || String(READER_FONT_SIZE_DEFAULT)),
      lineHeight: Number.parseFloat(holder?.style.lineHeight || String(READER_LINE_HEIGHT_DEFAULT)),
      turns: reader.querySelector("[data-turn-key]") !== null,
    };
  }

  /**
   * Lays the list out like a browser would, for every row as soon as it mounts: a row's height
   * follows the typography the rows carry, and the virtualizer reads the same height. A plain
   * row sits below every row before it; a windowed row where its transform puts it. Both sit
   * below the list's padding, and move with its scroll position.
   */
  function layOut(heightOf: (typography: Typography) => number): void {
    const rectOf = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.getAttribute("data-testid") === "transcript-reader") return DOMRect.fromRect({ x: 0, y: LIST_TOP, width: 600, height: VIEWPORT });
      const reader = this.closest<HTMLElement>("[data-testid='transcript-reader']");
      if (reader === null || !this.hasAttribute("data-row-index")) return rectOf.call(this);
      const height = heightOf(typographyOf(reader));
      const translated = /translateY\((-?[\d.]+)px\)/.exec((this as HTMLElement).style.transform)?.[1];
      const start = translated === undefined ? Number(this.getAttribute("data-row-index")) * height : Number(translated);
      return DOMRect.fromRect({ x: 0, y: LIST_TOP + PADDING + start - reader.scrollTop, width: 600, height });
    });
    const offsetHeightOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")?.get;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("data-testid") === "transcript-reader") return VIEWPORT;
      const reader = this.closest<HTMLElement>("[data-testid='transcript-reader']");
      if (reader !== null && this.hasAttribute("data-row-index")) return Math.round(heightOf(typographyOf(reader)));
      return offsetHeightOf?.call(this) ?? 0;
    });
    const offsetTopOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")?.get;
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      // The box the windowed rows are positioned in starts below the list's padding.
      if (this.parentElement?.getAttribute("data-testid") === "transcript-reader" && !this.hasAttribute("data-row-index")) return PADDING;
      return offsetTopOf?.call(this) ?? 0;
    });
  }

  /**
   * jsdom neither scrolls on `scrollTo` nor fires a scroll event when a script sets the scroll
   * position; a browser does both, the event before the next frame. The virtualizer follows the
   * scroll position only through that event.
   */
  function scrollLikeABrowser(reader: HTMLElement): void {
    let top = 0;
    Object.defineProperty(reader, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        const next = Math.max(0, value);
        if (next === top) return;
        top = next;
        setTimeout(() => reader.dispatchEvent(new Event("scroll")), 0);
      },
    });
    reader.scrollTo = ((options: ScrollToOptions) => {
      reader.scrollTop = options.top ?? top;
    }) as typeof reader.scrollTo;
  }

  /** The first row with room below the list's top edge and where its top sits: what the reader keeps in place. */
  function firstVisible(reader: HTMLElement): { key: string; offset: number } {
    const top = reader.getBoundingClientRect().top;
    for (const row of reader.querySelectorAll<HTMLElement>("[data-row-key]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top) return { key: row.dataset["rowKey"] as string, offset: rect.top - top };
    }
    throw new Error("no visible row");
  }
  const offsetOf = (reader: HTMLElement, key: string): number | undefined => {
    const row = [...reader.querySelectorAll<HTMLElement>("[data-row-key]")].find((candidate) => candidate.dataset["rowKey"] === key);
    return row === undefined ? undefined : row.getBoundingClientRect().top - reader.getBoundingClientRect().top;
  };
  const rowHeight = (reader: HTMLElement): number => (reader.querySelector("[data-row-index]") as HTMLElement).getBoundingClientRect().height;

  async function openPopover(): Promise<HTMLElement> {
    const open = screen.queryByTestId("reader-typography-popover");
    if (open !== null) return open;
    fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
    return screen.findByTestId("reader-typography-popover");
  }

  async function change(kind: Change): Promise<void> {
    const popover = await openPopover();
    // The user arrives asynchronously; a change made before that is not stored, so it is repeated until it is.
    await waitFor(() => {
      if (kind === "font") fireEvent.click(within(popover).getByRole("button", { name: "增大字号" }));
      else if (kind === "lineHeight") fireEvent.click(within(popover).getByRole("radio", { name: "2.0" }));
      else fireEvent.click(within(popover).getByRole("switch", { name: "显示发言人" }));
      expect(localStorage.getItem(TYPOGRAPHY_KEY)).not.toBeNull();
    });
  }

  const sentences = (count: number, speakers: boolean) =>
    Array.from({ length: count }, (_, index) =>
      segment(`p${index}`, index, index * PARAGRAPH_GAP_MS * 2, index * PARAGRAPH_GAP_MS * 2 + 1_000, `第${index}段。`, speakers ? { speakerId: index % 2 === 0 ? "sp1" : "sp2" } : {}),
    );

  /**
   * Opens a list of 200 rows (windowed) or 12 (plain) and waits until it is drawn with the
   * typography `stored` holds (the defaults when nothing is stored) and, with speakers, their
   * turns: the stored typography only applies once the user has loaded.
   */
  async function openList(windowed: boolean, speakers: boolean, stored?: Partial<ReaderTypography>) {
    // A windowed row is 400px at the defaults, a little less without the turn headers; a plain one about 80px.
    const windowedBase = (turns: boolean): number => (turns || !speakers ? 400 : 360);
    layOut(({ fontSize, lineHeight, turns }) =>
      windowed
        ? windowedBase(turns) * (fontSize / READER_FONT_SIZE_DEFAULT) * (lineHeight / READER_LINE_HEIGHT_DEFAULT)
        : fontSize * lineHeight * 3 + (turns ? 40 : 0),
    );
    const typography = { ...READER_TYPOGRAPHY_DEFAULTS, ...stored };
    if (stored !== undefined) localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(typography));
    mockApi({ ...speakerRoutes({ segments: sentences(windowed ? 200 : 12, speakers) }), "GET /api/contents/c1/chapters": { body: { revisions: [] } } });
    const mounted = mountReader();
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    scrollLikeABrowser(reader);
    await waitFor(() => expect(reader.querySelector("[data-segment-id='p2']")).not.toBeNull(), { timeout: 5_000 });
    const expected: Typography = { fontSize: typography.fontSize, lineHeight: typography.lineHeight, turns: speakers && typography.showSpeakers };
    await waitFor(() => expect(typographyOf(reader)).toEqual(expected), { timeout: 5_000 });
    return { ...mounted, reader };
  }

  /** Scrolls the anchor row half a row above the list's top edge, then pauses as a reader does. */
  async function scrollToAnchor(reader: HTMLElement): Promise<{ key: string; offset: number }> {
    const anchorIndex = 2;
    act(() => {
      reader.scrollTop = Math.round(rowHeight(reader) * (anchorIndex + 0.5));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, READING_PAUSE_MS)));
    const before = firstVisible(reader);
    expect(before.key).toBe(`p${anchorIndex}`);
    return before;
  }

  /** The anchor row is mounted and back at its distance from the top, and the rows really changed size, so it was kept by correction and not by luck. */
  async function expectKept(reader: HTMLElement, before: { key: string; offset: number }, heightBefore: number): Promise<void> {
    await waitFor(
      () => {
        const offset = offsetOf(reader, before.key);
        expect(offset).not.toBeUndefined();
        expect(offset).toBeCloseTo(before.offset, 0);
      },
      { timeout: 5_000 },
    );
    expect(rowHeight(reader)).not.toBe(heightBefore);
  }

  describe.each([
    ["a plain list", false],
    ["a windowed list", true],
  ])("in %s", (_name, windowed) => {
    it.each<[string, Change, boolean]>([
      ["font size", "font", false],
      ["line height", "lineHeight", false],
      ["line height with speakers", "lineHeight", true],
      ["showing the speakers", "speakers", true],
    ])("puts the first visible row back at the same distance from the top after changing the %s", async (_label, kind, speakers) => {
      const { reader } = await openList(windowed, speakers);
      const before = await scrollToAnchor(reader);
      const heightBefore = rowHeight(reader);
      await change(kind);
      await expectKept(reader, before, heightBefore);
    });

    it("puts the first visible row back at the same distance from the top after 恢复默认", async () => {
      const { reader } = await openList(windowed, false, { fontSize: READER_FONT_SIZE_DEFAULT + 4 });
      const before = await scrollToAnchor(reader);
      const heightBefore = rowHeight(reader);
      const popover = await openPopover();
      fireEvent.click(within(popover).getByRole("button", { name: "恢复默认" }));
      expect(localStorage.getItem(TYPOGRAPHY_KEY)).toBeNull();
      await expectKept(reader, before, heightBefore);
      expect(typographyOf(reader).fontSize).toBe(READER_FONT_SIZE_DEFAULT);
    });
  });

  describe("a change that does not land", () => {
    it("leaves no anchor behind to pull the view back at a later render when the preference cannot be stored yet", async () => {
      layOut(({ fontSize, lineHeight }) => fontSize * lineHeight * 3);
      mockApi({
        ...speakerRoutes({ segments: sentences(12, false) }),
        "GET /api/auth/me": { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } },
      });
      const { controller } = mountReader();
      const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
      await waitFor(() => expect(reader.querySelector("[data-segment-id='p2']")).not.toBeNull());
      reader.scrollTop = 200;
      fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
      fireEvent.click(await screen.findByRole("button", { name: "增大字号" }));
      expect(localStorage.getItem(TYPOGRAPHY_KEY)).toBeNull();
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
      reader.scrollTop = 321;
      act(() => controller.reportTime(500));
      expect(reader.scrollTop).toBe(321);
    });

    it("leaves no anchor behind for 恢复默认 when everything is already at its default", async () => {
      const { reader, controller } = await openList(false, false);
      const popover = await openPopover();
      act(() => {
        reader.scrollTop = 200;
      });
      fireEvent.click(within(popover).getByRole("button", { name: "恢复默认" }));
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
      act(() => {
        reader.scrollTop = 333;
      });
      act(() => controller.reportTime(500));
      expect(reader.scrollTop).toBe(333);
    });
  });
});

describe("TranscriptTab sentence menu with speakers", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  async function open(options: Parameters<typeof speakerRoutes>[0] = {}, ready = "g1") {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mockApi(speakerRoutes(options));
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" },
    );
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.querySelector(`[data-segment-id='${ready}']`)).not.toBeNull());
    return { reader, writeText };
  }

  it("adds 复制这句（含发言人） in speaker mode, led by the speaker's name", async () => {
    const { reader, writeText } = await open();
    expect(rightClick(reader.querySelector("[data-segment-id='g1']") as HTMLElement)).toBe(true);
    expect(menuLabels()).toEqual(["从这里播放", "复制这句", "复制这句（带时间）", "复制这句（含发言人）"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence-with-speaker"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("陈明：今天讲检索。"));
  });

  it("leads an unnamed speaker's sentence with 发言人 N, uses a half-width colon for other languages and adds nothing for an unassigned sentence", async () => {
    const { reader, writeText } = await open({ language: "en" });
    rightClick(reader.querySelector("[data-segment-id='g3']") as HTMLElement);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence-with-speaker"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("发言人 2: 嗯。"));
    rightClick(reader.querySelector("[data-segment-id='g6']") as HTMLElement);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence-with-speaker"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("这一句没有人认领，所以它属于未分配的轮次。"));
  });

  it("is not offered when the text is not read by speakers", async () => {
    const plain = SEGMENTS.map((item) => ({ ...item }));
    const { reader } = await open({ segments: plain }, "s1");
    rightClick(reader.querySelector("[data-segment-id='s1']") as HTMLElement);
    expect(menuLabels()).toEqual(["从这里播放", "复制这句", "复制这句（带时间）"]);
  });
});

describe("TranscriptTab version info and applying speakers", () => {
  it("shows how the speakers of a version came about on its option and on the picker", async () => {
    mockApi(speakerRoutes({ revision: { kind: "asr", generation: { diarization: { status: "applied" } } } }));
    mountReader();
    const picker = (await screen.findByTestId("transcript-version", {}, { timeout: 5_000 })) as HTMLSelectElement;
    await waitFor(() => expect(picker.title).toContain("发言人识别：已识别发言人"));
    expect((picker.options[0] as HTMLOptionElement).title).toContain("发言人识别：已识别发言人");
  });

  it("shows how many sentences took their speaker from an accepted suggestion", async () => {
    mockApi(speakerRoutes({ revision: { kind: "manual", generation: { speakerReview: { acceptedSuggestions: 12 } } } }));
    mountReader();
    const picker = (await screen.findByTestId("transcript-version", {}, { timeout: 5_000 })) as HTMLSelectElement;
    await waitFor(() => expect(picker.title).toContain("12 句按建议归属，未逐句核对"));
  });

  it("applies speakers to the current text even while a newer recognition is being read", async () => {
    const current = revision("r1", { kind: "manual", createdAt: 1 });
    const recognized = revision("r5", { kind: "asr", createdAt: 5 });
    const { calls } = mockApi({
      ...speakerRoutes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [current, recognized] } },
      "GET /api/transcript/revisions/r1/segments": { body: { revision: current, items: SEGMENTS } },
      "GET /api/transcript/revisions/r5/segments": { body: { revision: recognized, items: SPEAKER_SEGMENTS.map((item) => ({ ...item, revisionId: "r5" })) } },
    });
    mountReader({ route: "/contents/c1?tab=transcript&revision=r5&applySpeakers=r5" });
    // The draft starts from the current text (r1), and the recognition is offered as the source of the speakers.
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5_000 });
    expect((await within(dialog).findAllByRole("option", { name: /ASR 原稿/ })).length).toBeGreaterThan(0);
    const draftAt = calls.findIndex((call) => call.path === "/api/contents/c1/transcript/draft");
    expect(draftAt).toBeGreaterThanOrEqual(0);
    const afterDraft = calls.slice(draftAt).map((call) => call.path.split("?")[0]);
    expect(afterDraft).toContain("/api/transcript/revisions/r1/segments");
  });
});
