import { afterEach, describe, expect, it } from "vitest";
import { speakerRosterDigest } from "../../../src/server/application/speaker-review.ts";
import { SpeakerService } from "../../../src/server/application/speakers.ts";
import { ensureBuiltinSummaryTemplates } from "../../../src/server/application/summary-templates.ts";
import { DEFAULT_SUMMARY_TEMPLATE_ID } from "../../../src/server/domain/prompts.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { TranscriptGeneration, TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { TranscriptKind } from "../../../src/shared/enums.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const NOW = 1_800_000_000_000;
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function errorOf(work: () => unknown): { class: string; code: string } {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected an error");
}

/** A revision with one sentence per entry: [speaker or undefined, startMs, endMs]. */
function insertRevision(
  h: Harness,
  contentId: string,
  sentences: Array<[string | undefined, number, number]>,
  options: { kind?: TranscriptKind; parent?: { revision: TranscriptRevision; segments: TranscriptSegment[] }; generation?: TranscriptGeneration } = {},
): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const id = h.newId();
  const kind = options.kind ?? "asr";
  const revision: TranscriptRevision = {
    id, contentId, kind, ...(options.parent === undefined ? {} : { parentRevisionId: options.parent.revision.id }), language: kind === "translated" ? "en" : "zh-CN",
    timingFidelity: kind === "asr" ? "exact_words" : kind === "translated" ? "segment_only" : "inherited_segment",
    generation: options.generation ?? { kind: "asr", asrProfileId: "asr", modelId: "scribe" }, segmentCount: sentences.length, createdAt: 1,
  };
  const segments: TranscriptSegment[] = sentences.map(([speakerId, startMs, endMs], ordinal) => ({
    id: h.newId() as SegmentId, revisionId: id, ordinal, startMs, endMs, text: `第${ordinal + 1}句`,
    ...(speakerId === undefined ? {} : { speakerId }),
    sourceSegmentIds: options.parent === undefined ? [] : [options.parent.segments[ordinal]?.id as SegmentId],
  }));
  h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision, segments));
  return { revision, segments };
}

function setup() {
  const h = createHarness();
  open.push(h);
  let now = NOW;
  const service = new SpeakerService({ repository: h.repository, newId: h.newId, now: () => now });
  const contentId = createLocalContent(h);
  h.repository.withTransaction((scope) =>
    scope.speakers.insert(LOCAL.userId, contentId, [{ id: "S1", name: "蒋炎岩" }, { id: "S2" }, { id: "S3", name: "张伟", nameConfirmedAt: NOW - 50 }], NOW - 100),
  );
  const base = insertRevision(h, contentId, [["S1", 0, 1000], ["S2", 1000, 3000], [undefined, 3000, 4000], ["S1", 4000, 4500]]);
  return { h, service, contentId, base, tick: (ms: number) => (now += ms), speaker: (id: string) => h.repository.withTransaction((scope) => scope.speakers.get(LOCAL.userId, contentId, id)) };
}

describe("speaker review", () => {
  it("counts each speaker's sentences and time in order of first appearance, the unassigned ones and the unconfirmed names", () => {
    const { h, service, base } = setup();
    const review = service.review(LOCAL, base.revision.id);
    const roster = h.repository.withTransaction((scope) => scope.speakers.list(LOCAL.userId, base.revision.contentId)).filter((speaker) => speaker.id !== "S3");
    expect(review).toEqual({
      revisionId: base.revision.id,
      rosterDigest: speakerRosterDigest(roster),
      speakers: [
        { id: "S1", sentences: 2, assignedMs: 1500 },
        { id: "S2", sentences: 1, assignedMs: 2000 },
      ],
      unassigned: 1,
      pendingNames: 1,
    });
  });

  it("reports what a manual revision recorded and what the Content's draft still waits for", () => {
    const { h, service, contentId, base } = setup();
    const manual = insertRevision(h, contentId, [["S1", 0, 1000], ["S2", 1000, 3000], [undefined, 3000, 4000], ["S2", 4000, 4500]], {
      kind: "manual", parent: base, generation: { kind: "manual", speakerReview: { acceptedSuggestions: 2, changedFromParent: 1 } },
    });
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: manual.revision.id, expectedVersion: null,
      segments: manual.segments.map((segment, index) => ({
        startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id], speakerId: segment.speakerId ?? null,
        ...(index < 3 ? { speakerReview: "needs_review" as const } : {}),
      })),
    });
    expect(service.review(LOCAL, manual.revision.id)).toMatchObject({ acceptedSuggestions: 2, changedFromParent: 1, draftNeedsReview: 3 });
    // The draft is reported on every revision of the Content, not only on the one it was opened from.
    const fromBase = service.review(LOCAL, base.revision.id);
    expect(fromBase.draftNeedsReview).toBe(3);
    expect(fromBase).not.toHaveProperty("acceptedSuggestions");
  });

  it("reports no draft line without a draft, or when nothing in the draft waits for review", () => {
    const { h, service, contentId, base } = setup();
    expect(service.review(LOCAL, base.revision.id)).not.toHaveProperty("draftNeedsReview");
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: base.revision.id, expectedVersion: null,
      segments: base.segments.map((segment) => ({
        startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id], speakerId: segment.speakerId ?? null,
      })),
    });
    expect(service.review(LOCAL, base.revision.id)).not.toHaveProperty("draftNeedsReview");
  });

  it("refuses another user's revision, one in the trash, a translation and a revision without speakers", () => {
    const { h, service, contentId, base } = setup();
    expect(errorOf(() => service.review(BOB, base.revision.id)).class).toBe("not_found");
    expect(errorOf(() => service.setRevisionConfirmed(BOB, base.revision.id, { confirmed: false })).class).toBe("not_found");
    expect(errorOf(() => service.review(LOCAL, "missing")).class).toBe("not_found");
    const translated = insertRevision(h, contentId, [["S1", 0, 1000], ["S2", 1000, 3000], [undefined, 3000, 4000], ["S1", 4000, 4500]], {
      kind: "translated", parent: base, generation: { kind: "manual" },
    });
    expect(errorOf(() => service.review(LOCAL, translated.revision.id)).class).toBe("invalid_request");
    expect(errorOf(() => service.setRevisionConfirmed(LOCAL, translated.revision.id, { confirmed: false })).class).toBe("invalid_request");
    const silent = insertRevision(h, contentId, [[undefined, 0, 1000]]);
    expect(errorOf(() => service.review(LOCAL, silent.revision.id)).class).toBe("invalid_request");
    expect(errorOf(() => service.setRevisionConfirmed(LOCAL, silent.revision.id, { confirmed: true, expectedRosterDigest: "x" })).class).toBe("invalid_request");
    h.repository.withTransaction((scope) => scope.contents.trash(LOCAL.userId, contentId, NOW));
    expect(errorOf(() => service.review(LOCAL, base.revision.id)).class).toBe("not_found");
    expect(countRows(h.db, "transcript_revision_speaker_confirmation")).toBe(0);
  });
});

describe("confirming a revision's speakers", () => {
  it("refuses a roster that changed since it was shown, writing nothing", () => {
    const { h, service, base, speaker } = setup();
    const { rosterDigest } = service.review(LOCAL, base.revision.id);
    service.patch(LOCAL, base.revision.contentId, "S2", { name: "主持人" });
    const error = errorOf(() => service.setRevisionConfirmed(LOCAL, base.revision.id, { confirmed: true, expectedRosterDigest: rosterDigest }));
    expect(error).toMatchObject({ class: "conflict", code: "conflict.speakers_changed" });
    expect(countRows(h.db, "transcript_revision_speaker_confirmation")).toBe(0);
    expect(speaker("S1")?.nameConfirmedAt).toBeUndefined();
  });

  it("keeps the digest when speakers only another revision names come or change", () => {
    const { h, service, contentId, base } = setup();
    const { rosterDigest } = service.review(LOCAL, base.revision.id);
    h.repository.withTransaction((scope) => scope.speakers.insert(LOCAL.userId, contentId, [{ id: "C1", name: "对比" }], NOW));
    insertRevision(h, contentId, [["C1", 0, 1000], ["S3", 1000, 2000]], { generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe", purpose: "comparison" } });
    service.patch(LOCAL, contentId, "C1", { name: "另一个名字" });
    service.patch(LOCAL, contentId, "S3", { name: "李四" });
    expect(service.review(LOCAL, base.revision.id).rosterDigest).toBe(rosterDigest);
  });

  it("marks the revision and confirms every name it shows in one go; a name confirmed earlier keeps its time", () => {
    const { h, service, contentId, base, tick, speaker } = setup();
    const named = insertRevision(h, contentId, [["S1", 0, 1000], ["S3", 1000, 2000]]);
    const { rosterDigest } = service.review(LOCAL, named.revision.id);
    tick(10);
    const review = service.setRevisionConfirmed(LOCAL, named.revision.id, { confirmed: true, expectedRosterDigest: rosterDigest });
    expect(review).toMatchObject({ revisionId: named.revision.id, confirmedAt: NOW + 10, pendingNames: 0 });
    expect(review.rosterDigest).not.toBe(rosterDigest);
    expect(speaker("S1")?.nameConfirmedAt).toBe(NOW + 10);
    expect(speaker("S3")?.nameConfirmedAt).toBe(NOW - 50);
    expect(speaker("S2")?.nameConfirmedAt).toBeUndefined();
    const listed = h.contents.revisions(LOCAL, contentId).revisions;
    expect(listed.find((item) => item.id === named.revision.id)?.speakersConfirmedAt).toBe(NOW + 10);
    expect(listed.find((item) => item.id === base.revision.id)).not.toHaveProperty("speakersConfirmedAt");
    // The base names an unnamed speaker: confirming it leaves that one unnamed and unconfirmed.
    const again = service.setRevisionConfirmed(LOCAL, base.revision.id, { confirmed: true, expectedRosterDigest: service.review(LOCAL, base.revision.id).rosterDigest });
    expect(again.confirmedAt).toBe(NOW + 10);
    expect(speaker("S2")).not.toHaveProperty("nameConfirmedAt");
    // Confirming once more (another window that saw the same roster) keeps the first time.
    tick(10);
    const repeated = service.setRevisionConfirmed(LOCAL, named.revision.id, { confirmed: true, expectedRosterDigest: review.rosterDigest });
    expect(repeated.confirmedAt).toBe(NOW + 10);
  });

  it("withdraws the mark alone: names stay confirmed and nothing else is touched, results made with the speakers included", () => {
    const { h, service, contentId, base, speaker } = setup();
    service.setRevisionConfirmed(LOCAL, base.revision.id, { confirmed: true, expectedRosterDigest: service.review(LOCAL, base.revision.id).rosterDigest });
    // Results generated while the revision was reviewed, each recording the speakers it was given.
    const speakerContext = {
      version: 1 as const,
      rules: { id: "speaker.rules", version: 1 },
      attributionDigest: "d".repeat(64),
      speakers: [{ id: "S1", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" }, { id: "S2", ordinal: 2, label: "发言人 2" }],
    };
    const modelRef = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
    const first = base.segments[0]?.id as SegmentId;
    ensureBuiltinSummaryTemplates(h.repository, NOW);
    h.repository.withTransaction((scope) => {
      const { artifactId } = scope.summaries.insertRevision(LOCAL.userId, {
        contentId, templateId: DEFAULT_SUMMARY_TEMPLATE_ID, artifactId: h.newId(),
        revision: {
          id: "summary-1", quality: "normal", body: `正文 [[seg:${first}]]`, citations: [{ transcriptRevisionId: base.revision.id, segmentId: first }],
          provenance: { inputs: [{ kind: "transcriptRevision", id: base.revision.id }], modelRef, promptRef: { id: DEFAULT_SUMMARY_TEMPLATE_ID, version: 1 }, promptSnapshot: "p", speakerContext, createdAt: NOW },
        },
      });
      scope.summaries.setCurrent(LOCAL.userId, artifactId, "summary-1");
      scope.chapters.insertAiRevision(LOCAL.userId, contentId, {
        id: "chapter-1", artifactId: h.newId(), transcriptRevisionId: base.revision.id, chapters: [{ startMs: 0, endMs: 1000, title: "开场", startSegmentId: first }],
        modelRef, promptRef: { id: "chapter.ai", version: 1 }, promptSnapshot: "p", quality: "normal", speakerContext, createdAt: NOW,
      });
      scope.chapters.setCurrent(LOCAL.userId, contentId, "chapter-1");
      scope.highlights.insertRevision(LOCAL.userId, contentId, {
        id: "highlight-1", artifactId: h.newId(), transcriptRevisionId: base.revision.id, items: [{ segmentId: first, score: 90, text: "关键" }],
        modelRef, promptRef: { id: "highlight.default", version: 1 }, promptSnapshot: "p", quality: "normal", speakerContext, createdAt: NOW,
      });
      scope.highlights.setCurrent(LOCAL.userId, contentId, "highlight-1");
    });
    const tables = ["content_speaker", "summary_artifact", "summary_revision", "chapter_artifact", "chapter_revision", "highlight_artifact", "highlight_revision"];
    const snapshot = () => Object.fromEntries(tables.map((table) => [table, h.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    const before = snapshot();
    for (const table of ["summary_revision", "chapter_revision", "highlight_revision"]) {
      expect(h.db.prepare(`SELECT speaker_context_json FROM ${table}`).all()).toEqual([{ speaker_context_json: JSON.stringify(speakerContext) }]);
    }
    const withdrawn = service.setRevisionConfirmed(LOCAL, base.revision.id, { confirmed: false });
    expect(withdrawn).not.toHaveProperty("confirmedAt");
    expect(countRows(h.db, "transcript_revision_speaker_confirmation")).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(speaker("S1")?.nameConfirmedAt).toBe(NOW);
  });
});
