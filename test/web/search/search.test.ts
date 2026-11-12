import { describe, expect, it } from "vitest";
import type { SearchResultDto } from "../../../src/shared/dto/search.ts";
import { hitLink, hitsByContent, normalizeQuery, normalizeRanges, speakerHitLink, summaryBasisChanged, termRanges } from "../../../src/web/search/search.ts";

const SEGMENT = "01JABCDEFGHJKMNPQRSTVWXYZ3";

const result: SearchResultDto = {
  contents: [{ contentId: "c2", title: "检索第二讲", matchedIn: "title", snippet: "检索第二讲", ranges: [{ start: 0, end: 2 }] }],
  segments: [
    { contentId: "c1", contentTitle: "第一讲", transcriptRevisionId: "r1", segmentId: SEGMENT as never, startMs: 75_000, snippet: "再看检索", ranges: [{ start: 2, end: 4 }] },
    { contentId: "c2", contentTitle: "检索第二讲", transcriptRevisionId: "r2", segmentId: SEGMENT as never, startMs: 0, snippet: "检索开场", ranges: [{ start: 0, end: 2 }] },
  ],
  summaries: [{ contentId: "c3", contentTitle: "第三讲", artifactId: "a3", templateId: "summary.core", summaryRevisionId: "sr3", snippet: "总结里的检索", ranges: [{ start: 4, end: 6 }] }],
  collections: [{ collectionId: "k1", name: "检索课程", snippet: "检索课程", ranges: [{ start: 0, end: 2 }] }],
};

describe("search helpers", () => {
  it("links each hit kind to where it opens and carries the query along", () => {
    const segment = new URL(hitLink({ kind: "segment", hit: result.segments[0]! }, "检索 重排"), "http://x");
    expect(segment.pathname).toBe("/contents/c1");
    expect(Object.fromEntries(segment.searchParams)).toEqual({ tab: "transcript", revision: "r1", segment: SEGMENT, search: "检索 重排" });
    expect(hitLink({ kind: "summary", hit: result.summaries[0]! }, "检索")).toBe(`/contents/c3?tab=summary&search=${encodeURIComponent("检索")}`);
    expect(hitLink({ kind: "content", hit: result.contents[0]! }, "检索")).toBe(`/contents/c2?search=${encodeURIComponent("检索")}`);
    expect(hitLink({ kind: "collection", hit: result.collections[0]! }, "检索")).toBe("/collections/k1");
  });

  it("orders hit Contents by group then relevance, keeping each Content's first hit", () => {
    const listed = hitsByContent(result);
    expect(listed.map((entry) => [entry.contentId, entry.first.kind])).toEqual([
      ["c2", "content"],
      ["c1", "segment"],
      ["c3", "summary"],
    ]);
    expect(listed[1]?.title).toBe("第一讲");
  });

  it("clamps, sorts and merges ranges", () => {
    expect(normalizeRanges("abcdef", [{ start: 4, end: 9 }, { start: 0, end: 2 }, { start: 1, end: 3 }, { start: 3, end: 3 }])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it("finds every term case-insensitively for in-page locating", () => {
    expect(termRanges("RAG 与 rag，检索", "rag 检索")).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 9 },
      { start: 10, end: 12 },
    ]);
    expect(termRanges("文本", "")).toEqual([]);
  });

  it("trims and bounds the query", () => {
    expect(normalizeQuery("  检索  ")).toBe("检索");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(200);
  });
});

describe("speakers in search", () => {
  it("opens a name match in the reading view filtered to that speaker, without the query", () => {
    expect(speakerHitLink({ contentId: "c 1", speakerId: "sp1" })).toBe("/contents/c%201?tab=transcript&speaker=sp1");
  });

  it("flags a summary hit only when it has a speaker basis state other than consistent", () => {
    expect(summaryBasisChanged({})).toBe(false);
    expect(summaryBasisChanged({ speakerContextState: "consistent" })).toBe(false);
    for (const state of ["attribution_changed", "evidence_removed", "unknown", "names_changed", "unconfirmed"] as const) {
      expect(summaryBasisChanged({ speakerContextState: state })).toBe(true);
    }
  });
});
