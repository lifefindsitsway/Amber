import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN, READER_LINE_HEIGHTS } from "../../../../src/shared/defaults.ts";
import { MARKER_FADE_MS, stickyMetrics, stickyTurnAt, useFadedTurn, useStickyTurn, type StickyMetrics, type StickyTurn } from "../../../../src/web/pages/content/reader-sticky.ts";

const rect = (top: number, height: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 300, height });

interface RowSpec {
  key: string;
  turn?: string;
  speaker?: string;
  header?: { top: number; height: number };
  /** The row's sentence paragraph; absent for a chapter heading. */
  text?: { top: number; height: number };
  top: number;
  height: number;
}

/** A scroller whose viewport starts at y=100 and whose rows sit at the given tops. */
function scroller(rows: RowSpec[]): HTMLElement {
  const container = document.createElement("div");
  container.getBoundingClientRect = () => rect(100, 300);
  for (const row of rows) {
    const element = document.createElement("div");
    element.setAttribute("data-row-key", row.key);
    element.getBoundingClientRect = () => rect(row.top, row.height);
    if (row.turn !== undefined) {
      const turn = document.createElement("div");
      turn.setAttribute("data-turn-key", row.turn);
      turn.setAttribute("data-turn-speaker", row.speaker ?? "");
      if (row.header !== undefined) {
        const header = document.createElement("div");
        header.setAttribute("data-turn-header", "");
        const { top, height } = row.header;
        header.getBoundingClientRect = () => rect(top, height);
        turn.append(header);
      }
      if (row.text !== undefined) {
        const text = document.createElement("p");
        text.setAttribute("data-reader-text", "");
        const { top, height } = row.text;
        text.getBoundingClientRect = () => rect(top, height);
        turn.append(text);
      }
      element.append(turn);
    }
    container.append(element);
  }
  return container;
}

/** A marker 30px tall and 20px lines: a row speaks for its turn while its text reaches y >= 150. */
const METRICS: StickyMetrics = { markerPx: 30, linePx: 20 };

describe("stickyMetrics", () => {
  it("takes the reader avatar's clamped diameter and one line of text at the reading typography", () => {
    expect(stickyMetrics({ fontSize: 12, lineHeight: 1.5 })).toEqual({ markerPx: 28, linePx: 18 });
    expect(stickyMetrics({ fontSize: 20, lineHeight: 2 })).toEqual({ markerPx: 35, linePx: 40 });
    expect(stickyMetrics({ fontSize: 32, lineHeight: 1.6 })).toEqual({ markerPx: 48, linePx: 51.2 });
  });
});

describe("stickyTurnAt", () => {
  it("names the turn of the first row with enough text left when that turn's header has scrolled away", () => {
    const container = scroller([
      { key: "a", turn: "t1", speaker: "sp1", header: { top: 20, height: 40 }, text: { top: 60, height: 80 }, top: 20, height: 150 },
      { key: "b", turn: "t1", speaker: "sp1", text: { top: 170, height: 100 }, top: 170, height: 112 },
    ]);
    // Row a's text ends at 140, 40px below the top: less than a marker and a line, so row b decides.
    expect(stickyTurnAt(container, METRICS)).toEqual({ key: "t1", speakerId: "sp1" });
  });

  it("measures the row's text, not the gap after it, against a marker plus one line", () => {
    const at = (textBottom: number) =>
      stickyTurnAt(
        scroller([
          { key: "a", turn: "t1", speaker: "sp1", header: { top: -200, height: 40 }, text: { top: -160, height: textBottom + 160 }, top: -200, height: textBottom + 200 + 24 },
          { key: "b", turn: "t2", speaker: "sp2", header: { top: textBottom + 24, height: 40 }, text: { top: textBottom + 64, height: 20 }, top: textBottom + 24, height: 100 },
        ]),
        METRICS,
      );
    // The threshold is y = 100 + 30 + 20 = 150. Just below it the row's trailing gap would still
    // reach past it, but the text does not: row a is passed over and t2's header is in view.
    expect(at(149)).toBeUndefined();
    expect(at(150)).toEqual({ key: "t1", speakerId: "sp1" });
    expect(at(151)).toEqual({ key: "t1", speakerId: "sp1" });
  });

  it("hands over to the next row of the same turn once the row above has too little text left", () => {
    const rows = (aBottom: number): RowSpec[] => [
      { key: "a", turn: "t1", speaker: "sp1", header: { top: -300, height: 40 }, text: { top: -260, height: aBottom + 260 }, top: -300, height: aBottom + 312 },
      { key: "b", turn: "t1", speaker: "sp1", text: { top: aBottom + 12, height: 200 }, top: aBottom + 12, height: 212 },
    ];
    expect(stickyTurnAt(scroller(rows(160)), METRICS)).toEqual({ key: "t1", speakerId: "sp1" });
    // Row a's text now ends 20px below the top; row b, with its turn's header in row a, takes over.
    expect(stickyTurnAt(scroller(rows(120)), METRICS)).toEqual({ key: "t1", speakerId: "sp1" });
  });

  it("is empty while the turn header is in view, and for a list that is empty or starts with a heading", () => {
    expect(stickyTurnAt(scroller([{ key: "a", turn: "t1", speaker: "sp1", header: { top: 110, height: 40 }, text: { top: 150, height: 160 }, top: 110, height: 200 }]), METRICS)).toBeUndefined();
    // Partly in view counts as in view.
    expect(stickyTurnAt(scroller([{ key: "a", turn: "t1", speaker: "sp1", header: { top: 70, height: 40 }, text: { top: 110, height: 160 }, top: 70, height: 200 }]), METRICS)).toBeUndefined();
    expect(stickyTurnAt(scroller([]), METRICS)).toBeUndefined();
    expect(
      stickyTurnAt(
        scroller([
          { key: "chapter:0", top: 90, height: 80 },
          { key: "a", turn: "t1", speaker: "sp1", header: { top: 170, height: 40 }, text: { top: 210, height: 60 }, top: 170, height: 100 },
        ]),
        METRICS,
      ),
    ).toBeUndefined();
  });

  it("gives no marker while the header is partly in view, even when the first paragraph is too short to speak for the turn", () => {
    // The header is cut by 1px at the top; the one-line first paragraph ends 49px below the top
    // edge, under the threshold of 50. The turn's second paragraph must not take over yet: the
    // marker would sit on the avatar that still shows.
    const rows = (headerTop: number): RowSpec[] => [
      { key: "a", turn: "t1", speaker: "sp1", header: { top: headerTop, height: 30 }, text: { top: headerTop + 30, height: 20 }, top: headerTop, height: 62 },
      { key: "b", turn: "t1", speaker: "sp1", text: { top: headerTop + 62, height: 200 }, top: headerTop + 62, height: 212 },
    ];
    expect(stickyTurnAt(scroller(rows(99)), METRICS)).toBeUndefined();
    expect(stickyTurnAt(scroller(rows(71)), METRICS)).toBeUndefined();
    // Once the header has left, the short paragraph is passed over and the second one speaks.
    expect(stickyTurnAt(scroller(rows(70)), METRICS)).toEqual({ key: "t1", speakerId: "sp1" });
  });

  it("reports unassigned sentences without a speaker", () => {
    const container = scroller([{ key: "a", turn: "t9", header: { top: -50, height: 40 }, text: { top: -10, height: 260 }, top: -50, height: 300 }]);
    expect(stickyTurnAt(container, METRICS)).toEqual({ key: "t9", speakerId: undefined });
  });

  /**
   * Two turns laid out as the reader sets them (header the avatar's height, text right under it,
   * a turn gap of one em), scrolled a pixel at a time past the scroller's top edge.
   */
  function scrollPast(fontSize: number, lineHeight: number, lines: number, visit: (turn: StickyTurn | undefined, nextHeaderTop: number, top: number) => void): void {
    const metrics = stickyMetrics({ fontSize, lineHeight });
    const header = metrics.markerPx;
    const text = lines * metrics.linePx;
    const gap = fontSize;
    for (let offset = -50; offset <= header + text + gap + 50; offset += 1) {
      const aTop = 100 - offset;
      const bTop = aTop + header + text + gap;
      const container = scroller([
        { key: "a", turn: "t1", speaker: "sp1", header: { top: aTop, height: header }, text: { top: aTop + header, height: text }, top: aTop, height: header + text + gap },
        { key: "b", turn: "t2", speaker: "sp2", header: { top: bTop, height: header }, text: { top: bTop + header, height: metrics.linePx }, top: bTop, height: header + metrics.linePx + gap },
      ]);
      visit(stickyTurnAt(container, metrics), bTop, 100);
    }
  }
  const sizes = Array.from({ length: READER_FONT_SIZE_MAX - READER_FONT_SIZE_MIN + 1 }, (_, index) => READER_FONT_SIZE_MIN + index);
  const lineHeights = READER_LINE_HEIGHTS.split(" ").map(Number);

  it("never gives a turn of one line a marker, at any reading size and line height", () => {
    for (const fontSize of sizes) {
      for (const lineHeight of lineHeights) {
        scrollPast(fontSize, lineHeight, 1, (turn) => expect(turn, `${fontSize}px × ${lineHeight}`).toBeUndefined());
      }
    }
  });

  it("never leaves the marker over the next turn's header avatar, at any reading size and line height", () => {
    for (const fontSize of sizes) {
      for (const lineHeight of lineHeights) {
        const { markerPx } = stickyMetrics({ fontSize, lineHeight });
        let shown = 0;
        scrollPast(fontSize, lineHeight, 4, (turn, nextHeaderTop, top) => {
          if (turn?.key !== "t1") return;
          shown += 1;
          expect(nextHeaderTop, `${fontSize}px × ${lineHeight}`).toBeGreaterThanOrEqual(top + markerPx);
        });
        // A four-line turn does get the marker for a while.
        expect(shown, `${fontSize}px × ${lineHeight}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("useStickyTurn", () => {
  /** A host whose first child is a scroller (viewport from y=100) holding the given rows. */
  function Probe(props: { host: HTMLElement }) {
    const turn = useStickyTurn(props.host, true, undefined, METRICS);
    return <output data-testid="sticky">{turn?.key ?? ""}</output>;
  }
  const row = (key: string, turn: string, options: { header?: { top: number; height: number }; text: { top: number; height: number } }): HTMLElement => {
    const built = scroller([{ key, turn, speaker: "sp1", top: options.header?.top ?? options.text.top, height: 400, ...options }]).firstElementChild;
    if (!(built instanceof HTMLElement)) throw new Error("row not built");
    return built;
  };
  const settle = async (): Promise<void> => {
    // The observer reports in a microtask, the hook answers in the next frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
  };

  it("answers again when the rows are replaced without a scroll, as a windowed list does after a jump", async () => {
    const host = document.createElement("div");
    const list = scroller([]);
    host.append(list);
    // Deep inside a long turn: a row without its header, text reaching far below the top edge.
    list.append(row("r60", "t2", { text: { top: 0, height: 400 } }));
    render(<Probe host={host} />);
    await settle();
    expect(screen.getByTestId("sticky").textContent).toBe("t2");
    // The list jumps to its start: the rows of the old position give way to the first turn, its
    // header in view. No scroll event follows the swap.
    list.replaceChildren(row("r0", "t1", { header: { top: 110, height: 30 }, text: { top: 140, height: 300 } }));
    await settle();
    expect(screen.getByTestId("sticky").textContent).toBe("");
  });
});

describe("useFadedTurn", () => {
  afterEach(() => vi.useRealTimers());

  function Probe(props: { turn: StickyTurn | undefined }) {
    const { shown, visible } = useFadedTurn(props.turn);
    return <output data-testid="faded" data-visible={String(visible)}>{shown?.key ?? ""}</output>;
  }
  const state = () => {
    const node = screen.getByTestId("faded");
    return [node.textContent, node.getAttribute("data-visible")];
  };

  it("fades a changed turn out, swaps it after one fade, and fades it in; the same turn is not touched", () => {
    vi.useFakeTimers();
    const a: StickyTurn = { key: "a", speakerId: "sp1" };
    const b: StickyTurn = { key: "b", speakerId: "sp2" };
    const { rerender } = render(<Probe turn={undefined} />);
    expect(state()).toEqual(["", "false"]);
    rerender(<Probe turn={a} />);
    expect(state()).toEqual(["a", "true"]);
    rerender(<Probe turn={{ ...a }} />);
    expect(state()).toEqual(["a", "true"]);
    rerender(<Probe turn={b} />);
    expect(state()).toEqual(["a", "false"]);
    act(() => void vi.advanceTimersByTime(MARKER_FADE_MS));
    expect(state()).toEqual(["b", "true"]);
  });

  it("keeps the last turn's content while it fades out when no turn is left", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe turn={{ key: "a", speakerId: "sp1" }} />);
    rerender(<Probe turn={undefined} />);
    expect(state()).toEqual(["a", "false"]);
  });
});
