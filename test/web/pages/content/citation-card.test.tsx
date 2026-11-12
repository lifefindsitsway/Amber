import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeakerDto } from "../../../../src/shared/dto/speaker.ts";
import { CitationCard, type CitedSentence, type SentencePlayback } from "../../../../src/web/pages/content/citation-card.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const CHEN: SpeakerDto = { id: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, used: true };
const CITED: CitedSentence = { segment: segment("s9", 9, 75_000, 80_000, "再看重排序。", { speakerId: "sp1" }), speaker: CHEN };

afterEach(() => {
  vi.useRealTimers();
});

function show(cited: CitedSentence | undefined, mode: SentencePlayback["mode"] = "play") {
  mockApi({});
  const playRange = vi.fn<(startMs: number, endMs: number) => void>();
  renderApp(
    <p>
      正文
      <CitationCard contentId="c1" cited={cited} playback={{ mode, playRange }}>
        <button type="button" data-citation="s9">
          1:15
        </button>
      </CitationCard>
      <button type="button">之后</button>
    </p>,
  );
  return { playRange, badge: screen.getByRole("button", { name: "1:15" }) };
}

describe("CitationCard", () => {
  it("opens on hover with the sentence, its speaker and 播放这句, which plays exactly that sentence", () => {
    const { badge, playRange } = show(CITED);
    expect(screen.queryByTestId("citation-card")).toBeNull();
    fireEvent.pointerEnter(badge);
    const card = screen.getByRole("group", { name: "引用的原句" });
    expect(screen.getByTestId("citation-card-speaker").textContent).toBe("陈明");
    expect(card.textContent).toContain("再看重排序。");
    expect(card.textContent).toContain("1:15");
    fireEvent.click(screen.getByRole("button", { name: "播放这句" }));
    expect(playRange).toHaveBeenCalledWith(75_000, 80_000);
  });

  it("says 跳到这句 when the player can only be moved, and offers nothing when it cannot", () => {
    const { badge } = show(CITED, "jump");
    fireEvent.pointerEnter(badge);
    expect(screen.getByTestId("citation-card-play").textContent).toBe("跳到这句");
  });

  it("offers no action without a player that can be moved", () => {
    const { badge } = show(CITED, "unsupported");
    fireEvent.pointerEnter(badge);
    expect(screen.getByTestId("citation-card")).toBeTruthy();
    expect(screen.queryByTestId("citation-card-play")).toBeNull();
  });

  it("leaves out the speaker line for a sentence without a speaker to name", () => {
    const { badge } = show({ segment: CITED.segment });
    fireEvent.pointerEnter(badge);
    expect(screen.queryByTestId("citation-card-speaker")).toBeNull();
    expect(screen.getByTestId("citation-card").textContent).toContain("再看重排序。");
  });

  it("opens on keyboard focus, puts its action next in the tab order, and closes on Esc back onto the badge", () => {
    const { badge } = show(CITED);
    act(() => badge.focus());
    const action = screen.getByTestId("citation-card-play");
    // Rendered right after the badge: the next focusable element in document order.
    expect(badge.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(screen.getByRole("button", { name: "之后" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => action.focus());
    expect(screen.getByTestId("citation-card")).toBeTruthy();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(screen.queryByTestId("citation-card")).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("closes once focus leaves it, and shortly after the pointer leaves", () => {
    vi.useFakeTimers();
    const { badge } = show(CITED);
    act(() => badge.focus());
    act(() => screen.getByRole("button", { name: "之后" }).focus());
    expect(screen.queryByTestId("citation-card")).toBeNull();
    fireEvent.pointerEnter(badge);
    fireEvent.pointerLeave(badge);
    expect(screen.getByTestId("citation-card")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByTestId("citation-card")).toBeNull();
  });

  it("leaves the badge alone when the sentence is not known", () => {
    const { badge } = show(undefined);
    fireEvent.pointerEnter(badge);
    act(() => badge.focus());
    expect(screen.queryByTestId("citation-card")).toBeNull();
  });
});
