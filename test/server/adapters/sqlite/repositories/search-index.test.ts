import { afterEach, describe, expect, it } from "vitest";
import type { ContentFigure } from "../../../../../src/server/domain/figure.ts";
import type { RepositoryScope, SearchIndexQuery } from "../../../../../src/server/ports/repository.ts";
import { insertSummary } from "../../../../fixtures/pipeline/summary-data.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../../../fixtures/pipeline/harness.ts";
import { projectionSnapshot, seedContent } from "../../../../fixtures/search/corpus.ts";
import { fixedSpeakerId, seedContent as seedSpeakerContent } from "../../../../fixtures/pipeline/speaker-context.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

const query = (h: Harness, partial: Partial<SearchIndexQuery> & Pick<SearchIndexQuery, "terms">, owner = LOCAL.userId) =>
  h.repository.withTransaction((scope) =>
    scope.search.query(owner, { mode: "fts", scope: { kind: "global" }, groupLimit: 20, likeLimit: 200, ...partial }),
  );

describe("sqlite search index", () => {
  it("projects title, primary segments, current summaries (without citation markers) and reference texts", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "Gradient Descent 入门", lines: ["今天讲梯度下降", "学习率很重要"], reference: "课后阅读：凸优化" });
    insertSummary(h, { contentId: seeded.contentId, transcriptRevisionId: seeded.revisionId as string, citations: [{ transcriptRevisionId: seeded.revisionId as string, segmentId: seeded.segmentIds[0] as never }] });
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, seeded.contentId));
    const kinds = (projectionSnapshot(h) as Array<{ kind: string; text: string }>).map((row) => `${row.kind}:${row.text}`);
    expect(kinds).toEqual(expect.arrayContaining(["title:Gradient Descent 入门", "segment:今天讲梯度下降", "segment:学习率很重要", "reference:课后阅读：凸优化"]));
    const summary = (projectionSnapshot(h) as Array<{ kind: string; text: string }>).find((row) => row.kind === "summary");
    expect(summary?.text).not.toContain("[[seg:");
    expect(query(h, { terms: ["seg:"], mode: "fts" }).filter((hit) => hit.kind === "summary")).toEqual([]);
  });

  it("matches English substrings through FTS and two-character Chinese words through LIKE", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "Gradient Descent", lines: ["梯度下降的直觉", "无关的一句"] });
    expect(query(h, { terms: ["radient"] })).toEqual([{ kind: "title", contentId: seeded.contentId, text: "Gradient Descent" }]);
    const short = query(h, { terms: ["梯度"], mode: "like" });
    expect(short).toEqual([
      { kind: "segment", contentId: seeded.contentId, transcriptRevisionId: seeded.revisionId, segmentId: seeded.segmentIds[0], startMs: 0, text: "梯度下降的直觉" },
    ]);
  });

  it("treats quotes, operators, wildcards and LIKE metacharacters as literal text", () => {
    const h = harness();
    seedContent(h, { lines: ['他说 "OR" 不是运算符', "100%_完成", "普通的一句话"] });
    expect(query(h, { terms: ['"OR"'] })).toHaveLength(1);
    expect(query(h, { terms: ["OR"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["NOT"] })).toEqual([]);
    expect(query(h, { terms: ["的一*"] })).toEqual([]);
    expect(query(h, { terms: ["%_"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["_"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["%"], mode: "like" })).toHaveLength(1);
  });

  it("requires every term and keeps each kind within the group limit", () => {
    const h = harness();
    seedContent(h, { lines: Array.from({ length: 30 }, (_, index) => `重复出现的检索句 ${index}`) });
    expect(query(h, { terms: ["检索句", "17"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["重复出现"], groupLimit: 5 })).toHaveLength(5);
    expect(query(h, { terms: ["重复"], mode: "like", groupLimit: 5 })).toHaveLength(5);
    expect(query(h, { terms: ["重复"], mode: "like", likeLimit: 3 })).toHaveLength(3);
  });

  it("scopes library away from collections and a collection scope to its members", () => {
    const h = harness();
    const inside = seedContent(h, { title: "机器学习 第一讲" });
    seedContent(h, { title: "机器学习 番外" });
    const collection = h.collections.create(LOCAL, { name: "机器学习 课程" });
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId: collection.id, contentId: inside.contentId, position: 0, addedAt: 1 }));
    expect(query(h, { terms: ["机器学习"] }).map((hit) => hit.kind).sort()).toEqual(["collection", "title", "title"]);
    expect(query(h, { terms: ["机器学习"], scope: { kind: "library" } }).map((hit) => hit.kind)).toEqual(["title", "title"]);
    expect(query(h, { terms: ["机器学习"], scope: { kind: "collection", collectionId: collection.id } })).toEqual([
      { kind: "title", contentId: inside.contentId, text: "机器学习 第一讲" },
    ]);
  });

  it("never returns another owner's rows", () => {
    const h = harness();
    seedContent(h, { title: "只属于本地用户的标题" });
    expect(query(h, { terms: ["本地用户"] }, BOB.userId)).toEqual([]);
    expect(query(h, { terms: ["本地用户"] })).toHaveLength(1);
  });

  it("ranks a revision's segments by question trigrams for chat retrieval", () => {
    const h = harness();
    const seeded = seedContent(h, { lines: ["向量数据库负责召回", "重排序模型提升精度", "今天天气不错"] });
    const other = seedContent(h, { lines: ["重排序模型在另一讲"] });
    const ids = h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, seeded.revisionId as string, "重排序模型是做什么的？", 2));
    expect(ids[0]).toBe(seeded.segmentIds[1]);
    expect(ids).not.toContain(other.segmentIds[0]);
    expect(h.repository.withTransaction((scope) => scope.search.matchSegments(BOB.userId, seeded.revisionId as string, "重排序模型", 2))).toEqual([]);
    expect(h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, seeded.revisionId as string, "啊？", 2))).toEqual([]);
  });

  it("ranks chat retrieval within some speakers' sentences in the query itself, so the limit counts only theirs", () => {
    const h = harness();
    // The first speaker's sentences match better, so a filter applied after the limit would leave nothing.
    const texts = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? `重排序模型重排序模型第${i}句` : `重排序模型在第${i}句`));
    const { contentId, revision, segments } = seedSpeakerContent(h, { texts, speakers: [{}, {}], assign: (i) => i % 2 });
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, contentId));
    const match = (speakerIds?: string[]) =>
      h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, revision.id, "重排序模型", 5, speakerIds === undefined ? undefined : { speakerIds }));
    const speakerOf = new Map(segments.map((segment) => [segment.id as string, segment.speakerId]));
    expect(match().map((id) => speakerOf.get(id))).toEqual(Array(5).fill(fixedSpeakerId(0)));
    expect(match([fixedSpeakerId(1)]).map((id) => speakerOf.get(id))).toEqual(Array(5).fill(fixedSpeakerId(1)));
    expect(match([fixedSpeakerId(0), fixedSpeakerId(1)])).toEqual(match());
    expect(match([])).toEqual([]);
  });

  it("removes a Content's or Collection's rows and rebuilds everything from the business tables", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "要删除的内容", lines: ["一句话"] });
    const collection = h.collections.create(LOCAL, { name: "要删除的合集", description: "说明文字" });
    const before = projectionSnapshot(h);
    h.repository.withTransaction((scope) => scope.search.rebuild());
    expect(projectionSnapshot(h)).toEqual(before);
    h.repository.withTransaction((scope) => {
      scope.search.removeContent(LOCAL.userId, seeded.contentId);
      scope.search.removeCollection(LOCAL.userId, collection.id);
    });
    expect(projectionSnapshot(h)).toEqual([]);
  });

  it("reports itself unhealthy when emptied while data exists, and start-up repairs it", () => {
    const h = harness();
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    seedContent(h, { title: "健康检查" });
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    h.db.exec("DELETE FROM search_index");
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(false);
    h.search.ensureReady();
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    expect(projectionSnapshot(h)).toHaveLength(1);
  });

  it("never projects a Content in the trash, and stays healthy when only such Contents exist", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "回收站里的讲次", lines: ["梯度下降"] });
    h.repository.withTransaction((scope) => {
      scope.contents.trash(LOCAL.userId, seeded.contentId, 5);
      scope.search.removeContent(LOCAL.userId, seeded.contentId);
    });
    expect(projectionSnapshot(h)).toEqual([]);
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    // Neither re-deriving the one Content nor a full rebuild brings it back.
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, seeded.contentId));
    h.repository.withTransaction((scope) => scope.search.rebuild());
    expect(projectionSnapshot(h)).toEqual([]);
    h.repository.withTransaction((scope) => {
      scope.contents.restore(LOCAL.userId, seeded.contentId);
      scope.search.syncContent(LOCAL.userId, seeded.contentId);
    });
    expect(query(h, { terms: ["回收站"], mode: "like" }).map((hit) => hit.kind)).toEqual(["title"]);
  });
});

describe("sqlite search index: speakers", () => {
  /** Three speakers (the third unnamed) over nine sentences: 4, 3 and 1 of them, one unassigned. */
  function seeded(h: Harness) {
    const texts = Array.from({ length: 9 }, (_, i) => `检索增强生成第${i}句`);
    const assign = (i: number) => (i < 4 ? 0 : i < 7 ? 1 : i === 7 ? 2 : undefined);
    const seed = seedSpeakerContent(h, { texts, speakers: [{ name: "张伟" }, { name: "张伟明" }, {}], assign });
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, seed.contentId));
    return seed;
  }

  it("joins each matched sentence's speaker as it is now, in both match modes", () => {
    const h = harness();
    const seed = seeded(h);
    for (const mode of ["fts", "like"] as const) {
      const hits = query(h, { terms: mode === "fts" ? ["检索增强生成"] : ["检索"], mode });
      const bySegment = new Map(hits.flatMap((hit) => (hit.kind === "segment" ? [[hit.segmentId, hit.speaker]] : [])));
      expect(bySegment.size).toBe(9);
      expect(bySegment.get(seed.segments[0]?.id as string)).toEqual({ id: fixedSpeakerId(0), ordinal: 1, name: "张伟", colorIndex: expect.any(Number), confirmed: false });
      expect(bySegment.get(seed.segments[7]?.id as string)).toEqual({ id: fixedSpeakerId(2), ordinal: 3, colorIndex: expect.any(Number), confirmed: false });
      expect(bySegment.get(seed.segments[8]?.id as string)).toBeUndefined();
    }
    h.repository.withTransaction((scope) => scope.speakerConfirmations.set(LOCAL.userId, seed.contentId, seed.revision.id, 1));
    expect(query(h, { terms: ["检索增强生成"] }).every((hit) => hit.kind !== "segment" || hit.speaker === undefined || hit.speaker.confirmed)).toBe(true);
  });

  it("matches named speakers given sentences by the primary, most sentences first, within the limit", () => {
    const h = harness();
    const seed = seeded(h);
    const match = (terms: string[], limit = 20, owner = LOCAL.userId) => h.repository.withTransaction((scope) => scope.search.matchSpeakers(owner, terms, limit));
    expect(match(["张伟"])).toEqual([
      { contentId: seed.contentId, speakerId: fixedSpeakerId(0), ordinal: 1, name: "张伟", colorIndex: expect.any(Number), sentences: 4 },
      { contentId: seed.contentId, speakerId: fixedSpeakerId(1), ordinal: 2, name: "张伟明", colorIndex: expect.any(Number), sentences: 3 },
    ]);
    expect(match(["张伟"], 1).map((hit) => hit.speakerId)).toEqual([fixedSpeakerId(0)]);
    expect(match(["伟", "明"]).map((hit) => hit.speakerId)).toEqual([fixedSpeakerId(1)]);
    expect(match([])).toEqual([]);
    expect(match(["张伟"], 20, BOB.userId)).toEqual([]);
  });
});

describe("sqlite search index: figure captions", () => {
  const T0 = 1_790_000_000_000;
  let next = 0;
  /** Writes a figure and syncs its row in one transaction, as the figure service does. */
  function addFigure(h: Harness, contentId: string, overrides: Partial<ContentFigure> = {}, userId = LOCAL.userId): ContentFigure {
    next += 1;
    const figure: ContentFigure = {
      id: `01JFIGURE${String(next).padStart(17, "0")}`,
      contentId,
      userId,
      source: "upload",
      displayMs: 1000,
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
  const figureRows = (h: Harness) => (projectionSnapshot(h) as Array<{ kind: string; text: string; content_id: string; revision_id: string; segment_id: string | null }>).filter((row) => row.kind === "figure");
  const change = (h: Harness, figure: ContentFigure, work: (scope: RepositoryScope) => unknown) =>
    h.repository.withTransaction((scope) => {
      work(scope);
      scope.search.syncFigure(figure.userId, figure.contentId, figure.id);
    });

  it("indexes a live captioned figure under its id, outside the sentence id column, and follows caption edits, deletion, restore and purge", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "插图讲次", lines: ["无关的一句"] });
    const bare = addFigure(h, seeded.contentId);
    const figure = addFigure(h, seeded.contentId, { caption: "黑板上的损失函数推导" });
    expect(figureRows(h)).toEqual([{ text: "黑板上的损失函数推导", kind: "figure", user_id: LOCAL.userId, content_id: seeded.contentId, collection_id: null, revision_id: figure.id, segment_id: null, start_ms: null }]);
    expect(query(h, { terms: ["损失函数"] })).toEqual([{ kind: "figure", contentId: seeded.contentId, figureId: figure.id, ordinal: 2, text: "黑板上的损失函数推导" }]);

    change(h, figure, (scope) => scope.figures.update(LOCAL.userId, figure.id, 1, { caption: "改过的备注：学习率曲线" }, T0 + 1));
    expect(figureRows(h).map((row) => row.text)).toEqual(["改过的备注：学习率曲线"]);
    expect(query(h, { terms: ["损失函数"] })).toEqual([]);
    // A caption given to an uncaptioned figure joins it.
    change(h, bare, (scope) => scope.figures.update(LOCAL.userId, bare.id, 1, { caption: "后补的学习率说明" }, T0 + 1));
    expect(query(h, { terms: ["学习率"] }).map((hit) => (hit.kind === "figure" ? hit.figureId : undefined)).sort()).toEqual([bare.id, figure.id].sort());

    change(h, figure, (scope) => scope.figures.update(LOCAL.userId, figure.id, 2, { caption: null }, T0 + 2));
    expect(figureRows(h).map((row) => row.revision_id)).toEqual([bare.id]);

    change(h, bare, (scope) => scope.figures.setDeleted(LOCAL.userId, bare.id, T0 + 3, T0 + 3));
    expect(figureRows(h)).toEqual([]);
    change(h, bare, (scope) => scope.figures.setDeleted(LOCAL.userId, bare.id, undefined, T0 + 4));
    expect(figureRows(h).map((row) => row.revision_id)).toEqual([bare.id]);

    // Purged with its image: the row goes too, whoever calls the sync afterwards.
    change(h, bare, (scope) => scope.figures.setDeleted(LOCAL.userId, bare.id, T0 + 5, T0 + 5));
    change(h, bare, (scope) => scope.figures.purgeDeleted(T0 + 6, 10));
    expect(figureRows(h)).toEqual([]);
    // Sentences and the title stayed as they were throughout.
    expect((projectionSnapshot(h) as Array<{ kind: string }>).map((row) => row.kind).sort()).toEqual(["segment", "title"]);
  });

  it("leaves the trash with its Content and comes back on restore; a Content sync and a rebuild carry every caption", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "回收站插图", lines: ["一句字幕"] });
    const first = addFigure(h, seeded.contentId, { caption: "第一张示意图", displayMs: 9000 });
    const second = addFigure(h, seeded.contentId, { caption: "第二张示意图", displayMs: 2000 });
    addFigure(h, seeded.contentId, { caption: "已删除的示意图", deletedAt: T0 });
    const before = projectionSnapshot(h);
    expect(figureRows(h).map((row) => row.revision_id).sort()).toEqual([first.id, second.id].sort());

    h.repository.withTransaction((scope) => {
      scope.contents.trash(LOCAL.userId, seeded.contentId, 5);
      scope.search.removeContent(LOCAL.userId, seeded.contentId);
    });
    expect(query(h, { terms: ["示意图"] })).toEqual([]);
    // A figure change while its Content is in the trash does not bring the caption back.
    change(h, first, (scope) => scope.figures.update(LOCAL.userId, first.id, 1, { caption: "回收站里改的示意图" }, T0 + 1));
    h.repository.withTransaction((scope) => scope.search.rebuild());
    expect(figureRows(h)).toEqual([]);

    h.repository.withTransaction((scope) => {
      scope.contents.restore(LOCAL.userId, seeded.contentId);
      scope.search.syncContent(LOCAL.userId, seeded.contentId);
    });
    expect(query(h, { terms: ["示意图"] }).map((hit) => hit.kind)).toEqual(["figure", "figure"]);
    const restored = projectionSnapshot(h);
    expect(restored).toHaveLength((before as unknown[]).length);

    // Emptied and rebuilt from the business tables: every caption returns, nothing else changes.
    h.db.exec("DELETE FROM search_index");
    expect(figureRows(h)).toEqual([]);
    h.repository.withTransaction((scope) => scope.search.rebuild());
    expect(projectionSnapshot(h)).toEqual(restored);
    // A Content sync re-derives the same rows.
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, seeded.contentId));
    expect(projectionSnapshot(h)).toEqual(restored);
  });

  it("finds two-character captions through the short-query scan, ahead of a crowd of sentences, within the group limit", () => {
    const h = harness();
    const seeded = seedContent(h, { lines: Array.from({ length: 30 }, (_, index) => `板书出现在第 ${index} 句`) });
    const figure = addFigure(h, seeded.contentId, { caption: "板书照片" });
    const hits = query(h, { terms: ["板书"], mode: "like", likeLimit: 5, groupLimit: 3 });
    expect(hits[0]).toEqual({ kind: "figure", contentId: seeded.contentId, figureId: figure.id, ordinal: 1, text: "板书照片" });
    expect(hits.filter((hit) => hit.kind === "segment")).toHaveLength(3);
    // `%` and `_` stay literal in captions too.
    addFigure(h, seeded.contentId, { caption: "完成度 100%" });
    expect(query(h, { terms: ["0%"], mode: "like" }).map((hit) => hit.kind)).toEqual(["figure"]);
    expect(query(h, { terms: ["%"], mode: "like" }).map((hit) => hit.kind)).toEqual(["figure"]);
  });

  it("answers in every scope, a collection scope only for its members, and never for another owner", () => {
    const h = harness();
    const inside = seedContent(h, { title: "成员讲次" });
    const outside = seedContent(h, { title: "非成员讲次" });
    const member = addFigure(h, inside.contentId, { caption: "合集成员的流程图" });
    addFigure(h, outside.contentId, { caption: "合集之外的流程图" });
    const bobs = seedContent(h, { title: "别人的讲次", userId: BOB.userId });
    addFigure(h, bobs.contentId, { caption: "别人的流程图" }, BOB.userId);
    const collection = h.collections.create(LOCAL, { name: "图示合集" });
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId: collection.id, contentId: inside.contentId, position: 0, addedAt: 1 }));
    for (const mode of ["fts", "like"] as const) {
      const terms = mode === "fts" ? ["流程图"] : ["流程"];
      expect(query(h, { terms, mode })).toHaveLength(2);
      expect(query(h, { terms, mode, scope: { kind: "library" } })).toHaveLength(2);
      expect(query(h, { terms, mode, scope: { kind: "collection", collectionId: collection.id } })).toEqual([
        { kind: "figure", contentId: inside.contentId, figureId: member.id, ordinal: 1, text: "合集成员的流程图" },
      ]);
      expect(query(h, { terms, mode }, BOB.userId).map((hit) => hit.text)).toEqual(["别人的流程图"]);
    }
  });

  it("numbers a hit among its Content's live figures at query time, by display time, sort key and creation", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "编号讲次" });
    const late = addFigure(h, seeded.contentId, { caption: "收敛曲线的截图", source: "capture", capturedAtMs: 95_000, displayMs: 95_000 });
    const tieSecond = addFigure(h, seeded.contentId, { caption: "补充的收敛示意", displayMs: 40_000, sortKey: 2 });
    addFigure(h, seeded.contentId, { displayMs: 40_000, sortKey: 1, createdAt: T0 + 5 });
    const tieFirst = addFigure(h, seeded.contentId, { caption: "黑板上的收敛条件", displayMs: 40_000, sortKey: 1 });
    const earliest = addFigure(h, seeded.contentId, { caption: "开场的收敛图", displayMs: 1_000 });
    // Another Content's and another owner's figures number on their own.
    const other = seedContent(h, { title: "别的讲次" });
    addFigure(h, other.contentId, { caption: "别处的收敛图", displayMs: 0 });
    const bobs = seedContent(h, { title: "别人的讲次", userId: BOB.userId });
    addFigure(h, bobs.contentId, { caption: "别人的收敛图", displayMs: 0 }, BOB.userId);
    const numbered = () =>
      Object.fromEntries(
        query(h, { terms: ["收敛"], mode: "like" }).flatMap((hit) => (hit.kind === "figure" && hit.contentId === seeded.contentId ? [[hit.figureId, [hit.ordinal, hit.capturedAtMs]]] : [])),
      );
    expect(numbered()).toEqual({ [earliest.id]: [1, undefined], [tieFirst.id]: [2, undefined], [tieSecond.id]: [4, undefined], [late.id]: [5, 95_000] });
    expect(query(h, { terms: ["收敛图"] }).filter((hit) => hit.kind === "figure" && hit.contentId === other.contentId)).toEqual([
      expect.objectContaining({ ordinal: 1 }),
    ]);
    // Deleting the first figure moves the others up at once; nothing stored needs rewriting.
    change(h, earliest, (scope) => scope.figures.setDeleted(LOCAL.userId, earliest.id, T0 + 1, T0 + 1));
    expect(numbered()).toEqual({ [tieFirst.id]: [1, undefined], [tieSecond.id]: [3, undefined], [late.id]: [4, 95_000] });
    // A row left behind for a figure no longer live is never answered.
    h.db.prepare("INSERT INTO search_index (text, kind, user_id, content_id, revision_id) VALUES ('残留的收敛图', 'figure', ?, ?, ?)").run(LOCAL.userId, seeded.contentId, earliest.id);
    expect(numbered()).toEqual({ [tieFirst.id]: [1, undefined], [tieSecond.id]: [3, undefined], [late.id]: [4, 95_000] });
    expect(query(h, { terms: ["残留的收敛"] })).toEqual([]);
  });

  it("keeps figure captions out of chat retrieval", () => {
    const h = harness();
    const seeded = seedContent(h, { lines: ["重排序模型提升精度", "今天天气不错"] });
    const figure = addFigure(h, seeded.contentId, { caption: "重排序模型重排序模型的结构图" });
    const ids = h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, seeded.revisionId as string, "重排序模型的结构", 10));
    expect(ids).toEqual([seeded.segmentIds[0]]);
    // A figure's id sits in the revision column, yet retrieval by it finds nothing.
    expect(h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, figure.id, "重排序模型的结构", 10))).toEqual([]);
  });
});
