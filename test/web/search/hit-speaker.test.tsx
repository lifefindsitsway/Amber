import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BasisChangedMark, HitSpeaker, SpeakerHitsGroup, speakerHitSubject } from "../../../src/web/search/hit-speaker.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

describe("hit speakers", () => {
  it("names an unnamed speaker by ordinal and words the unreviewed state, not only its colour", () => {
    const { calls } = mockApi({});
    renderApp(<HitSpeaker contentId="c1" speaker={{ id: "sp2", ordinal: 2, colorIndex: 1, confirmed: false }} />);
    const speaker = screen.getByTestId("hit-speaker");
    expect(speaker.textContent).toContain("发言人 2未核对");
    // Search hits carry no photo: the letter avatar asks for nothing.
    expect(calls).toEqual([]);
  });

  it("says nothing extra for a reviewed speaker", () => {
    mockApi({});
    renderApp(<HitSpeaker contentId="c1" speaker={{ id: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, confirmed: true }} />);
    expect(screen.getByTestId("hit-speaker").textContent).not.toContain("未核对");
  });

  it("renders no group without name matches, and the mark in words", () => {
    mockApi({});
    renderApp(
      <>
        <SpeakerHitsGroup hits={[]} />
        <BasisChangedMark />
      </>,
    );
    expect(screen.queryByTestId("speaker-hits")).toBeNull();
    expect(screen.getByTestId("hit-basis-changed").textContent).toBe("人物依据已变化");
  });

  it("maps a name match to an avatar subject under the speaker's id", () => {
    expect(speakerHitSubject({ contentId: "c1", speakerId: "sp3", ordinal: 3, name: "李华", colorIndex: 2, sentences: 1 })).toEqual({ id: "sp3", ordinal: 3, colorIndex: 2, name: "李华" });
  });
});
