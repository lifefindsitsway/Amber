import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { useContentEvents } from "../../../../../src/web/api/context.tsx";
import type { ContentEvent } from "../../../../../src/web/api/content-events.ts";
import { SPEAKER_NAME_MAX_GRAPHEMES } from "../../../../../src/shared/defaults.ts";
import { normalizeSpeakerName } from "../../../../../src/shared/speakers.ts";
import {
  speakerLabel,
  speakerNameLength,
  useCreateSpeaker,
  usePatchSpeaker,
  useSetSpeakersConfirmed,
  useSpeakerReview,
  useSpeakers,
  useSpeakerSuggestions,
} from "../../../../../src/web/pages/content/speakers/speaker-data.ts";
import { renderApp } from "../../../../fixtures/web/render.tsx";
import { stubFetch } from "../../../../fixtures/web/speaker-fetch.ts";

const ONE = { id: "s1", ordinal: 1, name: "陈明", colorIndex: 0, used: true };
const TWO = { id: "s2", ordinal: 2, colorIndex: 1, used: true };

function Probe(props: { onEvent?: (event: ContentEvent) => void; query?: string }) {
  const speakers = useSpeakers("c1");
  const create = useCreateSpeaker("c1");
  const patch = usePatchSpeaker("c1");
  const suggestions = useSpeakerSuggestions(props.query ?? "", "c1");
  const events = useContentEvents();
  useEffect(() => events.subscribe((event) => props.onEvent?.(event)), [events, props]);
  return (
    <div>
      <p data-testid="names">{(speakers.data?.items ?? []).map((item) => item.name ?? `#${item.ordinal}`).join(",")}</p>
      <p data-testid="suggestions">{(suggestions.data?.items ?? []).map((item) => item.name).join(",")}</p>
      <button onClick={() => create.mutate({ colorIndex: 4 })}>create</button>
      <button onClick={() => patch.mutate({ speakerId: "s1", patch: { name: "新" } })}>patch</button>
    </div>
  );
}

describe("speaker data hooks", () => {
  it("reads the Content's speakers and the suggestions for a typed name", async () => {
    const calls = stubFetch({
      "GET /api/contents/c1/speakers": { json: { items: [ONE, TWO] } },
      "GET /api/speakers/suggestions": { json: { items: [{ contentId: "c2", speakerId: "z", name: "李雪", colorIndex: 2 }] } },
    });
    renderApp(<Probe query="李" />);
    await waitFor(() => expect(screen.getByTestId("names").textContent).toBe("陈明,#2"));
    await waitFor(() => expect(screen.getByTestId("suggestions").textContent).toBe("李雪"));
    expect(calls.map((call) => call.path)).toContain("/api/speakers/suggestions?q=%E6%9D%8E&contentId=c1");
  });

  it("leaves the query out of the suggestions request when nothing is typed, and still names the Content", async () => {
    const calls = stubFetch({
      "GET /api/contents/c1/speakers": { json: { items: [] } },
      "GET /api/speakers/suggestions": { json: { items: [] } },
    });
    renderApp(<Probe />);
    await waitFor(() => expect(calls.some((call) => call.path === "/api/speakers/suggestions?contentId=c1")).toBe(true));
  });

  it("creates a speaker and tells this and the other windows", async () => {
    const calls = stubFetch({
      "GET /api/contents/c1/speakers": { json: { items: [ONE] } },
      "GET /api/speakers/suggestions": { json: { items: [] } },
      "POST /api/contents/c1/speakers": { status: 201, json: TWO },
    });
    const onEvent = vi.fn();
    renderApp(<Probe onEvent={onEvent} />);
    await waitFor(() => expect(screen.getByTestId("names").textContent).toBe("陈明"));
    fireEvent.click(screen.getByText("create"));
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: "speakersChanged", contentId: "c1" }));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ colorIndex: 4 });
    // The list is read again.
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1/speakers" && call.method === "GET").length).toBeGreaterThanOrEqual(2));
  });

  it("patches a speaker, tells the other windows and refreshes the suggestions", async () => {
    const calls = stubFetch({
      "GET /api/contents/c1/speakers": { json: { items: [ONE] } },
      "GET /api/speakers/suggestions": { json: { items: [] } },
      "PATCH /api/contents/c1/speakers/s1": { json: { ...ONE, name: "新" } },
    });
    const onEvent = vi.fn();
    renderApp(<Probe onEvent={onEvent} />);
    await waitFor(() => expect(screen.getByTestId("names").textContent).toBe("陈明"));
    fireEvent.click(screen.getByText("patch"));
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: "speakersChanged", contentId: "c1" }));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ name: "新" });
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith("/api/speakers/suggestions")).length).toBeGreaterThanOrEqual(2));
    await act(async () => undefined);
  });

  it("does not tell anyone when the change was refused", async () => {
    stubFetch({
      "GET /api/contents/c1/speakers": { json: { items: [ONE] } },
      "GET /api/speakers/suggestions": { json: { items: [] } },
      "PATCH /api/contents/c1/speakers/s1": { status: 400, json: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "" } } },
    });
    const onEvent = vi.fn();
    renderApp(<Probe onEvent={onEvent} />);
    await waitFor(() => expect(screen.getByTestId("names").textContent).toBe("陈明"));
    fireEvent.click(screen.getByText("patch"));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("speakerLabel", () => {
  const t = ((key: string, options?: { ordinal?: number }) => `${key}#${options?.ordinal}`) as unknown as TFunction;

  it("is the name, else 「发言人 N」 by ordinal", () => {
    expect(speakerLabel(t, { name: "陈明", ordinal: 1 })).toBe("陈明");
    expect(speakerLabel(t, { ordinal: 3 })).toBe("speakerIdentity.unnamed#3");
  });
});

describe("speakerNameLength", () => {
  it("counts what the stored name will count, so the counter agrees with the limit", () => {
    const samples = [
      "",
      "   ",
      "陈明",
      "  陈   明  ",
      "a\u202Eb\u200Fc",
      "line\nbreak\tname",
      "👩‍🔬 Lin",
      "字".repeat(SPEAKER_NAME_MAX_GRAPHEMES),
      "字".repeat(SPEAKER_NAME_MAX_GRAPHEMES + 1),
      `${"字".repeat(SPEAKER_NAME_MAX_GRAPHEMES)}\u202E `,
      `${"字".repeat(SPEAKER_NAME_MAX_GRAPHEMES - 1)}  \n字`,
    ];
    for (const sample of samples) {
      const stored = normalizeSpeakerName(sample);
      const length = speakerNameLength(sample);
      expect(stored === "too_long", JSON.stringify(sample)).toBe(length > SPEAKER_NAME_MAX_GRAPHEMES);
      if (stored === undefined) expect(length).toBe(0);
      if (typeof stored === "string" && stored !== "too_long") expect(length).toBe([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(stored)].length);
    }
  });
});

describe("speaker review hooks", () => {
  const REVIEW = { revisionId: "r1", rosterDigest: "abc", speakers: [{ id: "s1", sentences: 3, assignedMs: 4000 }], unassigned: 1, pendingNames: 1 };

  function ReviewProbe(props: { onEvent: (event: ContentEvent) => void }) {
    const review = useSpeakerReview("c1", "r1");
    const confirm = useSetSpeakersConfirmed("c1");
    const events = useContentEvents();
    useEffect(() => events.subscribe((event) => props.onEvent(event)), [events, props]);
    return (
      <div>
        <p data-testid="pending">{review.data?.pendingNames ?? "-"}</p>
        <button onClick={() => confirm.mutate({ revisionId: "r1", request: { confirmed: true, expectedRosterDigest: review.data?.rosterDigest as string } })}>confirm</button>
      </div>
    );
  }

  it("reads a revision's review, confirms it with the digest it read and tells the other windows", async () => {
    let stored: typeof REVIEW & { confirmedAt?: number } = REVIEW;
    const calls = stubFetch({
      "GET /api/transcript/revisions/r1/speaker-review": () => ({ json: stored }),
      "PUT /api/transcript/revisions/r1/speakers-confirmed": () => {
        stored = { ...REVIEW, confirmedAt: 5, pendingNames: 0, rosterDigest: "def" };
        return { json: stored };
      },
      "GET /api/contents/c1/speakers": { json: { items: [ONE] } },
    });
    const onEvent = vi.fn();
    renderApp(<ReviewProbe onEvent={onEvent} />);
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("1"));
    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: "speakerReviewChanged", contentId: "c1" }));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ confirmed: true, expectedRosterDigest: "abc" });
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("0"));
  });
});
