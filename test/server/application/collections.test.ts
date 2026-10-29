import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_LANGUAGE_DEFAULT } from "../../../src/shared/defaults.ts";
import type { AppError } from "../../../src/shared/errors.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { BOB, builtinPromptRefs, configureLlm, createHarness, createLocalContent, LOCAL, taskOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import { insertCollectionSummary, insertSummary, seedTranscripts } from "../../fixtures/pipeline/summary-data.ts";
import { countRows, insertRow } from "../../tools/sqlite.ts";
import type { TranscriptFixture } from "../../fixtures/transcripts/lecture.ts";

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

async function errorOf(work: () => unknown): Promise<AppError | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError;
    }
    throw error;
  }
  return undefined;
}

async function codeOf(work: () => unknown): Promise<string | undefined> {
  return (await errorOf(work))?.code;
}

/** A collection of `n` local Contents, each with transcripts and, unless `bare`, a current core summary. */
async function collectionOf(h: Harness, n: number, bare: readonly number[] = []) {
  const collection = h.collections.create(LOCAL, { name: "Course" });
  const members: Array<{ contentId: string; transcriptRevisionId: string; summaryRevisionId?: string; fixture: TranscriptFixture }> = [];
  for (let index = 0; index < n; index += 1) {
    const contentId = createLocalContent(h);
    const fixture = seedTranscripts(h, contentId);
    const summary = bare.includes(index) ? undefined : insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    await h.collections.addItem(LOCAL, collection.id, { contentId });
    members.push({ contentId, transcriptRevisionId: fixture.asr.revision.id, ...(summary === undefined ? {} : { summaryRevisionId: summary.revisionId }), fixture });
  }
  return { collectionId: collection.id, members };
}

describe("collection CRUD", () => {
  it("creates, lists, renames, clears the description and deletes, for the owner only", async () => {
    const h = harness();
    const created = h.collections.create(LOCAL, { name: "Course", description: "about RAG" });
    expect(created).toMatchObject({ name: "Course", description: "about RAG", itemCount: 0, items: [] });
    expect(h.collections.list(LOCAL).items.map((item) => item.id)).toEqual([created.id]);
    expect(h.collections.list(BOB).items).toEqual([]);

    const patched = h.collections.patch(LOCAL, created.id, { name: "Renamed", description: null });
    expect(patched.name).toBe("Renamed");
    expect(patched).not.toHaveProperty("description");
    expect(await codeOf(() => h.collections.patch(BOB, created.id, { name: "x" }))).toBe("not_found");
    expect(await codeOf(() => h.collections.get(BOB, created.id))).toBe("not_found");
    expect(await codeOf(() => h.collections.delete(BOB, created.id))).toBe("not_found");

    h.collections.delete(LOCAL, created.id);
    expect(await codeOf(() => h.collections.get(LOCAL, created.id))).toBe("not_found");
  });

  it("refuses deletion while a Task works on the collection and keeps member Contents after deletion", async () => {
    const h = harness();
    configureLlm(h);
    const { collectionId, members } = await collectionOf(h, 1);
    const { body } = await h.collections.createSummary(LOCAL, collectionId, {});
    expect(await codeOf(() => h.collections.delete(LOCAL, collectionId))).toBe("conflict");
    h.tasks.cancel(LOCAL, body.taskId);
    h.collections.delete(LOCAL, collectionId);
    expect(h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, members[0]?.contentId as string))).toBeDefined();
  });
});

describe("collection items", () => {
  it("enrolls an existing Content at the end, once", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 2);
    const detail = h.collections.get(LOCAL, collectionId);
    expect(detail.items.map((item) => [item.contentId, item.position])).toEqual([
      [members[0]?.contentId, 0],
      [members[1]?.contentId, 1],
    ]);
    expect(detail.items[0]).toMatchObject({ processingStatus: "queued" });
    const again = await h.collections.addItem(LOCAL, collectionId, { contentId: members[0]?.contentId as string });
    expect(again).toEqual({ status: 200, body: detail.items[0] });
    expect(h.collections.get(LOCAL, collectionId).itemCount).toBe(2);

    const bobs = createLocalContent(h, BOB.userId);
    expect(await codeOf(() => h.collections.addItem(LOCAL, collectionId, { contentId: bobs }))).toBe("not_found");
    expect(await codeOf(() => h.collections.addItem(BOB, collectionId, { contentId: bobs }))).toBe("not_found");
  });

  it("imports a URL into the collection", async () => {
    const h = harness();
    const collection = h.collections.create(LOCAL, { name: "Course" });
    const result = await h.collections.addItem(LOCAL, collection.id, { url: WATCH });
    expect(result.status).toBe(202);
    const body = result.body as { contentIds: string[]; taskIds: string[] };
    expect(h.collections.get(LOCAL, collection.id).items.map((item) => item.contentId)).toEqual(body.contentIds);
    expect(taskOf(h, body.taskIds[0] as string).kind).toBe("process_content");
  });

  it("gives each member its canonical source URL, none for a local file", async () => {
    const h = harness();
    const collection = h.collections.create(LOCAL, { name: "Course" });
    await h.collections.addItem(LOCAL, collection.id, { contentId: createLocalContent(h) });
    await h.collections.addItem(LOCAL, collection.id, { url: WATCH });
    const [local, platform] = h.collections.get(LOCAL, collection.id).items;
    expect(local === undefined ? undefined : Object.hasOwn(local, "sourceUrl")).toBe(false);
    expect(platform?.sourceUrl).toBe(WATCH);
  });

  it("gives each member its Content's source kind and own update time, not the item's", async () => {
    const h = harness();
    const collection = h.collections.create(LOCAL, { name: "Course" });
    await h.collections.addItem(LOCAL, collection.id, { contentId: createLocalContent(h) });
    await h.collections.addItem(LOCAL, collection.id, { url: WATCH });
    const [local, platform] = h.collections.get(LOCAL, collection.id).items;
    h.db.prepare("UPDATE content SET updated_at = ? WHERE id = ?").run(4242, local?.contentId);
    expect(local).toMatchObject({ source: { kind: "local" }, updatedAt: 1 });
    expect(platform?.source).toEqual({ kind: "youtube" });
    expect(h.collections.get(LOCAL, collection.id).items[0]).toMatchObject({ source: { kind: "local" }, updatedAt: 4242 });
  });

  it("reorders with a complete permutation only and removes items", async () => {
    const h = harness();
    const { collectionId } = await collectionOf(h, 3);
    const ids = h.collections.get(LOCAL, collectionId).items.map((item) => item.id);
    const reversed = [...ids].reverse();
    expect(h.collections.reorder(LOCAL, collectionId, reversed).items.map((item) => [item.id, item.position])).toEqual(reversed.map((id, index) => [id, index]));
    for (const bad of [ids.slice(1), [...ids, ids[0] as string], [ids[0], ids[1], "nope"]]) {
      expect(await codeOf(() => h.collections.reorder(LOCAL, collectionId, bad as string[]))).toBe("invalid_request");
    }
    h.collections.removeItem(LOCAL, collectionId, ids[1] as string);
    expect(h.collections.get(LOCAL, collectionId).items.map((item) => item.id)).toEqual([ids[2], ids[0]]);
    expect(await codeOf(() => h.collections.removeItem(LOCAL, collectionId, ids[1] as string))).toBe("not_found");
  });
});

describe("when a collection last changed", () => {
  const T0 = 1_790_000_000_000;
  afterEach(() => {
    vi.useRealTimers();
  });
  /** The services keep the clock they were built with, so the fake one comes first. */
  function clocked(): { h: Harness; at: (offset: number) => void } {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    return { h: harness(), at: (offset) => vi.setSystemTime(T0 + offset) };
  }

  it("moves with edits, members joining or leaving and the order, not with a member's own changes", async () => {
    const { h, at } = clocked();
    const collection = h.collections.create(LOCAL, { name: "Course" });
    const updatedAt = () => h.collections.get(LOCAL, collection.id).updatedAt;
    expect([collection.createdAt, collection.updatedAt]).toEqual([T0, T0]);

    at(1);
    expect(h.collections.patch(LOCAL, collection.id, { description: "about" }).updatedAt).toBe(T0 + 1);
    at(2);
    const first = createLocalContent(h);
    await h.collections.addItem(LOCAL, collection.id, { contentId: first });
    await h.collections.addItem(LOCAL, collection.id, { contentId: createLocalContent(h) });
    await h.collections.addItem(LOCAL, collection.id, { contentId: createLocalContent(h) });
    expect(updatedAt()).toBe(T0 + 2);
    at(3);
    // Enrolling a member again changes nothing, nor does renaming a member.
    await h.collections.addItem(LOCAL, collection.id, { contentId: first });
    h.contents.patch(LOCAL, first, { title: "第一讲" });
    expect(updatedAt()).toBe(T0 + 2);

    at(4);
    const ids = h.collections.get(LOCAL, collection.id).items.map((item) => item.id);
    expect(h.collections.reorder(LOCAL, collection.id, [...ids].reverse()).updatedAt).toBe(T0 + 4);
    at(5);
    h.collections.removeItem(LOCAL, collection.id, ids[2] as string);
    expect(updatedAt()).toBe(T0 + 5);
  });

  it("moves when a URL is imported into it, and when a member Content is deleted, for its collections only", async () => {
    const { h, at } = clocked();
    const course = h.collections.create(LOCAL, { name: "Course" });
    const other = h.collections.create(LOCAL, { name: "Other" });
    const member = createLocalContent(h);
    await h.collections.addItem(LOCAL, course.id, { contentId: member });
    at(1);
    await h.collections.addItem(LOCAL, course.id, { url: WATCH });
    expect(h.collections.get(LOCAL, course.id).updatedAt).toBe(T0 + 1);
    at(2);
    await h.deleteContent.delete(LOCAL, member);
    expect(h.collections.get(LOCAL, course.id)).toMatchObject({ itemCount: 1, updatedAt: T0 + 2 });
    expect(h.collections.get(LOCAL, other.id).updatedAt).toBe(T0);
  });
});

describe("collection summary", () => {
  it("freezes each member's core summary and primary, in order, into a summarize_collection Task", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const { collectionId, members } = await collectionOf(h, 2);
    const items = h.collections.get(LOCAL, collectionId).items;
    const result = await h.collections.createSummary(LOCAL, collectionId, { modelRef });
    expect(result.status).toBe(202);
    const task = taskOf(h, result.body.taskId);
    expect(task).toMatchObject({ kind: "summarize_collection", collectionId });
    expect(JSON.parse(task.requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "summarize_collection",
      promptRefs: builtinPromptRefs("summarize_collection"),
      modelRef,
      outputLanguage: UI_LANGUAGE_DEFAULT,
      inputItems: members.map((member, index) => ({
        collectionItemId: items[index]?.id,
        contentId: member.contentId,
        summaryRevisionId: member.summaryRevisionId,
        transcriptRevisionId: member.transcriptRevisionId,
        position: index,
      })),
    });
    expect(h.collections.getSummary(LOCAL, collectionId)).toEqual({ stale: false, activeTaskId: result.body.taskId });
    expect(await codeOf(() => h.collections.createSummary(LOCAL, collectionId, {}))).toBe("conflict.mutation_lane");
    expect((await errorOf(() => h.collections.createSummary(LOCAL, collectionId, {})))?.userMessage).toBe("已有一个「合集归纳」任务正在进行，与这次操作冲突；请等它结束，或在左下角「任务」里取消后再试");
  });

  it("freezes the user's default output language when the request names none", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const { collectionId } = await collectionOf(h, 1);
    h.userSettings.patch(LOCAL, { language: "en" });
    const result = await h.collections.createSummary(LOCAL, collectionId, { modelRef });
    expect(JSON.parse(taskOf(h, result.body.taskId).requestJson)).toMatchObject({ outputLanguage: "en" });
  });

  it("lists each member with its cover", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 1);
    h.db.prepare("UPDATE content SET cover_url = ? WHERE id = ?").run("https://img.example.com/c.jpg", members[0]?.contentId);
    expect(h.collections.get(LOCAL, collectionId).items[0]).toMatchObject({ coverUrl: "https://img.example.com/c.jpg" });
  });

  it("refuses an empty collection and lists members without a core summary", async () => {
    const h = harness();
    const empty = h.collections.create(LOCAL, { name: "Empty" });
    expect(await codeOf(() => h.collections.createSummary(LOCAL, empty.id, {}))).toBe("invalid_request");
    const { collectionId, members } = await collectionOf(h, 3, [0, 2]);
    const error = await errorOf(() => h.collections.createSummary(LOCAL, collectionId, {}));
    expect(error).toMatchObject({
      code: "invalid_request.collection_summary_missing",
      details: { missingContentIds: [members[0]?.contentId, members[2]?.contentId] },
    });
    expect(h.repository.withTransaction((scope) => scope.tasks.listByCollection(LOCAL.userId, collectionId))).toEqual([]);
  });

  it("shows a summary stored while collection summaries still cited without its markers, partials too; storage is untouched", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 1);
    const items = h.collections.get(LOCAL, collectionId).items;
    const member = members[0] as (typeof members)[number];
    const segment = member.fixture.asr.segments[0];
    const citation = { transcriptRevisionId: member.fixture.asr.revision.id, segmentId: segment?.id as SegmentId };
    const stored = {
      body: `## 这个合集在讲什么\n结论 [[seg:${segment?.id}]][[unresolved:s4]]。`,
      citations: [citation],
      partialBody: `第一组[[seg:${segment?.id}]]、[[unresolved:seg:gone]]归纳`,
      partialCitations: [citation],
    };
    const inputItems = [
      { collectionItemId: items[0]?.id as string, contentId: member.contentId, summaryRevisionId: member.summaryRevisionId as string, transcriptRevisionId: member.transcriptRevisionId, position: 0 },
    ];
    const { revisionId, partialId } = insertCollectionSummary(h, collectionId, inputItems, LOCAL.userId, stored);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({
      current: { id: revisionId, body: "## 这个合集在讲什么\n结论。", citations: [], partials: [{ id: partialId, body: "第一组归纳", citations: [] }] },
    });
    const kept = h.repository.withTransaction((scope) => scope.collectionSummaries.getCurrent(LOCAL.userId, collectionId));
    expect(kept).toMatchObject({ body: stored.body, citations: stored.citations });
  });

  it("shows the current revision with its partials and derives member_changed and order_changed", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 2);
    const items = h.collections.get(LOCAL, collectionId).items;
    const inputItems = members.map((member, index) => ({
      collectionItemId: items[index]?.id as string,
      contentId: member.contentId,
      summaryRevisionId: member.summaryRevisionId as string,
      transcriptRevisionId: member.transcriptRevisionId,
      position: index,
    }));
    const { artifactId, revisionId, partialId } = insertCollectionSummary(h, collectionId, inputItems);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({
      artifactId,
      stale: false,
      current: { id: revisionId, partials: [{ id: partialId, index: 0, body: "第一组归纳" }], quality: "normal", qualityReasons: [], stale: false },
    });

    h.collections.reorder(LOCAL, collectionId, [items[1]?.id as string, items[0]?.id as string]);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: true, staleReason: "order_changed" });
    h.collections.reorder(LOCAL, collectionId, [items[0]?.id as string, items[1]?.id as string]);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: false });

    // A member's primary proofread from its frozen transcript is still that member's text; another lineage is not.
    const first = members[0] as (typeof members)[number];
    const setPrimary = (revisionId: string, updatedAt: number) =>
      h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, first.contentId, revisionId, updatedAt));
    setPrimary(first.fixture.corrected.revision.id, 10);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: false });
    setPrimary(first.fixture.platform.revision.id, 11);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: true, staleReason: "member_changed" });
    setPrimary(first.fixture.asr.revision.id, 12);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: false });

    insertSummary(h, { contentId: members[1]?.contentId as string, transcriptRevisionId: members[1]?.transcriptRevisionId as string });
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: true, staleReason: "member_changed" });
    expect(await codeOf(() => h.collections.getSummary(BOB, collectionId))).toBe("not_found");
  });

  it("labels each partial with the members it covered, numbered in the revision's own order", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 3);
    const items = h.collections.get(LOCAL, collectionId).items;
    const inputItems = members.map((member, index) => ({
      collectionItemId: items[index]?.id as string,
      contentId: member.contentId,
      summaryRevisionId: member.summaryRevisionId as string,
      transcriptRevisionId: member.transcriptRevisionId,
      position: index * 3,
    }));
    const partialInputs = inputItems.slice(1).map((item) => ({ kind: "collectionItemSnapshot" as const, ...item }));
    insertCollectionSummary(h, collectionId, inputItems, LOCAL.userId, { partialInputs });
    expect(h.collections.getSummary(LOCAL, collectionId).current?.partials[0]?.itemRange).toEqual({ first: 2, last: 3 });

    // Reordering the live collection does not relabel what an existing revision covered.
    h.collections.reorder(LOCAL, collectionId, [items[2]?.id as string, items[1]?.id as string, items[0]?.id as string]);
    expect(h.collections.getSummary(LOCAL, collectionId).current?.partials[0]?.itemRange).toEqual({ first: 2, last: 3 });
  });

  it("leaves the range out when a partial's inputs do not name its members", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 1);
    const items = h.collections.get(LOCAL, collectionId).items;
    const member = members[0] as (typeof members)[number];
    insertCollectionSummary(h, collectionId, [
      { collectionItemId: items[0]?.id as string, contentId: member.contentId, summaryRevisionId: member.summaryRevisionId as string, transcriptRevisionId: member.transcriptRevisionId, position: 0 },
    ]);
    expect(h.collections.getSummary(LOCAL, collectionId).current?.partials[0]).not.toHaveProperty("itemRange");
  });
});

describe("deleting the collection summary", () => {
  /** A collection of two whose summary has two revisions (the later current), each with a partial and usage. */
  async function summarised(h: Harness) {
    const { collectionId, members } = await collectionOf(h, 2);
    const items = h.collections.get(LOCAL, collectionId).items;
    const inputItems = () =>
      members.map((member, index) => ({
        collectionItemId: items[index]?.id as string,
        contentId: member.contentId,
        summaryRevisionId: currentSummaryOf(h, member.contentId) as string,
        transcriptRevisionId: member.transcriptRevisionId,
        position: index,
      }));
    const older = insertCollectionSummary(h, collectionId, inputItems());
    // The first member's core summary moves on; the older collection summary keeps its earlier revision frozen.
    const first = members[0] as (typeof members)[number];
    const newer = insertSummary(h, { contentId: first.contentId, transcriptRevisionId: first.transcriptRevisionId, createdAt: 30 });
    const latest = insertCollectionSummary(h, collectionId, inputItems());
    for (const [id, revisionId] of [
      ["usage-older", older.revisionId],
      ["usage-latest", latest.revisionId],
      ["usage-partial", latest.partialId],
    ] as const) {
      insertRow(h.db, "token_usage", {
        id,
        user_id: LOCAL.userId,
        model_ref_json: "{}",
        feature: "collection_summary",
        artifact_revision_id: revisionId,
        outcome: "succeeded",
        created_at: 10,
      });
    }
    return { collectionId, first, older, newer, latest, coreArtifactId: newer.artifactId };
  }

  function currentSummaryOf(h: Harness, contentId: string): string | undefined {
    return h.repository.withTransaction((scope) => scope.summaries.findArtifact(LOCAL.userId, contentId, "summary.core")?.currentRevisionId);
  }

  it("removes every revision, partial and the artifact, keeps usage unlinked and frees the member summaries it froze", async () => {
    const h = harness();
    const { collectionId, first, newer, latest, coreArtifactId } = await summarised(h);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ current: { id: latest.revisionId } });
    expect(countRows(h.db, "collection_summary_revision")).toBe(2);
    expect(countRows(h.db, "rollup_partial", "collection_summary_revision_id IS NOT NULL")).toBe(2);
    expect(h.summaries.revisions(LOCAL, coreArtifactId).frozenRevisionIds).toEqual([first.summaryRevisionId]);
    h.db.prepare("UPDATE collection SET updated_at = ? WHERE id = ?").run(777, collectionId);

    h.collections.deleteSummary(LOCAL, collectionId);
    expect(countRows(h.db, "collection_summary_artifact")).toBe(0);
    expect(countRows(h.db, "collection_summary_revision")).toBe(0);
    expect(countRows(h.db, "rollup_partial", "collection_summary_revision_id IS NOT NULL")).toBe(0);
    expect(countRows(h.db, "token_usage")).toBe(3);
    expect(countRows(h.db, "token_usage", "artifact_revision_id IS NULL")).toBe(3);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
    expect(h.summaries.revisions(LOCAL, coreArtifactId).frozenRevisionIds).toEqual([]);
    expect(h.collections.get(LOCAL, collectionId).updatedAt).toBe(777);
    expect(h.collections.getSummary(LOCAL, collectionId)).toEqual({ stale: false });
    expect(h.repository.withTransaction((scope) => scope.tasks.listByCollection(LOCAL.userId, collectionId))).toEqual([]);
    // The member summary the older revision froze can be deleted now.
    expect(h.summaries.deleteRevision(LOCAL, coreArtifactId, first.summaryRevisionId as string).items.map((item) => item.id)).toEqual([newer.revisionId]);
    // Once gone there is nothing to delete: a second (or concurrent) request is not_found.
    expect(await codeOf(() => h.collections.deleteSummary(LOCAL, collectionId))).toBe("not_found");
  });

  it("is not_found without a summary, for another owner (deleting nothing) and for an unknown collection", async () => {
    const h = harness();
    const bare = await collectionOf(h, 1);
    expect(await codeOf(() => h.collections.deleteSummary(LOCAL, bare.collectionId))).toBe("not_found");
    const { collectionId, latest } = await summarised(h);
    expect(await codeOf(() => h.collections.deleteSummary(BOB, collectionId))).toBe("not_found");
    expect(await codeOf(() => h.collections.deleteSummary(LOCAL, "missing"))).toBe("not_found");
    expect(countRows(h.db, "collection_summary_revision")).toBe(2);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ current: { id: latest.revisionId } });
  });

  it("refuses while a summary Task is unfinished and goes once it is cancelled", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const { collectionId } = await summarised(h);
    const { body } = await h.collections.createSummary(LOCAL, collectionId, { modelRef });
    expect(await codeOf(() => h.collections.deleteSummary(LOCAL, collectionId))).toBe("conflict.tasks_unfinished");
    expect(countRows(h.db, "collection_summary_revision")).toBe(2);
    h.tasks.cancel(LOCAL, body.taskId);
    h.collections.deleteSummary(LOCAL, collectionId);
    expect(countRows(h.db, "collection_summary_artifact")).toBe(0);
    // The finished Task's record stays.
    expect(taskOf(h, body.taskId).kind).toBe("summarize_collection");
  });
});

describe("collections and the trash", () => {
  it("leaves a trashed member out of the members, the count and the summary input, and gives it back its slot on restore", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 3);
    const ids = h.collections.get(LOCAL, collectionId).items.map((item) => item.id);
    h.trash.trash(LOCAL, members[1]?.contentId as string);
    expect(h.collections.get(LOCAL, collectionId)).toMatchObject({ itemCount: 2, items: [{ id: ids[0], position: 0 }, { id: ids[2], position: 2 }] });
    expect(h.collections.list(LOCAL).items[0]?.itemCount).toBe(2);

    // Adding a member never reuses the hidden member's position.
    const added = (await h.collections.addItem(LOCAL, collectionId, { contentId: createLocalContent(h) })).body as { id: string; position: number };
    expect(added.position).toBe(3);
    // A reorder names the visible items only and stays within their slots.
    expect(await codeOf(() => h.collections.reorder(LOCAL, collectionId, [ids[0], ids[1], ids[2], added.id] as string[]))).toBe("invalid_request");
    const reordered = h.collections.reorder(LOCAL, collectionId, [added.id, ids[2], ids[0]] as string[]);
    expect(reordered.items.map((item) => [item.id, item.position])).toEqual([[added.id, 0], [ids[2], 2], [ids[0], 3]]);
    // Removing the hidden member is as unknown as any other id.
    expect(await codeOf(() => h.collections.removeItem(LOCAL, collectionId, ids[1] as string))).toBe("not_found");

    h.trash.restore(LOCAL, members[1]?.contentId as string);
    expect(h.collections.get(LOCAL, collectionId).items.map((item) => [item.id, item.position])).toEqual([
      [added.id, 0],
      [ids[1], 1],
      [ids[2], 2],
      [ids[0], 3],
    ]);
  });

  it("summarises only the visible members", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const { collectionId, members } = await collectionOf(h, 2, [1]);
    // The member without a core summary is in the trash: not missing, just not there.
    h.trash.trash(LOCAL, members[1]?.contentId as string);
    const { body } = await h.collections.createSummary(LOCAL, collectionId, { modelRef });
    expect(JSON.parse(taskOf(h, body.taskId).requestJson).inputItems.map((item: { contentId: string }) => item.contentId)).toEqual([members[0]?.contentId]);
  });

  it("withholds the current summary while a member it summarised is in the trash, shows it after restore, and stale after a purge", async () => {
    const h = harness();
    const { collectionId, members } = await collectionOf(h, 2);
    const items = h.collections.get(LOCAL, collectionId).items;
    const inputItems = members.map((member, index) => ({
      collectionItemId: items[index]?.id as string,
      contentId: member.contentId,
      summaryRevisionId: member.summaryRevisionId as string,
      transcriptRevisionId: member.transcriptRevisionId,
      position: index,
    }));
    const { artifactId, revisionId } = insertCollectionSummary(h, collectionId, inputItems);
    const markdown = async () => {
      let text = "";
      for await (const chunk of h.exports.exportCollection(LOCAL, collectionId, { backlinks: false }).body) text += chunk;
      return text;
    };
    expect(await markdown()).toContain("这门课在讲什么");

    h.trash.trash(LOCAL, members[1]?.contentId as string);
    expect(h.collections.getSummary(LOCAL, collectionId)).toEqual({ artifactId, stale: true, staleReason: "member_changed", hiddenReason: "member_trashed" });
    const hidden = await markdown();
    expect(hidden).not.toContain("这门课在讲什么");
    expect(hidden).toContain("合集归纳暂不可用");

    h.trash.restore(LOCAL, members[1]?.contentId as string);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: false, current: { id: revisionId } });

    h.trash.trash(LOCAL, members[1]?.contentId as string);
    await h.trash.purge(LOCAL, members[1]?.contentId as string);
    expect(h.collections.getSummary(LOCAL, collectionId)).toMatchObject({ stale: true, staleReason: "member_changed", current: { id: revisionId } });
    expect(h.collections.getSummary(LOCAL, collectionId)).not.toHaveProperty("hiddenReason");
    expect(await markdown()).toContain("这门课在讲什么");
  });
});
