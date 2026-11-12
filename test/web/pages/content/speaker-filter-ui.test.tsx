import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { SpeakerDto } from "../../../../src/shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../../src/shared/dto/transcript.ts";
import { readerSections, viewRows } from "../../../../src/web/pages/content/reader-rows.ts";
import { filteredViewRows, sentenceCounts, type FilteredRow } from "../../../../src/web/pages/content/speaker-filter.ts";
import {
  SpeakerFilterBar,
  SpeakerFilterButton,
  SpeakerFilterEmpty,
  SpeakerGap,
  useScrollToSegment,
  useSpeakerFilter,
} from "../../../../src/web/pages/content/speaker-filter-ui.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const CHEN: SpeakerDto = { id: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, used: true };
const UNNAMED: SpeakerDto = { id: "sp2", ordinal: 2, colorIndex: 1, used: true };
const LI: SpeakerDto = { id: "sp3", ordinal: 3, name: "李华", colorIndex: 2, used: true };
const ROSTER = [LI, CHEN, UNNAMED];

const say = (id: string, index: number, startMs: number, endMs: number, speakerId: string | undefined): TranscriptSegmentDto =>
  segment(id, index, startMs, endMs, `句子${id}。`, speakerId === undefined ? {} : { speakerId });

const TEXT = [say("a", 0, 0, 4_000, "sp1"), say("b", 1, 4_000, 8_000, "sp2"), say("c", 2, 8_000, 12_000, "sp2"), say("d", 3, 200_000, 204_000, "sp1"), say("e", 4, 204_000, 208_000, undefined)];

function Location() {
  const location = useLocation();
  return <span data-testid="location">{location.search}</span>;
}

/** A small reading view put together the way the transcript tab is to use these parts. */
function Reader(props: { segments: TranscriptSegmentDto[]; speakers: SpeakerDto[] | undefined; scrolled: (index: number) => void }) {
  const filter = useSpeakerFilter(props.speakers);
  const full = useMemo<FilteredRow[]>(() => viewRows(readerSections(props.segments, []), { turns: true, hasMarks: () => false }), [props.segments]);
  const filtered = useMemo(
    () => (filter.active ? filteredViewRows(props.segments, [], filter.selectedSet, { turns: true, hasMarks: () => false }) : undefined),
    [filter.active, filter.selectedSet, props.segments],
  );
  const rows = filtered?.rows ?? full;
  const { scrolled } = props;
  const scrollTo = useCallback((index: number) => scrolled(index), [scrolled]);
  const returnTo = useScrollToSegment(rows, scrollTo);
  return (
    <div>
      <SpeakerFilterButton contentId="c1" speakers={props.speakers ?? []} counts={sentenceCounts(props.segments)} selected={filter.selected} onChange={filter.set} />
      {filtered === undefined ? null : <SpeakerFilterBar speakers={props.speakers ?? []} selected={filter.selected} turns={filtered.turns} onClear={filter.clear} />}
      {filtered !== undefined && filtered.sentences === 0 ? (
        <SpeakerFilterEmpty onClear={filter.clear} />
      ) : (
        <ol data-testid="rows">
          {rows.map((row) =>
            row.kind === "gap" ? (
              <li key={`gap:${row.firstSkippedId}`}>
                <SpeakerGap
                  gap={row}
                  onReturn={(segmentId) => {
                    filter.clear();
                    returnTo(segmentId);
                  }}
                />
              </li>
            ) : row.kind === "paragraph" ? (
              <li key={row.paragraph.segments[0]?.id} data-testid="row">
                {row.paragraph.segments.map((item) => item.id).join("")}
              </li>
            ) : null,
          )}
        </ol>
      )}
      <Location />
    </div>
  );
}

function open(route: string, segments = TEXT, speakers: SpeakerDto[] | undefined = ROSTER) {
  mockApi({});
  const scrolled = vi.fn<(index: number) => void>();
  renderApp(<Reader segments={segments} speakers={speakers} scrolled={scrolled} />, { route, path: "/contents/:id" });
  return { scrolled };
}

const rowsShown = (): string[] => screen.queryAllByTestId("row").map((row) => row.textContent ?? "");
const params = (): URLSearchParams => new URLSearchParams(screen.getByTestId("location").textContent ?? "");

describe("speaker filter in the reading view", () => {
  it("normalizes the address once the speakers are known, keeping search and revision", async () => {
    open("/contents/c1?tab=transcript&revision=r1&search=%E9%87%8D&speaker=sp2&speaker=ghost&speaker=sp1&speaker=sp2");
    await waitFor(() => expect(params().getAll("speaker")).toEqual(["sp1", "sp2"]));
    expect(params().get("search")).toBe("重");
    expect(params().get("revision")).toBe("r1");
    expect(rowsShown()).toEqual(["a", "bc", "d"]);
  });

  it("picks several speakers in the popover, lists their sentence counts and round-trips through the address", async () => {
    open("/contents/c1?tab=transcript&search=x");
    const trigger = screen.getByTestId("speaker-filter");
    expect(trigger.getAttribute("aria-label")).toBe("只看某些发言人");
    fireEvent.click(trigger);
    const popover = await screen.findByTestId("speaker-filter-popover");
    const options = within(popover).getAllByTestId("speaker-filter-option");
    // Only speakers with sentences here, by ordinal: 李华 has none.
    expect(options.map((option) => [option.querySelector("[title]")?.textContent, option.lastElementChild?.textContent])).toEqual([
      ["陈明", "2 句"],
      ["发言人 2", "2 句"],
    ]);
    fireEvent.click(within(options[1] as HTMLElement).getByRole("checkbox"));
    await waitFor(() => expect(params().getAll("speaker")).toEqual(["sp2"]));
    fireEvent.click(within(options[0] as HTMLElement).getByRole("checkbox"));
    await waitFor(() => expect(params().getAll("speaker")).toEqual(["sp1", "sp2"]));
    expect(params().get("search")).toBe("x");
    expect(trigger.getAttribute("aria-label")).toBe("只看某些发言人，已选 2 人");
    expect(screen.getByRole("status").textContent).toBe("只看 陈明、发言人 2 · 3 轮");
  });

  it("shows the active line with turns, and 清除 brings the full text back", async () => {
    open("/contents/c1?speaker=sp1");
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "只看 陈明 · 2 轮");
    expect(rowsShown()).toEqual(["a", "d"]);
    fireEvent.click(screen.getByTestId("speaker-filter-clear"));
    await waitFor(() => expect(rowsShown()).toEqual(["a", "bc", "d", "e"]));
    expect(params().has("speaker")).toBe(false);
  });

  it("puts a gap bar with the skipped time between turns apart, and clicking it returns to the full text at that place", async () => {
    const { scrolled } = open("/contents/c1?speaker=sp1");
    const gap = await screen.findByTestId("speaker-gap");
    const button = within(gap).getByRole("button");
    expect(button.textContent).toBe("略过 3 分 16 秒");
    expect(button.getAttribute("aria-label")).toBe("略过 3 分 16 秒，回到完整原文的这个位置");
    fireEvent.click(button);
    await waitFor(() => expect(rowsShown()).toEqual(["a", "bc", "d", "e"]));
    // The first skipped sentence, b, is in the full text's second row.
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith(1));
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(params().has("speaker")).toBe(false);
  });

  it("says when the selected speakers have no sentence in this revision and offers to clear the filter", async () => {
    open("/contents/c1?speaker=sp3");
    expect(await screen.findByTestId("speaker-filter-empty")).toHaveProperty("textContent", expect.stringContaining("这份字幕稿里没有所选发言人的句子"));
    // Still listed in the popover, so it can be unticked.
    fireEvent.click(screen.getByTestId("speaker-filter"));
    const popover = await screen.findByTestId("speaker-filter-popover");
    expect(within(popover).getAllByTestId("speaker-filter-option").map((option) => option.dataset["speakerId"])).toEqual(["sp1", "sp2", "sp3"]);
    fireEvent.click(screen.getByTestId("speaker-filter-empty-clear"));
    await waitFor(() => expect(rowsShown()).toEqual(["a", "bc", "d", "e"]));
  });

  it("keeps ids it cannot check yet, so a revision without speakers shows the empty state rather than dropping them", async () => {
    open("/contents/c1?speaker=sp1", TEXT.map(({ speakerId: _speakerId, ...rest }) => rest), undefined);
    expect(await screen.findByTestId("speaker-filter-empty")).toBeTruthy();
    expect(params().getAll("speaker")).toEqual(["sp1"]);
  });

  it("drops an id the speaker list does not know", async () => {
    open("/contents/c1?speaker=ghost");
    await waitFor(() => expect(params().has("speaker")).toBe(false));
    expect(rowsShown()).toEqual(["a", "bc", "d", "e"]);
  });
});

describe("SpeakerFilterButton", () => {
  it("is keyboard operable: checkboxes inside a labelled popover", async () => {
    mockApi({});
    const onChange = vi.fn<(ids: string[]) => void>();
    function Harness() {
      const [selected, setSelected] = useState<string[]>(["sp1"]);
      return (
        <SpeakerFilterButton
          contentId="c1"
          speakers={ROSTER}
          counts={new Map([["sp1", 3], ["sp3", 1]])}
          selected={selected}
          onChange={(ids) => {
            onChange(ids);
            setSelected(ids);
          }}
        />
      );
    }
    renderApp(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "只看某些发言人，已选 1 人" }));
    const popover = await screen.findByRole("dialog", { name: "只看某些发言人" });
    const boxes = within(popover).getAllByRole("checkbox");
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);
    fireEvent.click(boxes[0] as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
