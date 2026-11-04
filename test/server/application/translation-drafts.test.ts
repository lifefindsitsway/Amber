import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { TranslationDraftSegment } from "../../../src/shared/dto/translation.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../fixtures/transcripts/lecture.ts";
import { countRows, insertRow } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const MODEL_REF = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };
const PROMPT_REF = { id: "translate.subtitles", version: 1 };

async function codeOf(work: () => unknown): Promise<{ code: string; details?: unknown } | undefined> {
  try {
    await work();
  } catch (error) {
    const appError = (error as { appError?: { code: string; details?: unknown } }).appError;
    return appError === undefined ? { code: String(error) } : { code: appError.code, ...(appError.details === undefined ? {} : { details: appError.details }) };
  }
  return undefined;
}

/** The lecture with its corrected revision as primary, translated by the model into English and Japanese. */
function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture: TranscriptFixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.corrected.revision.id, 2);
  });
  /** A machine translation of the primary, with speakers and paragraph marks, made current. */
  const machineTranslate = (language: string, createdAt: number): string => {
    const id = h.newId();
    const segments: TranscriptSegment[] = fixture.corrected.segments.map((source, ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: source.startMs,
      endMs: source.endMs,
      text: `${language} ${ordinal}`,
      speakerId: ordinal % 2 === 0 ? "s1" : "s2",
      paragraphStart: ordinal % 3 === 0,
      sourceSegmentIds: [source.id],
    }));
    const revision: TranscriptRevision = {
      id,
      contentId,
      kind: "translated",
      parentRevisionId: fixture.corrected.revision.id,
      language,
      timingFidelity: "segment_only",
      generation: { kind: "llm", modelRef: MODEL_REF, promptRef: PROMPT_REF, promptSnapshot: "<prompt>" },
      segmentCount: segments.length,
      createdAt,
    };
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
      const artifact = scope.translations.getArtifact(LOCAL.userId, contentId, language);
      scope.translations.setCurrent(LOCAL.userId, contentId, language, id, artifact?.id ?? h.newId());
    });
    return id;
  };
  const en = machineTranslate("en", 10);
  const ja = machineTranslate("ja", 11);
  return { h, contentId, fixture, en, ja, machineTranslate };
}

const segmentsOf = (h: Harness, revisionId: string) => h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revisionId));
const revisionOf = (h: Harness, revisionId: string) => h.repository.withTransaction((scope) => scope.transcripts.getRevision(LOCAL.userId, revisionId));
const currentOf = (h: Harness, contentId: string, language: string) =>
  h.repository.withTransaction((scope) => scope.translations.getArtifact(LOCAL.userId, contentId, language)?.currentRevisionId);
/** Every sentence of `revisionId` with its text rewritten. */
const edited = (h: Harness, revisionId: string, rewrite: (text: string) => string = (text) => `${text}!`): TranslationDraftSegment[] =>
  segmentsOf(h, revisionId).map((segment) => ({ id: segment.id, text: rewrite(segment.text) }));

describe("translation drafts beside the transcript draft", () => {
  it("keeps the transcript draft and each language's draft apart for reads, writes and deletes", () => {
    const { h, contentId, fixture, en, ja } = setup();
    const original = h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: fixture.corrected.revision.id,
      expectedVersion: null,
      segments: fixture.corrected.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] })),
    });
    const english = h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: null, segments: edited(h, en) });
    const japanese = h.translationDrafts.put(LOCAL, contentId, "ja", { baseRevisionId: ja, expectedVersion: null, segments: edited(h, ja) });
    expect([original.version, english.version, japanese.version]).toEqual([1, 1, 1]);
    expect(english).toMatchObject({ targetLanguage: "en", baseRevisionId: en });

    expect(h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: 1, segments: edited(h, en, () => "second") }).version).toBe(2);
    expect(h.transcripts.getDraft(LOCAL, contentId)).toMatchObject({ id: original.id, version: 1 });
    expect(h.translationDrafts.get(LOCAL, contentId, "ja")).toMatchObject({ version: 1, segments: japanese.segments });
    expect(h.translationDrafts.get(LOCAL, contentId, "en").segments.every((segment) => segment.text === "second")).toBe(true);

    h.translationDrafts.discard(LOCAL, contentId, "ja", 1);
    expect(h.transcripts.getDraft(LOCAL, contentId).version).toBe(1);
    expect(h.translationDrafts.get(LOCAL, contentId, "en").version).toBe(2);
    h.transcripts.discardDraft(LOCAL, contentId, 1);
    expect(h.translationDrafts.get(LOCAL, contentId, "en").version).toBe(2);
    const listed = h.translations.get(LOCAL, contentId).translations;
    expect(listed.find((entry) => entry.targetLanguage === "en")?.draft).toMatchObject({ baseRevisionId: en, version: 2 });
    expect(listed.find((entry) => entry.targetLanguage === "ja")?.draft).toBeUndefined();
  });

  it("refuses a stale version on save, discard and commit, and never recreates a discarded draft", async () => {
    const { h, contentId, en } = setup();
    const body = (expectedVersion: number | null) => ({ baseRevisionId: en, expectedVersion, segments: edited(h, en) });
    const conflict = (currentVersion?: number) => ({ code: "conflict.draft_changed", ...(currentVersion === undefined ? {} : { details: { currentVersion } }) });

    expect(await codeOf(() => h.translationDrafts.put(LOCAL, contentId, "en", body(1)))).toEqual(conflict());
    h.translationDrafts.put(LOCAL, contentId, "en", body(null));
    expect(await codeOf(() => h.translationDrafts.put(LOCAL, contentId, "en", body(null)))).toEqual(conflict(1));
    h.translationDrafts.put(LOCAL, contentId, "en", body(1));
    expect(await codeOf(() => h.translationDrafts.put(LOCAL, contentId, "en", body(1)))).toEqual(conflict(2));
    expect(await codeOf(() => h.translationDrafts.discard(LOCAL, contentId, "en", 1))).toEqual(conflict(2));
    expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: 1 }))).toEqual(conflict(2));
    expect(currentOf(h, contentId, "en")).toBe(en);

    h.translationDrafts.discard(LOCAL, contentId, "en", 2);
    expect(await codeOf(() => h.translationDrafts.put(LOCAL, contentId, "en", body(2)))).toEqual(conflict());
    expect(await codeOf(() => h.translationDrafts.get(LOCAL, contentId, "en"))).toEqual({ code: "not_found" });
    expect(await codeOf(() => h.translationDrafts.discard(LOCAL, contentId, "en", 2))).toEqual(conflict());
    expect(await codeOf(() => h.translationDrafts.discard(LOCAL, contentId, "en"))).toEqual({ code: "not_found" });
    expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: 2 }))).toEqual(conflict());
    expect(countRows(h.db, "transcript_draft")).toBe(0);
  });

  it("starts a draft only from the language's current, unarchived translation, with exactly its sentences", async () => {
    const { h, contentId, fixture, en, ja, machineTranslate } = setup();
    const invalid = { code: "invalid_request" };
    const put = (language: string, baseRevisionId: string, segments: TranslationDraftSegment[]) =>
      codeOf(() => h.translationDrafts.put(LOCAL, contentId, language, { baseRevisionId, expectedVersion: null, segments }));
    const base = edited(h, en);
    const [first, second] = base as [TranslationDraftSegment, TranslationDraftSegment];

    expect(await put("fr", en, base)).toEqual({ code: "not_found" });
    expect(await put("not a tag!", en, base)).toEqual({ code: "not_found" });
    expect(await put("en", ja, edited(h, ja))).toEqual(invalid);
    expect(await put("en", fixture.corrected.revision.id, base)).toEqual(invalid);
    expect(await put("en", "missing", base)).toEqual({ code: "not_found" });
    // Sentence ids: one missing, one repeated, two swapped, one of another translation, one extra.
    expect(await put("en", en, base.slice(1))).toEqual(invalid);
    expect(await put("en", en, [first, first, ...base.slice(2)])).toEqual(invalid);
    expect(await put("en", en, [second, first, ...base.slice(2)])).toEqual(invalid);
    expect(await put("en", en, [{ ...first, id: segmentsOf(h, ja)[0]?.id as string }, ...base.slice(1)])).toEqual(invalid);
    expect(await put("en", en, [...base, { id: h.newId(), text: "more" }])).toEqual(invalid);
    expect(countRows(h.db, "transcript_draft")).toBe(0);

    // Empty text is fine while editing, and the tag may be spelled any way.
    expect(h.translationDrafts.put(LOCAL, contentId, "EN", { baseRevisionId: en, expectedVersion: null, segments: base.map((segment) => ({ ...segment, text: "" })) })).toMatchObject({ targetLanguage: "en", version: 1 });
    h.translationDrafts.discard(LOCAL, contentId, "en", 1);

    // A newer machine translation leaves the older one outside "current"; an archived current one is not editable either.
    const newer = machineTranslate("en", 20);
    expect(await put("en", en, base)).toEqual(invalid);
    h.transcripts.setArchived(LOCAL, newer, true);
    expect(await put("en", newer, edited(h, newer))).toEqual(invalid);
  });
});

describe("committing a translation draft", () => {
  it("rebuilds the sentences from the base, makes them current and keeps the machine translation", async () => {
    const { h, contentId, fixture, en } = setup();
    const base = segmentsOf(h, en);
    h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: null, segments: edited(h, en, (text) => `  ${text} edited `) });
    // Whatever timing or sources the stored draft claims, the commit takes the base's.
    h.repository.withTransaction((scope) => {
      const stored = scope.transcripts.getDraft(LOCAL.userId, contentId, "en");
      if (stored === undefined) throw new Error("draft missing");
      scope.transcripts.putDraft(
        LOCAL.userId,
        { ...stored, segments: stored.segments.map((segment) => ({ ...segment, startMs: 1, endMs: 2, sourceSegmentIds: [] })) },
        stored.version,
      );
    });

    const committed = h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: 2 });
    expect(committed).toMatchObject({
      kind: "translated",
      parentRevisionId: fixture.corrected.revision.id,
      language: "en",
      timingFidelity: "segment_only",
      generation: { kind: "manual", origin: { revisionId: en, modelRef: MODEL_REF, promptRef: PROMPT_REF } },
      segmentCount: base.length,
    });
    const segments = segmentsOf(h, committed.id);
    expect(segments.map(({ ordinal, startMs, endMs, speakerId, paragraphStart, sourceSegmentIds }) => ({ ordinal, startMs, endMs, speakerId, paragraphStart, sourceSegmentIds }))).toEqual(
      base.map(({ ordinal, startMs, endMs, speakerId, paragraphStart, sourceSegmentIds }) => ({ ordinal, startMs, endMs, speakerId, paragraphStart, sourceSegmentIds })),
    );
    expect(segments.map((segment) => segment.text)).toEqual(base.map((segment) => `${segment.text} edited`));
    expect(segments.some((segment) => base.some((source) => source.id === segment.id))).toBe(false);
    expect(currentOf(h, contentId, "en")).toBe(committed.id);
    expect(await codeOf(() => h.translationDrafts.get(LOCAL, contentId, "en"))).toEqual({ code: "not_found" });
    expect(revisionOf(h, en)).toBeDefined();
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses empty sentences and a stored draft whose sentences no longer match the base, writing nothing", async () => {
    const { h, contentId, en, ja } = setup();
    const revisions = countRows(h.db, "transcript_revision");
    const segments = edited(h, en);
    h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: null, segments: segments.map((segment, index) => (index === 1 ? { ...segment, text: " \n " } : segment)) });
    expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: 1 }))).toEqual({ code: "invalid_request" });

    const [first] = segmentsOf(h, en) as [TranscriptSegment];
    const foreign = segmentsOf(h, ja)[0] as TranscriptSegment;
    const variants: Array<Array<{ id: string }>> = [
      segments.slice(1),
      [segments[0] as TranslationDraftSegment, ...segments.slice(0, -1)],
      [segments[1] as TranslationDraftSegment, segments[0] as TranslationDraftSegment, ...segments.slice(2)],
      [{ id: foreign.id }, ...segments.slice(1)],
      [...segments, { id: h.newId() }],
    ];
    let version = 1;
    for (const ids of variants) {
      h.repository.withTransaction((scope) =>
        scope.transcripts.putDraft(
          LOCAL.userId,
          {
            id: "draft",
            contentId,
            baseRevisionId: en,
            targetLanguage: "en",
            version: 0,
            segments: ids.map(({ id }) => ({ id, startMs: first.startMs, endMs: first.endMs, text: "text", sourceSegmentIds: [] })),
            updatedAt: 1,
          },
          version,
        ),
      );
      version += 1;
      expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: version })), JSON.stringify(ids)).toEqual({ code: "invalid_request" });
    }
    expect(countRows(h.db, "transcript_revision")).toBe(revisions);
    expect(currentOf(h, contentId, "en")).toBe(en);
  });

  it("carries the origin over a second hand edit, deletes the replaced unreferenced edit and keeps a referenced one", () => {
    const { h, contentId, en } = setup();
    const editAndCommit = (base: string): TranscriptRevision => {
      h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: base, expectedVersion: null, segments: edited(h, base) });
      return h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: base, draftVersion: 1 }) as TranscriptRevision;
    };
    const first = editAndCommit(en);
    insertRow(h.db, "idempotency_record", {
      user_id: LOCAL.userId,
      route: "test",
      idempotency_key: "k",
      request_digest: "d",
      response_status: 201,
      response_body_json: JSON.stringify({ transcriptRevisionId: first.id }),
      resource_refs_json: JSON.stringify([first.id]),
      created_at: 1,
    });
    const second = editAndCommit(first.id);
    expect(second.generation).toEqual({ kind: "manual", origin: { revisionId: en, modelRef: MODEL_REF, promptRef: PROMPT_REF } });
    expect(revisionOf(h, first.id)).toBeUndefined();
    expect(countRows(h.db, "transcript_segment", "revision_id = ?", first.id)).toBe(0);
    expect(countRows(h.db, "idempotency_record")).toBe(0);
    expect(revisionOf(h, en)).toBeDefined();

    // A note on the second edit keeps it in the history when a third replaces it.
    const [segment] = segmentsOf(h, second.id) as [TranscriptSegment];
    insertRow(h.db, "note", {
      id: h.newId(),
      user_id: LOCAL.userId,
      content_id: contentId,
      transcript_revision_id: second.id,
      start_segment_id: segment.id,
      start_offset: 0,
      end_segment_id: segment.id,
      end_offset: 1,
      quote: "e",
      mark: "underline",
      color: "blue",
      created_at: 10,
      updated_at: 10,
    });
    const third = editAndCommit(second.id);
    expect(third.generation).toEqual(second.generation);
    expect(revisionOf(h, second.id)).toBeDefined();
    expect(currentOf(h, contentId, "en")).toBe(third.id);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps the draft when a new machine translation arrives and commits it only with allowOutdatedBase", async () => {
    const { h, contentId, en, machineTranslate } = setup();
    h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: null, segments: edited(h, en) });
    const newer = machineTranslate("en", 20);
    expect(h.translationDrafts.get(LOCAL, contentId, "en")).toMatchObject({ baseRevisionId: en, version: 1 });
    expect(h.translations.get(LOCAL, contentId).translations.find((entry) => entry.targetLanguage === "en")).toMatchObject({ current: { id: newer }, draft: { baseRevisionId: en } });

    const changed = { code: "conflict.translation_changed", details: { currentRevisionId: newer } };
    expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: 1 }))).toEqual(changed);
    expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: newer, draftVersion: 1 }))).toEqual(changed);
    expect(await codeOf(() => h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: en, draftVersion: 1, allowOutdatedBase: true }))).toEqual(changed);
    expect(currentOf(h, contentId, "en")).toBe(newer);

    const committed = h.translationDrafts.commit(LOCAL, contentId, "en", { expectedRevisionId: newer, draftVersion: 1, allowOutdatedBase: true });
    expect(committed.generation).toMatchObject({ kind: "manual", origin: { revisionId: en } });
    expect(currentOf(h, contentId, "en")).toBe(committed.id);
    expect(revisionOf(h, newer)).toBeDefined();
    expect(revisionOf(h, en)).toBeDefined();
  });
});

describe("archiving draft bases", () => {
  it("refuses to archive the base of any draft, and archives a current translation without one", async () => {
    const { h, contentId, fixture, en, ja } = setup();
    h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: null, segments: edited(h, en) });
    h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: fixture.asr.revision.id, expectedVersion: null, segments: [] });
    const referenced = { code: "conflict.revision_referenced", details: expect.objectContaining({ draft: 1 }) };
    expect(await codeOf(() => h.transcripts.setArchived(LOCAL, en, true))).toEqual(referenced);
    expect(await codeOf(() => h.transcripts.setArchived(LOCAL, fixture.asr.revision.id, true))).toEqual(referenced);
    expect(h.transcripts.setArchived(LOCAL, ja, true)).toMatchObject({ id: ja, archived: true });
    expect(currentOf(h, contentId, "ja")).toBe(ja);

    h.translationDrafts.discard(LOCAL, contentId, "en");
    expect(h.transcripts.setArchived(LOCAL, en, true)).toMatchObject({ id: en, archived: true });
  });
});

describe("deleting a Content with drafts of every kind", () => {
  it("purges the transcript draft and every translation draft with the Content", async () => {
    const { h, contentId, fixture, en, ja } = setup();
    h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: fixture.corrected.revision.id, expectedVersion: null, segments: [] });
    h.translationDrafts.put(LOCAL, contentId, "en", { baseRevisionId: en, expectedVersion: null, segments: edited(h, en) });
    h.translationDrafts.put(LOCAL, contentId, "ja", { baseRevisionId: ja, expectedVersion: null, segments: edited(h, ja) });
    expect(countRows(h.db, "transcript_draft")).toBe(3);

    await h.deleteContent.purge(LOCAL.userId, contentId, { onlyTrashed: false });
    expect(countRows(h.db, "transcript_draft")).toBe(0);
    expect(countRows(h.db, "transcript_revision")).toBe(0);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });
});
