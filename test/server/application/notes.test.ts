import { afterEach, describe, expect, it } from "vitest";
import { NOTE_SPAN_MAX_SEGMENTS, NOTES_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";
import type { NoteCreateRequest } from "../../../src/shared/dto/note.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { NoteService } from "../../../src/server/application/notes.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../fixtures/transcripts/lecture.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content with the lecture's platform, ASR and corrected revisions; a clock the test moves. */
function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setMetadata(LOCAL.userId, contentId, { title: "检索增强生成" }, 2);
  });
  const clock = { now: 1_000 };
  const notes = new NoteService({ repository: h.repository, now: () => clock.now, newId: h.newId });
  return { h, contentId, fixture, clock, notes };
}

const seg = (fixture: TranscriptFixture, part: keyof TranscriptFixture, index: number): TranscriptSegment => {
  const segment = fixture[part].segments[index];
  if (segment === undefined) throw new Error(`no segment ${index}`);
  return segment;
};

function body(fixture: TranscriptFixture, overrides: Partial<NoteCreateRequest> = {}): NoteCreateRequest {
  const first = seg(fixture, "corrected", 0);
  return {
    transcriptRevisionId: fixture.corrected.revision.id,
    startSegmentId: first.id,
    startOffset: 4,
    endSegmentId: first.id,
    endOffset: 6,
    mark: "background",
    color: "yellow",
    ...overrides,
  };
}

function errorOf(work: () => unknown): { class: string; code: string; userMessage: string; details?: unknown } {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected an error");
}

/** A translation of the corrected revision, sentence for sentence. */
function addTranslation(h: Harness, fixture: TranscriptFixture): string {
  const id = h.newId();
  const segments: TranscriptSegment[] = fixture.corrected.segments.map((parent, ordinal) => ({
    id: h.newId() as SegmentId, revisionId: id, ordinal, startMs: parent.startMs, endMs: parent.endMs, text: `EN ${ordinal}`, sourceSegmentIds: [parent.id],
  }));
  h.repository.withTransaction((scope) =>
    scope.transcripts.insertRevision(
      LOCAL.userId,
      {
        id, contentId: fixture.corrected.revision.contentId, kind: "translated", parentRevisionId: fixture.corrected.revision.id, language: "en",
        timingFidelity: "segment_only", segmentCount: segments.length, createdAt: 9,
        generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "p", modelDisplaySnapshot: "m" }, promptRef: { id: "translate", version: 1 }, promptSnapshot: "…" },
      },
      segments,
    ),
  );
  return id;
}

describe("NoteService.create", () => {
  it("cuts the quote from the stored sentence and answers 201 with the display title and start time", () => {
    const { contentId, fixture, notes } = setup();
    const result = notes.create(LOCAL, contentId, body(fixture, { comment: "核心概念" }));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      contentId, contentTitle: "检索增强生成", quote: "今天", startMs: seg(fixture, "corrected", 0).startMs, comment: "核心概念", createdAt: 1_000, updatedAt: 1_000,
    });
  });

  it("joins a cross-sentence quote with the reading separator of the full sentences", () => {
    const { contentId, fixture, notes } = setup();
    const across = notes.create(LOCAL, contentId, body(fixture, { startOffset: 14, endSegmentId: seg(fixture, "corrected", 1).id, endOffset: 6 }));
    expect(across.body.quote).toBe("生成。也就是 RA");
    // Unpunctuated captions get a space between sentences.
    const captions = notes.create(LOCAL, contentId, {
      ...body(fixture), transcriptRevisionId: fixture.platform.revision.id, startSegmentId: seg(fixture, "platform", 0).id, startOffset: 14,
      endSegmentId: seg(fixture, "platform", 1).id, endOffset: 3,
    });
    expect(captions.body.quote).toBe("生成 也就是");
  });

  it("replays the same key and body, refuses the same key with another body, and creates anew without a key", () => {
    const { h, contentId, fixture, notes } = setup();
    const first = notes.create(LOCAL, contentId, body(fixture), "note-key-1");
    const again = notes.create(LOCAL, contentId, body(fixture), "note-key-1");
    expect(again).toEqual({ ...first, replayed: true });
    expect(errorOf(() => notes.create(LOCAL, contentId, body(fixture, { color: "blue" }), "note-key-1")).class).toBe("idempotency_conflict");
    notes.create(LOCAL, contentId, body(fixture));
    expect(h.repository.withTransaction((scope) => scope.notes.countByContent(LOCAL.userId, contentId))).toBe(2);
  });

  it("refuses anchors outside the revision, on a translation or out of order as note_anchor", () => {
    const { h, contentId, fixture, notes } = setup();
    const translated = addTranslation(h, fixture);
    const second = seg(fixture, "corrected", 1);
    for (const bad of [
      body(fixture, { transcriptRevisionId: translated, startSegmentId: seg(fixture, "corrected", 0).id }),
      body(fixture, { startSegmentId: seg(fixture, "asr", 0).id }),
      body(fixture, { endSegmentId: "01J0000000000000000000NOPE" }),
      body(fixture, { startSegmentId: second.id, endSegmentId: seg(fixture, "corrected", 0).id }),
      body(fixture, { startOffset: 6, endOffset: 6 }),
      body(fixture, { endOffset: 99 }),
    ]) {
      expect(errorOf(() => notes.create(LOCAL, contentId, bad)).code).toBe("invalid_request.note_anchor");
    }
    // A revision of another Content is not found, like an unknown one.
    const other = createLocalContent(h);
    const otherFixture = lectureTranscripts(other);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, otherFixture.asr.revision, otherFixture.asr.segments));
    expect(errorOf(() => notes.create(LOCAL, contentId, body(fixture, { transcriptRevisionId: otherFixture.asr.revision.id }))).class).toBe("not_found");
    expect(h.repository.withTransaction((scope) => scope.notes.countByContent(LOCAL.userId, contentId))).toBe(0);
  });

  it("refuses more than NOTE_SPAN_MAX_SEGMENTS sentences and more than NOTES_PER_CONTENT_MAX notes", () => {
    const { h, contentId, notes } = setup();
    const long = h.newId();
    const segments: TranscriptSegment[] = Array.from({ length: NOTE_SPAN_MAX_SEGMENTS + 1 }, (_, ordinal) => ({
      id: h.newId() as SegmentId, revisionId: long, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 1000, text: `句子${ordinal}。`, sourceSegmentIds: [],
    }));
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: long, contentId, kind: "imported", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: segments.length, createdAt: 9 },
        segments,
      ),
    );
    const span = (last: number): NoteCreateRequest => ({
      transcriptRevisionId: long, startSegmentId: segments[0]?.id as string, startOffset: 0, endSegmentId: segments[last]?.id as string, endOffset: 1, mark: "underline", color: "blue",
    });
    expect(errorOf(() => notes.create(LOCAL, contentId, span(NOTE_SPAN_MAX_SEGMENTS)))).toMatchObject({ code: "invalid_request.note_span", details: { limit: NOTE_SPAN_MAX_SEGMENTS } });
    const widest = notes.create(LOCAL, contentId, span(NOTE_SPAN_MAX_SEGMENTS - 1));
    expect(widest.body.quote.startsWith("句子0。句子1。")).toBe(true);

    h.repository.withTransaction((scope) => {
      for (let n = 1; n < NOTES_PER_CONTENT_MAX; n += 1) {
        scope.notes.insert({
          id: h.newId(), userId: LOCAL.userId, contentId, transcriptRevisionId: long, startSegmentId: segments[0]?.id as string, startOffset: 0,
          endSegmentId: segments[0]?.id as string, endOffset: 1, quote: "句", mark: "underline", color: "blue", createdAt: n, updatedAt: n,
        });
      }
    });
    expect(errorOf(() => notes.create(LOCAL, contentId, span(0)))).toMatchObject({ code: "invalid_request.note_limit", details: { limit: NOTES_PER_CONTENT_MAX } });
  });

  it("answers not_found for another user's Content before anything is written or replayed", () => {
    const { h, contentId, fixture, notes } = setup();
    notes.create(LOCAL, contentId, body(fixture), "shared-key");
    expect(errorOf(() => notes.create(BOB, contentId, body(fixture), "shared-key")).class).toBe("not_found");
    expect(errorOf(() => notes.create(BOB, contentId, body(fixture))).class).toBe("not_found");
    expect(h.repository.withTransaction((scope) => scope.notes.countByContent(LOCAL.userId, contentId))).toBe(1);
  });
});

describe("NoteService.patch / delete", () => {
  it("changes mark, colour and comment, bumps updatedAt, clears a comment with null and keeps the anchor", () => {
    const { contentId, fixture, clock, notes } = setup();
    const created = notes.create(LOCAL, contentId, body(fixture, { comment: "旧" })).body;
    clock.now = 2_000;
    const patched = notes.patch(LOCAL, created.id, { mark: "underline", color: "purple" });
    expect(patched).toEqual({ ...created, mark: "underline", color: "purple", updatedAt: 2_000 });
    clock.now = 3_000;
    const cleared = notes.patch(LOCAL, created.id, { comment: null });
    expect(cleared.comment).toBeUndefined();
    expect(cleared.updatedAt).toBe(3_000);
    expect(notes.patch(LOCAL, created.id, { comment: "新" }).comment).toBe("新");
  });

  it("answers not_found for another user's or a missing note", () => {
    const { contentId, fixture, notes } = setup();
    const created = notes.create(LOCAL, contentId, body(fixture)).body;
    expect(errorOf(() => notes.patch(BOB, created.id, { color: "green" })).class).toBe("not_found");
    expect(errorOf(() => notes.delete(BOB, created.id)).class).toBe("not_found");
    notes.delete(LOCAL, created.id);
    expect(errorOf(() => notes.delete(LOCAL, created.id)).class).toBe("not_found");
    expect(errorOf(() => notes.patch(LOCAL, created.id, { color: "green" })).class).toBe("not_found");
  });
});

describe("NoteService.list", () => {
  it("lists in reading order and, for another revision, says where each note shows", () => {
    const { h, contentId, fixture, clock, notes } = setup();
    // Sentence 1 was proofread ("瑞格" → "RAG"); sentence 0 was left as it was.
    const changed = notes.create(LOCAL, contentId, body(fixture, { startSegmentId: seg(fixture, "corrected", 1).id, endSegmentId: seg(fixture, "corrected", 1).id, startOffset: 0, endOffset: 3 })).body;
    clock.now = 2_000;
    const unchanged = notes.create(LOCAL, contentId, body(fixture)).body;
    const plain = notes.list(LOCAL, contentId);
    expect(plain.items.map((item) => item.id)).toEqual([unchanged.id, changed.id]);
    expect(plain.items.every((item) => !("view" in item))).toBe(true);

    const onAsr = notes.list(LOCAL, contentId, fixture.asr.revision.id).items;
    expect(onAsr[0]?.view).toEqual({ segments: [{ segmentId: seg(fixture, "asr", 0).id, startOffset: 4, endOffset: 6 }], exact: true });
    expect(onAsr[1]?.view).toEqual({ segments: [{ segmentId: seg(fixture, "asr", 1).id, startOffset: 0, endOffset: seg(fixture, "asr", 1).text.length }], exact: false });
    // Platform captions share no ancestor with the proofread: matched by time, whole sentences.
    const onPlatform = notes.list(LOCAL, contentId, fixture.platform.revision.id).items;
    expect(onPlatform[0]?.view).toEqual({ segments: [{ segmentId: seg(fixture, "platform", 0).id, startOffset: 0, endOffset: seg(fixture, "platform", 0).text.length }], exact: false });
    expect(notes.list(LOCAL, contentId, fixture.corrected.revision.id).items[0]?.view?.exact).toBe(true);

    expect(errorOf(() => notes.list(LOCAL, contentId, addTranslation(h, fixture))).class).toBe("invalid_request");
    const other = createLocalContent(h);
    const otherFixture = lectureTranscripts(other);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, otherFixture.asr.revision, otherFixture.asr.segments));
    expect(errorOf(() => notes.list(LOCAL, contentId, otherFixture.asr.revision.id)).class).toBe("not_found");
    expect(errorOf(() => notes.list(BOB, contentId)).class).toBe("not_found");
  });

  it("shows nothing where a manual edit dropped the sentence, and both pieces of a split one", () => {
    const { h, contentId, fixture, notes } = setup();
    const manual = h.newId();
    const [a, b] = fixture.corrected.segments;
    const pieces: TranscriptSegment[] = [
      { id: h.newId() as SegmentId, revisionId: manual, ordinal: 0, startMs: 120, endMs: 2000, text: "大家好，", sourceSegmentIds: [a?.id as SegmentId] },
      { id: h.newId() as SegmentId, revisionId: manual, ordinal: 1, startMs: 2000, endMs: 4100, text: "今天我们来讲检索增强生成。", sourceSegmentIds: [a?.id as SegmentId] },
      // Retyped over the time of sentence 1, without a link to it.
      { id: h.newId() as SegmentId, revisionId: manual, ordinal: 2, startMs: 4300, endMs: 9700, text: "全新的一句。", sourceSegmentIds: [] },
    ];
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: manual, contentId, kind: "manual", parentRevisionId: fixture.corrected.revision.id, language: "zh-CN", timingFidelity: "inherited_segment", generation: { kind: "manual" }, segmentCount: 3, createdAt: 9 },
        pieces,
      ),
    );
    notes.create(LOCAL, contentId, body(fixture, { startOffset: 0, endOffset: 17 }));
    notes.create(LOCAL, contentId, body(fixture, { startSegmentId: b?.id as string, endSegmentId: b?.id as string, startOffset: 0, endOffset: 3 }));
    const views = notes.list(LOCAL, contentId, manual).items.map((item) => item.view);
    expect(views[0]?.segments.map((segment) => segment.segmentId)).toEqual([pieces[0]?.id, pieces[1]?.id]);
    expect(views[1]).toBeNull();
  });
});

describe("NoteService.groups", () => {
  it("lists Contents with notes latest first, pages with a cursor and counts groups, not notes", () => {
    const { h, contentId, fixture, clock, notes } = setup();
    const second = createLocalContent(h);
    const secondFixture = lectureTranscripts(second);
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, secondFixture.asr.revision, secondFixture.asr.segments);
      scope.contents.setCustomTitle(LOCAL.userId, second, "我的标题", 3);
    });
    notes.create(LOCAL, contentId, body(fixture));
    clock.now = 2_000;
    notes.create(LOCAL, contentId, body(fixture, { color: "green" }));
    clock.now = 3_000;
    notes.create(LOCAL, second, { ...body(fixture), transcriptRevisionId: secondFixture.asr.revision.id, startSegmentId: seg(secondFixture, "asr", 0).id, endSegmentId: seg(secondFixture, "asr", 0).id });

    const firstPage = notes.groups(LOCAL, { limit: 1 });
    expect(firstPage).toMatchObject({ items: [{ contentId: second, title: "我的标题", count: 1, latestAt: 3_000 }], total: 2 });
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = notes.groups(LOCAL, { limit: 1, cursor: firstPage.nextCursor as string });
    expect(secondPage).toEqual({ items: [{ contentId, title: "检索增强生成", count: 2, latestAt: 2_000 }], total: 2 });
    expect(errorOf(() => notes.groups(LOCAL, { limit: 1, cursor: "not-a-cursor" })).class).toBe("invalid_request");
    expect(notes.groups(BOB, { limit: 10 })).toEqual({ items: [], total: 0 });
  });

  /** One more Content per clock value, each with a single note created at that moment. */
  function contentsWithNotes(h: Harness, notes: NoteService, clock: { now: number }, times: number[]): string[] {
    return times.map((at) => {
      const contentId = createLocalContent(h);
      const fixture = lectureTranscripts(contentId);
      h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, fixture.asr.revision, fixture.asr.segments));
      clock.now = at;
      const first = seg(fixture, "asr", 0).id;
      notes.create(LOCAL, contentId, { ...body(fixture), transcriptRevisionId: fixture.asr.revision.id, startSegmentId: first, endSegmentId: first });
      return contentId;
    });
  }

  it("pages by number in the cursor's order, ties included, with no nextCursor and an empty page past the end", () => {
    const { h, clock, notes } = setup();
    // Two pairs share their latestAt, so only the contentId keeps them apart.
    contentsWithNotes(h, notes, clock, [2_000, 2_000, 3_000, 3_000, 4_000]);
    const everything = notes.groups(LOCAL, { limit: 10 }).items.map((group) => group.contentId);
    expect(everything).toHaveLength(5);

    const pageOne = notes.groups(LOCAL, { limit: 2, page: 1 });
    const { nextCursor, ...cursorFirst } = notes.groups(LOCAL, { limit: 2 });
    expect(nextCursor).toBeDefined();
    expect(pageOne).toEqual(cursorFirst);
    expect(pageOne).not.toHaveProperty("nextCursor");
    const pages = [1, 2, 3].map((page) => notes.groups(LOCAL, { limit: 2, page }));
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((page) => page.items.map((group) => group.contentId))).toEqual(everything);
    expect(pages.every((page) => page.total === 5 && !("nextCursor" in page))).toBe(true);
    expect(notes.groups(LOCAL, { limit: 2, page: 4 })).toEqual({ items: [], total: 5 });
    expect(notes.groups(LOCAL, { limit: 5, page: 2 })).toEqual({ items: [], total: 5 });

    // The cursor path walks the same order as before.
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = notes.groups(LOCAL, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      walked.push(...page.items.map((group) => group.contentId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(walked).toEqual(everything);
  });

  it("counts first in one transaction: no groups or a page past the end never lists, and page excludes cursor", () => {
    const { h, clock, notes: plain } = setup();
    contentsWithNotes(h, plain, clock, [2_000, 3_000, 4_000]);
    const calls: string[] = [];
    let transactions = 0;
    const repository: Repository = {
      withTransaction: (work) =>
        h.repository.withTransaction((scope) => {
          transactions += 1;
          const notes = {
            ...scope.notes,
            listGroups: (owner: string, position: Parameters<typeof scope.notes.listGroups>[1]) => {
              calls.push(`listGroups ${JSON.stringify(position)}`);
              return scope.notes.listGroups(owner, position);
            },
            countGroups: (owner: string) => {
              calls.push("countGroups");
              return scope.notes.countGroups(owner);
            },
          };
          return work({ ...scope, notes });
        }),
    };
    const notes = new NoteService({ repository });

    expect(notes.groups(LOCAL, { limit: 2, page: 2 }).items).toHaveLength(1);
    expect([calls.splice(0), transactions]).toEqual([["countGroups", 'listGroups {"limit":2,"offset":2}'], 1]);
    expect(notes.groups(LOCAL, { limit: 2, page: Number.MAX_SAFE_INTEGER })).toEqual({ items: [], total: 3 });
    expect(notes.groups(LOCAL, { limit: 3, page: 2 })).toEqual({ items: [], total: 3 });
    expect(notes.groups(BOB, { limit: 2, page: 1 })).toEqual({ items: [], total: 0 });
    expect(calls.splice(0)).toEqual(["countGroups", "countGroups", "countGroups"]);

    const cursor = notes.groups(LOCAL, { limit: 2 }).nextCursor as string;
    calls.splice(0);
    const before = transactions;
    expect(errorOf(() => notes.groups(LOCAL, { limit: 2, page: 1, cursor }))).toMatchObject({ class: "invalid_request", userMessage: expect.stringMatching(/\bpage$/) });
    expect([calls, transactions]).toEqual([[], before]);
  });

  it("loses a Content's notes when the Content is deleted", async () => {
    const { h, contentId, fixture, notes } = setup();
    notes.create(LOCAL, contentId, body(fixture));
    await h.deleteContent.delete(LOCAL, contentId);
    expect(notes.groups(LOCAL, { limit: 10 })).toEqual({ items: [], total: 0 });
    expect(h.db.prepare("SELECT count(*) AS n FROM note").get()).toEqual({ n: 0 });
  });
});

describe("NoteService quotes on read", () => {
  /**
   * A punctuation-restored revision whose sentences run on without closing punctuation, and
   * a note across all three stored with the space an earlier reading rule put between them.
   */
  function legacySetup() {
    const { h, contentId, fixture } = setup();
    const revisionId = h.newId();
    const texts = ["第一句没有标点", "第二句也没有", "第三句。"];
    const segments: TranscriptSegment[] = texts.map((text, ordinal) => ({
      id: h.newId() as SegmentId, revisionId, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 1000, text, sourceSegmentIds: [], paragraphStart: ordinal === 0,
    }));
    const insertNote = (anchor: { startSegment: number; startOffset: number; endSegment: number; endOffset: number }, quote: string, at: number): string => {
      const id = h.newId();
      h.repository.withTransaction((scope) =>
        scope.notes.insert({
          id, userId: LOCAL.userId, contentId, transcriptRevisionId: revisionId,
          startSegmentId: segments[anchor.startSegment]?.id as string, startOffset: anchor.startOffset,
          endSegmentId: segments[anchor.endSegment]?.id as string, endOffset: anchor.endOffset,
          quote, mark: "background", color: "yellow", createdAt: at, updatedAt: at,
        }),
      );
      return id;
    };
    h.repository.withTransaction((scope) =>
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: revisionId, contentId, kind: "imported", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: segments.length, createdAt: 9 },
        segments,
      ),
    );
    const legacy = insertNote({ startSegment: 0, startOffset: 2, endSegment: 2, endOffset: 2 }, "句没有标点 第二句也没有 第三", 10);
    const warnings: Array<{ message: string; fields: unknown }> = [];
    const loads: string[] = [];
    const logger = {
      debug: () => undefined, info: () => undefined, error: () => undefined,
      warn: (message: string, fields?: unknown) => void warnings.push({ message, fields }),
      child() { return logger; },
    };
    const repository: Repository = {
      withTransaction: (work) =>
        h.repository.withTransaction((scope) =>
          work({
            ...scope,
            transcripts: {
              ...scope.transcripts,
              listSegments: (owner: string, id: string, page?: Parameters<typeof scope.transcripts.listSegments>[2]) => {
                loads.push(id);
                return scope.transcripts.listSegments(owner, id, page);
              },
            },
          }),
        ),
    };
    const clock = { now: 5_000 };
    const notes = new NoteService({ repository, now: () => clock.now, newId: h.newId, logger });
    const storedQuote = (id: string): unknown => (h.db.prepare("SELECT quote FROM note WHERE id = ?").get(id) as { quote: string }).quote;
    return { h, contentId, fixture, revisionId, segments, insertNote, legacy, warnings, loads, notes, storedQuote };
  }

  const RECUT = "句没有标点第二句也没有第三";

  it("recuts the quote with today's separator on every read and leaves the stored snapshot alone", () => {
    const { contentId, fixture, revisionId, legacy, warnings, notes, storedQuote } = legacySetup();
    expect(notes.list(LOCAL, contentId).items.find((item) => item.id === legacy)?.quote).toBe(RECUT);
    expect(notes.list(LOCAL, contentId, revisionId).items.find((item) => item.id === legacy)?.quote).toBe(RECUT);
    expect(notes.list(LOCAL, contentId, fixture.corrected.revision.id).items.find((item) => item.id === legacy)?.quote).toBe(RECUT);
    expect(notes.find(LOCAL, legacy)?.quote).toBe(RECUT);
    expect(notes.patch(LOCAL, legacy, { color: "green" })).toMatchObject({ quote: RECUT, color: "green", updatedAt: 5_000 });
    expect(storedQuote(legacy)).toBe("句没有标点 第二句也没有 第三");
    expect(warnings).toEqual([]);
  });

  it("loads each anchored revision's sentences once per request, with or without a target revision", () => {
    const { contentId, fixture, revisionId, insertNote, loads, notes } = legacySetup();
    insertNote({ startSegment: 1, startOffset: 0, endSegment: 1, endOffset: 3 }, "第二句", 11);
    insertNote({ startSegment: 2, startOffset: 0, endSegment: 2, endOffset: 3 }, "第三句", 12);
    expect(notes.list(LOCAL, contentId).items.map((item) => item.quote)).toEqual([RECUT, "第二句", "第三句"]);
    expect(loads.splice(0)).toEqual([revisionId]);
    // Mapping onto another revision reuses the anchored revision already loaded for the quotes.
    notes.list(LOCAL, contentId, fixture.corrected.revision.id);
    expect([...loads.splice(0)].sort()).toEqual([fixture.corrected.revision.id, revisionId].sort());
  });

  it("falls back to the stored quote and warns when the anchor no longer checks out", () => {
    const { h, contentId, insertNote, warnings, notes, storedQuote } = legacySetup();
    const reversed = insertNote({ startSegment: 2, startOffset: 0, endSegment: 0, endOffset: 2 }, "倒序快照", 11);
    const pastEnd = insertNote({ startSegment: 0, startOffset: 0, endSegment: 1, endOffset: 99 }, "越界快照", 12);
    const startPastEnd = insertNote({ startSegment: 1, startOffset: 6, endSegment: 2, endOffset: 1 }, "起点越界快照", 13);
    // A span wider than NOTE_SPAN_MAX_SEGMENTS, on a revision long enough to hold one.
    const long = h.newId();
    const longSegments: TranscriptSegment[] = Array.from({ length: NOTE_SPAN_MAX_SEGMENTS + 1 }, (_, ordinal) => ({
      id: h.newId() as SegmentId, revisionId: long, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 1000, text: `句子${ordinal}。`, sourceSegmentIds: [],
    }));
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: long, contentId, kind: "imported", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: longSegments.length, createdAt: 9 },
        longSegments,
      );
      scope.notes.insert({
        id: "01J00000000000000000000WIDE", userId: LOCAL.userId, contentId, transcriptRevisionId: long, startSegmentId: longSegments[0]?.id as string, startOffset: 0,
        endSegmentId: longSegments[NOTE_SPAN_MAX_SEGMENTS]?.id as string, endOffset: 1, quote: "过宽快照", mark: "underline", color: "blue", createdAt: 14, updatedAt: 14,
      });
    });
    const quotes = new Map(notes.list(LOCAL, contentId).items.map((item) => [item.id, item.quote]));
    expect([quotes.get(reversed), quotes.get(pastEnd), quotes.get(startPastEnd), quotes.get("01J00000000000000000000WIDE")]).toEqual(["倒序快照", "越界快照", "起点越界快照", "过宽快照"]);
    expect(warnings.map((warning) => warning.message)).toEqual(Array(4).fill("note_quote_fallback"));
    expect(warnings.map((warning) => (warning.fields as { noteId: string }).noteId).sort()).toEqual([reversed, pastEnd, startPastEnd, "01J00000000000000000000WIDE"].sort());
    expect(notes.find(LOCAL, pastEnd)?.quote).toBe("越界快照");
    expect(storedQuote(pastEnd)).toBe("越界快照");
  });

  it("finds only the owner's note on a Content outside the trash", () => {
    const { h, contentId, legacy, notes } = legacySetup();
    expect(notes.find(BOB, legacy)).toBeUndefined();
    expect(notes.find(LOCAL, "01J0000000000000000000NOPE")).toBeUndefined();
    h.trash.trash(LOCAL, contentId);
    expect(notes.find(LOCAL, legacy)).toBeUndefined();
  });
});
