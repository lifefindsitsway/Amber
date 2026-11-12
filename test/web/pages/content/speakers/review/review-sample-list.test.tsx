import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SpeakerDto } from "../../../../../../src/shared/dto/speaker.ts";
import { CAPABILITIES } from "../../../../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider } from "../../../../../../src/web/player/player-controller.tsx";
import { ReviewSampleList, type SampleListSentence } from "../../../../../../src/web/pages/content/speakers/review/review-sample-list.tsx";
import { renderApp } from "../../../../../fixtures/web/render.tsx";

const SPEAKERS = new Map<string, SpeakerDto>([
  ["sa", { id: "sa", ordinal: 1, name: "陈明", colorIndex: 0, used: true }],
  ["sb", { id: "sb", ordinal: 2, colorIndex: 1, used: true }],
]);
const SENTENCES: SampleListSentence[] = [
  { id: "g0", startMs: 0, endMs: 2_000, text: "你好", speakerId: "sa" },
  { id: "g1", startMs: 2_000, endMs: 65_000, text: "很长的一段回答", speakerId: "sb" },
  { id: "g2", startMs: 65_000, endMs: 66_000, text: "没有人" },
];

function show(controller: PlayerController) {
  return renderApp(
    <PlayerControllerProvider controller={controller}>
      <ReviewSampleList contentId="c1" sentences={SENTENCES} speakers={SPEAKERS} />
    </PlayerControllerProvider>,
  );
}

describe("ReviewSampleList", () => {
  it("lists each speaker's clips with the time and text, and plays one as a range", () => {
    const controller = new PlayerController();
    const driver = { capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
    controller.attach(driver);
    show(controller);
    const rows = screen.getAllByTestId("speaker-review-sample");
    expect(rows.map((row) => row.getAttribute("data-segment-id"))).toEqual(["g0", "g1"]);
    expect(rows[1]?.textContent).toContain("0:02");
    expect(rows[1]?.textContent).toContain("很长的一段回答");
    fireEvent.click(screen.getByRole("button", { name: "播放 发言人 2 在 0:02 的片段" }));
    expect(driver.seek).toHaveBeenCalledWith(2_000);
    expect(driver.play).toHaveBeenCalledOnce();
    expect(controller.playingRange()).toMatchObject({ startMs: 2_000, endMs: 65_000 });
    expect(screen.getByTestId("speaker-review-sample-playing").textContent).toBe("播放中");
  });

  it("stops pausing at the clip's end once the list is gone", () => {
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.local, seek: vi.fn(), play: vi.fn(), pause: vi.fn() });
    const { unmount } = show(controller);
    fireEvent.click(screen.getByRole("button", { name: "播放 陈明 在 0:00 的片段" }));
    expect(controller.playingRange()).toBeDefined();
    unmount();
    expect(controller.playingRange()).toBeUndefined();
  });
});
