import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useLocation } from "react-router";
import { BREAKPOINT_DRAWER_PX, NOTE_SPAN_MAX_SEGMENTS, PARAGRAPH_GAP_MS, READER_FONT_SIZE_DEFAULT, READER_LINE_HEIGHT_DEFAULT, READER_MARGIN_DEFAULT, READER_MARGIN_MAX } from "../../../../src/shared/defaults.ts";
import { READER_TYPOGRAPHY_DEFAULTS, type ReaderTypography } from "../../../../src/shared/reader-typography.ts";
import type { NoteViewDto } from "../../../../src/shared/dto/note.ts";
import { selectionForExplain } from "../../../../src/web/chat/selection-toolbar.tsx";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { READER_COLUMN_CLASS } from "../../../../src/web/pages/content/reader-sentences.tsx";
import { changedSegments, TranscriptTab } from "../../../../src/web/pages/content/transcript-tab.tsx";
import { CITED_SEGMENT_ID, contentDetail, contentRoutes, revision, segment, SEGMENTS } from "../../../fixtures/web/content-data.ts";
import { note } from "../../../fixtures/web/note-data.ts";
import { CHEN, mountReader, pageState, READER_ME, SPEAKER_SEGMENTS, speakerRoutes, TYPOGRAPHY_KEY, UNNAMED } from "../../../fixtures/web/reader-speakers.tsx";
import { recognition } from "../../../fixtures/web/speaker-compare.ts";
import { stubResizeObserver } from "../../../fixtures/web/speaker-fetch.ts";
import { ContentPageProvider } from "../../../../src/web/pages/content/content-context.tsx";
import { CAPABILITIES } from "../../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider } from "../../../../src/web/player/player-controller.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { resetBundledFonts } from "../../../../src/web/bundled-fonts.ts";
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
    expect(within(reader).getAllByTestId("transcript-chapter").map((heading) => heading.textContent)).toEqual(["开场", "正文"]);
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

  it("heads a chapter with its title alone, in a heading, and a play button beside it named by where it plays from", async () => {
    mockApi(contentRoutes());
    renderApp(<ContentPage />, { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" });
    const reader = await screen.findByTestId("transcript-reader");
    const headings = await within(reader).findAllByTestId("transcript-chapter");
    expect(headings.map((heading) => heading.textContent)).toEqual(["开场", "正文"]);
    for (const [index, heading] of headings.entries()) {
      // The heading is a row of the reading column itself.
      expect(heading.parentElement?.className).toBe(READER_COLUMN_CLASS);
      const title = within(heading).getByTestId("chapter-title");
      expect(title.textContent).toBe(["开场", "正文"][index]);
      const h3 = title.closest("h3");
      expect(h3).not.toBeNull();
      expect(heading.contains(h3)).toBe(true);
      const play = within(heading).getByTestId("chapter-play");
      expect(play.tagName).toBe("BUTTON");
      expect(h3?.contains(play)).toBe(false);
      // Not text anyone said: a selection leaves it out.
      expect(play.hasAttribute("data-reader-meta")).toBe(true);
    }
    // The time is where the first sentence shown under the heading starts.
    expect(headings.map((heading) => within(heading).getByTestId("chapter-play").getAttribute("aria-label"))).toEqual(["从 0:00 播放", "从 1:15 播放"]);
  });

  it("seeks to the first sentence under a chapter heading from its play button or its title", async () => {
    stubResizeObserver();
    const select = vi.fn();
    mockApi(speakerRoutes());
    mountReader({ select });
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    const heading = async (title: string) => (await within(reader).findAllByTestId("transcript-chapter")).find((item) => item.textContent === title) as HTMLElement;
    // 正文 starts at 1:00; the first sentence under it, g7, at 1:15.
    const body = await heading("正文");
    expect(within(body).getByTestId("chapter-play").getAttribute("aria-label")).toBe("从 1:15 播放");
    fireEvent.click(within(body).getByTestId("chapter-title"));
    expect(select).toHaveBeenLastCalledWith({ revisionId: "r1", segmentId: "g7" }, 75_000);
    fireEvent.click(within(await heading("开场")).getByRole("button", { name: "从 0:00 播放" }));
    expect(select).toHaveBeenLastCalledWith({ revisionId: "r1", segmentId: "g1" }, 0);
    fireEvent.click(within(body).getByRole("button", { name: "从 1:15 播放" }));
    expect(select).toHaveBeenLastCalledWith({ revisionId: "r1", segmentId: "g7" }, 75_000);
    expect(select).toHaveBeenCalledTimes(3);
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
    // Each entry is the chapter's start and the title its heading in the reader shows.
    const titles = within(reader).getAllByTestId("transcript-chapter").map((heading) => heading.textContent);
    expect(titles).toEqual(["开场", "正文"]);
    expect(items.map((item) => item.textContent)).toEqual(["0:00开场", "1:00正文"]);
    expect(items.map((item) => item.lastElementChild?.textContent)).toEqual(titles);
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

/**
 * A FontFace stand-in: jsdom loads no fonts, so a registered face is only recorded. A face
 * finishes loading once `ready` settles (at once without it).
 */
function stubFontFaces(ready: Promise<void> = Promise.resolve()): string[] {
  const added: string[] = [];
  class FakeFontFace {
    readonly family: string;
    constructor(family: string) {
      this.family = family;
    }
    load(): Promise<this> {
      return ready.then(() => this);
    }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFontFace) => added.push(face.family) } });
  onTestFinished(() => {
    Reflect.deleteProperty(document, "fonts");
    resetBundledFonts();
  });
  return added;
}

const FONT_ROUTES = {
  "GET /api/fonts/reader/serif": { body: "serif", headers: { "content-type": "font/otf" } },
  "GET /api/fonts/reader/kai": { body: "kai", headers: { "content-type": "font/ttf" } },
};

describe("TranscriptTab keeps the reading position when the typography changes", () => {
  type Change = "font" | "lineHeight" | "speakers" | "typeface" | "margin";

  type Typography = { fontSize: number; lineHeight: number; turns: boolean; face: string; margin: number };

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
      face: reader.closest("[data-reader-font]")?.getAttribute("data-reader-font") ?? "default",
      margin: Number.parseFloat(reader.parentElement?.style.getPropertyValue("--reader-margin") || String(READER_MARGIN_DEFAULT)),
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
      else if (kind === "typeface") fireEvent.click(within(popover).getByRole("radio", { name: /^宋体/u }));
      else if (kind === "margin") fireEvent.change(within(popover).getByRole("slider", { name: "左右间距" }), { target: { value: String(READER_MARGIN_MAX) } });
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
  async function openList(
    windowed: boolean,
    speakers: boolean,
    stored?: Partial<ReaderTypography>,
    fonts: { ready?: Promise<void>; routes?: Parameters<typeof mockApi>[0]; drawn?: string } = {},
  ) {
    // A windowed row is 400px at the defaults, a little less without the turn headers; a plain one about 80px.
    const windowedBase = (turns: boolean): number => (turns || !speakers ? 400 : 360);
    // The serif face sets a little wider, so its rows wrap into more lines.
    const faceFactor = (face: string): number => (face === "default" ? 1 : 1.25);
    // Wider margins leave a narrower column, so the rows wrap into more lines.
    const marginFactor = (margin: number): number => 1 + (margin - READER_MARGIN_DEFAULT) / 400;
    layOut(({ fontSize, lineHeight, turns, face, margin }) =>
      windowed
        ? windowedBase(turns) * (fontSize / READER_FONT_SIZE_DEFAULT) * (lineHeight / READER_LINE_HEIGHT_DEFAULT) * faceFactor(face) * marginFactor(margin)
        : (fontSize * lineHeight * 3 + (turns ? 40 : 0)) * faceFactor(face) * marginFactor(margin),
    );
    stubFontFaces(fonts.ready);
    const typography = { ...READER_TYPOGRAPHY_DEFAULTS, ...stored };
    if (stored !== undefined) localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(typography));
    mockApi({
      ...speakerRoutes({ segments: sentences(windowed ? 200 : 12, speakers) }),
      ...(fonts.routes ?? FONT_ROUTES),
      "GET /api/contents/c1/chapters": { body: { revisions: [] } },
    });
    const mounted = mountReader();
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    scrollLikeABrowser(reader);
    await waitFor(() => expect(reader.querySelector("[data-segment-id='p2']")).not.toBeNull(), { timeout: 5_000 });
    const expected: Typography = {
      fontSize: typography.fontSize,
      lineHeight: typography.lineHeight,
      turns: speakers && typography.showSpeakers,
      face: fonts.drawn ?? typography.font ?? "default",
      margin: typography.sideMargin ?? READER_MARGIN_DEFAULT,
    };
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
      ["font", "typeface", false],
      ["font with speakers", "typeface", true],
      ["side margin", "margin", false],
      ["side margin with speakers", "margin", true],
    ])("puts the first visible row back at the same distance from the top after changing the %s", async (_label, kind, speakers) => {
      const { reader } = await openList(windowed, speakers);
      const before = await scrollToAnchor(reader);
      const heightBefore = rowHeight(reader);
      await change(kind);
      await expectKept(reader, before, heightBefore);
    });

    it("keeps the first visible row where it was when a stored face finishes loading after the rows are drawn", async () => {
      let release = (): void => undefined;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { reader } = await openList(windowed, true, { font: "serif" }, { ready, drawn: "default" });
      const before = await scrollToAnchor(reader);
      const heightBefore = rowHeight(reader);
      // Meanwhile the checked segment shows the read.
      const popover = await openPopover();
      const loading = within(popover).getByRole("radio", { name: "宋体（加载中）" });
      expect((loading as HTMLInputElement).checked).toBe(true);
      expect(loading.closest("label")?.getAttribute("aria-busy")).toBe("true");
      await act(async () => release());
      await waitFor(() => expect(typographyOf(reader).face).toBe("serif"));
      await expectKept(reader, before, heightBefore);
      expect(within(popover).getByRole("radio", { name: "宋体" }).closest("label")?.hasAttribute("aria-busy")).toBe(false);
    });

    it("keeps the first visible row where it was when a stored face that failed is read again and drawn", async () => {
      let reads = 0;
      const routes = {
        "GET /api/fonts/reader/serif": () => {
          reads += 1;
          return reads === 1
            ? { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } }
            : FONT_ROUTES["GET /api/fonts/reader/serif"];
        },
      };
      const { reader } = await openList(windowed, false, { font: "serif" }, { routes, drawn: "default" });
      const popover = await openPopover();
      await within(popover).findByTestId("reader-font-failed");
      const before = await scrollToAnchor(reader);
      const heightBefore = rowHeight(reader);
      fireEvent.click(within(popover).getByRole("radio", { name: "宋体" }));
      await waitFor(() => expect(typographyOf(reader).face).toBe("serif"));
      expect(reads).toBe(2);
      await expectKept(reader, before, heightBefore);
      expect(within(popover).queryByTestId("reader-font-failed")).toBeNull();
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

describe("TranscriptTab reading font", () => {
  const fontCalls = (calls: Array<{ path: string }>) => calls.filter((call) => call.path.startsWith("/api/fonts/"));

  async function openReader(stored?: Partial<ReaderTypography>, routes: Record<string, unknown> = FONT_ROUTES) {
    if (stored !== undefined) localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ ...READER_TYPOGRAPHY_DEFAULTS, ...stored }));
    const { calls } = mockApi({ ...speakerRoutes(), ...(routes as Parameters<typeof mockApi>[0]) });
    mountReader();
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.querySelector("[data-segment-id='g1']")).not.toBeNull(), { timeout: 5_000 });
    return { reader, calls };
  }

  it("reads no font and marks nothing in the default font", async () => {
    stubFontFaces();
    const { reader, calls } = await openReader();
    fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
    await screen.findByTestId("reader-typography-popover");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(fontCalls(calls)).toEqual([]);
    expect(reader.closest("[data-reader-font]")).toBeNull();
    // The host carries only the reading column's size variables, no font of any kind.
    const host = reader.parentElement as HTMLElement;
    expect([...host.style].sort()).toEqual(["--reader-font-size", "--reader-gutter", "--reader-margin"]);
  });

  it("gives the reading column the default side margin in px when none is stored", async () => {
    stubFontFaces();
    const { reader } = await openReader();
    expect((reader.parentElement as HTMLElement).style.getPropertyValue("--reader-margin")).toBe(`${READER_MARGIN_DEFAULT}px`);
  });

  it("gives the reading column the stored side margin in px", async () => {
    stubFontFaces();
    const { reader } = await openReader({ sideMargin: 120 });
    expect((reader.parentElement as HTMLElement).style.getPropertyValue("--reader-margin")).toBe("120px");
  });

  it("applies a stored bundled face once read, to the sentence paragraphs only", async () => {
    const added = stubFontFaces();
    const { reader, calls } = await openReader({ font: "kai" });
    await waitFor(() => expect(reader.closest("[data-reader-font]")?.getAttribute("data-reader-font")).toBe("kai"));
    expect(fontCalls(calls).map((call) => call.path)).toEqual(["/api/fonts/reader/kai"]);
    expect(added).toEqual(["LXGW WenKai Lite"]);
    // Every sentence sits in a paragraph that takes the reading font.
    for (const sentence of reader.querySelectorAll("[data-segment-id]")) expect(sentence.closest("[data-reader-text]")).not.toBeNull();
    // Chapter titles and turn headers (names, times) are outside those paragraphs.
    expect(reader.querySelectorAll("[data-testid='transcript-chapter']").length).toBeGreaterThan(0);
    for (const heading of reader.querySelectorAll("[data-testid='transcript-chapter'], [data-testid='turn-header']")) {
      expect(heading.closest("[data-reader-text]")).toBeNull();
      expect(heading.querySelector("[data-reader-text]")).toBeNull();
    }
    // No speaker name is inside a paragraph; each paragraph's time button opens it, and buttons keep their own font.
    expect(reader.querySelector("[data-reader-text] [data-testid='turn-speaker']")).toBeNull();
    const texts = [...reader.querySelectorAll("[data-reader-text]")];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect((text.firstElementChild as HTMLElement).matches("button[data-reading-time]")).toBe(true);
  });

  it("leaves the chapter titles in the page's font: no reading font rule reaches them", async () => {
    stubFontFaces();
    // The style sheet's own reading font rules, unlayered so the test DOM applies them.
    const css = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
    const rules = [...css.matchAll(/(\[data-reader-font\][^{}]*)\{([^{}]*)\}/g)].map((rule) => `${rule[1]}{${rule[2]}}`);
    expect(rules.some((rule) => rule.includes("var(--reader-font)"))).toBe(true);
    const sheet = document.createElement("style");
    sheet.textContent = rules.join("\n");
    document.head.append(sheet);
    onTestFinished(() => sheet.remove());
    const { reader } = await openReader({ font: "kai" });
    await waitFor(() => expect(reader.closest("[data-reader-font]")?.getAttribute("data-reader-font")).toBe("kai"));
    const family = (element: Element): string => getComputedStyle(element).fontFamily;
    // The sentences take the reading font through the rule...
    const paragraph = reader.querySelector("[data-reader-text]");
    expect(paragraph).not.toBeNull();
    expect(family(paragraph as Element)).toContain("--reader-font");
    // ...which neither a chapter title, nor anything in it, nor anything above it up to the reader matches.
    const titles = [...reader.querySelectorAll("[data-testid='transcript-chapter']")];
    expect(titles.length).toBeGreaterThan(0);
    const host = reader.closest("[data-reader-font]") as Element;
    for (const title of titles) {
      for (const element of [title, ...title.querySelectorAll("*")]) expect(family(element)).not.toContain("--reader-font");
      for (let element = title.parentElement; element !== null && element !== host.parentElement; element = element.parentElement) {
        expect(family(element)).not.toContain("--reader-font");
      }
    }
  });

  it("stays in the default font and says so when the stored face cannot be read", async () => {
    stubFontFaces();
    const { reader, calls } = await openReader({ font: "serif" }, {});
    await waitFor(() => expect(fontCalls(calls)).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
    expect((await screen.findByTestId("reader-font-failed")).textContent).toBe("字体加载失败");
    expect(reader.closest("[data-reader-font]")).toBeNull();
  });

  it("writes a custom name into the reader's custom property", async () => {
    stubFontFaces();
    const { reader, calls } = await openReader({ font: "custom", customFont: "Kaiti SC" });
    const host = reader.closest<HTMLElement>("[data-reader-font]");
    expect(host?.getAttribute("data-reader-font")).toBe("custom");
    expect(host?.style.getPropertyValue("--reader-custom-font")).toBe('"Kaiti SC"');
    expect(fontCalls(calls)).toEqual([]);
  });
});

describe("TranscriptTab reading in a stored bundled font", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  /** The full content page for the signed-in user whose stored typography reads in 楷体. */
  async function openPage(search = "", routes: Parameters<typeof mockApi>[0] = {}) {
    stubFontFaces();
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ ...READER_TYPOGRAPHY_DEFAULTS, font: "kai" }));
    const api = mockApi({
      ...contentRoutes(),
      ...FONT_ROUTES,
      "GET /api/auth/me": { body: READER_ME },
      "POST /api/contents/c1/notes": { status: 201, body: note("n9") },
      ...routes,
    });
    renderApp(
      <>
        <ContentPage />
        <LocationProbe />
      </>,
      { route: `/contents/c1?tab=transcript&revision=r1${search}`, path: "/contents/:id" },
    );
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.closest("[data-reader-font]")?.getAttribute("data-reader-font")).toBe("kai"), { timeout: 5_000 });
    const sentence = (id: string): HTMLElement => {
      const element = reader.querySelector<HTMLElement>(`[data-segment-id='${id}']`);
      expect(element).not.toBeNull();
      expect(element?.closest("[data-reader-text]")).not.toBeNull();
      return element as HTMLElement;
    };
    return { ...api, reader, sentence };
  }

  it("marks the search terms in the sentence text and selects the hit sentence", async () => {
    const { reader, sentence } = await openPage(`&segment=${CITED_SEGMENT_ID}&search=${encodeURIComponent("重排")}`);
    expect(sentence(CITED_SEGMENT_ID).getAttribute("aria-current")).toBe("true");
    const marks = [...reader.querySelectorAll("mark")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["重排"]);
    expect(marks[0]?.closest("[data-reader-text]")).not.toBeNull();
  });

  it("makes a note from a selection with the offsets of the stored text, and opens a placed note without seeking", async () => {
    const { calls, reader, sentence } = await openPage("", {
      "GET /api/contents/c1/notes": { body: { items: [note("n1", { startSegmentId: "s2", endSegmentId: "s2", view: placedOn("s2", 2, 4) })] } },
    });
    select(sentence("s1").firstChild as Text, 2, 4);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-note-underline"));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      transcriptRevisionId: "r1",
      startSegmentId: "s1",
      startOffset: 2,
      endSegmentId: "s1",
      endOffset: 4,
      mark: "underline",
      color: "blue",
    });

    const run = await waitFor(() => within(sentence("s2")).getByTestId("note-run"));
    expect(run.textContent).toBe("向量");
    expect(sentence("s2").textContent).toBe("先看向量库。");
    fireEvent.click(run);
    expect(await screen.findByTestId("note-popover")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).not.toContain("segment=");
    expect(reader.querySelector("[aria-current]")).toBeNull();
  });

  it("puts a chapter picked in the outline at the top, and a chapter's play button seeks to its first sentence", async () => {
    const { reader, sentence } = await openPage();
    const heading = within(reader).getAllByTestId("transcript-chapter")[1]?.closest("[data-row-index]") as HTMLElement;
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 400, height: 300 });
    heading.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 340, width: 400, height: 30 });
    fireEvent.click(screen.getByTestId("chapter-outline"));
    fireEvent.click(screen.getAllByTestId("chapter-outline-item")[1] as HTMLElement);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
    expect(reader.scrollTop).toBe(240);

    fireEvent.click(within(within(reader).getAllByTestId("transcript-chapter")[1] as HTMLElement).getByRole("button", { name: "从 1:15 播放" }));
    await waitFor(() => expect(sentence(CITED_SEGMENT_ID).getAttribute("aria-current")).toBe("true"));
  });

  it("follows playback with the current sentence in speaker turns", async () => {
    stubFontFaces();
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ ...READER_TYPOGRAPHY_DEFAULTS, font: "kai" }));
    mockApi({ ...speakerRoutes(), ...FONT_ROUTES });
    const { controller } = mountReader();
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.closest("[data-reader-font]")?.getAttribute("data-reader-font")).toBe("kai"), { timeout: 5_000 });
    expect(reader.querySelector("[data-turn-key]")).not.toBeNull();
    const current = (): Array<string | null> => [...reader.querySelectorAll("[data-testid='current-sentence']")].map((node) => node.getAttribute("data-segment-id"));
    act(() => controller.reportTime(1_000));
    expect(current()).toEqual(["g1"]);
    act(() => controller.reportTime(8_500));
    expect(current()).toEqual(["g3"]);
    act(() => controller.reportTime(20_000));
    expect(current()).toEqual(["g5"]);
    expect(reader.querySelector("[data-testid='current-sentence']")?.closest("[data-reader-text]")).not.toBeNull();
  });
});

/** The sentences a reader shows, in order. */
const shownSentences = (reader: HTMLElement): Array<string | null> => [...reader.querySelectorAll("[data-segment-id]")].map((node) => node.getAttribute("data-segment-id"));

/** The index of the reader row that holds a sentence. */
const rowOf = (reader: HTMLElement, segmentId: string): number => Number(reader.querySelector(`[data-segment-id='${segmentId}']`)?.closest<HTMLElement>("[data-row-index]")?.dataset["rowIndex"]);

/**
 * Lays every reader row out 100px below the one before it, the list's own box at the top, so
 * a scroll that puts a row at the top leaves `scrollTop` at that row's index × 100.
 */
function stubRowLayout(): void {
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = this.dataset["rowIndex"];
    return DOMRect.fromRect({ x: 0, y: index === undefined ? 0 : Number(index) * 100, width: 800, height: 100 });
  });
  onTestFinished(() => spy.mockRestore());
}

/** Records the elements centred by `scrollIntoView`, which jsdom does not implement. */
function stubScrollIntoView(): Element[] {
  const centred: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    centred.push(this);
  };
  onTestFinished(() => {
    Element.prototype.scrollIntoView = original;
  });
  return centred;
}

/** Only the transcript tab, with the address shown beside it (`location`). */
function mountSpeakerReader(route = "/contents/c1?tab=transcript&revision=r1") {
  const controller = new PlayerController();
  controller.attach({ capabilities: CAPABILITIES.local, seek: () => undefined });
  renderApp(
    <PlayerControllerProvider controller={controller}>
      <ContentPageProvider value={pageState()}>
        <TranscriptTab />
        <LocationProbe />
      </ContentPageProvider>
    </PlayerControllerProvider>,
    { route, path: "/contents/:id" },
  );
}

async function readerWith(id: string): Promise<HTMLElement> {
  const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
  await waitFor(() => expect(reader.querySelector(`[data-segment-id='${id}']`)).not.toBeNull());
  return reader;
}

const addressSpeakers = (): string[] => new URLSearchParams(screen.getByTestId("location").textContent ?? "").getAll("speaker");

const REVIEW_PATH = "GET /api/transcript/revisions/r1/speaker-review";

/** The review of the conversation in `SPEAKER_SEGMENTS`: 陈明 first, then speaker 2. */
const SPEAKER_REVIEW = {
  revisionId: "r1",
  rosterDigest: "digest-1",
  speakers: [
    { id: "sp1", sentences: 5, assignedMs: 25_000 },
    { id: "sp2", sentences: 1, assignedMs: 1_000 },
  ],
  unassigned: 1,
  pendingNames: 0,
};

describe("TranscriptTab speaker review", () => {
  beforeEach(() => {
    stubResizeObserver();
  });

  /** Another vendor's recognition made to compare with, over the same moments. */
  const comparisonRoutes = () => {
    const current = revision("r1");
    const other = recognition("r2", "scribe_v2", { comparison: true });
    return {
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [current, other] } },
      "GET /api/transcript/revisions/r2/segments": {
        body: { revision: other, items: SPEAKER_SEGMENTS.map((item, index) => ({ ...item, id: `o${index}`, revisionId: "r2", speakerId: index === 2 ? "sp4" : "sp3" })) },
      },
    };
  };

  it("puts the review mark beside the version picker in speaker mode and opens the panel from it", async () => {
    const { calls } = mockApi({ ...speakerRoutes(), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    mountSpeakerReader();
    await readerWith("g1");
    const badge = await screen.findByTestId("speaker-review-badge");
    expect(badge.previousElementSibling?.getAttribute("data-testid")).toBe("transcript-version");
    await waitFor(() => expect(badge.textContent).toBe("发言人未核对"));
    fireEvent.click(badge);
    const panel = await screen.findByTestId("speaker-review-panel");
    await within(panel).findByTestId("speaker-review-roster");
    expect(within(panel).getAllByTestId("speaker-review-roster-row").map((row) => row.getAttribute("data-speaker-id"))).toEqual(["sp1", "sp2"]);
    // Opening it only reads.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("shows no review mark and reads no review outside speaker mode", async () => {
    const { calls } = mockApi(contentRoutes());
    mountSpeakerReader();
    await readerWith("s1");
    await act(async () => undefined);
    expect(screen.queryByTestId("speaker-review-badge")).toBeNull();
    expect(calls.some((call) => call.path.endsWith("/speaker-review"))).toBe(false);
  });

  it("opens the draft editor on the comparison from 「去编辑器查看」 under 辅助核对", async () => {
    mockApi({ ...speakerRoutes(), ...comparisonRoutes(), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    mountSpeakerReader();
    await readerWith("g1");
    fireEvent.click(await screen.findByTestId("speaker-review-badge"));
    const panel = await screen.findByTestId("speaker-review-panel");
    await within(panel).findByTestId("speaker-review-roster");
    expect(within(panel).queryByTestId("comparison-summary")).toBeNull();
    fireEvent.click(within(panel).getByTestId("speaker-review-assist-toggle"));
    const summary = await within(panel).findByTestId("comparison-summary");
    await waitFor(() => expect(within(summary).getByTestId("comparison-summary-line").textContent).toContain("与 scribe_v2 的识别相比"));
    fireEvent.click(within(summary).getByTestId("comparison-summary-open"));
    expect(await screen.findByTestId("comparison-panel", {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByTestId("comparison-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("transcript-reader")).toBeNull();
    expect((await screen.findByTestId("comparison-header")).textContent).toContain("对比模型：scribe_v2");
  });

  it("opens the editor without the comparison from 编辑", async () => {
    mockApi({ ...speakerRoutes(), ...comparisonRoutes(), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    mountSpeakerReader();
    await readerWith("g1");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByTestId("comparison-toggle", {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByTestId("comparison-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("comparison-panel")).toBeNull();
  });

  it("offers no way to the editor from 辅助核对 on an archived revision, which cannot be edited", async () => {
    const routes = comparisonRoutes();
    const archived = revision("r1", { archived: true, archivedAt: 6 });
    mockApi({
      ...speakerRoutes({ revision: { archived: true, archivedAt: 6 } }),
      ...routes,
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [archived, ...routes["GET /api/contents/c1/transcript/revisions"].body.revisions.slice(1)] } },
      [REVIEW_PATH]: { body: SPEAKER_REVIEW },
    });
    mountSpeakerReader();
    await readerWith("g1");
    expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByTestId("speaker-review-badge"));
    const panel = await screen.findByTestId("speaker-review-panel");
    await within(panel).findByTestId("speaker-review-roster");
    fireEvent.click(within(panel).getByTestId("speaker-review-assist-toggle"));
    const summary = await within(panel).findByTestId("comparison-summary");
    // The comparison itself still reads; only the way into the editor is gone.
    await waitFor(() => expect(within(summary).getByTestId("comparison-summary-line").textContent).toContain("与 scribe_v2 的识别相比"));
    expect(within(summary).queryByTestId("comparison-summary-open")).toBeNull();
  });

  it("brings back the whole text when the roster leads to a sentence the filter hides, and scrolls to it", async () => {
    stubRowLayout();
    mockApi({ ...speakerRoutes(), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=sp1");
    const reader = await readerWith("g1");
    expect(shownSentences(reader)).not.toContain("g3");
    fireEvent.click(await screen.findByTestId("speaker-review-badge"));
    const panel = await screen.findByTestId("speaker-review-panel");
    const rows = await within(panel).findAllByTestId("speaker-review-roster-row");
    fireEvent.click(within(rows[1] as HTMLElement).getByTestId("speaker-review-locate"));
    await waitFor(() => expect(shownSentences(reader)).toContain("g3"));
    expect(addressSpeakers()).toEqual([]);
    expect(screen.queryByTestId("speaker-review-panel")).toBeNull();
    expect(rowOf(reader, "g3")).toBeGreaterThan(0);
    await waitFor(() => expect(reader.scrollTop).toBe(rowOf(reader, "g3") * 100));
  });

  it("scrolls to a sentence the filter shows without lifting it", async () => {
    const centred = stubScrollIntoView();
    mockApi({ ...speakerRoutes(), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=sp2");
    const reader = await readerWith("g3");
    fireEvent.click(await screen.findByTestId("speaker-review-badge"));
    const panel = await screen.findByTestId("speaker-review-panel");
    const rows = await within(panel).findAllByTestId("speaker-review-roster-row");
    fireEvent.click(within(rows[1] as HTMLElement).getByTestId("speaker-review-locate"));
    await waitFor(() => expect(centred.map((element) => element.getAttribute("data-row-index"))).toContain(String(rowOf(reader, "g3"))));
    expect(addressSpeakers()).toEqual(["sp2"]);
    expect(shownSentences(reader)).toEqual(["g3"]);
  });
});

describe("TranscriptTab 只看", () => {
  beforeEach(() => {
    stubResizeObserver();
  });

  const THIRD = { id: "sp3", ordinal: 3, name: "王芳", colorIndex: 2, used: true };

  it("writes the picked speakers into the address in order, then shows only their sentences with a bar", async () => {
    mockApi(speakerRoutes());
    mountSpeakerReader();
    const reader = await readerWith("g1");
    expect(screen.queryByTestId("speaker-filter-bar")).toBeNull();
    fireEvent.click(screen.getByTestId("speaker-filter"));
    const popover = await screen.findByTestId("speaker-filter-popover");
    const option = (id: string) => within(popover).getAllByTestId("speaker-filter-option").find((item) => item.getAttribute("data-speaker-id") === id) as HTMLElement;
    expect(within(popover).getAllByTestId("speaker-filter-option").map((item) => item.textContent)).toEqual(["陈陈明5 句", "2发言人 21 句"]);
    // Each option reads avatar, name and count. Picked out of order, written by ordinal.
    fireEvent.click(within(option("sp2")).getByRole("checkbox"));
    await waitFor(() => expect(addressSpeakers()).toEqual(["sp2"]));
    expect(shownSentences(reader)).toEqual(["g3"]);
    expect(screen.getByTestId("speaker-filter-bar").textContent).toBe("只看 发言人 2 · 1 轮清除");
    fireEvent.click(within(option("sp1")).getByRole("checkbox"));
    await waitFor(() => expect(addressSpeakers()).toEqual(["sp1", "sp2"]));
    expect(screen.getByTestId("location").textContent).toBe("?tab=transcript&revision=r1&speaker=sp1&speaker=sp2");
    expect(shownSentences(reader)).toEqual(["g1", "g2", "g3", "g4", "g5", "g7"]);
    expect(screen.getByTestId("speaker-filter-bar").textContent).toBe("只看 陈明、发言人 2 · 4 轮清除");
    // The one unassigned sentence is skipped: one bar, ahead of the next chapter's heading.
    expect(within(reader).getAllByTestId("speaker-gap").map((gap) => gap.textContent)).toEqual(["略过 53 秒"]);
    fireEvent.click(screen.getByTestId("speaker-filter-clear"));
    await waitFor(() => expect(addressSpeakers()).toEqual([]));
    expect(shownSentences(reader)).toEqual(["g1", "g2", "g3", "g4", "g5", "g6", "g7"]);
    expect(screen.queryByTestId("speaker-filter-bar")).toBeNull();
  });

  it("shows one speaker's turns with a bar over each skipped stretch, and the chapters over what is shown", async () => {
    mockApi(speakerRoutes());
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=sp1");
    const reader = await readerWith("g1");
    expect(shownSentences(reader)).toEqual(["g1", "g2", "g4", "g5", "g7"]);
    expect(screen.getByTestId("speaker-filter-bar").textContent).toBe("只看 陈明 · 3 轮清除");
    const rows = [...reader.querySelectorAll<HTMLElement>("[data-row-index]")].map((row) =>
      row.querySelector("[data-testid='speaker-gap']") !== null ? `gap ${row.textContent}` : row.querySelector("[data-testid='transcript-chapter']") !== null ? "chapter" : "text",
    );
    expect(rows.filter((row) => row !== "text")).toEqual(["chapter", "gap 略过 2 秒", "gap 略过 53 秒", "chapter"]);
    expect(screen.getByTestId("speaker-filter").getAttribute("aria-label")).toBe("只看某些发言人，已选 1 人");
  });

  it("clears the filter from a gap and keeps the reader at the first skipped sentence", async () => {
    stubRowLayout();
    mockApi(speakerRoutes());
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=sp1");
    const reader = await readerWith("g1");
    const gaps = within(reader).getAllByTestId("speaker-gap");
    fireEvent.click(within(gaps[1] as HTMLElement).getByRole("button", { name: "略过 53 秒，回到完整原文的这个位置" }));
    await waitFor(() => expect(shownSentences(reader)).toContain("g6"));
    expect(addressSpeakers()).toEqual([]);
    expect(screen.getByTestId("location").textContent).toBe("?tab=transcript&revision=r1");
    expect(rowOf(reader, "g6")).toBeGreaterThan(0);
    await waitFor(() => expect(reader.scrollTop).toBe(rowOf(reader, "g6") * 100));
  });

  /**
   * The reader on `route` with a sentence selected (as a click on it leaves it), recording in
   * order every scroll it makes: a row centred (`centre <sentence>`) or the list moved (`top <px>`).
   */
  async function readerWithSelection(route: string, segmentId: string, first: string): Promise<{ reader: HTMLElement; log: string[]; opened: string[] }> {
    stubRowLayout();
    const log: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      log.push(`centre ${this.querySelector("[data-segment-id]")?.getAttribute("data-segment-id") ?? ""}`);
    };
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.local, seek: () => undefined });
    renderApp(
      <PlayerControllerProvider controller={controller}>
        <ContentPageProvider value={{ ...pageState(), selection: { revisionId: "r1", segmentId } }}>
          <TranscriptTab />
          <LocationProbe />
        </ContentPageProvider>
      </PlayerControllerProvider>,
      { route, path: "/contents/:id" },
    );
    const reader = await readerWith(first);
    let top = 0;
    Object.defineProperty(reader, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
        log.push(`top ${value}`);
      },
    });
    await act(async () => undefined);
    const opened = log.splice(0);
    return { reader, log, opened };
  }

  it("stays at a gap's place when a selected sentence the filter hid comes back with the text", async () => {
    mockApi(speakerRoutes());
    const { reader, log } = await readerWithSelection("/contents/c1?tab=transcript&revision=r1&speaker=sp1", "g3", "g1");
    expect(shownSentences(reader)).not.toContain("g3");
    const gaps = within(reader).getAllByTestId("speaker-gap");
    fireEvent.click(within(gaps[1] as HTMLElement).getByRole("button"));
    await waitFor(() => expect(shownSentences(reader)).toContain("g6"));
    await act(async () => undefined);
    // Only the gap's own scroll: the selected g3, back at a row of its own, is not centred over it.
    expect(log).toEqual([`top ${rowOf(reader, "g6") * 100}`]);
    expect(reader.scrollTop).toBe(rowOf(reader, "g6") * 100);
  });

  it("stays at the turn the roster located when the selected sentence moves to another row", async () => {
    // Speaker 2 answers over two paragraphs: one gap bar stands for two rows of the whole text,
    // so every row after it moves when the filter is lifted.
    const shift = 5_000;
    const segments = [
      ...SPEAKER_SEGMENTS.slice(0, 3),
      segment("g3b", 3, 9_000 + PARAGRAPH_GAP_MS + 1_000, 9_000 + PARAGRAPH_GAP_MS + 2_000, "然后呢？", { speakerId: "sp2" }),
      ...SPEAKER_SEGMENTS.slice(3).map((item) => ({ ...item, ordinal: item.ordinal + 1, startMs: item.startMs + shift, endMs: item.endMs + shift })),
    ];
    mockApi({ ...speakerRoutes({ segments }), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    const { reader, log, opened } = await readerWithSelection("/contents/c1?tab=transcript&revision=r1&speaker=sp1", "g7", "g7");
    // Opened on a selection the filter shows: it is centred, as a deep link is.
    expect(opened).toEqual(["centre g7"]);
    const before = rowOf(reader, "g7");
    fireEvent.click(await screen.findByTestId("speaker-review-badge"));
    const rows = await within(await screen.findByTestId("speaker-review-panel")).findAllByTestId("speaker-review-roster-row");
    fireEvent.click(within(rows[1] as HTMLElement).getByTestId("speaker-review-locate"));
    await waitFor(() => expect(shownSentences(reader)).toContain("g3"));
    await act(async () => undefined);
    // g7 is shown before and after, at another row once the whole text is back.
    expect(rowOf(reader, "g7")).not.toBe(before);
    expect(log).toEqual([`top ${rowOf(reader, "g3") * 100}`]);
  });

  it("rewrites an address with unknown, repeated or unordered speakers, keeping the other parameters", async () => {
    mockApi(speakerRoutes());
    mountSpeakerReader("/contents/c1?tab=transcript&speaker=gone&speaker=sp2&revision=r1&speaker=sp1&speaker=sp2");
    const reader = await readerWith("g1");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?tab=transcript&revision=r1&speaker=sp1&speaker=sp2"));
    expect(shownSentences(reader)).toEqual(["g1", "g2", "g3", "g4", "g5", "g7"]);
  });

  it("drops an address of only unknown speakers and reads the whole text", async () => {
    mockApi(speakerRoutes());
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=gone");
    const reader = await readerWith("g6");
    await waitFor(() => expect(addressSpeakers()).toEqual([]));
    expect(shownSentences(reader)).toHaveLength(7);
    expect(screen.queryByTestId("speaker-filter-bar")).toBeNull();
    expect(screen.queryByTestId("speaker-filter-empty")).toBeNull();
  });

  it("only marks a search, inside the filtered sentences", async () => {
    mockApi(speakerRoutes());
    mountSpeakerReader(`/contents/c1?tab=transcript&revision=r1&speaker=sp1&search=${encodeURIComponent("重排序")}`);
    const reader = await readerWith("g1");
    expect(shownSentences(reader)).toEqual(["g1", "g2", "g4", "g5", "g7"]);
    expect([...reader.querySelectorAll("mark")].map((mark) => mark.closest("[data-segment-id]")?.getAttribute("data-segment-id"))).toEqual(["g4", "g7"]);
    fireEvent.click(screen.getByTestId("speaker-filter-clear"));
    await waitFor(() => expect(shownSentences(reader)).toHaveLength(7));
    expect(new URLSearchParams(screen.getByTestId("location").textContent ?? "").get("search")).toBe("重排序");
  });

  it("says when the picked speakers have no sentence in this version, and 清除筛选 brings the text back", async () => {
    mockApi(speakerRoutes({ speakers: [CHEN, UNNAMED, THIRD] }));
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=sp3");
    const empty = await screen.findByTestId("speaker-filter-empty", {}, { timeout: 5_000 });
    expect(empty.textContent).toBe("这份字幕稿里没有所选发言人的句子清除筛选");
    expect(screen.queryByTestId("transcript-reader")).toBeNull();
    expect(addressSpeakers()).toEqual(["sp3"]);
    // Still listed in the picker (avatar, name, count) so it can be unticked, with no sentence.
    fireEvent.click(screen.getByTestId("speaker-filter"));
    const option = (await screen.findAllByTestId("speaker-filter-option")).find((item) => item.getAttribute("data-speaker-id") === "sp3");
    expect(option?.textContent).toBe("王王芳0 句");
    fireEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
    const reader = await readerWith("g1");
    expect(shownSentences(reader)).toHaveLength(7);
    expect(addressSpeakers()).toEqual([]);
  });

  it("leaves the empty state for the whole text when the review panel locates a sentence", async () => {
    stubRowLayout();
    mockApi({ ...speakerRoutes({ speakers: [CHEN, UNNAMED, THIRD] }), [REVIEW_PATH]: { body: SPEAKER_REVIEW } });
    mountSpeakerReader("/contents/c1?tab=transcript&revision=r1&speaker=sp3");
    await screen.findByTestId("speaker-filter-empty", {}, { timeout: 5_000 });
    fireEvent.click(await screen.findByTestId("speaker-review-badge"));
    const rows = await within(await screen.findByTestId("speaker-review-panel")).findAllByTestId("speaker-review-roster-row");
    fireEvent.click(within(rows[1] as HTMLElement).getByTestId("speaker-review-locate"));
    const reader = await readerWith("g3");
    expect(addressSpeakers()).toEqual([]);
    expect(screen.queryByTestId("speaker-filter-empty")).toBeNull();
    await waitFor(() => expect(reader.scrollTop).toBe(rowOf(reader, "g3") * 100));
    expect(rowOf(reader, "g3")).toBeGreaterThan(0);
  });

  it("brings back the whole text when 定位原文 of a note leads to a sentence the filter hides", async () => {
    stubRowLayout();
    mockApi({
      ...speakerRoutes(),
      "GET /api/contents/c1/notes": { body: { items: [note("n1", { startSegmentId: "g3", endSegmentId: "g3", quote: "嗯", view: placedOn("g3", 0, 1) })] } },
    });
    renderApp(
      <>
        <ContentPage />
        <LocationProbe />
      </>,
      { route: "/contents/c1?tab=transcript&revision=r1", path: "/contents/:id" },
    );
    const reader = await readerWith("g3");
    const run = await waitFor(() => within(reader.querySelector("[data-segment-id='g3']") as HTMLElement).getByTestId("note-run"));
    fireEvent.click(run);
    await screen.findByTestId("note-popover");
    fireEvent.click(await screen.findByTestId("note-comment-edit"));
    fireEvent.change(screen.getByTestId("note-comment-input"), { target: { value: "回头再看" } });
    // Only 陈明: the note's sentence leaves the view and the unsaved note stays open on its own.
    fireEvent.click(screen.getByTestId("speaker-filter"));
    const option = (await screen.findAllByTestId("speaker-filter-option")).find((item) => item.getAttribute("data-speaker-id") === "sp1") as HTMLElement;
    fireEvent.click(within(option).getByRole("checkbox"));
    await waitFor(() => expect(shownSentences(reader)).not.toContain("g3"));
    const detached = await screen.findByTestId("note-popover-detached");
    fireEvent.click(within(detached).getByTestId("note-locate-anchor"));
    await waitFor(() => expect(shownSentences(reader)).toContain("g3"));
    expect(addressSpeakers()).toEqual([]);
    await waitFor(() => expect(reader.scrollTop).toBe(rowOf(reader, "g3") * 100));
    expect(rowOf(reader, "g3")).toBeGreaterThan(0);
  });
});

describe("TranscriptTab proofread hint about speakers", () => {
  const PROVIDERS = { "GET /api/providers": { body: { items: [{ id: "p1", name: "P", protocol: "openai_compatible", baseURL: "https://x", credentialStatus: "configured", hasCredential: true, models: [], createdAt: 1 }] } } };

  it("says beside the proofread button that unreviewed speakers are not read", async () => {
    mockApi({ ...speakerRoutes(), ...PROVIDERS });
    mountSpeakerReader();
    await readerWith("g1");
    const hint = await screen.findByTestId("proofread-speakers-not-read");
    expect(hint.textContent).toBe("发言人未核对，本次不读取");
    expect(hint.previousElementSibling?.getAttribute("data-testid")).toBe("proofread");
  });

  it("says nothing once the speakers are reviewed", async () => {
    mockApi({ ...speakerRoutes({ revision: { speakersConfirmedAt: 5 } }), ...PROVIDERS });
    mountSpeakerReader();
    await readerWith("g1");
    await screen.findByTestId("proofread");
    await act(async () => undefined);
    expect(screen.queryByTestId("proofread-speakers-not-read")).toBeNull();
  });

  it("says nothing for a text without speakers", async () => {
    mockApi({ ...contentRoutes(), ...PROVIDERS });
    mountSpeakerReader();
    await readerWith("s1");
    await screen.findByTestId("proofread");
    await act(async () => undefined);
    expect(screen.queryByTestId("proofread-speakers-not-read")).toBeNull();
  });

  it("says nothing while no model is configured, the button being disabled", async () => {
    mockApi(speakerRoutes());
    mountSpeakerReader();
    await readerWith("g1");
    await act(async () => undefined);
    expect(screen.queryByTestId("proofread-speakers-not-read")).toBeNull();
  });
});
