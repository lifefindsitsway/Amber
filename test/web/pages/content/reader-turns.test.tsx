import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_FONT_SIZE_DEFAULT, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from "../../../../src/shared/defaults.ts";
import { MARKER_FADE_MS } from "../../../../src/web/pages/content/reader-sticky.ts";
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

describe("speaker mode decision", () => {
  it("reads by turns when two speakers or a named one are referenced", async () => {
    const { reader } = await openReader();
    expect(headers(reader)).toEqual(["陈明，0:00", "陈明，0:10", "未分配，0:30", "陈明，1:15"]);
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
  it("names each turn once with its speaker and start time, the paragraphs of a turn sharing one line", async () => {
    const { reader } = await openReader();
    const first = within(reader).getAllByTestId("turn-header")[1] as HTMLElement;
    expect(first.getAttribute("role")).toBe("group");
    expect(first.textContent).toBe("陈陈明0:10");
    expect(within(first).getByTitle("陈明").textContent).toBe("陈明");
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

  it("does not break the document outline: no turn header is a heading", async () => {
    const { reader } = await openReader();
    expect(within(reader).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["0:00开场", "1:00正文"]);
  });

  it("shows sentences nobody owns as 未分配 with the neutral avatar, which opens nothing", async () => {
    const { reader } = await openReader();
    const header = within(reader).getAllByTestId("turn-header")[2] as HTMLElement;
    expect(header.textContent).toBe("未分配0:30");
    expect(header.querySelector("[data-kind='unassigned']")).not.toBeNull();
    expect(within(header).queryByTestId("turn-speaker")?.tagName).toBe("SPAN");
  });

  it("shows the speaker again after a chapter heading, even when the same one goes on", async () => {
    const { reader } = await openReader();
    const rows = [...reader.querySelectorAll("[data-row-index]")].map((row) => (row.querySelector("[data-testid='transcript-chapter']") !== null ? "chapter" : row.querySelector("[data-testid='turn-header']") !== null ? "header" : "body"));
    expect(rows).toEqual(["chapter", "header", "body", "header", "body", "header", "chapter", "header"]);
  });

  it("seeks from the turn's time like a paragraph's time does", async () => {
    const select = vi.fn();
    const { reader } = await openReader(speakerRoutes(), { select });
    fireEvent.click(within(within(reader).getAllByTestId("turn-header")[1] as HTMLElement).getByRole("button", { name: "0:10" }));
    expect(select).toHaveBeenCalledWith({ revisionId: "r1", segmentId: "g4" }, 10_000);
  });

  it("opens the identity card from the avatar or name without seeking, with the speaker's share, and offers editing", async () => {
    const select = vi.fn();
    const { reader } = await openReader(speakerRoutes(), { select });
    const trigger = within(within(reader).getAllByTestId("turn-header")[0] as HTMLElement).getByTestId("turn-speaker");
    expect(trigger.tagName).toBe("BUTTON");
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

  it("gives avatars an accessible name outside a header that already names them", async () => {
    const { reader } = await openReader();
    const compact = reader.querySelector("[data-turn-layout='compact']") as HTMLElement;
    expect(compact.getAttribute("role")).toBe("group");
    expect(compact.getAttribute("aria-label")).toBe("发言人 2，0:08");
    expect(within(compact).getByRole("img", { name: "发言人 2" })).toBeTruthy();
    // In a header the avatar sits beside the written name and is decorative.
    const header = within(reader).getAllByTestId("turn-header")[0] as HTMLElement;
    expect(within(header).queryByRole("img")).toBeNull();
  });
});

describe("short turns", () => {
  it("keeps the compact avatar out of the tab order and out of the text a selection takes, while the name beside it stays a stop", async () => {
    const { reader } = await openReader();
    const row = reader.querySelector("[data-turn-layout='compact']") as HTMLElement;
    const [avatarCell, text] = [row.children[0] as HTMLElement, row.children[1] as HTMLElement];
    expect(avatarCell.hasAttribute("data-reading-time")).toBe(true);
    expect(avatarCell.querySelector("button")?.getAttribute("tabindex")).toBe("-1");
    expect(text.querySelector("button[data-testid='turn-speaker']")?.hasAttribute("tabindex")).toBe(false);
  });

  it("keeps a one-line turn compact: avatar in the gutter, the name running at the start of the text", async () => {
    const { reader } = await openReader();
    const compact = reader.querySelectorAll("[data-turn-layout='compact']");
    expect(compact).toHaveLength(1);
    const row = compact[0] as HTMLElement;
    expect(within(row).queryByTestId("turn-header")).toBeNull();
    const text = row.querySelector("p") as HTMLElement;
    expect(text.textContent).toBe("发言人 20:08嗯。");
    // Same grid as the long turns.
    expect(row.style.gridTemplateColumns).toBe((reader.querySelector("[data-turn-layout='wide'] > div:last-child") as HTMLElement).style.gridTemplateColumns);
  });

  it("gives a short turn with a search hit the full layout", async () => {
    const { reader } = await openReader(speakerRoutes(), { route: "/contents/c1?tab=transcript&revision=r1&search=%E5%97%AF" });
    await waitFor(() => expect(reader.querySelector("mark")).not.toBeNull());
    expect(reader.querySelector("[data-turn-layout='compact']")).toBeNull();
    expect(headers(reader)).toContain("发言人 2，0:08");
  });

  it("gives a short turn with a note the full layout", async () => {
    const routes = {
      ...speakerRoutes(),
      "GET /api/contents/c1/notes": {
        body: { items: [note("n1", { startSegmentId: "g3", endSegmentId: "g3", mark: "underline", view: { segments: [{ segmentId: "g3", startOffset: 0, endOffset: 1 }], exact: true } })] },
      },
    };
    const { reader } = await openReader(routes);
    await waitFor(() => expect(reader.querySelector("[data-testid='note-run']")).not.toBeNull());
    expect(reader.querySelector("[data-turn-layout='compact']")).toBeNull();
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
    const { reader } = await openReader();
    await waitFor(() => expect(reader.querySelector("[data-turn-layout='narrow']")).not.toBeNull());
    expect(reader.querySelector("[data-turn-layout='wide'], [data-turn-layout='compact']")).toBeNull();
    expect(reader.querySelector("[data-testid='turn-line']")).toBeNull();
    const row = reader.querySelector("[data-segment-id='g4']")?.closest("[data-turn-key]") as HTMLElement;
    const children = [...row.children].map((child) => child.tagName + (child.getAttribute("data-testid") === "turn-header" ? ":header" : ""));
    expect(children).toEqual(["DIV:header", "P"]);
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
    expect(wide.style.paddingBottom).toBe("1.5em");
    expect(wide.style.getPropertyValue("--reader-avatar")).toBe("clamp(28px, 1.75em, 48px)");
    const grid = wide.lastElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("calc(var(--reader-avatar) + 0.75em) minmax(0, 40em)");
    // The timestamp and the avatar are separate boxes in the header row; the text column starts after the gutter.
    const header = within(wide).getByTestId("turn-header");
    expect(header.style.minHeight).toBe("var(--reader-avatar)");
    expect(grid.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    const body = reader.querySelector("[data-segment-id='g4']")?.closest("p") as HTMLElement;
    expect(body.className).toContain("break-words");
    // Chapter headings and timestamps keep the interface size: they carry no inline font size.
    expect((within(reader).getAllByTestId("transcript-chapter")[0] as HTMLElement).style.fontSize).toBe("");
    expect((within(header).getByRole("button", { name: "0:00" }) as HTMLElement).style.fontSize).toBe("");
  });

  it("keeps the plain paragraph on the same scale outside speaker mode", async () => {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ version: 1, fontSize: 24, lineHeight: 1.6, showSpeakers: true }));
    const plain = SPEAKER_SEGMENTS.map(({ speakerId: _speakerId, ...rest }) => rest);
    const { reader } = await openReader(speakerRoutes({ segments: plain }));
    const paragraph = reader.querySelector("[data-segment-id='g1']")?.closest("p") as HTMLElement;
    expect(paragraph.style.fontSize).toBe("24px");
    expect(paragraph.style.lineHeight).toBe("1.6");
    expect(paragraph.style.maxWidth).toBe("40em");
    expect(paragraph.style.paddingBottom).toBe("0.75em");
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
    const rowTops = new Map(keys.map((key, index) => [key, index < keys.indexOf("g4") ? -1_000 : key === "g4" ? -40 : key === "g5" ? 60 : 900]));
    for (const row of reader.querySelectorAll<HTMLElement>("[data-row-key]")) {
      const key = row.getAttribute("data-row-key") ?? "";
      const top = rowTops.get(key) ?? 900;
      row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: top, width: 600, height: key === "g4" ? 120 : 160 });
      const header = row.querySelector<HTMLElement>("[data-turn-header]");
      if (header !== null) header.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: top, width: 600, height: 40 });
    }
    // g4 ends at 80 (above the viewport top + clearance); g5 is the first row with room and its turn's header is in g4.
    act(() => void fireEvent.scroll(reader));
    await waitFor(() => expect(marker.getAttribute("data-visible")).toBe("true"));
    expect(marker.querySelector("[data-speaker-id]")?.getAttribute("data-speaker-id")).toBe("sp1");
    expect(host.contains(marker)).toBe(true);
    // The marker takes no pointer input and is not a control.
    expect(marker.querySelector("button")).toBeNull();
  });

  it("is hidden while the turn header is in view", async () => {
    const { reader } = await openReader();
    const marker = screen.getByTestId("turn-marker");
    reader.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 });
    for (const row of reader.querySelectorAll<HTMLElement>("[data-row-key]")) {
      row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 110, width: 600, height: 100 });
      const header = row.querySelector<HTMLElement>("[data-turn-header]");
      if (header !== null) header.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 110, width: 600, height: 40 });
    }
    act(() => void fireEvent.scroll(reader));
    expect(marker.getAttribute("data-visible")).toBe("false");
  });
});

describe("speakers in the data", () => {
  it("names a speaker the list does not know as unassigned instead of failing", async () => {
    const { reader } = await openReader(speakerRoutes({ speakers: [CHEN] }));
    expect((reader.querySelector("[data-turn-layout='compact']") as HTMLElement).getAttribute("aria-label")).toBe("未分配，0:08");
  });
});
