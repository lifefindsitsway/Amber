import { afterEach, describe, expect, it } from "vitest";
import { FigureService } from "../../../src/server/application/figures.ts";
import type { ContentFigure } from "../../../src/server/domain/figure.ts";
import type { LocalMediaIngest } from "../../../src/server/ports/local-media-ingest.ts";
import { BUILTIN_SUMMARY_TEMPLATES } from "../../../src/server/domain/prompts.ts";
import { attributionDigest, speakerLabels } from "../../../src/server/domain/speaker-context.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SearchResultDto } from "../../../src/shared/dto/search.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
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
    expect(h.search.search(BOB, { q: "梯度" })).toEqual({ contents: [], segments: [], summaries: [], collections: [], figures: [] });
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

describe("SearchService: speakers", () => {
  const CORE = BUILTIN_SUMMARY_TEMPLATES[0] as (typeof BUILTIN_SUMMARY_TEMPLATES)[number];

  /**
   * A Content titled `title` whose primary gives each line to a speaker (`undefined` =
   * unassigned). `speakers` are registered by index; `extra` revisions are stored beside the
   * primary without becoming it.
   */
  function speakerContent(
    h: Harness,
    input: { title: string; lines: Array<[string, number | undefined]>; speakers: Array<{ name?: string; confirmed?: boolean }>; userId?: string },
  ) {
    const userId = input.userId ?? LOCAL.userId;
    const contentId = h.newId();
    const revisionId = h.newId();
    const speakerIds = input.speakers.map(() => h.newId());
    const segments: TranscriptSegment[] = input.lines.map(([text, speaker], ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text,
      ...(speaker === undefined ? {} : { speakerId: speakerIds[speaker] as string }),
      sourceSegmentIds: [],
    }));
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId,
      kind: "asr",
      language: "zh-CN",
      timingFidelity: "exact_words",
      generation: { kind: "asr", asrProfileId: "a", modelId: "m" },
      segmentCount: segments.length,
      createdAt: 1,
    };
    h.repository.withTransaction((scope) => {
      scope.contents.insert({ id: contentId, userId, source: { kind: "local" }, title: input.title, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
      scope.speakers.insert(
        userId,
        contentId,
        input.speakers.map((speaker, index) => ({
          id: speakerIds[index] as string,
          ...(speaker.name === undefined ? {} : { name: speaker.name }),
          ...(speaker.confirmed === true ? { nameConfirmedAt: 1 } : {}),
        })),
        1,
      );
      scope.transcripts.insertRevision(userId, revision, segments);
      scope.contents.setPrimaryTranscript(userId, contentId, revisionId, 2);
      scope.search.syncContent(userId, contentId);
    });
    return { contentId, revisionId, speakerIds, segments };
  }

  it("a sentence hit carries who it is given to, as now, and whether the revision's speakers were reviewed", () => {
    const h = harness();
    const c = speakerContent(h, {
      title: "访谈",
      lines: [
        ["主持人问梯度下降", 0],
        ["嘉宾答梯度下降", 1],
        ["旁白说梯度下降", undefined],
      ],
      speakers: [{ name: "主持人" }, {}],
    });
    const speakerOf = () => new Map(h.search.search(LOCAL, { q: "梯度下降" }).segments.map((hit) => [hit.segmentId, hit.speaker]));
    const first = speakerOf();
    expect(first.get(c.segments[0]?.id as SegmentId)).toEqual({ id: c.speakerIds[0], ordinal: 1, name: "主持人", colorIndex: expect.any(Number), confirmed: false });
    expect(first.get(c.segments[1]?.id as SegmentId)).toEqual({ id: c.speakerIds[1], ordinal: 2, colorIndex: expect.any(Number), confirmed: false });
    expect(first.has(c.segments[2]?.id as SegmentId)).toBe(true);
    expect(first.get(c.segments[2]?.id as SegmentId)).toBeUndefined();
    // Reviewing and renaming show at once: nothing about speakers is indexed.
    h.repository.withTransaction((scope) => {
      scope.speakerConfirmations.set(LOCAL.userId, c.contentId, c.revisionId, 3);
      scope.speakers.update(LOCAL.userId, c.contentId, c.speakerIds[1] as string, { name: "嘉宾甲" }, 3);
    });
    const after = speakerOf();
    expect(after.get(c.segments[0]?.id as SegmentId)?.confirmed).toBe(true);
    expect(after.get(c.segments[1]?.id as SegmentId)).toMatchObject({ name: "嘉宾甲", confirmed: true });
  });

  it("a summary hit carries the state of the speakers it was generated with, and stays found in its place whatever the state", () => {
    const h = harness();
    const c = speakerContent(h, { title: "访谈", lines: [["主持人开场", 0], ["嘉宾回答", 1]], speakers: [{ name: "主持人", confirmed: true }, {}] });
    const plain = seedContent(h, { title: "讲座", lines: ["一句"] });
    h.repository.withTransaction((scope) => {
      scope.summaryTemplates.syncBuiltin(
        BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, name: template.nameKey, versions: [{ version: template.version, prompt: template.prompt }] })),
        1,
      );
      const store = (contentId: string, transcriptRevisionId: string, body: string, speakerContext?: ReturnType<typeof snapshot>) => {
        const revisionId = h.newId();
        const { artifactId } = scope.summaries.insertRevision(LOCAL.userId, {
          contentId,
          templateId: CORE.id,
          artifactId: h.newId(),
          revision: {
            id: revisionId,
            provenance: {
              inputs: [{ kind: "transcriptRevision", id: transcriptRevisionId }],
              promptRef: { id: CORE.id, version: CORE.version },
              ...(speakerContext === undefined ? {} : { speakerContext }),
              createdAt: 1,
            },
            quality: "normal",
            body,
            citations: [],
          },
        });
        scope.summaries.setCurrent(LOCAL.userId, artifactId, revisionId);
        scope.search.syncContent(LOCAL.userId, contentId);
      };
      const snapshot = () => ({
        version: 1 as const,
        rules: { id: "speaker.rules", version: 1 },
        attributionDigest: attributionDigest(c.segments),
        speakers: speakerLabels(scope.speakers.list(LOCAL.userId, c.contentId)),
      });
      store(c.contentId, c.revisionId, "访谈总结：检索增强生成的观点", snapshot());
      store(plain.contentId, plain.revisionId as string, "讲座总结：检索增强生成的原理");
    });
    const states = () => h.search.search(LOCAL, { q: "检索增强生成" }).summaries.map((hit) => [hit.contentId, hit.speakerContextState] as const);
    // The interview's primary is not reviewed yet.
    const before = states();
    expect(new Map(before)).toEqual(new Map([[c.contentId, "unconfirmed"], [plain.contentId, undefined]]));
    expect(h.search.search(LOCAL, { q: "检索增强生成" }).summaries.find((hit) => hit.contentId === plain.contentId)).not.toHaveProperty("speakerContextState");
    h.repository.withTransaction((scope) => scope.speakerConfirmations.set(LOCAL.userId, c.contentId, c.revisionId, 3));
    const after = states();
    expect(after.map(([contentId]) => contentId)).toEqual(before.map(([contentId]) => contentId));
    expect(new Map(after).get(c.contentId)).toBe("consistent");
  });

  it("names a matching speaker once per Content, only the owner's, outside the trash and given sentences by the primary", async () => {
    const h = harness();
    const a = speakerContent(h, { title: "第一讲", lines: [["开场", 0], ["提问", 1], ["回答", 0]], speakers: [{ name: "张伟", confirmed: true }, { name: "李雷" }] });
    const b = speakerContent(h, { title: "第二讲", lines: [["开场", 0]], speakers: [{ name: "张伟" }, { name: "张伟伟" }] });
    const trashed = speakerContent(h, { title: "回收站里", lines: [["开场", 0]], speakers: [{ name: "张伟" }] });
    speakerContent(h, { title: "别人的", lines: [["开场", 0]], speakers: [{ name: "张伟" }], userId: BOB.userId });
    h.repository.withTransaction((scope) => scope.contents.trash(LOCAL.userId, trashed.contentId, 5));
    const course = h.collections.create(LOCAL, { name: "课程" });
    await h.collections.addItem(LOCAL, course.id, { contentId: a.contentId });

    const result = h.search.search(LOCAL, { q: "张伟" });
    // 「张伟伟」 of the second lecture is registered but says nothing in its primary.
    expect(result.speakers).toEqual([
      { contentId: a.contentId, contentTitle: "第一讲", speakerId: a.speakerIds[0], ordinal: 1, name: "张伟", colorIndex: expect.any(Number), sentences: 2 },
      { contentId: b.contentId, contentTitle: "第二讲", speakerId: b.speakerIds[0], ordinal: 1, name: "张伟", colorIndex: expect.any(Number), sentences: 1 },
    ]);
    expect(h.search.search(LOCAL, { q: "张伟", scope: "library" }).speakers).toEqual(result.speakers);
    // A collection scope has no speaker group; nor does a query no name contains.
    expect(h.search.search(LOCAL, { q: "张伟", scope: course.id })).not.toHaveProperty("speakers");
    expect(h.search.search(LOCAL, { q: "开场" })).not.toHaveProperty("speakers");
    expect(h.search.search(BOB, { q: "张伟" }).speakers).toEqual([expect.objectContaining({ name: "张伟", contentTitle: "别人的" })]);
    // Names are not in the projection: they find no sentence, title or summary.
    const byName = h.search.search(LOCAL, { q: "李雷" });
    expect([byName.contents, byName.segments, byName.summaries, byName.collections]).toEqual([[], [], [], []]);
    expect(byName.speakers?.map((hit) => hit.speakerId)).toEqual([a.speakerIds[1]]);
    expect(h.db.prepare("SELECT count(*) AS n FROM search_index WHERE text LIKE '%张伟%' OR text LIKE '%李雷%'").get()).toEqual({ n: 0 });
  });

  it("matches names literally: every term, LIKE wildcards taken as text", () => {
    const h = harness();
    const c = speakerContent(h, { title: "讲座", lines: [["一", 0], ["二", 1]], speakers: [{ name: "Zhang Wei" }, { name: "100%_王" }] });
    expect(h.search.search(LOCAL, { q: "zhang wei" }).speakers?.map((hit) => hit.speakerId)).toEqual([c.speakerIds[0]]);
    expect(h.search.search(LOCAL, { q: "zhang li" })).not.toHaveProperty("speakers");
    expect(h.search.search(LOCAL, { q: "%_" }).speakers?.map((hit) => hit.speakerId)).toEqual([c.speakerIds[1]]);
    expect(h.search.search(LOCAL, { q: "0%" }).speakers?.map((hit) => hit.speakerId)).toEqual([c.speakerIds[1]]);
    expect(h.search.search(LOCAL, { q: "_王x" })).not.toHaveProperty("speakers");
  });
});

describe("SearchService: figure captions", () => {
  const T0 = 1_790_000_000_000;
  /** Patch, delete and restore never process an image, so the ingest is never reached. */
  const noIngest = new Proxy({} as LocalMediaIngest, {
    get: () => () => {
      throw new Error("no image processing in search tests");
    },
  });
  const figuresOf = (h: Harness) => new FigureService({ repository: h.repository, ingest: noIngest, media: h.media, files: h.media.data, now: () => T0 + 1000, newId: h.newId });

  /** Stored and projected in one transaction, as a capture or an upload is. */
  function addFigure(h: Harness, contentId: string, overrides: Partial<ContentFigure> = {}, userId = LOCAL.userId): ContentFigure {
    const figure: ContentFigure = {
      id: h.newId(),
      contentId,
      userId,
      source: "upload",
      displayMs: 0,
      sortKey: 0,
      widthRatio: 0.7,
      image: { width: 4, height: 3, bytes: 3, sha256: "a".repeat(64) },
      version: 1,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    };
    h.repository.withTransaction((scope) => {
      scope.figures.insert(figure, new Uint8Array([1, 2, 3]));
      scope.search.syncFigure(userId, contentId, figure.id);
    });
    return figure;
  }

  it("groups caption hits with the Content's title, a 「图 N」 ordinal among live figures and the capture time", () => {
    const h = harness();
    const lecture = seedContent(h, { title: "优化方法第三讲", lines: ["一句无关的字幕"] });
    // Listed out of order on purpose: display time, then sort key, then creation decide the ordinal.
    const late = addFigure(h, lecture.contentId, { caption: "收敛曲线的截图", source: "capture", capturedAtMs: 95_000, displayMs: 95_000 });
    const tieSecond = addFigure(h, lecture.contentId, { caption: "补充的收敛示意", displayMs: 40_000, sortKey: 2 });
    const tieFirstNewer = addFigure(h, lecture.contentId, { displayMs: 40_000, sortKey: 1, createdAt: T0 + 5 });
    const tieFirstOlder = addFigure(h, lecture.contentId, { caption: "黑板上的收敛条件", displayMs: 40_000, sortKey: 1 });
    addFigure(h, lecture.contentId, { caption: "已删除的收敛图", displayMs: 1_000, deletedAt: T0 });

    const result = h.search.search(LOCAL, { q: "收敛" });
    const byId = new Map(result.figures.map((hit) => [hit.figureId, hit]));
    expect(result.figures).toHaveLength(3);
    expect(byId.get(tieFirstOlder.id)).toMatchObject({ contentId: lecture.contentId, contentTitle: "优化方法第三讲", ordinal: 1, snippet: "黑板上的收敛条件" });
    expect(byId.get(tieFirstOlder.id)).not.toHaveProperty("capturedAtMs");
    expect(byId.get(tieSecond.id)).toMatchObject({ ordinal: 3 });
    expect(byId.get(late.id)).toMatchObject({ ordinal: 4, capturedAtMs: 95_000 });
    expect(result.figures.flatMap((hit) => hit.ranges.map((range) => hit.snippet.slice(range.start, range.end)))).toEqual(["收敛", "收敛", "收敛"]);
    expect(result.segments).toEqual([]);
    // The uncaptioned figure counts toward the ordinals but is never a hit.
    expect(byId.has(tieFirstNewer.id)).toBe(false);
  });

  it("follows caption edits, deletion and restore made through the figure service, renumbering the live figures", () => {
    const h = harness();
    const figures = figuresOf(h);
    const lecture = seedContent(h, { title: "图示讲次" });
    const first = addFigure(h, lecture.contentId, { caption: "第一张流程图", displayMs: 1_000 });
    const second = addFigure(h, lecture.contentId, { caption: "第二张流程图", displayMs: 2_000 });
    const ordinals = (q: string) => Object.fromEntries(h.search.search(LOCAL, { q }).figures.map((hit) => [hit.figureId, hit.ordinal]));
    expect(ordinals("流程图")).toEqual({ [first.id]: 1, [second.id]: 2 });

    figures.delete(LOCAL, first.id);
    expect(ordinals("流程图")).toEqual({ [second.id]: 1 });
    figures.restore(LOCAL, first.id);
    expect(ordinals("流程图")).toEqual({ [first.id]: 1, [second.id]: 2 });

    figures.patch(LOCAL, second.id, { version: 1, caption: "改名后的时序图" });
    expect(ordinals("流程图")).toEqual({ [first.id]: 1 });
    expect(ordinals("时序图")).toEqual({ [second.id]: 2 });
    // A blank caption takes the figure out of search; it keeps its place among the others.
    figures.patch(LOCAL, first.id, { version: 3, caption: "   " });
    expect(ordinals("流程图")).toEqual({});
    expect(ordinals("时序图")).toEqual({ [second.id]: 2 });
  });

  it("answers in the global, library and collection scopes and through the short-query path, for the owner only", async () => {
    const h = harness();
    const inside = seedContent(h, { title: "成员讲次" });
    const outside = seedContent(h, { title: "其它讲次" });
    const member = addFigure(h, inside.contentId, { caption: "板书照片" });
    const other = addFigure(h, outside.contentId, { caption: "另一张板书" });
    const bobs = seedContent(h, { title: "别人的讲次", userId: BOB.userId });
    addFigure(h, bobs.contentId, { caption: "别人的板书" }, BOB.userId);
    const course = h.collections.create(LOCAL, { name: "合集" });
    await addTo(h, course.id, inside.contentId);

    const ids = (result: SearchResultDto) => result.figures.map((hit) => hit.figureId).sort();
    for (const q of ["板书", "板书照"]) {
      expect(ids(h.search.search(LOCAL, { q }))).toEqual(q === "板书" ? [member.id, other.id].sort() : [member.id]);
      expect(ids(h.search.search(LOCAL, { q, scope: "library" }))).toEqual(q === "板书" ? [member.id, other.id].sort() : [member.id]);
      expect(ids(h.search.search(LOCAL, { q, scope: course.id }))).toEqual([member.id]);
    }
    expect(h.search.search(BOB, { q: "板书" }).figures.map((hit) => hit.snippet)).toEqual(["别人的板书"]);
    expect(h.search.search(BOB, { q: "板书照" }).figures).toEqual([]);
  });
});
