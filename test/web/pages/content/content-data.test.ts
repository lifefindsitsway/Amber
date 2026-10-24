import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PARAGRAPH_GAP_MS, PARAGRAPH_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import { ApiClient } from "../../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../../src/web/api/context.tsx";
import {
  contentKeys,
  currentManualId,
  newerAsrRevision,
  paragraphsOf,
  readableRevisions,
  readerRows,
  revisionGroups,
  rootOf,
  rootsOf,
  segmentAt,
  useContentTaskRefresh,
  useLatestRedos,
  useSegments,
  useUnfinishedCacheTask,
  visibleRevisions,
} from "../../../../src/web/pages/content/content-data.ts";
import { revision, segment } from "../../../fixtures/web/content-data.ts";
import { mockApi } from "../../../fixtures/web/render.tsx";
import { task } from "../../../fixtures/web/shell-data.ts";

describe("paragraphsOf", () => {
  it("breaks on a gap above PARAGRAPH_GAP_MS or a speaker change", () => {
    const segments = [
      segment("a", 0, 0, 1_000, "一。"),
      segment("b", 1, 1_000 + PARAGRAPH_GAP_MS, 4_000 + PARAGRAPH_GAP_MS, "二。"),
      segment("c", 2, 5_000 + 2 * PARAGRAPH_GAP_MS, 6_000 + 2 * PARAGRAPH_GAP_MS, "三。"),
      segment("d", 3, 6_000 + 2 * PARAGRAPH_GAP_MS, 7_000 + 2 * PARAGRAPH_GAP_MS, "四。", { speakerId: "B" }),
    ];
    expect(paragraphsOf(segments).map((paragraph) => paragraph.segments.map((item) => item.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(paragraphsOf(segments)[1]?.startMs).toBe(5_000 + 2 * PARAGRAPH_GAP_MS);
  });

  it("ends a paragraph at the next sentence mark once it reaches PARAGRAPH_MAX_CHARS, never inside a sentence", () => {
    const sentence = `${"讲".repeat(PARAGRAPH_MAX_CHARS / 4 - 1)}。`;
    const segments = ["a", "b", "c", "d", "e"].map((id, index) => segment(id, index, index * 1_000, (index + 1) * 1_000, sentence));
    expect(paragraphsOf(segments).map((paragraph) => paragraph.segments.map((item) => item.id))).toEqual([["a", "b", "c", "d"], ["e"]]);
    const unpunctuated = ["a", "b", "c", "d", "e"].map((id, index) => segment(id, index, index * 1_000, (index + 1) * 1_000, "讲".repeat(PARAGRAPH_MAX_CHARS / 4)));
    expect(paragraphsOf(unpunctuated)).toHaveLength(1);
  });

  it("finds the playing sentence and hides translations from reading", () => {
    const segments = [segment("a", 0, 0, 1_000, "一"), segment("b", 1, 1_000, 2_000, "二")];
    expect(segmentAt(segments, 1_500)?.id).toBe("b");
    expect(segmentAt(segments, undefined)).toBeUndefined();
    expect(readableRevisions([revision("r1"), revision("t1", { kind: "translated" })]).map((item) => item.id)).toEqual(["r1"]);
  });
});

describe("readerRows", () => {
  const marked = (id: string, ordinal: number, text: string, paragraphStart: boolean) =>
    segment(id, ordinal, ordinal * 1_000, ordinal * 1_000 + 900, text, { paragraphStart });

  it("is exactly paragraphsOf without chapters", () => {
    const segments = [segment("a", 0, 0, 1_000, "一。"), segment("b", 1, 1_000 + PARAGRAPH_GAP_MS, 2_000 + PARAGRAPH_GAP_MS, "二。")];
    expect(readerRows(segments, [])).toEqual(paragraphsOf(segments).map((paragraph) => ({ kind: "paragraph", paragraph })));
    expect(readerRows([], [{ startMs: 0, title: "空" }])).toEqual([]);
  });

  it("puts a heading before each chapter's paragraphs, by time, and leaves the sentences before the first chapter unheaded", () => {
    const segments = [segment("a", 0, 0, 1_000, "一。"), segment("b", 1, 1_000, 2_000, "二。"), segment("c", 2, 75_000, 76_000, "三。"), segment("d", 3, 76_000, 77_000, "四。")];
    const rows = readerRows(segments, [{ startMs: 60_000, title: "正文" }]);
    expect(rows.map((row) => (row.kind === "chapter" ? row.title : row.paragraph.segments.map((item) => item.id)))).toEqual([["a", "b"], "正文", ["c", "d"]]);
    expect(rows[1]).toEqual({ kind: "chapter", startMs: 60_000, title: "正文" });
  });

  it("breaks a paragraph at a chapter start even when the marks run on", () => {
    const segments = [marked("a", 0, "一。", true), marked("b", 1, "二。", false), marked("c", 2, "三。", false)];
    const rows = readerRows(segments, [{ startMs: 0, title: "开场" }, { startMs: 1_000, title: "正文" }]);
    expect(rows.map((row) => (row.kind === "chapter" ? row.title : row.paragraph.segments.map((item) => item.id)))).toEqual(["开场", ["a"], "正文", ["b", "c"]]);
  });

  it("paragraphs marked revisions by their marks alone: no length cap, a mark starts a paragraph", () => {
    const long = "讲".repeat(PARAGRAPH_MAX_CHARS * 3 / 5) + "。";
    const segments = [marked("a", 0, long, true), ...["b", "c", "d", "e"].map((id, i) => marked(id, i + 1, long, false)), marked("f", 5, "新段。", true)];
    const rows = readerRows(segments, []);
    expect(rows.map((row) => (row.kind === "chapter" ? row.title : row.paragraph.segments.map((item) => item.id)))).toEqual([["a", "b", "c", "d", "e"], ["f"]]);
    expect(long.length * 5).toBeGreaterThan(PARAGRAPH_MAX_CHARS * 2);
  });
});

describe("rootOf / rootsOf", () => {
  it("follows parents to the lineage root and lists every independent root", () => {
    const revisions = [
      revision("asr", { kind: "asr" }),
      revision("imp", { kind: "imported" }),
      revision("cor", { kind: "corrected", parentRevisionId: "asr" }),
      revision("man", { kind: "manual", parentRevisionId: "cor" }),
      revision("tr", { kind: "translated", parentRevisionId: "man" }),
    ];
    expect(rootOf(revisions[3] as (typeof revisions)[number], revisions).id).toBe("asr");
    expect(rootOf(revisions[1] as (typeof revisions)[number], revisions).id).toBe("imp");
    expect(rootsOf(revisions).map((item) => item.id)).toEqual(["asr", "imp"]);
  });
});

describe("useContentTaskRefresh", () => {
  it("re-reads the content, its highlights, translations, revisions and chat context when one of its Tasks changes", async () => {
    let push: (text: string) => void = () => undefined;
    vi.stubGlobal("fetch", async (input: string) => {
      if (String(input).endsWith("/api/tasks/events")) {
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => void (push = (text) => controller.enqueue(new TextEncoder().encode(text))) }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const client = new ApiClient({ baseUrl: "" }, "local");
    const queryClient = createQueryClient();
    for (const key of [["content", "c1"], contentKeys.highlights("c1"), contentKeys.translations("c1"), contentKeys.revisions("c1"), ["chat", "c1", "p1", "m1"], ["chat", "other", "p1", "m1"]]) {
      queryClient.setQueryData(key, {});
    }
    const wrapper = (props: { children: ReactNode }) => createElement(ApiProvider, { client, queryClient, children: props.children });
    renderHook(() => useContentTaskRefresh("c1"), { wrapper });
    const task = { id: "t1", kind: "process_content", statusProjection: "running", contentId: "c1", createdAt: 1 };
    await vi.waitFor(() => {
      push(`event: task.updated\ndata: ${JSON.stringify({ task })}\nid: 1\n\n`);
      expect(queryClient.getQueryState(["chat", "c1", "p1", "m1"])?.isInvalidated).toBe(true);
    });
    expect(queryClient.getQueryState(["content", "c1"])?.isInvalidated).toBe(true);
    for (const key of [contentKeys.highlights("c1"), contentKeys.translations("c1"), contentKeys.revisions("c1")]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(["chat", "other", "p1", "m1"])?.isInvalidated).toBe(false);
  });
});

describe("useUnfinishedCacheTask", () => {
  function wrapper(props: { children: ReactNode }) {
    return createElement(ApiProvider, { client: new ApiClient({ baseUrl: "" }, "local"), queryClient: createQueryClient(), children: props.children });
  }

  it("asks for the Content's one unfinished cache_media Task", async () => {
    const caching = task("t5", { kind: "cache_media", contentId: "c1" });
    const { calls } = mockApi({ "GET /api/tasks": { body: { items: [caching], eventSeq: 0 } } });
    const { result } = renderHook(() => useUnfinishedCacheTask("c1", true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(caching));
    expect(calls.map((call) => call.path)).toEqual(["/api/tasks?contentId=c1&kind=cache_media&unfinished=1&limit=1"]);
  });

  it("reads as null when there is none, and asks nothing while disabled", async () => {
    const { calls } = mockApi({ "GET /api/tasks": { body: { items: [], eventSeq: 0 } } });
    const none = renderHook(() => useUnfinishedCacheTask("c1", true), { wrapper });
    await waitFor(() => expect(none.result.current.data).toBeNull());
    calls.length = 0;
    const disabled = renderHook(() => useUnfinishedCacheTask("c2", false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disabled.result.current.data).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("useLatestRedos", () => {
  it("asks for the latest Task of each requested redo kind, under the Content's keys", async () => {
    const proofreading = task("r1", { kind: "reproofread", contentId: "c1" });
    const { calls } = mockApi({
      "GET /api/tasks": (call) => ({ body: { items: call.path.includes("kind=reproofread") ? [proofreading] : [], eventSeq: 0 } }),
    });
    const client = new ApiClient({ baseUrl: "" }, "local");
    const queryClient = createQueryClient();
    const wrapper = (props: { children: ReactNode }) => createElement(ApiProvider, { client, queryClient, children: props.children });
    const { result } = renderHook(() => useLatestRedos("c1", ["asr", "proofread", "chapter"]), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ proofread: "r1" }));
    expect(calls.map((call) => call.path).sort()).toEqual([
      "/api/tasks?contentId=c1&kind=regenerate_chapters&limit=1",
      "/api/tasks?contentId=c1&kind=reproofread&limit=1",
      "/api/tasks?contentId=c1&kind=retranscribe&limit=1",
    ]);
    // A Task event on the Content invalidates this prefix (useContentTaskRefresh), so a new redo is read.
    expect(contentKeys.latestRedos("c1", ["proofread"]).slice(0, 2)).toEqual(["content", "c1"]);
  });
});

describe("useSegments", () => {
  it("passes the query's signal to every page, so switching revisions abandons the old read", async () => {
    const signals: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      signals.push({ url, signal: init.signal ?? undefined });
      if (url.includes("/revisions/r1/")) {
        const page = url.includes("cursor=") ? { revision: revision("r1"), items: [segment("b", 1, 1_000, 2_000, "二")] } : { revision: revision("r1"), items: [segment("a", 0, 0, 1_000, "一")], nextCursor: "n1" };
        return Promise.resolve(new Response(JSON.stringify(page)));
      }
      // The second revision never answers: only an abort ends its read.
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const wrapper = (props: { children: ReactNode }) =>
      createElement(ApiProvider, { client: new ApiClient({ baseUrl: "" }, "local"), queryClient: createQueryClient(), children: props.children });
    const { result, rerender } = renderHook((props: { id: string }) => useSegments(props.id), { wrapper, initialProps: { id: "r1" } });
    await waitFor(() => expect(result.current.data?.map((item) => item.id)).toEqual(["a", "b"]));
    expect(signals).toHaveLength(2);
    for (const call of signals) expect(call.signal).toBeInstanceOf(AbortSignal);

    rerender({ id: "r2" });
    await waitFor(() => expect(signals).toHaveLength(3));
    rerender({ id: "r3" });
    await waitFor(() => expect(signals[2]?.signal?.aborted).toBe(true));
  });
});

describe("version picker rules", () => {
  // asr ← corrected ← m1 ← m2 ; asr ← m0 ; corrected ← en
  const asr = revision("asr", { kind: "asr", createdAt: 1 });
  const corrected = revision("corrected", { kind: "corrected", parentRevisionId: "asr", createdAt: 2 });
  const m0 = revision("m0", { kind: "manual", parentRevisionId: "asr", createdAt: 3 });
  const m1 = revision("m1", { kind: "manual", parentRevisionId: "corrected", createdAt: 4 });
  const m2 = revision("m2", { kind: "manual", parentRevisionId: "m1", createdAt: 5 });
  const en = revision("en", { kind: "translated", parentRevisionId: "corrected", createdAt: 6 });
  const all = [asr, corrected, m0, m1, m2, en];
  const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id);

  it("shows one manual revision: the primary when manual, else its nearest manual ancestor", () => {
    expect(currentManualId(all, "m2")).toBe("m2");
    expect(currentManualId(all, "m1")).toBe("m1");
    expect(currentManualId([...all, revision("c2", { kind: "corrected", parentRevisionId: "m2" })], "c2")).toBe("m2");
    expect(currentManualId(all, "corrected")).toBeUndefined();
    expect(ids(visibleRevisions(all, "m2"))).toEqual(["asr", "corrected", "m2", "en"]);
    expect(ids(visibleRevisions(all, "corrected"))).toEqual(["asr", "corrected", "en"]);
  });

  it("puts the other manual revisions behind the history toggle and archived ones behind theirs", () => {
    const archived = all.map((item) => (item.id === "asr" ? { ...item, archived: true } : item));
    expect(revisionGroups(archived, "m2")).toEqual({ history: new Set(["m0", "m1"]), archived: new Set(["asr"]) });
    expect(ids(visibleRevisions(archived, "m2"))).toEqual(["corrected", "m2", "en"]);
    expect(ids(visibleRevisions(archived, "m2", { showHistory: true }))).toEqual(["corrected", "m0", "m1", "m2", "en"]);
    expect(ids(visibleRevisions(archived, "m2", { showArchived: true }))).toEqual(["asr", "corrected", "m2", "en"]);
    expect(ids(visibleRevisions(archived, "m2", { include: ["m0", undefined] }))).toEqual(["corrected", "m0", "m2", "en"]);
  });

  it("finds an ASR original newer than a primary the user chose", () => {
    const later = revision("asr2", { kind: "asr", createdAt: 10 });
    expect(newerAsrRevision([...all, later], "m2")?.id).toBe("asr2");
    expect(newerAsrRevision([...all, later], "corrected")?.id).toBe("asr2");
    expect(newerAsrRevision([...all, revision("imp", { kind: "imported", createdAt: 11 }), later], "imp")).toBeUndefined();
    expect(newerAsrRevision([...all, { ...later, archived: true }], "m2")).toBeUndefined();
    // A root working copy as primary is replaced by the pipeline itself; nothing to suggest.
    expect(newerAsrRevision([...all, later], "asr")).toBeUndefined();
    expect(newerAsrRevision(all, "m2")).toBeUndefined();
  });

  it("finds an ASR original newer than an imported primary, but not a newer ASR working copy", () => {
    const imported = revision("imp", { kind: "imported", createdAt: 7 });
    const later = revision("asr2", { kind: "asr", createdAt: 10 });
    expect(newerAsrRevision([...all, imported, later], "imp")?.id).toBe("asr2");
    // Only a root counts: an ASR revision derived from another one is not a fresh original.
    expect(newerAsrRevision([...all, imported, revision("asr3", { kind: "asr", parentRevisionId: "asr", createdAt: 10 })], "imp")).toBeUndefined();
    expect(newerAsrRevision([...all, imported, { ...later, archived: true }], "imp")).toBeUndefined();
  });

  it("lists no manual revision and nothing behind the history toggle when the Content has none", () => {
    // platform ← corrected (primary) ; imported ; corrected ← en
    const platform = revision("p0", { kind: "platform", createdAt: 1 });
    const fixed = revision("c1", { kind: "corrected", parentRevisionId: "p0", createdAt: 2 });
    const imported = revision("imp", { kind: "imported", createdAt: 3 });
    const english = revision("en", { kind: "translated", parentRevisionId: "c1", createdAt: 4 });
    const none = [platform, fixed, imported, english];
    expect(currentManualId(none, "c1")).toBeUndefined();
    expect(revisionGroups(none, "c1")).toEqual({ history: new Set(), archived: new Set() });
    expect(ids(visibleRevisions(none, "c1"))).toEqual(["p0", "c1", "imp", "en"]);
    expect(ids(visibleRevisions(none, "c1", { showHistory: true }))).toEqual(["p0", "c1", "imp", "en"]);
    expect(ids(visibleRevisions(none, "imp"))).toEqual(["p0", "c1", "imp", "en"]);
  });
});
