import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../../src/web/api/context.tsx";
import { ContentPageProvider, type ContentPageState } from "../../../../src/web/pages/content/content-context.tsx";
import { useContentSubtitles } from "../../../../src/web/pages/content/content-subtitles.ts";
import { resetSubtitleFont } from "../../../../src/web/player/subtitle-font.ts";
import { readTrack, resetSubtitlePrefsMemory, writeTrack } from "../../../../src/web/player/subtitle-prefs.ts";
import { contentDetail, revision, segment } from "../../../fixtures/web/content-data.ts";
import { mockApi } from "../../../fixtures/web/render.tsx";

const REVISIONS = {
  primaryTranscriptRevisionId: "r1",
  revisions: [
    revision("r1"),
    revision("r2", { kind: "corrected", parentRevisionId: "r1", createdAt: 2 }),
    revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1", createdAt: 3 }),
    revision("t2", { kind: "translated", language: "ja", parentRevisionId: "r1", createdAt: 5 }),
    revision("t3", { kind: "translated", language: "en", parentRevisionId: "r2", createdAt: 4 }),
  ],
};

const page = (id: string, items: unknown[]) => ({ body: { revision: revision(id), items } });
const ORIGINAL = page("r1", [segment("a", 0, 0, 1_000, "一"), segment("b", 1, 1_000, 2_000, "二")]);
const TRANSLATION = page("t2", [segment("x", 0, 0, 1_000, "ichi", { revisionId: "t2", sourceSegmentIds: ["a"] })]);

function routes(overrides: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
    "GET /api/contents/c1/transcript/revisions": { body: REVISIONS },
    "GET /api/transcript/revisions/r1/segments": ORIGINAL,
    "GET /api/transcript/revisions/t2/segments": TRANSLATION,
    ...(overrides as Record<string, never>),
  });
}

function setup(openTab = vi.fn()) {
  const state: ContentPageState = {
    content: contentDetail(),
    primaryRevisionId: "r1",
    selection: undefined,
    select: () => undefined,
    openTab,
    highlightThreshold: 0,
    setHighlightThreshold: () => undefined,
    openSubtitleEditor: () => undefined,
  };
  const client = new ApiClient({ baseUrl: "" }, "local");
  const queryClient = createQueryClient();
  const wrapper = (props: { children: ReactNode }) =>
    createElement(ApiProvider, { client, queryClient, children: createElement(ContentPageProvider, { value: state, children: props.children }) });
  return renderHook((props: { request: number }) => useContentSubtitles(state.content, props.request), { wrapper, initialProps: { request: 0 } });
}

const segmentReads = (calls: Array<{ path: string }>) => calls.filter((call) => call.path.includes("/segments")).map((call) => call.path.split("/")[4]);

beforeEach(() => {
  localStorage.clear();
  resetSubtitlePrefsMemory();
  resetSubtitleFont();
});

describe("useContentSubtitles", () => {
  it("starts off, reading nothing, with the primary original and its newest translation picked", async () => {
    const { calls } = routes();
    const { result } = setup();
    await waitFor(() => expect(result.current?.originals).toHaveLength(2));
    const model = result.current;
    expect(model?.mode).toBe("off");
    expect(model?.status).toBe("off");
    expect(model?.originalId).toBe("r1");
    expect(model?.translations.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(model?.translationId).toBe("t2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(segmentReads(calls)).toEqual([]);
    expect(calls.some((call) => call.path.includes("/fonts/"))).toBe(false);
  });

  it("opens the editor on a request, turning on both lines when a translation exists, and pairs them", async () => {
    const { calls } = routes();
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current?.originals).toHaveLength(2));
    rerender({ request: 1 });
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.mode).toBe("bilingual");
    expect(result.current?.editing).toBe(true);
    expect(readTrack("u1", "c1").mode).toBe("bilingual");
    expect(result.current?.slices).toEqual([
      { startMs: 0, endMs: 1_000, original: "一", translation: "ichi" },
      { startMs: 1_000, endMs: 2_000, original: "二" },
    ]);
    expect(segmentReads(calls).sort()).toEqual(["r1", "t2"]);
    act(() => result.current?.setMode("off"));
    expect(result.current?.editing).toBe(false);
    // A request is acted on once: re-rendering with the same one changes nothing.
    rerender({ request: 1 });
    expect(result.current?.mode).toBe("off");
  });

  it("follows remembered revisions while they exist and falls back to the primary and its newest translation", async () => {
    routes({ "GET /api/transcript/revisions/r2/segments": page("r2", [segment("c", 0, 0, 500, "改")]) });
    writeTrack("u1", "c1", { version: 1, mode: "original", revisionId: "r2" });
    const { result } = setup();
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.originalId).toBe("r2");
    expect(result.current?.translations.map((item) => item.id)).toEqual(["t3"]);
    expect(result.current?.slices).toEqual([{ startMs: 0, endMs: 500, original: "改" }]);

    act(() => writeTrack("u1", "c1", { version: 1, mode: "original", revisionId: "gone", translationRevisionId: "t3" }));
    expect(result.current?.originalId).toBe("r1");
    expect(result.current?.translationId).toBe("t2");
    act(() => result.current?.setTranslation("t1"));
    expect(readTrack("u1", "c1")).toEqual({ version: 1, mode: "original", revisionId: "r1", translationRevisionId: "t1" });
    expect(result.current?.translationId).toBe("t1");
    act(() => result.current?.setOriginal("r2"));
    expect(readTrack("u1", "c1")).toEqual({ version: 1, mode: "original", revisionId: "r2" });
  });

  it("offers one manual original: the one the corrected primary descends from, unless another is the one shown", async () => {
    // r0 (asr) ← m1 ← r1 (corrected, primary) ; r0 ← m0, an earlier edit off the primary's line
    routes({
      "GET /api/contents/c1/transcript/revisions": {
        body: {
          primaryTranscriptRevisionId: "r1",
          revisions: [
            revision("r0", { kind: "asr", createdAt: 1 }),
            revision("m0", { kind: "manual", parentRevisionId: "r0", createdAt: 2 }),
            revision("m1", { kind: "manual", parentRevisionId: "r0", createdAt: 3 }),
            revision("r1", { kind: "corrected", parentRevisionId: "m1", createdAt: 4 }),
          ],
        },
      },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current?.originals.map((item) => item.id)).toEqual(["r0", "m1", "r1"]));
    expect(result.current?.originalId).toBe("r1");
    // A remembered earlier edit stays listed so the picker keeps showing its own value.
    act(() => writeTrack("u1", "c1", { version: 1, mode: "off", revisionId: "m0" }));
    expect(result.current?.originals.map((item) => item.id)).toEqual(["r0", "m0", "m1", "r1"]);
  });

  it("says loading, then a retryable failure, then empty", async () => {
    let failures = 1;
    routes({
      "GET /api/transcript/revisions/r1/segments": () => (failures-- > 0 ? { status: 500, body: {} } : { body: { revision: revision("r1"), items: [] } }),
    });
    // Sentences answer only once released, so the read is seen in flight.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (url.includes("/segments") ? gate.then(() => answer(url, init)) : answer(url, init)));
    writeTrack("u1", "c1", { version: 1, mode: "original" });
    const { result } = setup();
    await waitFor(() => expect(result.current?.originalId).toBe("r1"));
    expect(result.current?.status).toBe("loading");
    release();
    await waitFor(() => expect(result.current?.status).toBe("error"));
    act(() => result.current?.retry());
    await waitFor(() => expect(result.current?.status).toBe("empty"));
  });

  it("shows the original when a translation is wanted but the original has none, and offers to translate", async () => {
    routes({
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1")] } },
    });
    writeTrack("u1", "c1", { version: 1, mode: "translation" });
    const openTab = vi.fn();
    const { result } = setup(openTab);
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.mode).toBe("original");
    expect(result.current?.translations).toEqual([]);
    result.current?.goTranslate();
    expect(openTab).toHaveBeenCalledWith("translation");
  });
});
