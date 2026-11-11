import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER_FADE_MS, stickyTurnAt, useFadedTurn, type StickyTurn } from "../../../../src/web/pages/content/reader-sticky.ts";

const rect = (top: number, height: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 300, height });

/** A scroller whose viewport starts at y=100 and whose rows sit at the given tops. */
function scroller(rows: Array<{ key: string; turn?: string; speaker?: string; header?: { top: number; height: number }; top: number; height: number }>): HTMLElement {
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
      element.append(turn);
    }
    container.append(element);
  }
  return container;
}

describe("stickyTurnAt", () => {
  it("names the turn of the first visible row when that turn's header has scrolled away", () => {
    const container = scroller([
      { key: "a", turn: "t1", speaker: "sp1", header: { top: 20, height: 40 }, top: 20, height: 150 },
      { key: "b", turn: "t1", speaker: "sp1", top: 170, height: 100 },
    ]);
    expect(stickyTurnAt(container)).toEqual({ key: "t1", speakerId: "sp1" });
  });

  it("is empty while the turn header is in view, and for a list that is empty or starts with a heading", () => {
    expect(stickyTurnAt(scroller([{ key: "a", turn: "t1", speaker: "sp1", header: { top: 110, height: 40 }, top: 110, height: 200 }]))).toBeUndefined();
    expect(stickyTurnAt(scroller([]))).toBeUndefined();
    expect(stickyTurnAt(scroller([{ key: "chapter:0", top: 90, height: 60 }, { key: "a", turn: "t1", speaker: "sp1", header: { top: 150, height: 40 }, top: 150, height: 100 }]))).toBeUndefined();
  });

  it("leaves a row that is about to scroll out to the one below, so the marker never sits on the next turn's avatar", () => {
    const container = scroller([
      { key: "a", turn: "t1", speaker: "sp1", header: { top: -200, height: 40 }, top: -200, height: 320 },
      { key: "b", turn: "t2", speaker: "sp2", header: { top: 130, height: 40 }, top: 120, height: 100 },
    ]);
    // Row a ends 20px below the viewport top; the marker would be drawn over t2's header.
    expect(stickyTurnAt(container)).toBeUndefined();
  });

  it("reports unassigned sentences without a speaker", () => {
    const container = scroller([{ key: "a", turn: "t9", header: { top: -50, height: 40 }, top: -50, height: 300 }]);
    expect(stickyTurnAt(container)).toEqual({ key: "t9", speakerId: undefined });
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
