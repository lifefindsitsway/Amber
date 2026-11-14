import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HmacFileGrantVerifier, signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { multipartRequestDigest } from "../../../src/server/application/idempotency.ts";
import { UPLOAD_ROUTE, type UploadPart } from "../../../src/server/application/local-import.ts";
import { SubtitleImportService, writeSubtitleImport, type SubtitleImportWrite } from "../../../src/server/application/subtitle-import.ts";
import type { Content } from "../../../src/server/domain/content.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { withAssRestoreData } from "../../../src/server/domain/export/ambersub.ts";
import type { SubtitleImportPlan } from "../../../src/server/domain/subtitle-document.ts";
import { serializeSubtitlePackage, subtitleTextDigest, SUBTITLE_PACKAGE_FORMAT, SUBTITLE_PACKAGE_VERSION, type SubtitlePackage } from "../../../src/server/domain/subtitle-package.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { FILE_GRANT_TTL_MS, SPEAKERS_PER_CONTENT_MAX, SUBTITLE_IMPORT_MAX_BYTES } from "../../../src/shared/defaults.ts";
import type { RepositoryScope } from "../../../src/server/ports/repository.ts";
import type { SubtitleImportOptions } from "../../../src/shared/dto/subtitle-import.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { defaultSpeakerColorIndex } from "../../../src/shared/speakers.ts";
import { mediaFixtures } from "../../fixtures/media/index.ts";
import { BOB, createHarness, LOCAL, taskOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";
import { countRows, tempDataDir } from "../../tools/sqlite.ts";

const open: Harness[] = [];
function harness(): Harness {
  const created = createHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const OWNER = LOCAL.userId;
const DIGEST = "0".repeat(64);

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

function errorOf(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a failure");
}

async function asyncCodeOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

function insertContent(h: Harness, fields: Partial<Content> = {}, userId = OWNER): Content {
  const content: Content = { id: h.newId(), userId, source: { kind: "local" }, processingStatus: "queued", createdAt: 1, updatedAt: 1, ...fields };
  h.repository.withTransaction((scope) => scope.contents.insert(content));
  return content;
}

/** A two-sentence imported primary, so an import has something to replace. */
function insertPrimary(h: Harness, contentId: string): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = [0, 1].map((ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text: `asr ${ordinal}`,
    sourceSegmentIds: [],
  }));
  const revision: TranscriptRevision = {
    id: revisionId,
    contentId,
    kind: "imported",
    language: "en",
    timingFidelity: "segment_only",
    generation: { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    createdAt: 2,
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(OWNER, revision, segments);
    scope.contents.setPrimaryTranscript(OWNER, contentId, revisionId, 2);
  });
  return { revision, segments };
}

/** A current `zh-CN` translation of `parent`, as AI translation would leave it. */
function insertTranslation(h: Harness, contentId: string, parent: { revision: TranscriptRevision; segments: TranscriptSegment[] }, language = "zh-CN"): string {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = parent.segments.map((segment) => ({
    ...segment,
    id: h.newId() as SegmentId,
    revisionId,
    text: `译 ${segment.ordinal}`,
    sourceSegmentIds: [segment.id],
  }));
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(
      OWNER,
      { id: revisionId, contentId, kind: "translated", parentRevisionId: parent.revision.id, language, timingFidelity: "segment_only", generation: { kind: "manual" }, segmentCount: segments.length, createdAt: 3 },
      segments,
    );
    scope.translations.setCurrent(OWNER, contentId, language, revisionId, h.newId());
  });
  return revisionId;
}

function insertSpeakers(h: Harness, contentId: string, speakers: Array<{ name?: string; ordinal?: number }>) {
  return h.repository.withTransaction((scope) =>
    scope.speakers.insert(
      OWNER,
      contentId,
      speakers.map((speaker) => ({ id: h.newId(), ...speaker })),
      5,
    ),
  );
}

/** Three sentences: Alice, an unnamed "Speaker 2", Alice again; a translation of the first and last. */
function samplePlan(overrides: Partial<SubtitleImportPlan> = {}): SubtitleImportPlan {
  return {
    format: "ambersub",
    language: "en",
    paragraphMarks: true,
    speakers: [
      { key: "a", name: "Alice", ordinal: 1, colorIndex: 4 },
      { key: "b", ordinal: 2, fallbackName: "Speaker 2" },
    ],
    segments: [
      { startMs: 0, endMs: 1000, text: "one", speakerKey: "a", paragraphStart: true },
      { startMs: 1000, endMs: 2000, text: "two", speakerKey: "b", paragraphStart: false },
      { startMs: 2000, endMs: 3000, text: "three", speakerKey: "a", paragraphStart: true },
    ],
    translations: [
      {
        language: "zh-CN",
        lines: [
          { segmentIndex: 2, text: "三" },
          { segmentIndex: 1, text: "二" },
        ],
      },
    ],
    droppedCues: 0,
    ...overrides,
  };
}

function write(h: Harness, input: Omit<SubtitleImportWrite, "newId" | "now"> & { now?: number }) {
  return h.repository.withTransaction((scope) => writeSubtitleImport(scope, OWNER, { newId: h.newId, now: 10, ...input }));
}

function read<T>(h: Harness, work: (scope: RepositoryScope) => T): T {
  return h.repository.withTransaction((scope) => work(scope) as never) as T;
}

function options(extra: Partial<SubtitleImportOptions> = {}): SubtitleImportOptions {
  return { expectedDigest: DIGEST, ...extra };
}

describe("writeSubtitleImport into a new Content", () => {
  it("registers speakers before the original and its translation, makes them primary and current, and ignores existing-Content options", () => {
    const h = harness();
    const content = insertContent(h);
    const written = write(h, {
      contentId: content.id,
      plan: samplePlan(),
      newContent: true,
      // Meaningless for a new Content: ignored rather than refused.
      options: options({ setCurrent: false, identities: [{ key: "a", speakerId: "missing" }], expectedState: { primaryRevisionId: "x", currentTranslations: {}, speakers: [], speakerRoom: 0 } }),
    });
    expect(written.speakersCreated).toBe(2);
    expect(Object.keys(written.translationRevisionIds)).toEqual(["zh-CN"]);

    const speakers = read(h, (scope) => scope.speakers.list(OWNER, content.id));
    expect(speakers.map(({ ordinal, name, colorIndex, nameConfirmedAt }) => ({ ordinal, name, colorIndex, nameConfirmedAt }))).toEqual([
      { ordinal: 1, name: "Alice", colorIndex: 4, nameConfirmedAt: undefined },
      // The ordinal it asked for was free, so the default-style label is not stored as a name.
      { ordinal: 2, name: undefined, colorIndex: defaultSpeakerColorIndex(2), nameConfirmedAt: undefined },
    ]);
    const [alice, unnamed] = speakers;

    const original = read(h, (scope) => scope.transcripts.getRevision(OWNER, written.revisionId));
    expect(original).toMatchObject({ kind: "imported", language: "en", timingFidelity: "segment_only", generation: { kind: "imported", format: "ambersub" }, segmentCount: 3 });
    const originalSegments = read(h, (scope) => scope.transcripts.listSegments(OWNER, written.revisionId));
    expect(originalSegments.map(({ ordinal, text, speakerId, paragraphStart, sourceSegmentIds }) => ({ ordinal, text, speakerId, paragraphStart, sourceSegmentIds }))).toEqual([
      { ordinal: 0, text: "one", speakerId: alice?.id, paragraphStart: true, sourceSegmentIds: [] },
      { ordinal: 1, text: "two", speakerId: unnamed?.id, paragraphStart: false, sourceSegmentIds: [] },
      { ordinal: 2, text: "three", speakerId: alice?.id, paragraphStart: true, sourceSegmentIds: [] },
    ]);

    const translationId = written.translationRevisionIds["zh-CN"] as string;
    const translation = read(h, (scope) => scope.transcripts.getRevision(OWNER, translationId));
    expect(translation).toMatchObject({ kind: "translated", parentRevisionId: written.revisionId, language: "zh-CN", generation: { kind: "imported", format: "ambersub" }, segmentCount: 2 });
    const translated = read(h, (scope) => scope.transcripts.listSegments(OWNER, translationId));
    expect(translated.map(({ ordinal, startMs, endMs, text, speakerId, paragraphStart, sourceSegmentIds }) => ({ ordinal, startMs, endMs, text, speakerId, paragraphStart, sourceSegmentIds }))).toEqual([
      // The first sentence of a marked revision always opens a paragraph, even though its source does not.
      { ordinal: 1, startMs: 1000, endMs: 2000, text: "二", speakerId: unnamed?.id, paragraphStart: true, sourceSegmentIds: [originalSegments[1]?.id] },
      { ordinal: 2, startMs: 2000, endMs: 3000, text: "三", speakerId: alice?.id, paragraphStart: true, sourceSegmentIds: [originalSegments[2]?.id] },
    ]);

    expect(read(h, (scope) => scope.contents.get(OWNER, content.id))?.primaryTranscriptRevisionId).toBe(written.revisionId);
    expect(read(h, (scope) => scope.translations.getArtifact(OWNER, content.id, "zh-CN"))?.currentRevisionId).toBe(translationId);
    expect(countRows(h.db, "transcript_revision_speaker_confirmation")).toBe(0);
  });

  it("writes no translation without lines, no paragraph marks when the plan has none, and no speaker no sentence names", () => {
    const h = harness();
    const content = insertContent(h);
    const written = write(h, {
      contentId: content.id,
      newContent: true,
      plan: samplePlan({
        format: "srt",
        paragraphMarks: false,
        speakers: [{ key: "a", name: "Alice" }, { key: "unused", name: "Nobody" }],
        segments: [
          { startMs: 0, endMs: 1000, text: "one", speakerKey: "a" },
          { startMs: 1000, endMs: 2000, text: "two", speakerKey: null },
        ],
        translations: [{ language: "zh-CN", lines: [] }],
      }),
    });
    expect(written.translationRevisionIds).toEqual({});
    expect(written.speakersCreated).toBe(1);
    expect(read(h, (scope) => scope.speakers.list(OWNER, content.id)).map((speaker) => speaker.name)).toEqual(["Alice"]);
    const segments = read(h, (scope) => scope.transcripts.listSegments(OWNER, written.revisionId));
    expect(segments.map((segment) => [segment.paragraphStart, segment.speakerId === undefined])).toEqual([
      [undefined, false],
      [undefined, true],
    ]);
    expect(read(h, (scope) => scope.translations.listArtifacts(OWNER, content.id))).toEqual([]);
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, written.revisionId))?.generation).toEqual({ kind: "imported", format: "srt" });
  });

  it("warns about dropped cues and a timeline that does not fit the known duration", () => {
    const h = harness();
    const content = insertContent(h, { durationMs: 600_000 });
    const written = write(h, { contentId: content.id, newContent: false, plan: samplePlan({ droppedCues: 2 }) });
    expect(written.warnings).toContain("subtitle_cue_dropped");
    expect(written.warnings).toContain("imported_subtitle_invalid");
    expect(written.warnings).toContain("subtitle_coverage_low");
    expect(write(h, { contentId: insertContent(h).id, newContent: false, plan: samplePlan() }).warnings).toEqual([]);
  });
});

describe("writeSubtitleImport into an existing Content", () => {
  it("makes the import primary and its translations current by default, keeping the replaced revisions and the translation draft", () => {
    const h = harness();
    const content = insertContent(h);
    const primary = insertPrimary(h, content.id);
    const oldTranslation = insertTranslation(h, content.id, primary);
    const draft = read(h, (scope) =>
      scope.transcripts.putDraft(
        OWNER,
        { id: h.newId(), contentId: content.id, baseRevisionId: oldTranslation, targetLanguage: "zh-CN", version: 0, segments: [{ id: h.newId(), startMs: 0, endMs: 900, text: "草稿", sourceSegmentIds: [] }], updatedAt: 4 },
        null,
      ),
    );
    expect(draft).toHaveProperty("written");

    const written = write(h, { contentId: content.id, newContent: false, plan: samplePlan() });
    expect(read(h, (scope) => scope.contents.get(OWNER, content.id))?.primaryTranscriptRevisionId).toBe(written.revisionId);
    expect(read(h, (scope) => scope.translations.getArtifact(OWNER, content.id, "zh-CN"))?.currentRevisionId).toBe(written.translationRevisionIds["zh-CN"]);
    // An import is not a hand edit: the replaced current translation stays.
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, oldTranslation))).toBeDefined();
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, primary.revision.id))).toBeDefined();
    expect(read(h, (scope) => scope.transcripts.getDraft(OWNER, content.id, "zh-CN"))).toMatchObject({ baseRevisionId: oldTranslation, version: 1 });
  });

  it("only adds revisions with setCurrent false, touching no pointer", () => {
    const h = harness();
    const content = insertContent(h);
    const primary = insertPrimary(h, content.id);
    const oldTranslation = insertTranslation(h, content.id, primary);
    const written = write(h, {
      contentId: content.id,
      newContent: false,
      plan: samplePlan(),
      // A stale snapshot does not matter when no pointer moves.
      options: options({ setCurrent: false, expectedState: { primaryRevisionId: null, currentTranslations: {}, speakers: [], speakerRoom: 0 } }),
    });
    expect(read(h, (scope) => scope.contents.get(OWNER, content.id))?.primaryTranscriptRevisionId).toBe(primary.revision.id);
    expect(read(h, (scope) => scope.translations.getArtifact(OWNER, content.id, "zh-CN"))?.currentRevisionId).toBe(oldTranslation);
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, written.revisionId))?.kind).toBe("imported");
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, written.translationRevisionIds["zh-CN"] as string))?.kind).toBe("translated");
  });

  it("maps chosen speakers onto existing identities without changing them and creates the rest", () => {
    const h = harness();
    const content = insertContent(h);
    const [existing] = insertSpeakers(h, content.id, [{ name: "Alice Liddell" }]);
    const before = read(h, (scope) => scope.speakers.get(OWNER, content.id, existing?.id as string));
    const written = write(h, {
      contentId: content.id,
      newContent: false,
      plan: samplePlan(),
      options: options({
        identities: [{ key: "a", speakerId: existing?.id as string }, { key: "b" }],
        expectedState: { primaryRevisionId: null, currentTranslations: {}, speakers: [{ id: existing?.id as string, name: "Alice Liddell" }], speakerRoom: SPEAKERS_PER_CONTENT_MAX - 1 },
      }),
    });
    expect(written.speakersCreated).toBe(1);
    const speakers = read(h, (scope) => scope.speakers.list(OWNER, content.id));
    expect(speakers).toHaveLength(2);
    expect(read(h, (scope) => scope.speakers.get(OWNER, content.id, existing?.id as string))).toEqual(before);
    const segments = read(h, (scope) => scope.transcripts.listSegments(OWNER, written.revisionId));
    expect(segments.map((segment) => segment.speakerId)).toEqual([existing?.id, speakers[1]?.id, existing?.id]);
    // Ordinal 2 was free, so the new unnamed speaker keeps it.
    expect(speakers[1]).toMatchObject({ ordinal: 2 });
    expect(speakers[1]?.name).toBeUndefined();
  });

  it("refuses a chosen speaker that only comparison transcriptions name, as the preview never offers it", () => {
    const h = harness();
    const content = insertContent(h);
    insertPrimary(h, content.id);
    const [compared] = insertSpeakers(h, content.id, [{ name: "Compared" }]);
    const revisionId = h.newId();
    // A comparison transcription that is not the primary is the only revision naming this speaker.
    const comparison = {
      id: revisionId,
      contentId: content.id,
      kind: "asr",
      language: "en",
      timingFidelity: "segment_only",
      generation: { kind: "asr", purpose: "comparison" },
      segmentCount: 1,
      createdAt: 3,
    } as unknown as TranscriptRevision;
    read(h, (scope) =>
      scope.transcripts.insertRevision(OWNER, comparison, [
        { id: h.newId() as SegmentId, revisionId, ordinal: 0, startMs: 0, endMs: 900, text: "x", speakerId: compared?.id as string, sourceSegmentIds: [] },
      ]),
    );
    expect(read(h, (scope) => scope.speakers.comparisonOnlyIds(OWNER, content.id)).has(compared?.id as string)).toBe(true);
    const code = codeOf(() =>
      write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: options({ identities: [{ key: "a", speakerId: compared?.id as string }] }) }),
    );
    expect(code).toBe("conflict.speakers_changed");
    expect(read(h, (scope) => scope.speakers.count(OWNER, content.id))).toBe(1);
  });

  it("refuses a chosen speaker that is gone or was renamed since the preview, writing nothing", () => {
    const h = harness();
    const content = insertContent(h);
    const [existing] = insertSpeakers(h, content.id, [{ name: "Alice" }]);
    const gone = codeOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: options({ identities: [{ key: "a", speakerId: h.newId() }] }) }));
    expect(gone).toBe("conflict.speakers_changed");
    const renamed = codeOf(() =>
      write(h, {
        contentId: content.id,
        newContent: false,
        plan: samplePlan(),
        options: options({
          identities: [{ key: "a", speakerId: existing?.id as string }],
          expectedState: { primaryRevisionId: null, currentTranslations: {}, speakers: [{ id: existing?.id as string, name: "Alicia" }], speakerRoom: 1 },
        }),
      }),
    );
    expect(renamed).toBe("conflict.speakers_changed");
    // Another Content's speaker is not this Content's.
    const other = insertContent(h);
    const [foreign] = insertSpeakers(h, other.id, [{ name: "Alice" }]);
    expect(codeOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: options({ identities: [{ key: "a", speakerId: foreign?.id as string }] }) }))).toBe(
      "conflict.speakers_changed",
    );
    expect(countRows(h.db, "transcript_revision")).toBe(0);
    expect(read(h, (scope) => scope.speakers.count(OWNER, content.id))).toBe(1);
  });

  it("falls back to the smallest free ordinal when the asked one is taken or out of range, storing the file's label as a name", () => {
    const h = harness();
    const content = insertContent(h);
    insertSpeakers(h, content.id, [{ name: "First" }, { name: "Second" }]);
    write(h, {
      contentId: content.id,
      newContent: false,
      plan: samplePlan({
        speakers: [
          { key: "a", ordinal: 2, fallbackName: "Speaker 2" },
          { key: "b", ordinal: 4 },
          { key: "c", ordinal: SPEAKERS_PER_CONTENT_MAX + 1, fallbackName: `Speaker ${SPEAKERS_PER_CONTENT_MAX + 1}`, name: "ignored" },
        ],
        segments: [
          { startMs: 0, endMs: 1000, text: "one", speakerKey: "a", paragraphStart: true },
          { startMs: 1000, endMs: 2000, text: "two", speakerKey: "b", paragraphStart: false },
          { startMs: 2000, endMs: 3000, text: "three", speakerKey: "c", paragraphStart: false },
        ],
      }),
    });
    const speakers = read(h, (scope) => scope.speakers.list(OWNER, content.id));
    expect(speakers.map(({ ordinal, name, colorIndex }) => ({ ordinal, name, colorIndex }))).toEqual([
      { ordinal: 1, name: "First", colorIndex: defaultSpeakerColorIndex(1) },
      { ordinal: 2, name: "Second", colorIndex: defaultSpeakerColorIndex(2) },
      { ordinal: 3, name: "Speaker 2", colorIndex: defaultSpeakerColorIndex(3) },
      { ordinal: 4, name: undefined, colorIndex: defaultSpeakerColorIndex(4) },
      { ordinal: 5, name: `Speaker ${SPEAKERS_PER_CONTENT_MAX + 1}`, colorIndex: defaultSpeakerColorIndex(5) },
    ]);
  });

  it("gives speakers without an ordinal of their own the smallest free ordinals, so named speakers and a numbered one keep their places", () => {
    const h = harness();
    const content = insertContent(h);
    write(h, {
      contentId: content.id,
      newContent: true,
      plan: samplePlan({
        speakers: [
          { key: "jiang", name: "Jiang" },
          { key: "mike", name: "Mike" },
          { key: "eleven", ordinal: 11, fallbackName: "Speaker 11" },
        ],
        segments: [
          { startMs: 0, endMs: 1000, text: "one", speakerKey: "jiang", paragraphStart: true },
          { startMs: 1000, endMs: 2000, text: "two", speakerKey: "mike", paragraphStart: false },
          { startMs: 2000, endMs: 3000, text: "three", speakerKey: "eleven", paragraphStart: false },
        ],
      }),
    });
    const speakers = read(h, (scope) => scope.speakers.list(OWNER, content.id));
    expect(speakers.map(({ ordinal, name, colorIndex }) => ({ ordinal, name, colorIndex }))).toEqual([
      { ordinal: 1, name: "Jiang", colorIndex: defaultSpeakerColorIndex(1) },
      { ordinal: 2, name: "Mike", colorIndex: defaultSpeakerColorIndex(2) },
      { ordinal: 11, name: undefined, colorIndex: defaultSpeakerColorIndex(11) },
    ]);
  });

  it("refuses more new speakers than the Content has room for, without truncating or writing", () => {
    const h = harness();
    const content = insertContent(h);
    insertSpeakers(
      h,
      content.id,
      Array.from({ length: SPEAKERS_PER_CONTENT_MAX - 1 }, () => ({})),
    );
    const error = errorOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan() }));
    expect(error).toMatchObject({ code: "conflict.speaker_capacity", details: { room: 1, required: 2 } });
    expect(countRows(h.db, "transcript_revision")).toBe(0);
    expect(read(h, (scope) => scope.speakers.count(OWNER, content.id))).toBe(SPEAKERS_PER_CONTENT_MAX - 1);
    // Reusing one leaves room for the other.
    const [first] = read(h, (scope) => scope.speakers.list(OWNER, content.id));
    expect(write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: options({ identities: [{ key: "a", speakerId: first?.id as string }] }) }).speakersCreated).toBe(1);
  });

  it("rechecks the primary and each imported language's current translation against the preview when setting them current", () => {
    const h = harness();
    const content = insertContent(h);
    const primary = insertPrimary(h, content.id);
    const translation = insertTranslation(h, content.id, primary);
    const state = (primaryRevisionId: string | null, currentTranslations: Record<string, string>) =>
      options({ expectedState: { primaryRevisionId, currentTranslations, speakers: [], speakerRoom: SPEAKERS_PER_CONTENT_MAX } });

    expect(errorOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: state(null, { "zh-CN": translation }) }))).toMatchObject({
      code: "conflict.primary_changed",
      details: { currentPrimaryRevisionId: primary.revision.id },
    });
    expect(errorOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: state(primary.revision.id, {}) }))).toMatchObject({
      code: "conflict.translation_changed",
      details: { currentRevisionId: translation },
    });
    expect(errorOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: state(primary.revision.id, { "zh-CN": h.newId() }) }))).toMatchObject({
      code: "conflict.translation_changed",
    });
    expect(countRows(h.db, "transcript_revision")).toBe(2);
    expect(countRows(h.db, "content_speaker")).toBe(0);

    // A language the file does not carry is not compared.
    const written = write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: state(primary.revision.id, { "zh-CN": translation, fr: h.newId() }) });
    expect(read(h, (scope) => scope.contents.get(OWNER, content.id))?.primaryTranscriptRevisionId).toBe(written.revisionId);
  });

  it("refuses a Content in an empty state that changed: a primary appeared since the preview", () => {
    const h = harness();
    const content = insertContent(h);
    const primary = insertPrimary(h, content.id);
    const error = errorOf(() =>
      write(h, { contentId: content.id, newContent: false, plan: samplePlan(), options: options({ expectedState: { primaryRevisionId: null, currentTranslations: {}, speakers: [], speakerRoom: 8 } }) }),
    );
    expect(error).toMatchObject({ code: "conflict.primary_changed", details: { currentPrimaryRevisionId: primary.revision.id } });
  });

  it("rolls back every row when a later step fails", () => {
    const h = harness();
    const content = insertContent(h);
    const broken = samplePlan({ translations: [{ language: "zh-CN", lines: [{ segmentIndex: 0, text: "一" }, { segmentIndex: 9, text: "?" }] }] });
    expect(codeOf(() => write(h, { contentId: content.id, newContent: false, plan: broken }))).toBe("internal");
    // Speakers, the original and the translation were attempted in that order; none remains.
    expect(countRows(h.db, "content_speaker")).toBe(0);
    expect(countRows(h.db, "transcript_revision")).toBe(0);
    expect(countRows(h.db, "transcript_segment")).toBe(0);
    expect(read(h, (scope) => scope.contents.get(OWNER, content.id))?.primaryTranscriptRevisionId).toBeUndefined();
  });

  it("refuses another user's Content as not found", () => {
    const h = harness();
    const content = insertContent(h, {}, BOB.userId);
    expect(codeOf(() => write(h, { contentId: content.id, newContent: false, plan: samplePlan() }))).toBe("not_found");
    expect(countRows(h.db, "content_speaker")).toBe(0);
  });
});

describe("SubtitleImportService.inspect", () => {
  it("answers plain text with its digest and no cues, and the target state of the user's Content", () => {
    const h = harness();
    const service = new SubtitleImportService({ repository: h.repository });
    const content = insertContent(h, { durationMs: 60_000 });
    const primary = insertPrimary(h, content.id);
    const translation = insertTranslation(h, content.id, primary);
    const [named, unnamed] = insertSpeakers(h, content.id, [{ name: "Alice" }, {}]);
    read(h, (scope) => scope.speakers.update(OWNER, content.id, unnamed?.id as string, { avatar: { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) } }, 6));
    const text = "\uFEFFplain notes";
    const response = service.inspect(LOCAL, { text, filename: "notes.txt", contentId: content.id });
    expect(response).toEqual({
      format: "txt",
      digest: subtitleTextDigest("plain notes"),
      cueCount: 0,
      droppedCues: { count: 0, samples: [] },
      speakers: { source: "none", candidates: [], sequence: [] },
      limits: [],
      target: {
        primaryRevisionId: primary.revision.id,
        speakers: [
          { id: named?.id, ordinal: 1, name: "Alice", colorIndex: defaultSpeakerColorIndex(1), used: false },
          { id: unnamed?.id, ordinal: 2, colorIndex: defaultSpeakerColorIndex(2), avatarVersion: 1, used: false },
        ],
        speakerRoom: SPEAKERS_PER_CONTENT_MAX - 2,
        currentTranslations: { "zh-CN": translation },
        durationMs: 60_000,
        coverageWarning: false,
      },
    });
    expect(service.inspect(LOCAL, { text: "# notes", format: "md" })).toMatchObject({ format: "md", digest: subtitleTextDigest("# notes") });
    expect(service.inspect(LOCAL, { text: "x", format: "md" })).not.toHaveProperty("target");
  });

  it("refuses another user's Content before reading the text, and text past the size limit", () => {
    const h = harness();
    const service = new SubtitleImportService({ repository: h.repository });
    const foreign = insertContent(h, {}, BOB.userId);
    expect(codeOf(() => service.inspect(LOCAL, { text: "1\n00:00:00,000 --> 00:00:01,000\nx\n", contentId: foreign.id }))).toBe("not_found");
    expect(codeOf(() => service.inspect(LOCAL, { text: "x".repeat(SUBTITLE_IMPORT_MAX_BYTES + 1), format: "txt" }))).toBe("media_too_large");
  });

  it("previews a local file only under its grant, within the size limit, as UTF-8", async () => {
    const h = harness();
    const key = randomBytes(32);
    const service = new SubtitleImportService({ repository: h.repository, grants: new HmacFileGrantVerifier(key) });
    const grant = (path: string, purpose: "local_file" | "relink" = "local_file") => signFileGrant(key, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS });
    const dir = tempDataDir("amber-inspect-");
    const notes = join(dir, "notes.md");
    writeFileSync(notes, "\uFEFF# heading");
    expect(await service.inspectLocal(LOCAL, { path: notes, grant: grant(notes) })).toMatchObject({ format: "md", digest: subtitleTextDigest("# heading"), cueCount: 0 });

    const other = join(dir, "other.txt");
    writeFileSync(other, "x");
    expect(await asyncCodeOf(() => service.inspectLocal(LOCAL, { path: notes, grant: grant(other) }))).toBe("unauthenticated.file_grant");
    expect(await asyncCodeOf(() => service.inspectLocal(LOCAL, { path: notes, grant: grant(notes, "relink") }))).toBe("unauthenticated.file_grant");
    const large = join(dir, "large.txt");
    writeFileSync(large, Buffer.alloc(SUBTITLE_IMPORT_MAX_BYTES + 1, 0x61));
    expect(await asyncCodeOf(() => service.inspectLocal(LOCAL, { path: large, grant: grant(large) }))).toBe("media_too_large");
    const latin1 = join(dir, "latin1.txt");
    writeFileSync(latin1, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    expect(await asyncCodeOf(() => service.inspectLocal(LOCAL, { path: latin1, grant: grant(latin1) }))).toBe("invalid_request.subtitle_encoding");
    expect(await asyncCodeOf(() => service.inspectLocal(LOCAL, { path: dir, grant: grant(dir) }))).toBe("invalid_request");
    const foreign = insertContent(h, {}, BOB.userId);
    expect(await asyncCodeOf(() => service.inspectLocal(LOCAL, { path: notes, grant: grant(notes), contentId: foreign.id }))).toBe("not_found");
  });
});

describe("ContentService.importSubtitle with options for plain text", () => {
  it("checks the previewed digest and still stores a ReferenceText", async () => {
    const h = harness();
    const content = insertContent(h);
    const text = "some notes";
    expect(codeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text, format: "txt", options: options() }))).toBe("conflict.subtitle_changed");
    expect(countRows(h.db, "reference_text")).toBe(0);
    const response = h.contents.importSubtitle(LOCAL, content.id, { text, filename: "a.txt", options: options({ expectedDigest: subtitleTextDigest(text) }) });
    expect(Object.keys(response).sort()).toEqual(["referenceTextId", "warnings"]);
    expect(countRows(h.db, "reference_text")).toBe(1);
  });
});

const SRT = "1\n00:00:00,000 --> 00:00:02,000\nAlice: hello\n\n2\n00:00:02,000 --> 00:00:04,000\nworld\n";
const VTT = "WEBVTT\n\n00:00.000 --> 00:02.000\n<v Alice>hello\n\n00:02.000 --> 00:04.000\n<v Bob>world\n\n00:04.000 --> 00:06.000\n<v Alice>again\n";
const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const PACKAGE: SubtitlePackage = {
  format: SUBTITLE_PACKAGE_FORMAT,
  formatVersion: SUBTITLE_PACKAGE_VERSION,
  generator: { app: "Amber", version: "0.7.0" },
  original: {
    language: "en",
    paragraphMarks: false,
    speakers: [
      { key: "s1", ordinal: 1, name: "Alice", colorIndex: 3 },
      { key: "s2", ordinal: 2, colorIndex: 1 },
    ],
    segments: [
      { key: "g1", startMs: 0, endMs: 1000, text: "one", speaker: "s1" },
      { key: "g2", startMs: 1000, endMs: 2000, text: "two", speaker: "s2" },
      { key: "g3", startMs: 2000, endMs: 3000, text: "three", speaker: null },
    ],
  },
  translations: [{ language: "zh-CN", segments: [{ sourceSegmentKey: "g1", text: "一" }, { sourceSegmentKey: "g3", text: "三" }] }],
};
const PACKAGE_TEXT = serializeSubtitlePackage(PACKAGE);

async function settledCodeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

const stacks: MediaStack[] = [];
function stack(): MediaStack {
  const created = createMediaStack();
  stacks.push(created);
  return created;
}
afterEach(async () => {
  for (const created of stacks.splice(0)) await created.close();
});

const withDigest = (text: string, extra: Record<string, unknown> = {}) => ({ expectedDigest: subtitleTextDigest(text), ...extra });

describe("POST /contents/:id/subtitle-import through the shared reader", () => {
  it("imports VTT voices as speakers when options are sent, answering the new fields", () => {
    const h = harness();
    const content = insertContent(h);
    const response = h.contents.importSubtitle(LOCAL, content.id, { text: VTT, language: "en", options: withDigest(VTT) });
    expect(response).toEqual({ transcriptRevisionId: expect.any(String), translationRevisionIds: {}, speakersCreated: 2, warnings: [] });
    const speakers = read(h, (scope) => scope.speakers.list(OWNER, content.id));
    expect(speakers.map((speaker) => [speaker.ordinal, speaker.name, speaker.nameConfirmedAt])).toEqual([
      [1, "Alice", undefined],
      [2, "Bob", undefined],
    ]);
    const segments = read(h, (scope) => scope.transcripts.listSegments(OWNER, response.transcriptRevisionId as string));
    expect(segments.map((segment) => [segment.text, segment.speakerId])).toEqual([
      ["hello", speakers[0]?.id],
      ["world", speakers[1]?.id],
      ["again", speakers[0]?.id],
    ]);
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, response.transcriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "vtt" });
  });

  it("leaves a request without options exactly as the plain import: no speakers, the old response shape", () => {
    const h = harness();
    const content = insertContent(h);
    const srt = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "en" });
    expect(Object.keys(srt).sort()).toEqual(["transcriptRevisionId", "warnings"]);
    const vtt = h.contents.importSubtitle(LOCAL, content.id, { text: VTT, language: "en", filename: "a.vtt" });
    expect(Object.keys(vtt).sort()).toEqual(["transcriptRevisionId", "warnings"]);
    expect(countRows(h.db, "content_speaker")).toBe(0);
    expect(read(h, (scope) => scope.transcripts.listSegments(OWNER, srt.transcriptRevisionId as string)).map((segment) => segment.text)).toEqual(["Alice: hello", "world"]);
    expect(read(h, (scope) => scope.transcripts.listSegments(OWNER, vtt.transcriptRevisionId as string)).map((segment) => segment.text)).toEqual(["hello", "world", "again"]);
  });

  it("takes SRT prefixes chosen in the options and refuses a text that is not the previewed one", async () => {
    const h = harness();
    const content = insertContent(h);
    expect(await settledCodeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "en", options: withDigest(VTT) }))).toBe("conflict.subtitle_changed");
    expect(countRows(h.db, "transcript_revision")).toBe(0);
    const response = h.contents.importSubtitle(LOCAL, content.id, {
      text: SRT,
      language: "en",
      options: withDigest(SRT, { speakers: { prefixNames: ["Alice"], unlabeled: "inherit" } }),
    });
    expect(response.speakersCreated).toBe(1);
    const segments = read(h, (scope) => scope.transcripts.listSegments(OWNER, response.transcriptRevisionId as string));
    expect(segments.map((segment) => segment.text)).toEqual(["hello", "world"]);
    expect(new Set(segments.map((segment) => segment.speakerId)).size).toBe(1);
  });

  it("needs the language of a standard format, not of a package", async () => {
    const h = harness();
    const content = insertContent(h);
    expect(await settledCodeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: VTT, options: withDigest(VTT) }))).toBe("invalid_request");
    const response = h.contents.importSubtitle(LOCAL, content.id, { text: PACKAGE_TEXT, filename: "talk.ambersub" });
    expect(response.speakersCreated).toBe(2);
    const translationId = response.translationRevisionIds?.["zh-CN"] as string;
    expect(read(h, (scope) => scope.translations.getArtifact(OWNER, content.id, "zh-CN"))?.currentRevisionId).toBe(translationId);
    expect(read(h, (scope) => scope.contents.get(OWNER, content.id))?.primaryTranscriptRevisionId).toBe(response.transcriptRevisionId);
    expect(read(h, (scope) => scope.speakers.list(OWNER, content.id)).map((speaker) => [speaker.ordinal, speaker.name, speaker.colorIndex])).toEqual([
      [1, "Alice", 3],
      [2, undefined, 1],
    ]);
  });

  it("recognizes an ASS by extension and a package by content without options", () => {
    const h = harness();
    const content = insertContent(h);
    const ass = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:00.00,0:00:01.00,Default,Alice,0,0,0,,hello",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,world",
      "",
    ].join("\n");
    const imported = h.contents.importSubtitle(LOCAL, content.id, { text: ass, filename: "a.ass", language: "en" });
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, imported.transcriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "ass" });
    expect(imported.speakersCreated).toBe(1);
    const sniffed = h.contents.importSubtitle(LOCAL, content.id, { text: PACKAGE_TEXT });
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, sniffed.transcriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "ambersub" });
    // Plain text is still a ReferenceText.
    expect(Object.keys(h.contents.importSubtitle(LOCAL, content.id, { text: "just notes" }))).toEqual(["referenceTextId", "warnings"]);
  });
});

describe("initial subtitles of a new Content", () => {
  it("imports a link's initial subtitle with options in the creating transaction and records it on the Task", async () => {
    const h = harness();
    const { body } = await h.importContent.import(LOCAL, {
      items: [{ url: WATCH, initialSubtitle: { text: VTT, language: "en", options: withDigest(VTT, { setCurrent: false }) } }],
      settings: { autoProofread: true },
    });
    const contentId = body.contentIds[0] as string;
    const content = read(h, (scope) => scope.contents.get(OWNER, contentId));
    const revisions = read(h, (scope) => scope.transcripts.listRevisions(OWNER, contentId));
    expect(revisions).toHaveLength(1);
    // A new Content's import is always its primary, whatever setCurrent says.
    expect(content?.primaryTranscriptRevisionId).toBe(revisions[0]?.id);
    expect(read(h, (scope) => scope.speakers.count(OWNER, contentId))).toBe(2);
    expect(JSON.parse(taskOf(h, body.taskIds[0] as string).requestJson)).toMatchObject({ initialSubtitleRevisionId: revisions[0]?.id });
  });

  it("refuses a changed text, and an initial subtitle for an existing Content, before writing", async () => {
    const h = harness();
    const changed = await settledCodeOf(() =>
      h.importContent.import(LOCAL, { items: [{ url: WATCH, initialSubtitle: { text: VTT, language: "en", options: withDigest(SRT) } }], settings: { autoProofread: true } }),
    );
    expect(changed).toBe("conflict.subtitle_changed");
    expect(countRows(h.db, "content")).toBe(0);
    await h.importContent.import(LOCAL, { items: [{ url: WATCH }], settings: { autoProofread: true } });
    const existing = await settledCodeOf(() =>
      h.importContent.import(LOCAL, { items: [{ url: WATCH, initialSubtitle: { text: PACKAGE_TEXT, format: "ambersub", language: "en" } }], settings: { autoProofread: true } }),
    );
    expect(existing).toBe("conflict");
    expect(countRows(h.db, "transcript_revision")).toBe(0);
  });

  it("imports a package with its translation for a new link Content", async () => {
    const h = harness();
    const { body } = await h.importContent.import(LOCAL, {
      items: [{ url: WATCH, initialSubtitle: { text: PACKAGE_TEXT, format: "ambersub", language: "en" } }],
      settings: { autoProofread: true },
    });
    const contentId = body.contentIds[0] as string;
    const artifact = read(h, (scope) => scope.translations.getArtifact(OWNER, contentId, "zh-CN"));
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, artifact?.currentRevisionId as string))).toMatchObject({ kind: "translated", segmentCount: 2 });
  });
});

const field = (name: string, value: string): UploadPart => ({ kind: "field", name, value });
async function* bytesOf(data: Buffer): AsyncIterable<Uint8Array> {
  yield data;
}
const file = (name: string, data: Buffer, filename: string): UploadPart => ({ kind: "file", name, filename, stream: bytesOf(data) });
async function* partsOf(...parts: UploadPart[]): AsyncIterable<UploadPart> {
  yield* parts;
}
const media = () => file("file", readFileSync(mediaFixtures().withAudio.path), "lecture.mp4");

describe("upload with subtitle options", () => {
  it("digests a request without options exactly as before, and one with options differently", async () => {
    const s = stack();
    const settings = { autoProofread: false };
    const subtitle = Buffer.from(SRT);
    const plain = await s.localImport.upload(
      LOCAL,
      partsOf(field("settings", JSON.stringify(settings)), field("allowDuplicate", "true"), field("subtitleLanguage", "en"), file("subtitle", subtitle, "a.srt"), media()),
      "plain-key",
    );
    const stored = read(s.h, (scope) => scope.idempotency.get(OWNER, UPLOAD_ROUTE, "plain-key"));
    const [asset] = read(s.h, (scope) => scope.mediaAssets.listByContent(OWNER, plain.body.contentIds[0] as string));
    expect(stored?.requestDigest).toBe(
      multipartRequestDigest({
        mediaSha256: asset?.fingerprint as string,
        subtitleSha256: `sha256:${createHash("sha256").update(subtitle).digest("hex")}`,
        metadata: { settings, allowDuplicate: true, subtitleLanguage: "en" },
      }),
    );

    const options = withDigest(SRT, { speakers: { prefixNames: ["Alice"] } });
    const withOptions = await s.localImport.upload(
      LOCAL,
      partsOf(
        field("settings", JSON.stringify(settings)),
        field("allowDuplicate", "true"),
        field("subtitleLanguage", "en"),
        field("subtitleOptions", JSON.stringify(options)),
        file("subtitle", subtitle, "a.srt"),
        media(),
      ),
      "options-key",
    );
    expect(read(s.h, (scope) => scope.idempotency.get(OWNER, UPLOAD_ROUTE, "options-key"))?.requestDigest).not.toBe(stored?.requestDigest);
    const contentId = withOptions.body.contentIds[0] as string;
    expect(read(s.h, (scope) => scope.speakers.list(OWNER, contentId)).map((speaker) => speaker.name)).toEqual(["Alice"]);
    const request = JSON.parse(taskOf(s.h, withOptions.body.taskIds[0] as string).requestJson) as { initialSubtitleRevisionId?: string };
    expect(read(s.h, (scope) => scope.contents.get(OWNER, contentId))?.primaryTranscriptRevisionId).toBe(request.initialSubtitleRevisionId);
  });

  it("refuses options out of order, malformed, without a subtitle or for a changed file, leaving nothing", async () => {
    const s = stack();
    const subtitle = Buffer.from(SRT);
    const options = JSON.stringify(withDigest(SRT));
    const cases: Array<[string, UploadPart[], string]> = [
      ["after the subtitle", [field("subtitleLanguage", "en"), file("subtitle", subtitle, "a.srt"), field("subtitleOptions", options), media()], "invalid_request"],
      ["not JSON", [field("subtitleLanguage", "en"), field("subtitleOptions", "{"), file("subtitle", subtitle, "a.srt"), media()], "invalid_request"],
      ["unknown key", [field("subtitleLanguage", "en"), field("subtitleOptions", JSON.stringify({ ...withDigest(SRT), extra: 1 })), file("subtitle", subtitle, "a.srt"), media()], "invalid_request"],
      ["without a subtitle", [field("subtitleOptions", options), media()], "invalid_request"],
      ["changed file", [field("subtitleLanguage", "en"), field("subtitleOptions", JSON.stringify(withDigest(VTT))), file("subtitle", subtitle, "a.srt"), media()], "conflict.subtitle_changed"],
    ];
    for (const [label, parts, code] of cases) {
      expect(await settledCodeOf(() => s.localImport.upload(LOCAL, partsOf(...parts))), label).toBe(code);
    }
    expect(countRows(s.h.db, "content")).toBe(0);
    expect(await s.files.list("assets")).toEqual([]);
  });
});

describe("formats named by extension and verified restore data", () => {
  const ASS = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,one",
    "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,two",
    "Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,three",
    "",
  ].join("\n");

  it("tells SRT and VTT apart by content whatever the file is named, in the import and its preview", () => {
    const h = harness();
    const content = insertContent(h);
    const service = new SubtitleImportService({ repository: h.repository });
    expect(service.inspect(LOCAL, { text: VTT, filename: "talk.srt" }).format).toBe("vtt");
    expect(service.inspect(LOCAL, { text: SRT, filename: "talk.vtt" }).format).toBe("srt");
    const vtt = h.contents.importSubtitle(LOCAL, content.id, { text: VTT, filename: "talk.srt", language: "en", options: withDigest(VTT) });
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, vtt.transcriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "vtt" });
    const srt = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, filename: "talk.vtt", language: "en", options: withDigest(SRT) });
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, srt.transcriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "srt" });
    // A declared format still has to match the content.
    expect(codeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: VTT, format: "srt", language: "en", options: withDigest(VTT) }))).toBe(
      "invalid_request.subtitle_format",
    );
  });

  it("imports a misnamed upload and local file with options by content", async () => {
    const s = stack();
    const uploaded = await s.localImport.upload(
      LOCAL,
      partsOf(field("allowDuplicate", "true"), field("subtitleLanguage", "en"), field("subtitleOptions", JSON.stringify(withDigest(SRT))), file("subtitle", Buffer.from(SRT), "talk.vtt"), media()),
    );
    const uploadedContent = read(s.h, (scope) => scope.contents.get(OWNER, uploaded.body.contentIds[0] as string));
    expect(read(s.h, (scope) => scope.transcripts.getRevision(OWNER, uploadedContent?.primaryTranscriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "srt" });

    const { withAudio } = mediaFixtures();
    const path = join(tempDataDir("amber-sub-"), "talk.srt");
    writeFileSync(path, VTT);
    const local = await s.localImport.importLocalFile(LOCAL, {
      path: withAudio.path,
      grant: s.grant(withAudio.path),
      settings: { autoProofread: true },
      allowDuplicate: true,
      initialSubtitle: { path, grant: s.grant(path), language: "en", options: withDigest(VTT) },
    });
    const localContent = read(s.h, (scope) => scope.contents.get(OWNER, local.body.contentIds[0] as string));
    expect(read(s.h, (scope) => scope.transcripts.getRevision(OWNER, localContent?.primaryTranscriptRevisionId as string))?.generation).toEqual({ kind: "imported", format: "vtt" });
  });

  it("does not need a language for a styled ASS whose restore data verified, and still does for a plain ASS", async () => {
    const h = harness();
    const content = insertContent(h);
    const styled = withAssRestoreData(ASS, PACKAGE_TEXT);
    const imported = h.contents.importSubtitle(LOCAL, content.id, { text: styled, filename: "talk.ass", options: withDigest(styled) });
    expect(read(h, (scope) => scope.transcripts.getRevision(OWNER, imported.transcriptRevisionId as string))).toMatchObject({ language: "en", generation: { kind: "imported", format: "ass" } });
    expect(imported.speakersCreated).toBe(2);
    expect(await settledCodeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: ASS, filename: "talk.ass", options: withDigest(ASS) }))).toBe("invalid_request");
  });
});

describe("local file with subtitle options", () => {
  it("reads the granted subtitle through the shared reader when options are sent", async () => {
    const s = stack();
    const { withAudio } = mediaFixtures();
    const subtitlePath = join(tempDataDir("amber-sub-"), "talk.vtt");
    writeFileSync(subtitlePath, `\uFEFF${VTT}`);
    const result = await s.localImport.importLocalFile(LOCAL, {
      path: withAudio.path,
      grant: s.grant(withAudio.path),
      settings: { autoProofread: true },
      allowDuplicate: true,
      initialSubtitle: { path: subtitlePath, grant: s.grant(subtitlePath), language: "en", options: withDigest(VTT) },
    });
    const contentId = result.body.contentIds[0] as string;
    expect(read(s.h, (scope) => scope.speakers.count(OWNER, contentId))).toBe(2);

    const packagePath = join(tempDataDir("amber-sub-"), "talk.ambersub");
    writeFileSync(packagePath, PACKAGE_TEXT);
    const packaged = await s.localImport.importLocalFile(LOCAL, {
      path: withAudio.path,
      grant: s.grant(withAudio.path),
      settings: { autoProofread: true },
      allowDuplicate: true,
      initialSubtitle: { path: packagePath, grant: s.grant(packagePath), language: "en" },
    });
    expect(read(s.h, (scope) => scope.translations.listArtifacts(OWNER, packaged.body.contentIds[0] as string))).toHaveLength(1);
  });
});
