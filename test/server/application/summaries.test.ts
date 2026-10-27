import { afterEach, describe, expect, it } from "vitest";
import { UI_LANGUAGE_DEFAULT } from "../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { BOB, configureLlm, createHarness, createLocalContent, LOCAL, taskOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import { insertCollectionSummary, insertSummary, seedTranscripts } from "../../fixtures/pipeline/summary-data.ts";
import { countRows, insertRow } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = seedTranscripts(h, contentId);
  return { h, contentId, fixture };
}

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

function aiChapters(h: Harness, contentId: string, transcriptRevisionId: string, segmentId: SegmentId): string {
  const id = h.newId();
  h.repository.withTransaction((scope) => {
    scope.chapters.insertAiRevision(LOCAL.userId, contentId, {
      id,
      artifactId: h.newId(),
      transcriptRevisionId,
      chapters: [{ startMs: 0, endMs: 1000, title: "One", startSegmentId: segmentId }],
      modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
      promptRef: { id: "chapter.ai", version: 1 },
      promptSnapshot: "x",
      quality: "normal",
      createdAt: 3,
    });
    scope.chapters.setCurrent(LOCAL.userId, contentId, id);
  });
  return id;
}

describe("listing a Content's summaries", () => {
  it("lists every builtin template and the current revision with quality reasons", () => {
    const { h, contentId, fixture } = setup();
    const segment = fixture.asr.segments[0];
    const { artifactId, revisionId } = insertSummary(h, {
      contentId,
      transcriptRevisionId: fixture.asr.revision.id,
      citations: [{ transcriptRevisionId: fixture.asr.revision.id, segmentId: segment?.id as SegmentId }],
      quality: "degraded",
    });
    const { templates } = h.summaries.list(LOCAL, contentId);
    expect(templates.map((entry) => entry.template.id)).toEqual(["summary.core", "summary.detailed", "summary.terms"]);
    expect(templates[0]).toMatchObject({
      artifactId,
      stale: false,
      current: {
        id: revisionId,
        transcriptRevisionId: fixture.asr.revision.id,
        quality: "degraded",
        qualityReasons: ["citation_degraded"],
        citations: [{ segmentId: segment?.id }],
        promptRef: { id: "summary.core", version: 1 },
        stale: false,
      },
    });
    expect(templates[1]).toEqual({ template: expect.objectContaining({ id: "summary.detailed" }), stale: false });
  });

  it("derives transcript_changed and chapters_changed without touching the revision", () => {
    const { h, contentId, fixture } = setup();
    const chapterId = aiChapters(h, contentId, fixture.asr.revision.id, fixture.asr.segments[0]?.id as SegmentId);
    insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, chapterRevisionId: chapterId });
    expect(h.summaries.list(LOCAL, contentId).templates[0]).toMatchObject({ stale: false });

    aiChapters(h, contentId, fixture.asr.revision.id, fixture.asr.segments[1]?.id as SegmentId);
    expect(h.summaries.list(LOCAL, contentId).templates[0]).toMatchObject({ stale: true, staleReason: "chapters_changed", current: { stale: true } });

    // A primary proofread from the summary's transcript is the same lineage: only the chapters still differ.
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.corrected.revision.id, 5));
    expect(h.summaries.list(LOCAL, contentId).templates[0]).toMatchObject({ stale: true, staleReason: "chapters_changed" });

    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.platform.revision.id, 6));
    expect(h.summaries.list(LOCAL, contentId).templates[0]).toMatchObject({ stale: true, staleReason: "transcript_changed" });
  });

  it("stays fresh when the primary is edited from the summary's transcript", () => {
    const { h, contentId, fixture } = setup();
    insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.corrected.revision.id, 5));
    expect(h.summaries.list(LOCAL, contentId).templates[0]).toMatchObject({ stale: false, current: { stale: false } });
  });

  it("keeps showing a deleted template that already produced a summary of this Content", () => {
    const { h, contentId, fixture } = setup();
    const kept = h.summaryTemplates.create(LOCAL, { name: "Kept", prompt: "x" });
    const unused = h.summaryTemplates.create(LOCAL, { name: "Unused", prompt: "x" });
    insertSummary(h, { contentId, templateId: kept.id, transcriptRevisionId: fixture.asr.revision.id });
    h.summaryTemplates.delete(LOCAL, kept.id);
    h.summaryTemplates.delete(LOCAL, unused.id);
    const listed = h.summaries.list(LOCAL, contentId).templates.map((entry) => entry.template);
    expect(listed.find((template) => template.id === kept.id)).toMatchObject({ deleted: true });
    expect(listed.map((template) => template.id)).not.toContain(unused.id);
  });

  it("is the owner's only", async () => {
    const { h, contentId, fixture } = setup();
    const { artifactId } = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
    expect(await codeOf(() => h.summaries.list(BOB, contentId))).toBe("not_found");
    expect(await codeOf(() => h.summaries.revisions(BOB, artifactId))).toBe("not_found");
  });
});

describe("generating a summary", () => {
  it("freezes template version, primary and output language into a regenerate_summary Task at submission", async () => {
    const { h, contentId, fixture } = setup();
    const modelRef = configureLlm(h);
    const custom = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "v1" });
    const first = await h.summaries.create(LOCAL, contentId, { templateId: custom.id, modelRef });
    expect(first.status).toBe(202);
    const task = taskOf(h, first.body.taskId);
    expect(task.kind).toBe("regenerate_summary");
    expect(JSON.parse(task.requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "regenerate_summary",
      modelRef,
      outputLanguage: UI_LANGUAGE_DEFAULT,
      templateRef: { id: custom.id, version: 1 },
      baseRevisionId: fixture.asr.revision.id,
    });
    expect(h.summaries.list(LOCAL, contentId).templates.find((entry) => entry.template.id === custom.id)?.activeTaskId).toBe(first.body.taskId);

    h.summaryTemplates.patch(LOCAL, custom.id, { prompt: "v2" });
    await h.tasks.cancel(LOCAL, first.body.taskId);
    const second = await h.summaries.create(LOCAL, contentId, { templateId: custom.id, outputLanguage: "en" });
    expect(JSON.parse(taskOf(h, second.body.taskId).requestJson)).toMatchObject({ templateRef: { id: custom.id, version: 2 }, outputLanguage: "en" });
    // The first Task keeps the version it froze.
    expect(JSON.parse(taskOf(h, first.body.taskId).requestJson)).toMatchObject({ templateRef: { id: custom.id, version: 1 } });
  });

  it("conflicts only with unfinished work on the same template and replays an idempotent submission", async () => {
    const { h, contentId } = setup();
    const first = await h.summaries.create(LOCAL, contentId, { templateId: "summary.core" }, "key-1");
    expect(await codeOf(() => h.summaries.create(LOCAL, contentId, { templateId: "summary.core" }))).toBe("conflict.mutation_lane");
    const other = await h.summaries.create(LOCAL, contentId, { templateId: "summary.terms" });
    expect(other.status).toBe(202);
    const replay = await h.summaries.create(LOCAL, contentId, { templateId: "summary.core" }, "key-1");
    expect(replay.body).toEqual(first.body);
  });

  it("refuses a Content without primary, an unusable template and someone else's model or Content", async () => {
    const { h, contentId } = setup();
    const bare = createLocalContent(h);
    expect(await codeOf(() => h.summaries.create(LOCAL, bare, { templateId: "summary.core" }))).toBe("invalid_request");
    expect(await codeOf(() => h.summaries.create(LOCAL, contentId, { templateId: "nope" }))).toBe("invalid_request");
    const bobsModel = configureLlm(h, BOB.userId);
    expect(await codeOf(() => h.summaries.create(LOCAL, contentId, { templateId: "summary.core", modelRef: bobsModel }))).toBe("invalid_request");
    expect(await codeOf(() => h.summaries.create(BOB, contentId, { templateId: "summary.core" }))).toBe("not_found");
    expect(h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId))).toEqual([]);
  });

  it("refuses new work below the disk low-water mark", async () => {
    const { h, contentId } = setup();
    h.disk.low();
    expect(await codeOf(() => h.summaries.create(LOCAL, contentId, { templateId: "summary.core" }))).toBe("disk_low");
  });
});

describe("revisions and current", () => {
  it("lists revisions oldest first and switches current within the artifact only", async () => {
    const { h, contentId, fixture } = setup();
    const older = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 10 });
    const newer = insertSummary(h, { contentId, transcriptRevisionId: fixture.corrected.revision.id, createdAt: 11 });
    expect(newer.artifactId).toBe(older.artifactId);
    const list = h.summaries.revisions(LOCAL, older.artifactId);
    expect(list).toMatchObject({ artifactId: older.artifactId, currentRevisionId: newer.revisionId });
    expect(list.items.map((item) => [item.id, item.stale])).toEqual([
      [older.revisionId, false],
      [newer.revisionId, true],
    ]);
    expect(h.summaries.setCurrent(LOCAL, older.artifactId, older.revisionId).currentRevisionId).toBe(older.revisionId);

    const other = insertSummary(h, { contentId, templateId: "summary.terms", transcriptRevisionId: fixture.asr.revision.id });
    expect(await codeOf(() => h.summaries.setCurrent(LOCAL, older.artifactId, other.revisionId))).toBe("not_found");
    expect(await codeOf(() => h.summaries.setCurrent(BOB, older.artifactId, older.revisionId))).toBe("not_found");
  });
});

describe("deleting one earlier summary revision", () => {
  async function errorOf(work: () => unknown): Promise<{ code: string; details?: unknown } | undefined> {
    try {
      await work();
    } catch (error) {
      return isAmberError(error) ? { code: error.appError.code, ...(error.appError.details === undefined ? {} : { details: error.appError.details }) } : { code: String(error) };
    }
    return undefined;
  }

  it("deletes it with its partials, keeps usage with the link cleared, and frees the transcript it alone cited", async () => {
    const h = createHarness();
    open.push(h);
    const contentId = createLocalContent(h);
    const fixture = seedTranscripts(h, contentId);
    const segment = fixture.corrected.segments[0];
    // The earlier revision is the only thing citing the proofread transcript.
    const older = insertSummary(h, { contentId, transcriptRevisionId: fixture.corrected.revision.id, citations: [{ transcriptRevisionId: fixture.corrected.revision.id, segmentId: segment?.id as SegmentId }], createdAt: 10 });
    const current = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 20 });
    expect(current.artifactId).toBe(older.artifactId);
    insertRow(h.db, "rollup_partial", {
      id: "rp",
      summary_revision_id: older.revisionId,
      partial_index: 0,
      inputs_json: "[]",
      body: "分段",
      citations_json: "[]",
      model_ref_json: "{}",
      prompt_ref_json: "{}",
      prompt_snapshot: "",
      created_at: 10,
    });
    insertRow(h.db, "token_usage", {
      id: "usage",
      user_id: LOCAL.userId,
      model_ref_json: "{}",
      feature: "summary",
      artifact_revision_id: older.revisionId,
      content_id: contentId,
      outcome: "succeeded",
      created_at: 10,
    });
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.asr.revision.id, 30));
    const corrected = () => h.contents.revisions(LOCAL, contentId).revisions.find((item) => item.id === fixture.corrected.revision.id);
    expect(corrected()?.blockers.history).toBe(1);

    const listed = h.summaries.revisions(LOCAL, older.artifactId);
    expect(listed.frozenRevisionIds).toEqual([]);
    const after = h.summaries.deleteRevision(LOCAL, older.artifactId, older.revisionId);
    expect(after.items.map((item) => item.id)).toEqual([current.revisionId]);
    expect(after.currentRevisionId).toBe(current.revisionId);
    expect(countRows(h.db, "rollup_partial", "id = 'rp'")).toBe(0);
    expect(h.db.prepare("SELECT artifact_revision_id FROM token_usage WHERE id = 'usage'").get()).toEqual({ artifact_revision_id: null });
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
    expect(corrected()).toMatchObject({ blockers: { history: 0 }, historyArtifacts: [] });
  });

  it("refuses the current revision, one a collection summary was built from, and another owner's, deleting nothing", async () => {
    const h = createHarness();
    open.push(h);
    const contentId = createLocalContent(h);
    const fixture = seedTranscripts(h, contentId);
    const frozen = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 10 });
    const current = insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id, createdAt: 20 });
    const collection = h.collections.create(LOCAL, { name: "Course" });
    await h.collections.addItem(LOCAL, collection.id, { contentId });
    const item = h.collections.get(LOCAL, collection.id).items[0];
    insertCollectionSummary(h, collection.id, [
      { collectionItemId: item?.id as string, contentId, summaryRevisionId: frozen.revisionId, transcriptRevisionId: fixture.asr.revision.id, position: 0 },
    ]);
    expect(h.summaries.revisions(LOCAL, frozen.artifactId).frozenRevisionIds).toEqual([frozen.revisionId]);

    expect(await errorOf(() => h.summaries.deleteRevision(LOCAL, current.artifactId, current.revisionId))).toEqual({
      code: "conflict.summary_revision_in_use",
      details: { reason: "current" },
    });
    expect(await errorOf(() => h.summaries.deleteRevision(LOCAL, frozen.artifactId, frozen.revisionId))).toEqual({
      code: "conflict.summary_revision_in_use",
      details: { reason: "collection_summary" },
    });
    expect((await errorOf(() => h.summaries.deleteRevision(BOB, frozen.artifactId, frozen.revisionId)))?.code).toBe("not_found");
    expect((await errorOf(() => h.summaries.deleteRevision(LOCAL, frozen.artifactId, "missing")))?.code).toBe("not_found");
    expect(countRows(h.db, "summary_revision")).toBe(2);
  });
});
