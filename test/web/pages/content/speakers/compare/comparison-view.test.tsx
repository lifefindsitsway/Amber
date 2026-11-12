import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ComparedSentence } from "../../../../../../src/shared/speaker-comparison.ts";
import { ComparisonView, type ComparisonFilter } from "../../../../../../src/web/pages/content/speakers/compare/comparison-view.tsx";
import { revision } from "../../../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../../../fixtures/web/render.tsx";
import { COMPARE_SPEAKERS, recognition, segmentRoute, speakerOf, turns, type Row } from "../../../../../fixtures/web/speaker-compare.ts";

/** The sentences being checked, as the editor hands them over: row keys, times and speakers. */
function sentences(rows: readonly Row[]): ComparedSentence[] {
  return rows.map(([startMs, endMs, ordinal], index) => ({ id: `d${index + 1}`, startMs, endMs, speakerId: ordinal === null ? null : speakerOf(ordinal) }));
}

const BASE = recognition("r1", "qwen-asr", { createdAt: 5 });
const OTHER = recognition("r2", "scribe_v2", { comparison: true });
const MINE = turns([1, 2, 1, 2, 1, 2, 1, 2]);
// Label 3 is speaker 1 and label 4 speaker 2; label 4 also takes the fifth sentence.
const THEIRS = turns([3, 4, 3, 4, 4, 4, 3, 4]);

function render(options: { theirs?: readonly Row[]; rangePlayable?: boolean; revisions?: ReturnType<typeof recognition>[] } = {}) {
  const { calls } = mockApi({
    ...segmentRoute("r2", options.theirs ?? THEIRS, OTHER),
    "GET /api/asr-profiles": { body: { items: [] } },
  });
  const playRange = vi.fn();
  const onLocate = vi.fn();
  const filters: Array<ComparisonFilter | null> = [];
  renderApp(
    <ComparisonView
      contentId="c1"
      sentences={sentences(MINE)}
      baseRevisionId="r1"
      revisions={options.revisions ?? [BASE, OTHER]}
      speakers={COMPARE_SPEAKERS}
      playRange={playRange}
      {...(options.rangePlayable === undefined ? {} : { rangePlayable: options.rangePlayable })}
      onLocate={onLocate}
      onFilterChange={(filter) => filters.push(filter)}
    />,
  );
  return { calls, playRange, onLocate, filters };
}

describe("ComparisonView", () => {
  it("states model, coverage and counts, proposes who is who and lists the sentence the other model gives to someone else", async () => {
    const { calls, playRange, onLocate } = render();
    const header = await screen.findByTestId("comparison-header");
    expect(header.textContent).toContain("对比模型：scribe_v2");
    expect(header.textContent).toContain("覆盖率 100%");
    expect(header.textContent).toContain("归属不同 1");
    expect(header.textContent).toContain("无法判断 0");
    expect(header.textContent).toContain("身份未对应 0");
    expect(screen.queryByTestId("comparison-unreliable")).toBeNull();

    const rows = screen.getAllByTestId("comparison-mapping-row");
    expect(rows.map((row) => [row.getAttribute("data-source-speaker"), row.getAttribute("data-status")])).toEqual([
      ["spk-3", "matched"],
      ["spk-4", "matched"],
    ]);
    expect((screen.getAllByTestId("comparison-map") as HTMLSelectElement[]).map((select) => select.value)).toEqual(["spk-1", "spk-2"]);
    expect(within(rows[1] as HTMLElement).getByTestId("comparison-mapping-status").textContent).toBe("对应（重叠 80%）");

    const listed = screen.getAllByTestId("comparison-row");
    expect(listed.map((row) => [row.getAttribute("data-segment-id"), row.getAttribute("data-kind")])).toEqual([["d5", "different"]]);
    expect(listed[0]?.textContent).toContain("当前：陈明·对比稿：林雪");
    const play = within(listed[0] as HTMLElement).getByTestId("comparison-play");
    expect(play.textContent).toBe("播放");
    fireEvent.click(play);
    expect(playRange).toHaveBeenCalledWith(20_000, 25_000);
    fireEvent.click(within(listed[0] as HTMLElement).getByTestId("comparison-locate"));
    expect(onLocate).toHaveBeenCalledWith("d5");
    // Read-only: nothing but reads went out.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("recomputes from a changed correspondence and filters the editor's rows by category", async () => {
    const { filters } = render();
    await screen.findByTestId("comparison-header");
    // Label 4 corresponds to nobody: its five sentences become unmapped.
    fireEvent.change(screen.getAllByTestId("comparison-map")[1] as HTMLSelectElement, { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("comparison-header").textContent).toContain("身份未对应 5"));
    expect(screen.getByTestId("comparison-header").textContent).toContain("归属不同 0");
    expect(screen.getAllByTestId("comparison-row").map((row) => row.getAttribute("data-segment-id"))).toEqual(["d2", "d4", "d5", "d6", "d8"]);

    fireEvent.click(screen.getByTestId("comparison-filter-different"));
    expect(screen.getByTestId("comparison-filter-different").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryAllByTestId("comparison-row")).toEqual([]);
    fireEvent.click(screen.getByTestId("comparison-filter-unmapped"));
    expect(screen.getAllByTestId("comparison-row")).toHaveLength(5);
    expect([...(filters.at(-1)?.ids ?? [])]).toEqual(["d2", "d4", "d5", "d6", "d8"]);
    expect(filters.at(-1)?.kind).toBe("unmapped");
    fireEvent.click(screen.getByTestId("comparison-filter-all"));
    expect(filters.at(-1)).toBeNull();
  });

  it("shows the category the editor filters by, and 「全部」 once the editor filters by something else", async () => {
    mockApi({ ...segmentRoute("r2", THEIRS, OTHER), "GET /api/asr-profiles": { body: { items: [] } } });
    const filters: Array<ComparisonFilter | null> = [];
    // The editor's side: the category its rows are filtered by, set from outside the view.
    let setActive: (category: ComparisonFilter["kind"] | null) => void = () => undefined;
    function Editor() {
      const [active, set] = useState<ComparisonFilter["kind"] | null>(null);
      setActive = set;
      return (
        <ComparisonView
          contentId="c1"
          sentences={sentences(MINE)}
          baseRevisionId="r1"
          revisions={[BASE, OTHER]}
          speakers={COMPARE_SPEAKERS}
          onFilterChange={(filter) => filters.push(filter)}
          activeCategory={active}
        />
      );
    }
    renderApp(<Editor />);
    await screen.findByTestId("comparison-header");
    fireEvent.click(screen.getByTestId("comparison-filter-different"));
    expect(filters.at(-1)?.kind).toBe("different");
    act(() => setActive("different"));
    expect(screen.getByTestId("comparison-filter-different").getAttribute("aria-pressed")).toBe("true");
    // The editor's own menu took over: the chip no longer claims to filter.
    act(() => setActive(null));
    await waitFor(() => expect(screen.getByTestId("comparison-filter-all").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("comparison-filter-different").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getAllByTestId("comparison-row")).toHaveLength(1);
    // One press picks it again.
    fireEvent.click(screen.getByTestId("comparison-filter-different"));
    expect(filters.at(-1)?.kind).toBe("different");
  });

  it("does not report a difference when the same ordinal is somebody else in the other transcription", async () => {
    // There, label 4 speaks first: by ordinal everything would differ, by time nothing does.
    render({ theirs: turns([4, 3, 4, 3, 4, 3, 4, 3]) });
    expect(await screen.findByTestId("comparison-agree")).toBeTruthy();
    expect((screen.getAllByTestId("comparison-map") as HTMLSelectElement[]).map((select) => select.value)).toEqual(["spk-1", "spk-2"]);
  });

  it("warns when the timelines do not line up, and offers only a jump where the player cannot play a range", async () => {
    const { playRange } = render({ theirs: [...THEIRS, [40_000, 80_000, null]], rangePlayable: false });
    expect((await screen.findByTestId("comparison-unreliable")).textContent).toBe("两份稿的时间轴对不上，结果不可靠");
    const play = screen.getByTestId("comparison-play");
    expect(play.textContent).toBe("跳到");
    expect(play.getAttribute("aria-label")).toBe("跳到 0:20");
    fireEvent.click(play);
    expect(playRange).toHaveBeenCalledWith(20_000, 25_000);
  });

  it("offers the comparison transcription when nothing can be compared, never the recognition the draft comes from", async () => {
    const base = recognition("r0", "qwen-asr", { createdAt: 1 });
    const manual = revision("r1", { kind: "manual", parentRevisionId: "r0", generation: { kind: "manual" }, createdAt: 2 });
    render({ revisions: [base, manual] });
    expect(await screen.findByTestId("comparison-none")).toBeTruthy();
    expect(screen.queryByTestId("comparison-header")).toBeNull();
  });
});
