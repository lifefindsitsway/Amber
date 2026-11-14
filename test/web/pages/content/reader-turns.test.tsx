import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_FONT_SIZE_DEFAULT, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from "../../../../src/shared/defaults.ts";
import { MARKER_FADE_MS } from "../../../../src/web/pages/content/reader-sticky.ts";
import { READER_COLUMN_CLASS, READER_INDENT_ATTRIBUTE, READER_SCROLLER_CLASS } from "../../../../src/web/pages/content/reader-sentences.tsx";
import { READER_GUTTER } from "../../../../src/web/pages/content/reader-turns.tsx";
import { selectionForExplain } from "../../../../src/web/chat/selection-toolbar.tsx";
import { formatDuration } from "../../../../src/web/format.ts";
import { segment } from "../../../fixtures/web/content-data.ts";
import { note } from "../../../fixtures/web/note-data.ts";
import { CHEN, mountReader, SPEAKER_SEGMENTS, speakerRoutes, TYPOGRAPHY_KEY, UNNAMED } from "../../../fixtures/web/reader-speakers.tsx";
import { mockApi } from "../../../fixtures/web/render.tsx";
import { stubResizeObserver } from "../../../fixtures/web/speaker-fetch.ts";

beforeEach(() => {
  localStorage.clear();
  stubResizeObserver();
});

async function openReader(routes: Parameters<typeof mockApi>[0] = speakerRoutes(), options: Parameters<typeof mountReader>[0] & { ready?: string } = {}) {
  mockApi(routes);
  const mounted = mountReader(options);
  const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
  await waitFor(() => expect(reader.querySelector(`[data-segment-id='${options.ready ?? "g1"}']`)).not.toBeNull());
  return { ...mounted, reader };
}

const headers = (reader: HTMLElement): string[] => within(reader).queryAllByTestId("turn-header").map((header) => header.getAttribute("aria-label") ?? "");

/** Each sentence paragraph of the reader: the first sentence's id and the paragraph's first child node. */
const paragraphs = (reader: HTMLElement) =>
  [...reader.querySelectorAll<HTMLElement>("p[data-reader-text]")].map((paragraph) => ({
    id: paragraph.querySelector("[data-segment-id]")?.getAttribute("data-segment-id"),
    lead: paragraph.firstChild as HTMLElement,
    times: paragraph.querySelectorAll("[data-reading-time]").length,
  }));

/** Start of each sentence of the conversation, by id. */
const STARTS = new Map(SPEAKER_SEGMENTS.map((item) => [item.id, item.startMs]));

/**
 * Every paragraph opens with exactly one time: a real button with the reader's look, showing the
 * paragraph's start, that plays from its first sentence.
 */
function expectTimeFirst(reader: HTMLElement, select: ReturnType<typeof vi.fn>, ids: string[]): void {
  const found = paragraphs(reader);
  expect(found.map((paragraph) => paragraph.id)).toEqual(ids);
  for (const { id, lead, times } of found) {
    expect(lead.tagName).toBe("BUTTON");
    expect(lead.getAttribute("type")).toBe("button");
    expect(lead.hasAttribute("data-reading-time")).toBe(true);
    for (const name of ["font-mono", "text-xs", "leading-none", "text-accent", "hover:underline"]) expect(lead.className.split(" ")).toContain(name);
    expect(lead.className).toContain("mr-2");
    // A 24px hit area from a positioned pseudo-element, leaving the line box alone.
    expect(lead.className).toContain("relative");
    expect(lead.className).toContain("before:absolute");
    expect(lead.className).toContain("before:h-6");
    expect(times).toBe(1);
    const startMs = STARTS.get(id ?? "") as number;
    expect(lead.textContent).toBe(formatDuration(startMs));
    // Its visible time is its accessible name.
    expect(lead.getAttribute("aria-label")).toBeNull();
    select.mockClear();
    fireEvent.click(lead);
    expect(select).toHaveBeenCalledWith({ revisionId: "r1", segmentId: id }, startMs);
  }
}

describe("speaker mode decision", () => {
  it("reads by turns when two speakers or a named one are referenced", async () => {
    const { reader } = await openReader();
    expect(headers(reader)).toEqual(["陈明", "发言人 2", "陈明", "未分配", "陈明"]);
  });

  it("reads like a plain text when the only speaker has no name", async () => {
    const lone = SPEAKER_SEGMENTS.map((item) => ({ ...item, speakerId: "sp2" }));
    const { reader } = await openReader(speakerRoutes({ segments: lone, speakers: [UNNAMED] }));
    expect(within(reader).queryAllByTestId("turn-header")).toEqual([]);
    expect(reader.querySelector("[data-turn-key]")).toBeNull();
    // No speaker mode: no speaker switch in the typography popover and the plain copy button.
    fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
    expect(screen.queryByRole("switch", { name: "显示发言人" })).toBeNull();
    expect(screen.getByTestId("transcript-copy").textContent).toBe("复制");
  });

  it("asks for no speakers when no sentence names one", async () => {
    const api = mockApi({
      ...speakerRoutes({ segments: SPEAKER_SEGMENTS.map(({ speakerId: _speakerId, ...rest }) => rest) }),
    });
    mountReader();
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.querySelector("[data-segment-id='g1']")).not.toBeNull());
    expect(api.calls.some((call) => call.path.endsWith("/speakers"))).toBe(false);
  });

  it("falls back to the plain text when the speakers cannot be loaded", async () => {
    const { reader } = await openReader({ ...speakerRoutes(), "GET /api/contents/c1/speakers": { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } } } });
    expect(within(reader).queryAllByTestId("turn-header")).toEqual([]);
    expect(reader.querySelector("[data-segment-id='g1']")).not.toBeNull();
  });
});

describe("turn layout", () => {
  it("names each turn once with its avatar and speaker only, the paragraphs of a turn sharing one line", async () => {
    const { reader } = await openReader();
    const first = within(reader).getAllByTestId("turn-header")[2] as HTMLElement;
    expect(first.getAttribute("role")).toBe("group");
    expect(first.hasAttribute("data-turn-header")).toBe(true);
    expect(first.textContent).toBe("陈陈明");
    expect(within(first).getByTitle("陈明").textContent).toBe("陈明");
    // The header is a line of its own, ahead of the text.
    const row = first.closest("[data-turn-key]") as HTMLElement;
    expect(row.firstElementChild).toBe(first);
    expect(first.querySelector("[data-reader-text]")).toBeNull();
    // The turn's second paragraph has no header of its own but sits under the same turn key and line.
    const second = reader.querySelector("[data-segment-id='g5']")?.closest("[data-turn-key]") as HTMLElement;
    expect(second.getAttribute("data-turn-key")).toBe("g4");
    expect(within(second).queryByTestId("turn-header")).toBeNull();
    const lines = reader.querySelectorAll("[data-turn-key='g4'] [data-testid='turn-line']");
    expect(lines).toHaveLength(2);
    expect((lines[0] as HTMLElement).style.bottom).toBe("-0.75em");
    expect((lines[1] as HTMLElement).style.bottom).toBe("0px");
    expect((lines[0] as HTMLElement).style.backgroundColor).toContain("--speaker-0-fg");
  });

  it("keeps the time out of the header: no time button, no time mark, and marked as said by nobody", async () => {
    const { reader } = await openReader();
    const all = within(reader).getAllByTestId("turn-header");
    expect(all).toHaveLength(5);
    for (const header of all) {
      expect(header.hasAttribute("data-reader-meta")).toBe(true);
      expect(header.hasAttribute("data-reading-time")).toBe(false);
      expect(header.querySelector("[data-reading-time]")).toBeNull();
      expect(header.textContent).not.toMatch(/\d:\d\d/);
      expect(within(header).queryByRole("button", { name: /\d:\d\d/ })).toBeNull();
    }
  });

  it("opens every paragraph with its time, the first of a turn included, and plays from its first sentence", async () => {
    const select = vi.fn();
    const { reader } = await openReader(speakerRoutes(), { select });
    expectTimeFirst(reader, select, ["g1", "g3", "g4", "g5", "g6", "g7"]);
    // The time sits at the start of the text column, after the turn line, in the wide layout.
    const g4 = reader.querySelector("[data-segment-id='g4']")?.closest("p") as HTMLElement;
    expect(g4.parentElement?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(g4.closest("[data-turn-layout]")?.getAttribute("data-turn-layout")).toBe("wide");
  });

  it("does not break the document outline: no turn header is a heading", async () => {
    const { reader } = await openReader();
    expect(within(reader).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["开场", "正文"]);
  });

  it("shows sentences nobody owns as 未分配 with the neutral avatar, which opens nothing", async () => {
    const { reader } = await openReader();
    const header = within(reader).getAllByTestId("turn-header")[3] as HTMLElement;
    expect(header.textContent).toBe("未分配");
    expect(header.getAttribute("aria-label")).toBe("未分配");
    expect(header.querySelector("[data-kind='unassigned']")).not.toBeNull();
    expect(within(header).queryByTestId("turn-speaker")?.tagName).toBe("SPAN");
  });

  it("shows the speaker again after a chapter heading, even when the same one goes on", async () => {
    const { reader } = await openReader();
    const rows = [...reader.querySelectorAll("[data-row-index]")].map((row) => (row.querySelector("[data-testid='transcript-chapter']") !== null ? "chapter" : row.querySelector("[data-testid='turn-header']") !== null ? "header" : "body"));
    expect(rows).toEqual(["chapter", "header", "header", "header", "body", "header", "chapter", "header"]);
  });

  it("opens the identity card from the avatar or name without seeking, with the speaker's share, and offers editing", async () => {
    const select = vi.fn();
    const { reader } = await openReader(speakerRoutes(), { select });
    const trigger = within(within(reader).getAllByTestId("turn-header")[0] as HTMLElement).getByTestId("turn-speaker");
    expect(trigger.tagName).toBe("BUTTON");
    // One control holds both the avatar and the name.
    expect(trigger.querySelector("[data-testid='speaker-avatar']")).not.toBeNull();
    expect(within(trigger).getByTitle("陈明")).toBeTruthy();
    fireEvent.click(trigger);
    const card = await screen.findByTestId("speaker-card");
    expect(within(card).getByTestId("speaker-card-name").textContent).toBe("陈明");
    // 陈明 speaks g1, g2, g4, g5, g7 of the six assigned sentences' 29 s: sentences and share are those of the read text.
    expect(within(card).getByTestId("speaker-card-share").textContent).toMatch(/^5 句 · 约占 \d+% 时长$/);
    fireEvent.click(within(card).getByTestId("speaker-card-edit"));
    expect(await screen.findByTestId("speaker-edit-form")).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
    expect(reader.querySelector("[aria-current]")).toBeNull();
  });

  it("opens the card by keyboard on the name", async () => {
    const { reader } = await openReader();
    const trigger = within(within(reader).getAllByTestId("turn-header")[0] as HTMLElement).getByTestId("turn-speaker");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(await screen.findByTestId("speaker-card")).toBeTruthy();
  });

  it("names a header by who speaks alone, the avatar beside the written name being decorative", async () => {
    const { reader } = await openReader();
    const [named, unnamed] = within(reader).getAllByTestId("turn-header") as [HTMLElement, HTMLElement];
    expect(named.getAttribute("aria-label")).toBe("陈明");
    expect(unnamed.getAttribute("aria-label")).toBe("发言人 2");
    expect(unnamed.textContent).toBe("2发言人 2");
    for (const header of [named, unnamed]) {
      expect(within(header).queryByRole("img")).toBeNull();
      expect(header.querySelector("[data-testid='speaker-avatar']")?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("selecting across turns", () => {
  /** Selects from the start of `from`'s first text to the end of `to`'s last text. */
  function select(from: Element, to: Element): Selection {
    const texts = (element: Element): Text[] => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const found: Text[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) found.push(node as Text);
      return found;
    };
    const range = document.createRange();
    range.setStart(texts(from)[0] as Text, 0);
    const end = texts(to).at(-1) as Text;
    range.setEnd(end, end.length);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  it("takes what was said: no speaker names and no times, the chapter title kept", async () => {
    const { reader } = await openReader();
    const [first] = within(reader).getAllByTestId("turn-header") as [HTMLElement];
    const g4 = reader.querySelector("[data-segment-id='g4']") as HTMLElement;
    const across = select(first, g4);
    expect(across.toString()).toContain("发言人 2");
    expect(selectionForExplain(across)).toEqual({ text: "今天讲检索。先看向量库。嗯。对，重排序是第二步，要把粗排的结果再精排一遍。" });
    const g6 = reader.querySelector("[data-segment-id='g6']") as HTMLElement;
    const g7 = reader.querySelector("[data-segment-id='g7']") as HTMLElement;
    expect(selectionForExplain(select(g6, g7))?.text).toBe("这一句没有人认领，所以它属于未分配的轮次。正文再看重排序，它决定了最终展示给用户的排列顺序。");
    window.getSelection()?.removeAllRanges();
  });
});

describe("short turns", () => {
  /** The layout of the turn holding g3 (speaker 2's one-word answer): its row's children and the text's. */
  const shape = (reader: HTMLElement) => {
    const row = reader.querySelector("[data-segment-id='g3']")?.closest("[data-turn-key]") as HTMLElement;
    return {
      layout: row.getAttribute("data-turn-layout"),
      children: [...row.children].map((child) => (child.getAttribute("data-testid") === "turn-header" ? "header" : child.tagName)),
      header: within(row).getByTestId("turn-header").getAttribute("aria-label"),
      text: (row.querySelector("p[data-reader-text]") as HTMLElement).firstElementChild?.textContent,
    };
  };
  const USUAL = { layout: "wide", children: ["header", "DIV"], header: "发言人 2", text: "0:08" };

  it("lays out a one-sentence short turn like any other: header line, then its time and text", async () => {
    const { reader } = await openReader();
    expect(reader.querySelector("[data-turn-layout='compact']")).toBeNull();
    expect([...reader.querySelectorAll("[data-turn-layout]")].map((row) => row.getAttribute("data-turn-layout"))).toEqual(["wide", "wide", "wide", "wide", "wide", "wide"]);
    expect(shape(reader)).toEqual(USUAL);
    expect((reader.querySelector("[data-segment-id='g3']")?.closest("p") as HTMLElement).textContent).toBe("0:08嗯。");
    // Same grid as the long turns.
    const grids = [...reader.querySelectorAll<HTMLElement>("[data-turn-layout='wide'] > div:last-child")].map((grid) => grid.style.gridTemplateColumns);
    expect(new Set(grids).size).toBe(1);
  });

  it("lays out a short turn with a search hit the same way", async () => {
    const { reader } = await openReader(speakerRoutes(), { route: "/contents/c1?tab=transcript&revision=r1&search=%E5%97%AF" });
    await waitFor(() => expect(reader.querySelector("mark")).not.toBeNull());
    expect(reader.querySelector("[data-turn-layout='compact']")).toBeNull();
    expect(shape(reader)).toEqual(USUAL);
  });

  it("lays out a short turn with a note the same way", async () => {
    const routes = {
      ...speakerRoutes(),
      "GET /api/contents/c1/notes": {
        body: { items: [note("n1", { startSegmentId: "g3", endSegmentId: "g3", mark: "underline", view: { segments: [{ segmentId: "g3", startOffset: 0, endOffset: 1 }], exact: true } })] },
      },
    };
    const { reader } = await openReader(routes);
    await waitFor(() => expect(reader.querySelector("[data-testid='note-run']")).not.toBeNull());
    expect(reader.querySelector("[data-turn-layout='compact']")).toBeNull();
    expect(shape(reader)).toEqual(USUAL);
  });
});

describe("narrow pane", () => {
  function resizeTo(width: number): void {
    const observers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
          observers.push(callback);
        }
        observe(): void {
          for (const callback of observers) callback([{ contentRect: { width } }]);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  }

  it("puts avatar and name above the text, without the gutter, below 520px", async () => {
    resizeTo(480);
    const select = vi.fn();
    const { reader } = await openReader(speakerRoutes(), { select });
    await waitFor(() => expect(reader.querySelector("[data-turn-layout='narrow']")).not.toBeNull());
    expect(reader.querySelector("[data-turn-layout]:not([data-turn-layout='narrow'])")).toBeNull();
    expect(reader.querySelector("[data-testid='turn-line']")).toBeNull();
    const row = reader.querySelector("[data-segment-id='g4']")?.closest("[data-turn-key]") as HTMLElement;
    const children = [...row.children].map((child) => child.tagName + (child.getAttribute("data-testid") === "turn-header" ? ":header" : ""));
    expect(children).toEqual(["DIV:header", "P"]);
    const later = reader.querySelector("[data-segment-id='g5']")?.closest("[data-turn-key]") as HTMLElement;
    expect([...later.children].map((child) => child.tagName)).toEqual(["P"]);
    // Every paragraph still opens with its time, the first of a turn included.
    expectTimeFirst(reader, select, ["g1", "g3", "g4", "g5", "g6", "g7"]);
    // No sticky marker without a gutter.
    expect(screen.queryByTestId("turn-marker")).toBeNull();
  });

  it("keeps the gutter from 520px up", async () => {
    resizeTo(520);
    const { reader } = await openReader();
    expect(reader.querySelector("[data-turn-layout='narrow']")).toBeNull();
    expect(reader.querySelector("[data-turn-layout='wide']")).not.toBeNull();
    expect(screen.getByTestId("turn-marker")).toBeTruthy();
  });
});

describe("typography", () => {
  it.each([READER_FONT_SIZE_MIN, READER_FONT_SIZE_DEFAULT, 24, READER_FONT_SIZE_MAX])("scales the body, its spacing and the avatar column with a %i px font", async (size) => {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ version: 1, fontSize: size, lineHeight: 1.8, showSpeakers: true }));
    const { reader } = await openReader();
    await waitFor(() => expect((reader.querySelector("[data-turn-key]") as HTMLElement).style.fontSize).toBe(`${size}px`));
    const wide = reader.querySelector("[data-turn-layout='wide']") as HTMLElement;
    expect(wide.style.lineHeight).toBe("1.8");
    // Spacing, measure and gutter are em (or derive from the em-based avatar), so they follow the font size.
    // The first turn is one paragraph: its row ends with the turn gap; a paragraph inside a turn with the paragraph gap.
    expect(wide.style.paddingBottom).toBe("1em");
    expect((reader.querySelector("[data-segment-id='g4']")?.closest("[data-turn-key]") as HTMLElement).style.paddingBottom).toBe("0.75em");
    expect((reader.querySelector("[data-segment-id='g5']")?.closest("[data-turn-key]") as HTMLElement).style.paddingBottom).toBe("1em");
    expect(wide.style.getPropertyValue("--reader-avatar")).toBe("clamp(28px, 1.75em, 48px)");
    const grid = wide.lastElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("calc(var(--reader-avatar) + 0.75em) minmax(0, 1fr)");
    // The measure belongs to the centred reading column around the row, sized from the reading size plus the gutter.
    const column = wide.closest("[data-row-index] > div") as HTMLElement;
    expect(column.className).toBe(READER_COLUMN_CLASS);
    const host = reader.parentElement as HTMLElement;
    expect(host.style.getPropertyValue("--reader-font-size")).toBe(`${size}px`);
    expect(host.style.getPropertyValue("--reader-gutter")).toBe(READER_GUTTER);
    expect(reader.className).toContain(READER_SCROLLER_CLASS);
    // A chapter heading indents by the gutter, to the edge the names and the text share.
    const chapterColumn = (within(reader).getAllByTestId("transcript-chapter")[0] as HTMLElement).parentElement as HTMLElement;
    expect(chapterColumn.className).toBe(READER_COLUMN_CLASS);
    expect(chapterColumn.hasAttribute(READER_INDENT_ATTRIBUTE)).toBe(true);
    expect(column.hasAttribute(READER_INDENT_ATTRIBUTE)).toBe(false);
    // The header holds the avatar and the name; the text column starts after the gutter.
    const header = within(wide).getByTestId("turn-header");
    expect(header.style.minHeight).toBe("var(--reader-avatar)");
    expect(grid.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    const body = reader.querySelector("[data-segment-id='g4']")?.closest("p") as HTMLElement;
    expect(body.className).toContain("break-words");
    // Chapter headings and timestamps keep the interface size: they carry no inline font size.
    expect((within(reader).getAllByTestId("transcript-chapter")[0] as HTMLElement).style.fontSize).toBe("");
    expect((within(wide).getByRole("button", { name: "0:00" }) as HTMLElement).style.fontSize).toBe("");
  });

  it("keeps the plain paragraph on the same scale outside speaker mode, opening with the same time", async () => {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ version: 1, fontSize: 24, lineHeight: 1.6, showSpeakers: true }));
    const plain = SPEAKER_SEGMENTS.map(({ speakerId: _speakerId, ...rest }) => rest);
    const select = vi.fn();
    const { reader } = await openReader(speakerRoutes({ segments: plain }), { select });
    const paragraph = reader.querySelector("[data-segment-id='g1']")?.closest("p") as HTMLElement;
    expect(paragraph.style.fontSize).toBe("24px");
    expect(paragraph.style.lineHeight).toBe("1.6");
    // No measure of its own and no gutter: the reading column carries the measure.
    expect(paragraph.style.maxWidth).toBe("");
    expect(paragraph.parentElement?.className).toBe(READER_COLUMN_CLASS);
    const host = reader.parentElement as HTMLElement;
    expect(host.style.getPropertyValue("--reader-gutter")).toBe("0px");
    expect(host.style.getPropertyValue("--reader-font-size")).toBe("24px");
    expect(paragraph.style.paddingBottom).toBe("0.75em");
    // Without turns the first four sentences are one paragraph.
    expectTimeFirst(reader, select, ["g1", "g5", "g6", "g7"]);
  });

  it("defaults to 16px and a line height of 1.7", async () => {
    const { reader } = await openReader();
    const wide = reader.querySelector("[data-turn-layout='wide']") as HTMLElement;
    expect([wide.style.fontSize, wide.style.lineHeight]).toEqual(["16px", "1.7"]);
  });

  it("applies a change at once and stores it per user; 恢复默认 removes it", async () => {
    const { reader } = await openReader();
    await waitFor(() => expect(screen.getByRole("button", { name: "Aa 阅读排版" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
    const popover = await screen.findByTestId("reader-typography-popover");
    // The user arrives asynchronously; a change made before that is not stored.
    await waitFor(() => {
      fireEvent.click(within(popover).getByRole("button", { name: "增大字号" }));
      expect(localStorage.getItem(TYPOGRAPHY_KEY)).not.toBeNull();
    });
    const stored = JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY) as string) as { fontSize: number };
    expect(stored.fontSize).toBeGreaterThan(READER_FONT_SIZE_DEFAULT);
    expect((reader.querySelector("[data-turn-key]") as HTMLElement).style.fontSize).toBe(`${stored.fontSize}px`);
    fireEvent.click(within(popover).getByRole("radio", { name: "2.0" }));
    expect((reader.querySelector("[data-turn-key]") as HTMLElement).style.lineHeight).toBe("2");
    fireEvent.click(within(popover).getByRole("button", { name: "恢复默认" }));
    expect(localStorage.getItem(TYPOGRAPHY_KEY)).toBeNull();
    expect((reader.querySelector("[data-turn-key]") as HTMLElement).style.fontSize).toBe("16px");
  });

  it("hides the turns with 显示发言人 and keeps the reading otherwise as it was", async () => {
    const { reader } = await openReader();
    fireEvent.click(screen.getByRole("button", { name: "Aa 阅读排版" }));
    const popover = await screen.findByTestId("reader-typography-popover");
    await waitFor(() => {
      fireEvent.click(within(popover).getByRole("switch", { name: "显示发言人" }));
      expect(localStorage.getItem(TYPOGRAPHY_KEY)).not.toBeNull();
    });
    await waitFor(() => expect(reader.querySelector("[data-turn-key]")).toBeNull());
    expect(within(reader).queryAllByTestId("turn-header")).toEqual([]);
    expect(reader.querySelector("[data-segment-id='g6']")?.closest("p")?.textContent).toBe("0:30这一句没有人认领，所以它属于未分配的轮次。");
    // The switch stays where the user can turn the turns back on.
    expect((within(popover).getByRole("switch") as HTMLInputElement).checked).toBe(false);
  });
});

describe("overlapping sentences", () => {
  // A speaks 0-10 s; B interrupts 4-6 s.
  const overlap = [
    segment("o1", 0, 0, 10_000, "我先说一件很长的事情。", { speakerId: "sp1" }),
    segment("o2", 1, 4_000, 6_000, "等一下。", { speakerId: "sp2" }),
    segment("o3", 2, 12_000, 14_000, "然后继续。", { speakerId: "sp1" }),
  ];
  const marks = (reader: HTMLElement) => ({
    primary: [...reader.querySelectorAll("[data-testid='current-sentence']")].map((node) => node.getAttribute("data-segment-id")),
    weak: [...reader.querySelectorAll("[data-overlap-current]")].map((node) => node.getAttribute("data-segment-id")),
  });

  async function open(select?: Parameters<typeof mountReader>[0]) {
    return await openReader(speakerRoutes({ segments: overlap }), { ...select, ready: "o1" });
  }

  it("marks the sentence that started last as primary and the others weakly, and nothing outside any", async () => {
    const { reader, controller } = await open();
    act(() => controller.reportTime(2_000));
    expect(marks(reader)).toEqual({ primary: ["o1"], weak: [] });
    act(() => controller.reportTime(5_000));
    expect(marks(reader)).toEqual({ primary: ["o2"], weak: ["o1"] });
    act(() => controller.reportTime(8_000));
    expect(marks(reader)).toEqual({ primary: ["o1"], weak: [] });
    act(() => controller.reportTime(11_000));
    expect(marks(reader)).toEqual({ primary: [], weak: [] });
  });

  it("keeps the sentence the user clicked to play as primary while it lasts, then follows playback again", async () => {
    const { reader, controller } = await open();
    fireEvent.click(reader.querySelector("[data-segment-id='o1']") as HTMLElement);
    act(() => controller.reportTime(5_000));
    expect(marks(reader)).toEqual({ primary: ["o1"], weak: ["o2"] });
    act(() => controller.reportTime(12_500));
    expect(marks(reader)).toEqual({ primary: ["o3"], weak: [] });
    // The pin ended when the time left the sentence: coming back, the later-starting one leads again.
    act(() => controller.reportTime(5_000));
    expect(marks(reader)).toEqual({ primary: ["o2"], weak: ["o1"] });
  });

  it("lets 从这里播放 in the sentence menu lead the highlight like a click does", async () => {
    mockApi(speakerRoutes({ segments: overlap }));
    const { controller } = mountReader({ contextMenu: true });
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    await waitFor(() => expect(reader.querySelector("[data-segment-id='o1']")).not.toBeNull());
    act(() => {
      reader.querySelector("[data-segment-id='o1']")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    fireEvent.click(screen.getByTestId("context-menu-item-play-from-here"));
    act(() => controller.reportTime(5_000));
    expect(marks(reader)).toEqual({ primary: ["o1"], weak: ["o2"] });
  });

  it("marks nothing when the player cannot track time", async () => {
    mockApi(speakerRoutes({ segments: overlap }));
    mountReader();
    const reader = await screen.findByTestId("transcript-reader", {}, { timeout: 5_000 });
    expect(marks(reader)).toEqual({ primary: [], weak: [] });
  });
});

describe("sticky marker", () => {
  /** Lets the scroll's animation frame and a fade pass, so a marker that was going to show has shown. */
  const settleFrames = () => act(() => new Promise((resolve) => setTimeout(resolve, MARKER_FADE_MS + 50)));

  /** Places each row at `top` with `height`, its header at its top and its text below the header, above a 12px trailing gap. */
  function place(reader: HTMLElement, layout: (key: string) => { top: number; height: number }): void {
    for (const row of reader.querySelectorAll<HTMLElement>("[data-row-key]")) {
      const { top, height } = layout(row.getAttribute("data-row-key") ?? "");
      row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: top, width: 600, height });
      const header = row.querySelector<HTMLElement>("[data-turn-header]");
      if (header !== null) header.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: top, width: 600, height: 28 });
      const text = row.querySelector<HTMLElement>("[data-reader-text]");
      const textTop = header === null ? top : top + 28;
      if (text !== null) text.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: textTop, width: 600, height: top + height - 12 - textTop });
    }
  }

  it("stands for the turn whose header scrolled out, fades with the turn, and is hidden from assistive technology", async () => {
    const { reader } = await openReader();
    const host = reader.parentElement as HTMLElement;
    const marker = screen.getByTestId("turn-marker");
    expect(marker.getAttribute("aria-hidden")).toBe("true");
    expect(marker.getAttribute("data-visible")).toBe("false");
    // One source for the fade: the same duration the marker's state machine waits.
    expect(marker.style.transitionDuration).toBe(`${MARKER_FADE_MS}ms`);
    // The viewport starts at y=100; the g4/g5 turn's header (in row g4) has scrolled above it.
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 });
    const keys = [...reader.querySelectorAll<HTMLElement>("[data-row-key]")].map((row) => row.getAttribute("data-row-key"));
    place(reader, (key) => {
      const index = keys.indexOf(key);
      if (index < keys.indexOf("g4")) return { top: -1_000, height: 100 };
      if (key === "g4") return { top: -40, height: 120 };
      if (key === "g5") return { top: 60, height: 160 };
      return { top: 900, height: 100 };
    });
    // At 16px × 1.7 a row needs its text to reach 28 + 27.2 px below the top. g4's text ends at 68,
    // above the top; g5's reaches 208, and its turn's header is in g4.
    act(() => void fireEvent.scroll(reader));
    await waitFor(() => expect(marker.getAttribute("data-visible")).toBe("true"));
    expect(marker.querySelector("[data-speaker-id]")?.getAttribute("data-speaker-id")).toBe("sp1");
    expect(host.contains(marker)).toBe(true);
    // Its horizontal place comes from a still copy of the scroller and its reading column.
    expect(marker.parentElement?.className).toContain(READER_COLUMN_CLASS);
    expect(marker.parentElement?.parentElement?.className).toContain(READER_SCROLLER_CLASS);
    // The marker takes no pointer input and is not a control.
    expect(marker.querySelector("button")).toBeNull();
  });

  it("is hidden while the turn header is in view", async () => {
    const { reader } = await openReader();
    const marker = screen.getByTestId("turn-marker");
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 });
    // The opening chapter heading has scrolled away; g1's row, header and two lines of text are in view.
    place(reader, (key) => (key === "chapter:0" ? { top: -1_000, height: 60 } : key === "g1" ? { top: 110, height: 100 } : { top: 900, height: 100 }));
    act(() => void fireEvent.scroll(reader));
    await settleFrames();
    expect(marker.getAttribute("data-visible")).toBe("false");
  });

  it("is hidden when a turn's text has less than a marker and a line left below the top", async () => {
    const { reader } = await openReader();
    const marker = screen.getByTestId("turn-marker");
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 });
    const keys = [...reader.querySelectorAll<HTMLElement>("[data-row-key]")].map((row) => row.getAttribute("data-row-key"));
    // g5's text ends at 150: 50px below the top, under the 55.2px needed. g6's header follows, in view.
    place(reader, (key) => {
      const index = keys.indexOf(key);
      if (index < keys.indexOf("g5")) return { top: -1_000, height: 100 };
      if (key === "g5") return { top: -40, height: 202 };
      if (key === "g6") return { top: 162, height: 100 };
      return { top: 900, height: 100 };
    });
    act(() => void fireEvent.scroll(reader));
    await settleFrames();
    expect(marker.getAttribute("data-visible")).toBe("false");
  });
});

describe("speakers in the data", () => {
  it("names a speaker the list does not know as unassigned instead of failing", async () => {
    const { reader } = await openReader(speakerRoutes({ speakers: [CHEN] }));
    expect(headers(reader)).toEqual(["陈明", "未分配", "陈明", "未分配", "陈明"]);
  });
});
