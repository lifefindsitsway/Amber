import { afterEach, describe, expect, it } from "vitest";
import type { SearchResultDto } from "../../../src/shared/dto/search.ts";
import { evenCues } from "../../fixtures/platform/subtitles.ts";
import { createDemoStack, type DemoStack } from "../../fixtures/pipeline/demo-stack.ts";
import { BOB, createHarness, LOCAL, LOCAL_TOKEN, taskOf, waitFor, type Harness } from "../../fixtures/pipeline/harness.ts";
import { projectionSnapshot, seedContent, srtOf } from "../../fixtures/search/corpus.ts";

const open: Array<Harness | DemoStack> = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

/** Every highlighted span of every hit, as text. */
function marked(result: SearchResultDto): string[] {
  return [...result.contents, ...result.segments, ...result.summaries, ...result.collections].flatMap((hit) =>
    hit.ranges.map((range) => hit.snippet.slice(range.start, range.end)),
  );
}

/** The synthetic search corpus: two lectures in two collections. */
function corpus(h: Harness) {
  const ml = seedContent(h, { title: "机器学习导论", lines: ["今天讲梯度下降。", "Gradient descent is an optimizer.", "下面看例子。"] });
  const dl = seedContent(h, { title: "深度学习", lines: ["反向传播计算梯度。", "激活函数的选择。"] });
  const courseA = h.collections.create(LOCAL, { name: "优化方法" });
  const courseB = h.collections.create(LOCAL, { name: "神经网络" });
  return { ml, dl, courseA, courseB };
}

async function addTo(h: Harness, collectionId: string, contentId: string): Promise<void> {
  await h.collections.addItem(LOCAL, collectionId, { contentId });
}

describe("SearchService", () => {
  it("a two-character Chinese word, an English substring and a cross-collection query all hit with correct highlights", async () => {
    const h = harness();
    const { ml, dl, courseA, courseB } = corpus(h);
    await addTo(h, courseA.id, ml.contentId);
    await addTo(h, courseB.id, dl.contentId);

    const chinese = h.search.search(LOCAL, { q: "梯度" });
    expect(chinese.segments.map((hit) => hit.segmentId).sort()).toEqual([ml.segmentIds[0], dl.segmentIds[0]].sort());
    expect(new Set(marked(chinese))).toEqual(new Set(["梯度"]));
    const hit = chinese.segments.find((segment) => segment.contentId === ml.contentId);
    expect(hit).toMatchObject({ contentTitle: "机器学习导论", transcriptRevisionId: ml.revisionId, startMs: 0 });

    const english = h.search.search(LOCAL, { q: "radient" });
    expect(english.segments).toHaveLength(1);
    expect(english.segments[0]).toMatchObject({ segmentId: ml.segmentIds[1], snippet: "Gradient descent is an optimizer." });
    expect(marked(english)).toEqual(["radient"]);

    // Global spans both collections; each collection scope keeps to its own member.
    expect(new Set(chinese.segments.map((segment) => segment.contentId))).toEqual(new Set([ml.contentId, dl.contentId]));
    expect(h.search.search(LOCAL, { q: "梯度", scope: courseA.id }).segments.map((segment) => segment.contentId)).toEqual([ml.contentId]);
    expect(h.search.search(LOCAL, { q: "梯度", scope: courseB.id }).segments.map((segment) => segment.contentId)).toEqual([dl.contentId]);
    expect(h.search.search(LOCAL, { q: "优化方法" }).collections).toMatchObject([{ collectionId: courseA.id, name: "优化方法" }]);
  });

  it("a Content in two collections hits in both scopes; leaving one changes only that scope", async () => {
    const h = harness();
    const { ml, courseA, courseB } = corpus(h);
    await addTo(h, courseA.id, ml.contentId);
    await addTo(h, courseB.id, ml.contentId);
    const contentsIn = (scope: string) => h.search.search(LOCAL, { q: "梯度下降", scope }).segments.map((segment) => segment.contentId);
    expect(contentsIn(courseA.id)).toEqual([ml.contentId]);
    expect(contentsIn(courseB.id)).toEqual([ml.contentId]);
    const library = h.search.search(LOCAL, { q: "梯度下降", scope: "library" });

    const item = h.collections.get(LOCAL, courseB.id).items.find((entry) => entry.contentId === ml.contentId);
    h.collections.removeItem(LOCAL, courseB.id, item?.id as string);
    expect(contentsIn(courseB.id)).toEqual([]);
    expect(contentsIn(courseA.id)).toEqual([ml.contentId]);
    expect(h.search.search(LOCAL, { q: "梯度下降", scope: "library" })).toEqual(library);
  });

  it("results are identical after SearchService.rebuild()", async () => {
    const h = harness();
    const { ml, dl, courseA } = corpus(h);
    await addTo(h, courseA.id, ml.contentId);
    h.contents.importSubtitle(LOCAL, dl.contentId, { text: "参考资料：梯度裁剪与 Gradient clipping", format: "txt" });
    const queries = [{ q: "梯度" }, { q: "radient" }, { q: "梯度", scope: "library" }, { q: "梯度下降", scope: courseA.id }, { q: "学习" }, { q: "优化" }];
    const before = queries.map((query) => h.search.search(LOCAL, query));
    h.search.rebuild();
    expect(queries.map((query) => h.search.search(LOCAL, query))).toEqual(before);
  });

  it("groups one entry per Content, a title before a reference text, and keeps library free of collections", () => {
    const h = harness();
    const both = seedContent(h, { title: "凸优化讲义", reference: "凸优化的补充材料" });
    const referenceOnly = seedContent(h, { title: "其他标题", reference: "附录：凸优化习题" });
    h.collections.create(LOCAL, { name: "凸优化合集" });
    const result = h.search.search(LOCAL, { q: "凸优化" });
    expect(result.contents).toEqual([
      expect.objectContaining({ contentId: both.contentId, matchedIn: "title", title: "凸优化讲义" }),
      expect.objectContaining({ contentId: referenceOnly.contentId, matchedIn: "reference", title: "其他标题" }),
    ]);
    expect(result.collections).toHaveLength(1);
    expect(h.search.search(LOCAL, { q: "凸优化", scope: "library" }).collections).toEqual([]);
  });

  it("isolates owners and refuses a collection scope that is not the caller's", () => {
    const h = harness();
    const { courseA } = corpus(h);
    expect(h.search.search(BOB, { q: "梯度" })).toEqual({ contents: [], segments: [], summaries: [], collections: [] });
    expect(() => h.search.search(BOB, { q: "梯度", scope: courseA.id })).toThrow(expect.objectContaining({ appError: expect.objectContaining({ class: "not_found" }) }));
  });
});

describe("incremental projection equals a rebuild", () => {
  it("after import, pipeline summary, subtitle import, manual commit, primary switch, renames and deletions", { timeout: 60_000 }, async () => {
    const stack = await createDemoStack();
    open.push(stack);
    const { h } = stack;
    /** The projection as maintained so far must equal one derived from scratch. */
    const expectConsistent = (): unknown[] => {
      const incremental = projectionSnapshot(h);
      h.search.rebuild();
      expect(projectionSnapshot(h)).toEqual(incremental);
      return incremental;
    };
    const inject = async (method: "POST" | "PUT", url: string, payload: unknown) => {
      const response = await stack.built.app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${LOCAL_TOKEN}` } });
      expect(response.statusCode).toBeLessThan(300);
      return response.json() as { id: string };
    };
    const profile = await inject("POST", "/api/providers", {
      name: "replay",
      protocol: "openai_compatible",
      baseURL: "https://llm.example.com/v1",
      models: [{ modelId: "model-a", contextWindowTokens: 128_000 }],
    });
    await inject("PUT", `/api/providers/${profile.id}/credential`, { value: "<placeholder-llm-key>" });
    const lines = ["今天讲检索增强生成。", "先看向量数据库。", "再看重排序。"];
    h.platforms.youtube
      .video("srchconsist", {
        metadata: { title: "检索第一讲", durationMs: 30_000, rawLanguage: "zh-CN", subtitleTracks: [{ locator: "zh", language: "zh-CN", autoGenerated: false, translated: false }] },
        subtitles: { zh: evenCues(lines.length, 30_000, (index) => lines[index] as string) },
      })
      .video("srchsecondx", {
        metadata: { title: "检索第二讲", durationMs: 30_000, rawLanguage: "zh-CN", subtitleTracks: [{ locator: "zh", language: "zh-CN", autoGenerated: false, translated: false }] },
        subtitles: { zh: evenCues(2, 30_000, (index) => `第二讲 ${index}`) },
      });
    const { body } = await h.importContent.import(LOCAL, {
      items: [{ url: "https://www.youtube.com/watch?v=srchconsist" }, { url: "https://www.youtube.com/watch?v=srchsecondx" }],
      settings: { modelRef: { providerProfileId: profile.id, modelId: "model-a" }, autoProofread: false },
      collection: { name: "检索课程" },
    });
    await waitFor(() => body.taskIds.every((taskId) => ["succeeded", "failed"].includes(taskOf(h, taskId).statusProjection)), 30_000);
    expect(body.taskIds.map((taskId) => taskOf(h, taskId).statusProjection)).toEqual(["succeeded", "succeeded"]);
    const [first, second] = body.contentIds as [string, string];
    expect(h.search.search(LOCAL, { q: "向量数据库" }).segments).toHaveLength(1);
    expect(h.search.search(LOCAL, { q: "检索第一讲" }).contents).toHaveLength(1);
    expect((expectConsistent() as Array<{ kind: string }>).filter((row) => row.kind === "summary")).toHaveLength(2);

    // Imported subtitle becomes primary; a reference text joins the corpus.
    const imported = h.contents.importSubtitle(LOCAL, first, { text: srtOf(["导入的新字幕第一句", "导入的新字幕第二句"]), format: "srt", language: "zh-CN" });
    h.contents.importSubtitle(LOCAL, first, { text: "课后阅读：重排序论文", format: "txt" });
    expect(h.search.search(LOCAL, { q: "向量数据库" }).segments).toEqual([]);
    expectConsistent();
    // A manual commit on top of it becomes primary at once.
    const base = imported.transcriptRevisionId as string;
    const baseSegments = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, base));
    h.transcripts.putDraft(LOCAL, first, {
      baseRevisionId: base, expectedVersion: null,
      segments: baseSegments.map((segment, index) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: index === 0 ? "手工修订后的句子" : segment.text,
        sourceSegmentIds: [segment.id],
      })),
    });
    h.transcripts.commitDraft(LOCAL, first, { expectedPrimaryRevisionId: base, draftVersion: 1 });
    expect(h.search.search(LOCAL, { q: "手工修订" }).segments).toHaveLength(1);
    expectConsistent();
    // Switching back to the platform revision, renaming and deleting.
    const platform = h.contents.revisions(LOCAL, first).revisions.find((revision) => revision.kind === "platform");
    h.contents.setPrimary(LOCAL, first, platform?.id as string);
    const collectionId = h.collections.list(LOCAL).items[0]?.id as string;
    h.collections.patch(LOCAL, collectionId, { name: "检索课程（修订）", description: "新的说明" });
    const extra = h.collections.create(LOCAL, { name: "临时合集" });
    h.collections.delete(LOCAL, extra.id);
    await h.deleteContent.delete(LOCAL, second);

    expect(expectConsistent().length).toBeGreaterThan(0);
    expect(h.search.search(LOCAL, { q: "向量数据库" }).segments).toHaveLength(1);
    expect(h.search.search(LOCAL, { q: "检索第二讲" }).contents).toEqual([]);
    expect(h.search.search(LOCAL, { q: "修订" }).collections).toHaveLength(1);
  });
});
