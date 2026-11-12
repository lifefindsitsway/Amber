import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DraftSegment } from "../../../../../../src/web/pages/content/speaker-draft.ts";
import { KeepSpeakersConfirmed, keepSpeakersConfirmedField, useKeepSpeakersConfirmed } from "../../../../../../src/web/pages/content/speakers/review/keep-speakers-confirmed.tsx";
import { revision, segment } from "../../../../../fixtures/web/content-data.ts";
import { renderApp } from "../../../../../fixtures/web/render.tsx";
import { stubFetch } from "../../../../../fixtures/web/speaker-fetch.ts";

const BASE_SEGMENTS = [
  segment("b1", 0, 0, 1_000, "一", { revisionId: "base", speakerId: "sa" }),
  segment("b2", 1, 1_000, 2_000, "二", { revisionId: "base", speakerId: "sa" }),
  segment("b3", 2, 2_000, 3_000, "三", { revisionId: "base", speakerId: "sb" }),
];

const draftOf = (speakers: Array<string | null>, review: Array<"needs_review" | undefined> = []): DraftSegment[] =>
  speakers.map((speakerId, index) => ({
    id: `d${index}`,
    startMs: index * 1_000,
    endMs: index * 1_000 + 1_000,
    text: "x",
    sourceSegmentIds: [`b${index + 1}`],
    speakerId,
    ...(review[index] === undefined ? {} : { speakerReview: review[index] }),
  }));

function stub(baseConfirmed: boolean) {
  return stubFetch({
    "GET /api/contents/c1/transcript/revisions": {
      json: { primaryTranscriptRevisionId: "base", revisions: [revision("base", baseConfirmed ? { speakersConfirmedAt: 1_700_000_000_000 } : {})] },
    },
    "GET /api/transcript/revisions/base/segments": { json: { revision: { ...revision("base"), archived: undefined }, items: BASE_SEGMENTS } },
  });
}

/** The editor's side: the draft as edited (`next` is the edit the 「edit」 button makes) and the commit body. */
function Probe(props: { segments: DraftSegment[]; next: DraftSegment[]; onCommit: (body: object) => void }) {
  const [segments, setSegments] = useState(props.segments);
  const state = useKeepSpeakersConfirmed({ contentId: "c1", baseRevisionId: "base", segments });
  return (
    <div>
      <KeepSpeakersConfirmed state={state} />
      <button onClick={() => setSegments(props.next)}>edit</button>
      <button onClick={() => props.onCommit({ draftVersion: 1, ...keepSpeakersConfirmedField(state) })}>commit</button>
    </div>
  );
}

function show(segments: DraftSegment[], next: DraftSegment[] = segments) {
  const onCommit = vi.fn();
  const result = renderApp(<Probe segments={segments} next={next} onCommit={onCommit} />);
  return { ...result, onCommit };
}

describe("KeepSpeakersConfirmed", () => {
  it("is offered, unticked, when the base is reviewed and speakers changed; ticking sends speakersConfirmed", async () => {
    stub(true);
    const { onCommit } = show(draftOf(["sa", "sb", "sb"]));
    const box = (await screen.findByTestId("keep-speakers-confirmed-input")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByLabelText("保持发言人已核对")).toBe(box);
    expect(screen.getByTestId("keep-speakers-confirmed-detail").textContent).toBe("相对底稿改了 1 句的发言人；勾选表示你已检查整份字幕稿的发言人归属");
    expect(box.getAttribute("aria-describedby")).toBe(screen.getByTestId("keep-speakers-confirmed-detail").id);
    fireEvent.click(screen.getByText("commit"));
    expect(onCommit).toHaveBeenLastCalledWith({ draftVersion: 1 });
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByText("commit"));
    expect(onCommit).toHaveBeenLastCalledWith({ draftVersion: 1, speakersConfirmed: true });
  });

  it("unticks itself when the count changes after ticking", async () => {
    stub(true);
    const { onCommit } = show(draftOf(["sa", "sb", "sb"]), draftOf(["sb", "sb", "sb"]));
    fireEvent.click(await screen.findByTestId("keep-speakers-confirmed-input"));
    fireEvent.click(screen.getByText("edit"));
    await waitFor(() => expect(screen.getByTestId("keep-speakers-confirmed-detail").textContent).toContain("改了 2 句"));
    expect((screen.getByTestId("keep-speakers-confirmed-input") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText("commit"));
    expect(onCommit).toHaveBeenLastCalledWith({ draftVersion: 1 });
  });

  it("names both counts when the sentences still to confirm make a difference", async () => {
    stub(true);
    // The suggestion matches the base: accepted it changes nothing, left unassigned it does.
    show(draftOf(["sa", "sa", "sb"], [undefined, undefined, "needs_review"]));
    expect((await screen.findByTestId("keep-speakers-confirmed-detail")).textContent).toBe("相对底稿改了 1 句的发言人（采纳建议时为 0 句）；勾选表示你已检查整份字幕稿的发言人归属");
  });

  it("is not offered when nothing changed hands, the base is not reviewed, or nobody is named", async () => {
    let calls = stub(true);
    const { onCommit, unmount } = show(draftOf(["sa", "sa", "sb"]), draftOf([null, null, null]));
    await waitFor(() => expect(calls.some((call) => call.path.startsWith("/api/transcript/revisions/base/segments"))).toBe(true));
    await act(async () => undefined);
    expect(screen.queryByTestId("keep-speakers-confirmed")).toBeNull();
    fireEvent.click(screen.getByText("edit"));
    await act(async () => undefined);
    expect(screen.queryByTestId("keep-speakers-confirmed")).toBeNull();
    fireEvent.click(screen.getByText("commit"));
    expect(onCommit).toHaveBeenLastCalledWith({ draftVersion: 1 });
    unmount();

    calls = stub(false);
    show(draftOf(["sb", "sb", "sb"]));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/contents/c1/transcript/revisions")).toBe(true));
    await act(async () => undefined);
    expect(screen.queryByTestId("keep-speakers-confirmed")).toBeNull();
    // The base's sentences are not even read for an unreviewed base.
    expect(calls.some((call) => call.path.includes("/segments"))).toBe(false);
  });
});
