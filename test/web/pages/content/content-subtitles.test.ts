import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../../src/web/api/context.tsx";
import { ContentPageProvider, type ContentPageState } from "../../../../src/web/pages/content/content-context.tsx";
import { contentKeys } from "../../../../src/web/pages/content/content-data.ts";
import { useContentSubtitles } from "../../../../src/web/pages/content/content-subtitles.ts";
import { resetSubtitleFont } from "../../../../src/web/player/subtitle-font.ts";
import { SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES } from "../../../../src/shared/defaults.ts";
import { defaultSubtitleAppearance } from "../../../../src/shared/subtitle-style.ts";
import { readTrack, resetSubtitlePrefsMemory, subtitlePrefKeys, writeAppearance, writeTrack } from "../../../../src/web/player/subtitle-prefs.ts";
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

// en's current translation was made from r2, so r1's English falls to r1's newest English one.
const TRANSLATIONS = {
  translations: [
    { artifactId: "a-en", targetLanguage: "en", current: REVISIONS.revisions[4], revisions: [REVISIONS.revisions[2], REVISIONS.revisions[4]], stale: true },
    { artifactId: "a-ja", targetLanguage: "ja", current: REVISIONS.revisions[3], revisions: [REVISIONS.revisions[3]], stale: false },
  ],
  activeTasks: [],
};

const page = (id: string, items: unknown[]) => ({ body: { revision: revision(id), items } });
const ORIGINAL = page("r1", [segment("a", 0, 0, 1_000, "一"), segment("b", 1, 1_000, 2_000, "二")]);
const TRANSLATION = page("t2", [segment("x", 0, 0, 1_000, "ichi", { revisionId: "t2", sourceSegmentIds: ["a"] })]);

function routes(overrides: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
    "GET /api/contents/c1/transcript/revisions": { body: REVISIONS },
    "GET /api/contents/c1/translations": { body: TRANSLATIONS },
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
  return { ...renderHook((props: { request: number }) => useContentSubtitles(state.content, props.request), { wrapper, initialProps: { request: 0 } }), queryClient };
}

const segmentReads = (calls: Array<{ path: string }>) => calls.filter((call) => call.path.includes("/segments")).map((call) => call.path.split("/")[4]);

beforeEach(() => {
  localStorage.clear();
  resetSubtitlePrefsMemory();
  resetSubtitleFont();
});

describe("useContentSubtitles", () => {
  it("starts off, reading nothing, with the primary original and the current translation of its newest translation's language", async () => {
    const { calls } = routes();
    const { result } = setup();
    await waitFor(() => expect(result.current?.originals).toHaveLength(2));
    const model = result.current;
    expect(model?.mode).toBe("off");
    expect(model?.status).toBe("off");
    expect(model?.originalId).toBe("r1");
    expect(model?.translations.map((item) => [item.language, item.label, item.currentId])).toEqual([
      ["en", "英语", "t1"],
      ["ja", "日语", "t2"],
    ]);
    await waitFor(() => expect(result.current?.translationId).toBe("t2"));
    expect(result.current?.translationLocked).toBe(false);
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

  it("follows remembered revisions while they exist and falls back to the primary and the default translation", async () => {
    routes({ "GET /api/transcript/revisions/r2/segments": page("r2", [segment("c", 0, 0, 500, "改")]) });
    writeTrack("u1", "c1", { version: 2, mode: "original", revisionId: "r2" });
    const { result } = setup();
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.originalId).toBe("r2");
    expect(result.current?.translations.map((item) => item.currentId)).toEqual(["t3"]);
    expect(result.current?.slices).toEqual([{ startMs: 0, endMs: 500, original: "改" }]);

    act(() => writeTrack("u1", "c1", { version: 2, mode: "original", revisionId: "gone" }));
    expect(result.current?.originalId).toBe("r1");
    expect(result.current?.translationId).toBe("t2");
  });

  it("reads a first-format translation as following its language, and writes only the current format", async () => {
    routes();
    // t3 is English made from r2; shown over r1 it follows English there, which is t1.
    localStorage.setItem(subtitlePrefKeys.track("u1", "c1"), JSON.stringify({ version: 1, mode: "original", translationRevisionId: "t3" }));
    const { result } = setup();
    await waitFor(() => expect(result.current?.translationId).toBe("t1"));
    expect(result.current?.translationLocked).toBe(false);

    act(() => result.current?.lockTranslation("t1"));
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "original", revisionId: "r1", translation: { language: "en", lockedRevisionId: "t1" } });
    expect(result.current?.translationId).toBe("t1");
    expect(result.current?.translationLocked).toBe(true);
    act(() => result.current?.followTranslation("ja"));
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "original", revisionId: "r1", translation: { language: "ja" } });
    expect(result.current?.translationId).toBe("t2");
    // A lock belongs to its original; another original keeps only the language.
    act(() => result.current?.lockTranslation("t1"));
    act(() => result.current?.setOriginal("r2"));
    expect(readTrack("u1", "c1")).toEqual({ version: 2, mode: "original", revisionId: "r2", translation: { language: "en" } });
    expect(result.current?.translationId).toBe("t3");
  });

  it("drops back to following when the locked version is archived, and lists a locked current version under its history", async () => {
    const archived = { ...REVISIONS, revisions: REVISIONS.revisions.map((item) => (item.id === "t1" ? { ...item, archived: true } : item)) };
    const extra = revision("t4", { kind: "translated", language: "ja", parentRevisionId: "r1", createdAt: 6 });
    routes({ "GET /api/contents/c1/transcript/revisions": { body: { ...archived, revisions: [...archived.revisions, extra] } } });
    writeTrack("u1", "c1", { version: 2, mode: "off", translation: { language: "en", lockedRevisionId: "t1" } });
    const { result } = setup();
    // English has no candidate left for r1, so nothing is shown in its place.
    await waitFor(() => expect(result.current?.translations.map((item) => item.language)).toEqual(["ja"]));
    expect(result.current?.translationId).toBeUndefined();

    act(() => result.current?.lockTranslation("t2"));
    expect(result.current?.translationId).toBe("t2");
    expect(result.current?.translationLocked).toBe(true);
    expect(result.current?.translations[0]?.currentId).toBe("t2");
    expect(result.current?.translations[0]?.history.map((item) => item.id)).toEqual(["t4", "t2"]);
  });

  it("picks the same default translation as the export dialogs: the current one of the newest translation's language, or the locked one", async () => {
    // The scenario the export and subtitle-video dialogs are tested with: en t1 is current although t3 is newer.
    const enCurrent = revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1", createdAt: 2 });
    const ja = revision("t2", { kind: "translated", language: "ja", parentRevisionId: "r1", createdAt: 3 });
    const enNewer = revision("t3", { kind: "translated", language: "en", parentRevisionId: "r1", createdAt: 4 });
    routes({
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), enCurrent, ja, enNewer] } },
      "GET /api/contents/c1/translations": {
        body: {
          translations: [
            { artifactId: "a-en", targetLanguage: "en", current: enCurrent, revisions: [enCurrent, enNewer], stale: false },
            { artifactId: "a-ja", targetLanguage: "ja", current: ja, revisions: [ja], stale: false },
          ],
          activeTasks: [],
        },
      },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current?.translationId).toBe("t1"));
    expect(result.current?.translations.map((item) => [item.language, item.currentId, item.history.map((option) => option.id)])).toEqual([
      ["en", "t1", ["t3"]],
      ["ja", "t2", []],
    ]);
    act(() => writeTrack("u1", "c1", { version: 2, mode: "off", translation: { language: "en", lockedRevisionId: "t3" } }));
    expect(result.current?.translationId).toBe("t3");
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
    act(() => writeTrack("u1", "c1", { version: 2, mode: "off", revisionId: "m0" }));
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
    writeTrack("u1", "c1", { version: 2, mode: "original" });
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
    writeTrack("u1", "c1", { version: 2, mode: "translation" });
    const openTab = vi.fn();
    const { result } = setup(openTab);
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.mode).toBe("original");
    expect(result.current?.translations).toEqual([]);
    result.current?.goTranslate();
    expect(openTab).toHaveBeenCalledWith("translation");
  });

  it("keeps each cue a unit with its speaker's cut label when the appearance shows speakers, and slices as before without", async () => {
    const long = "很".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES + 2);
    const { calls } = routes({
      "GET /api/transcript/revisions/r1/segments": page("r1", [segment("a", 0, 0, 1_000, "一", { speakerId: "s1" }), segment("b", 1, 1_000, 2_000, "二", { speakerId: "s2" })]),
      "GET /api/contents/c1/speakers": {
        body: {
          items: [
            { id: "s1", ordinal: 1, name: long, colorIndex: 0, used: true },
            { id: "s2", ordinal: 2, colorIndex: 1, used: true },
          ],
        },
      },
    });
    writeTrack("u1", "c1", { version: 2, mode: "bilingual", revisionId: "r1", translation: { language: "ja" } });
    writeAppearance("u1", { ...defaultSubtitleAppearance(), speaker: "change" });
    const { result } = setup();
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.slices).toEqual([]);
    expect(result.current?.units).toEqual([
      { startMs: 0, endMs: 1_000, units: [{ cue: 0, original: "一", translation: "ichi", label: `${"很".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES)}…`, speakerLabel: `${"很".repeat(SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES)}…` }] },
      { startMs: 1_000, endMs: 2_000, units: [{ cue: 1, original: "二", label: "发言人 2", speakerLabel: "发言人 2" }] },
    ]);
    expect(calls.filter((call) => call.path.endsWith("/speakers"))).toHaveLength(1);

    act(() => writeAppearance("u1", defaultSubtitleAppearance()));
    await waitFor(() => expect(result.current?.units).toBeUndefined());
    expect(result.current?.slices).toEqual([
      { startMs: 0, endMs: 1_000, original: "一", translation: "ichi" },
      { startMs: 1_000, endMs: 2_000, original: "二" },
    ]);
  });

  it("keeps the same units when the speakers are read again with the same labels", async () => {
    let reads = 0;
    const { calls } = routes({
      "GET /api/transcript/revisions/r1/segments": page("r1", [segment("a", 0, 0, 1_000, "一", { speakerId: "s1" }), segment("b", 1, 1_000, 2_000, "二", { speakerId: "s1" })]),
      "GET /api/contents/c1/speakers": () => {
        reads += 1;
        // A new avatar changes the speaker, not the label subtitles show.
        return { body: { items: [{ id: "s1", ordinal: 1, name: "张三", colorIndex: 0, used: true, ...(reads > 1 ? { avatarVersion: reads } : {}) }] } };
      },
    });
    writeTrack("u1", "c1", { version: 2, mode: "original", revisionId: "r1" });
    writeAppearance("u1", { ...defaultSubtitleAppearance(), speaker: "change" });
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    const units = result.current?.units;
    expect(units?.[0]?.units[0]?.speakerLabel).toBe("张三");
    await act(() => queryClient.invalidateQueries({ queryKey: contentKeys.speakers("c1") }));
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/speakers"))).toHaveLength(2));
    expect(result.current?.units).toBe(units);
  });

  it("reads no speakers while the appearance shows none", async () => {
    const { calls } = routes();
    writeTrack("u1", "c1", { version: 2, mode: "original", revisionId: "r1" });
    const { result } = setup();
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.units).toBeUndefined();
    expect(calls.some((call) => call.path.endsWith("/speakers"))).toBe(false);
  });
});
