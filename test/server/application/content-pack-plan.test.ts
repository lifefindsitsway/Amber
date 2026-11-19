import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_DESCRIPTION_MAX_CHARS, FIGURE_WIDTH_MIN_RATIO, NOTES_PER_CONTENT_MAX, SPEAKER_PALETTE_SIZE } from "../../../src/shared/defaults.ts";
import type { ContentPackImportDecisions, ContentPackSelection, PackContentDecision, PackContentResult, PackPreviewContent } from "../../../src/shared/dto/content-pack.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { openDatabase, type SqliteConnection } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { createPackCollections } from "../../../src/server/application/content-pack-collections.ts";
import type { ContentPackEngine, PackExportBuild, PackImportMediaPlan, PlacedPackMedia } from "../../../src/server/application/content-pack-engine.ts";
import { createContentPackEngine } from "../../../src/server/application/content-pack-plan.ts";
import {
  CONTENT_PACK_FORMAT,
  CONTENT_PACK_FORMAT_VERSION,
  collectionsDocumentSchema,
  contentDocumentSchema,
  contentPackHeaderSchema,
  PACK_ENTRY_NAME,
  revisionDocumentSchema,
} from "../../../src/server/domain/content-pack/document.ts";
import type { Content } from "../../../src/server/domain/content.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { ContentFigure } from "../../../src/server/domain/figure.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { Note } from "../../../src/server/domain/note.ts";
import type { TranscriptGeneration, TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { PackDocuments } from "../../../src/server/ports/content-pack.ts";
import type { NotPromise, RepositoryScope } from "../../../src/server/ports/repository.ts";
import { countRows, insertRow, openTempDatabase, tempDataDir } from "../../tools/sqlite.ts";

/**
 * The content pack engine end to end over two libraries: data made on A, its documents built,
 * serialized and parsed back with the pack schemas exactly as an archive would carry them,
 * then previewed, prepared and committed on B (and back).
 */

const T0 = 1_790_000_000_000;
const IMAGES = join(import.meta.dirname, "../../fixtures/images");
const LOSSY = new Uint8Array(readFileSync(join(IMAGES, "lossy.webp")));
const LOSSLESS = new Uint8Array(readFileSync(join(IMAGES, "lossless.webp")));
// The sample JPEG carries an encoder comment, which the pack refuses: it goes re-encoded.
const JPEG = new Uint8Array(readFileSync(join(IMAGES, "sample.jpg")));
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

interface Device {
  db: SqliteConnection;
  repository: SqliteRepository;
  engine: ContentPackEngine;
  newId: () => string;
  run<T>(work: (scope: RepositoryScope) => NotPromise<T>): T;
}

const opened: SqliteConnection[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** One migrated library, copied for every device: migrating each from scratch would dominate the run. */
let template: string | undefined;
function freshDatabase(): SqliteConnection {
  if (template === undefined) {
    const migrated = openTempDatabase();
    migrated.db.close();
    template = migrated.file;
  }
  const dir = tempDataDir("amber-pack-");
  const file = join(dir, "amber.db");
  copyFileSync(template, file);
  return openDatabase(file, { backupDir: join(dir, "backups") }).db;
}

function device(mode: "local" | "server" = "local"): Device {
  const db = freshDatabase();
  opened.push(db);
  const repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  const newId = monotonicFactory();
  const engine = createContentPackEngine({ mode, repository, collections: createPackCollections({ repository }), newId });
  return { db, repository, engine, newId, run: (work) => repository.withTransaction(work) };
}

// ---------------------------------------------------------------------------------------------
// Fixtures

function addContent(d: Device, owner: string, overrides: Partial<Content> = {}): string {
  const id = overrides.id ?? d.newId();
  d.run((scope) => scope.contents.insert({ id, userId: owner, source: { kind: "local" }, processingStatus: "succeeded", title: "讲座", durationMs: 60_000, createdAt: T0, updatedAt: T0, ...overrides }));
  return id;
}

function addRevision(
  d: Device,
  owner: string,
  contentId: string,
  options: {
    kind: TranscriptRevision["kind"];
    parent?: { id: string; segments: TranscriptSegment[] };
    texts: string[];
    speakers?: Array<string | undefined>;
    words?: boolean;
    paragraphs?: boolean;
    language?: string;
    generation?: TranscriptGeneration;
    createdAt?: number;
  },
): { id: string; segments: TranscriptSegment[] } {
  const id = d.newId();
  const segments = options.texts.map((text, ordinal): TranscriptSegment => {
    const speakerId = options.speakers?.[ordinal];
    return {
      id: d.newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text,
      ...(options.words === true ? { words: [{ text, startMs: ordinal * 1000, endMs: ordinal * 1000 + 800 }] } : {}),
      ...(speakerId === undefined ? {} : { speakerId }),
      ...(options.paragraphs === true ? { paragraphStart: ordinal % 2 === 0 } : {}),
      sourceSegmentIds: options.parent === undefined ? [] : [(options.parent.segments[ordinal] as TranscriptSegment).id],
    };
  });
  const revision: TranscriptRevision = {
    id,
    contentId,
    kind: options.kind,
    ...(options.parent === undefined ? {} : { parentRevisionId: options.parent.id }),
    language: options.language ?? "zh-CN",
    timingFidelity: options.words === true ? "exact_words" : options.kind === "corrected" || options.kind === "manual" ? "inherited_segment" : "segment_only",
    generation: options.generation ?? { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    createdAt: options.createdAt ?? T0,
  };
  d.run((scope) => scope.transcripts.insertRevision(owner, revision, segments));
  return { id, segments };
}

function addFigure(d: Device, owner: string, contentId: string, bytes: Uint8Array, overrides: Partial<ContentFigure> = {}): string {
  const id = overrides.id ?? d.newId();
  d.run((scope) =>
    scope.figures.insert(
      { id, contentId, userId: owner, source: "upload", displayMs: 5000, sortKey: 0, widthRatio: 0.7, image: { width: 64, height: 48, bytes: bytes.length, sha256: sha(bytes) }, version: 1, createdAt: T0, updatedAt: T0, ...overrides },
      bytes,
    ),
  );
  return id;
}

function addNote(d: Device, owner: string, contentId: string, revision: { id: string; segments: TranscriptSegment[] }, overrides: Partial<Note> = {}): string {
  const id = overrides.id ?? d.newId();
  const segment = revision.segments[0] as TranscriptSegment;
  d.run((scope) =>
    scope.notes.insert({
      id,
      userId: owner,
      contentId,
      transcriptRevisionId: revision.id,
      startSegmentId: segment.id,
      startOffset: 0,
      endSegmentId: segment.id,
      endOffset: 2,
      quote: segment.text.slice(0, 2),
      mark: "underline",
      color: "yellow",
      comment: "评论",
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    }),
  );
  return id;
}

const ASR_GENERATION: TranscriptGeneration = { kind: "asr", asrProfileId: "profile-a", modelId: "paraformer-v2" };
const LLM_GENERATION: TranscriptGeneration = {
  kind: "llm",
  modelRef: { providerProfileId: "profile-llm", modelId: "deepseek-chat", providerNameSnapshot: "中转", modelDisplaySnapshot: "DeepSeek V3" },
  promptRef: { id: "proofread", version: 1 },
  promptSnapshot: "PROMPT TEXT THAT MUST NOT TRAVEL",
};

/** A lecture on A: ASR original, its proofread (the primary), a translation, an archived import, speakers 0 and 1, a note, two figures. */
function seedLecture(d: Device, owner = "alice") {
  const contentId = addContent(d, owner);
  const asset: MediaAsset = {
    id: d.newId(),
    userId: owner,
    contentId,
    kind: "external_local",
    storageRef: "/home/someone/videos/lecture.mp4",
    displayName: "lecture.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1234,
    fingerprint: `sha256:${sha("lecture-bytes")}`,
    availability: "available",
    retentionPolicy: "never_delete",
    createdAt: T0,
  };
  d.run((scope) => {
    scope.mediaAssets.insert(asset);
    scope.speakers.insert(owner, contentId, [{ id: "0", name: "甲老师", nameConfirmedAt: T0 }, { id: "1", name: "乙同学" }], T0);
    scope.speakers.update(owner, contentId, "0", { avatar: { mime: "image/jpeg", bytes: JPEG } }, T0);
  });
  const texts = ["大家好今天讲检索", "检索增强生成是什么", "我们先看一个例子", "谢谢大家"];
  const asr = addRevision(d, owner, contentId, { kind: "asr", texts, speakers: ["0", "1", "0", undefined], words: true, generation: ASR_GENERATION, createdAt: T0 + 1 });
  const corrected = addRevision(d, owner, contentId, {
    kind: "corrected",
    parent: asr,
    texts: texts.map((text) => `${text}。`),
    speakers: ["0", "1", "0", undefined],
    paragraphs: true,
    generation: LLM_GENERATION,
    createdAt: T0 + 2,
  });
  const translated = addRevision(d, owner, contentId, {
    kind: "translated",
    parent: corrected,
    texts: ["Hello.", "What is RAG?", "An example.", "Thanks."],
    speakers: ["0", "1", "0", undefined],
    language: "en",
    generation: LLM_GENERATION,
    createdAt: T0 + 3,
  });
  const archived = addRevision(d, owner, contentId, { kind: "imported", texts: ["旧字幕"], createdAt: T0 + 4 });
  d.run((scope) => {
    scope.contents.setPrimaryTranscript(owner, contentId, corrected.id, T0);
    scope.translations.setCurrent(owner, contentId, "en", translated.id, d.newId());
    scope.transcripts.setArchived(owner, archived.id, T0 + 10);
    scope.speakerConfirmations.set(owner, contentId, corrected.id, T0 + 11);
  });
  const noteId = addNote(d, owner, contentId, corrected);
  const anchored = addFigure(d, owner, contentId, LOSSY, { source: "capture", capturedAtMs: 2100, displayMs: 2100, caption: "图一", anchor: { revisionId: corrected.id, segmentId: (corrected.segments[2] as TranscriptSegment).id, side: "before" } });
  const loose = addFigure(d, owner, contentId, LOSSLESS, { displayMs: 3500, sortKey: 1 });
  return { contentId, asset, asr, corrected, translated, archived, noteId, figures: { anchored, loose } };
}

// ---------------------------------------------------------------------------------------------
// Export, serialize, import

const avatarWebp = LOSSY;
const hooks = {
  hashMedia: async () => sha("lecture-bytes"),
  normalizeAvatar: async () => avatarWebp,
  signal: new AbortController().signal,
};

interface Pack {
  build: PackExportBuild;
  documents: PackDocuments;
  images: Map<string, Uint8Array>;
}

/** What an archive round trip does to the documents: JSON bytes, parsed with the strict schemas. */
function serialize(build: PackExportBuild): Pack {
  const json = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
  const images = new Map<string, Uint8Array>();
  for (const content of build.contents) {
    for (const name of [content.entry, ...content.revisions.map((r) => r.entry), ...content.images.map((i) => i.entry), ...content.media.map((m) => m.entry)]) {
      expect(name).toMatch(PACK_ENTRY_NAME);
    }
    for (const image of content.images) images.set(image.entry, image.bytes);
  }
  const documents: PackDocuments = {
    header: contentPackHeaderSchema.parse({
      format: CONTENT_PACK_FORMAT,
      formatVersion: CONTENT_PACK_FORMAT_VERSION,
      amberVersion: "0.0.0-test",
      encryption: "none",
      createdAt: T0,
      contents: build.contents.map((content) => ({ key: content.document.key, entry: content.entry, ...(content.title === undefined ? {} : { title: content.title }) })),
      entries: [],
    }),
    collections: collectionsDocumentSchema.parse(json(build.collections)),
    contents: build.contents.map((content) => ({
      entry: content.entry,
      document: contentDocumentSchema.parse(json(content.document)),
      revisions: new Map(content.revisions.map((revision) => [revision.entry, revisionDocumentSchema.parse(json(revision.document))])),
    })),
    digests: new Map(),
  };
  return { build, documents, images };
}

async function exportPack(d: Device, owner: string, selection: ContentPackSelection): Promise<Pack> {
  d.engine.validateSelection(owner, selection);
  return serialize(await d.engine.buildExport(owner, selection, hooks));
}

/** Everything of the Content: all revisions, figures, notes and the given media. */
function all(d: Device, owner: string, contentId: string, media: string[] = []): ContentPackSelection["contents"][number] {
  const revisionIds = d.run((scope) => scope.transcripts.listRevisions(owner, contentId)).map((revision) => revision.id);
  return { contentId, revisionIds, figures: true, notes: true, mediaAssetIds: media };
}

/** Overrides of the default decision; `undefined` removes a field. */
type Decide = (preview: PackPreviewContent) => { [K in keyof PackContentDecision]?: PackContentDecision[K] | undefined } | undefined;

/** The default the wizard would offer: a new Content or a merge into the single match, every category, every new file. */
const defaults = (preview: PackPreviewContent): PackContentDecision => ({
  key: preview.key,
  action: preview.diff.targetContentId === undefined ? "import" : "merge",
  ...(preview.diff.targetContentId === undefined ? {} : { targetContentId: preview.diff.targetContentId }),
  revisions: true,
  figures: true,
  notes: true,
  mediaKeys: preview.diff.media.filter((item) => item.state === "new" || item.state === "fill").map((item) => item.key),
});

function placedAt(plan: PackImportMediaPlan): PlacedPackMedia {
  return {
    location: plan.targetKind === "external_local" ? { path: `/imported/${plan.entry}` } : { storageRef: plan.targetKind === "platform_cache" ? `media/${plan.media.cacheFileName}` : `assets/x/${plan.assetId}` },
    sizeBytes: plan.media.sizeBytes,
    sha256: plan.media.sha256,
  };
}

function preview(d: Device, owner: string, pack: Pack) {
  return d.engine.analyzeImport(owner, pack.documents);
}

function importPack(d: Device, owner: string, pack: Pack, decide: Decide = () => ({}), options: { beforeCommit?: () => void; place?: (plan: PackImportMediaPlan) => PlacedPackMedia | undefined } = {}) {
  const analysed = preview(d, owner, pack);
  const decisions: ContentPackImportDecisions = {
    contents: analysed.contents.flatMap((item) => {
      const chosen = decide(item);
      if (chosen === undefined) return [];
      const merged: Record<string, unknown> = { ...defaults(item), ...chosen };
      for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
      return [merged as PackContentDecision];
    }),
    collections: [],
  };
  const prepared = d.engine.prepareImport(owner, pack.documents, analysed.state, decisions);
  options.beforeCommit?.();
  const images = new Map([...pack.images].filter(([entry]) => prepared.imageEntries.has(entry)));
  const placed = new Map<string, PlacedPackMedia>();
  for (const plan of prepared.media) {
    const at = (options.place ?? placedAt)(plan);
    if (at !== undefined) placed.set(plan.entry, at);
  }
  const results: PackContentResult[] = [
    ...prepared.refused,
    ...prepared.contents.map((item) => d.engine.commitContent(owner, pack.documents, item, { images, media: placed, now: T0 + 1000 })),
  ];
  return { preview: analysed.contents, prepared, results };
}

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

function readingOf(d: Device, owner: string, revisionId: string) {
  return d.run((scope) => {
    const revision = scope.transcripts.getRevision(owner, revisionId) as TranscriptRevision;
    const speakers = new Map(scope.speakers.list(owner, revision.contentId).map((speaker) => [speaker.id, speaker.name]));
    return scope.transcripts.listSegments(owner, revisionId).map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      words: segment.words,
      speaker: segment.speakerId === undefined ? undefined : speakers.get(segment.speakerId),
      paragraphStart: segment.paragraphStart,
    }));
  });
}

function revisionsByOrigin(d: Device, owner: string, contentId: string): Map<string, TranscriptRevision> {
  return new Map(d.run((scope) => scope.transcripts.listRevisions(owner, contentId)).map((revision) => [revision.originId ?? revision.id, revision]));
}

// ---------------------------------------------------------------------------------------------

describe("content pack engine: export plan and selection", () => {
  it("lists carryable revisions, flags archived, current and anchored items, and blocks what cannot go", async () => {
    const a = device();
    const lecture = seedLecture(a);
    const empty = addContent(a, "alice", { title: "空" });
    const busy = addContent(a, "alice", { source: { kind: "bilibili", platformContentId: "BV1", platformPartId: "1", sourceUrl: "https://www.bilibili.com/video/BV1" } });
    insertRow(a.db, "task", { id: "task-1", user_id: "alice", content_id: busy, kind: "process_content", request_json: "{}", status_projection: "running", created_at: T0 });
    const plan = a.engine.exportPlan("alice", { contentIds: [lecture.contentId, empty, busy] });
    const [first, second, third] = plan.contents;
    expect(first?.revisions.map((revision) => [revision.kind, revision.primary, revision.archived, revision.currentTranslation])).toEqual([
      ["asr", false, false, false],
      ["corrected", true, false, false],
      ["translated", false, false, true],
      ["imported", false, true, false],
    ]);
    expect(first?.revisions[1]).toMatchObject({ anchoredFigures: 1, notes: 1 });
    expect(first).toMatchObject({ figures: 2, notes: 1, speakers: 2, platformChapters: false, media: [{ assetId: lecture.asset.id, kind: "original", sizeBytes: 1234 }] });
    expect(first?.blocked).toBeUndefined();
    expect(second?.blocked).toBe("nothing_to_carry");
    expect(third).toMatchObject({ blocked: "busy", busyTaskId: "task-1" });

    const refused = (selection: ContentPackSelection) => {
      try {
        a.engine.validateSelection("alice", selection);
      } catch (error) {
        return isAmberError(error) ? [error.appError.code, error.appError.details] : error;
      }
      return undefined;
    };
    const base = { contentId: lecture.contentId, figures: false, notes: false, mediaAssetIds: [] };
    expect(refused({ contents: [{ ...base, revisionIds: [lecture.translated.id] }], collectionIds: [] })).toEqual(["invalid_request.pack_selection", { reason: "translation_without_parent", contentId: lecture.contentId }]);
    expect(refused({ contents: [{ ...base, revisionIds: [] , contentId: empty }], collectionIds: [] })).toEqual(["invalid_request.pack_selection", { reason: "nothing_to_carry", contentId: empty }]);
    expect(refused({ contents: [{ ...base, revisionIds: [], contentId: busy }], collectionIds: [] })).toEqual(["conflict.pack_content_busy", { contentId: busy, taskId: "task-1" }]);
    expect(refused({ contents: [{ ...base, revisionIds: [lecture.corrected.id, lecture.translated.id] }], collectionIds: [] })).toBeUndefined();
    // A media-only local Content carries something.
    expect(refused({ contents: [{ ...base, revisionIds: [], mediaAssetIds: [lecture.asset.id] }], collectionIds: [] })).toBeUndefined();
  });

  it("answers not_found for another user's Content and never shows it", () => {
    const a = device();
    const lecture = seedLecture(a);
    expect(() => a.engine.exportPlan("bob", { contentIds: [lecture.contentId] })).toThrow(expect.objectContaining({ appError: expect.objectContaining({ class: "not_found" }) }));
    expect(() => a.engine.validateSelection("bob", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] })).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ class: "not_found" }) }),
    );
  });

  it("writes only the whitelisted generation, transfer identities and no local paths or Profile ids", async () => {
    const a = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId, [lecture.asset.id])], collectionIds: [] });
    const text = JSON.stringify(pack.build.contents.map((content) => [content.document, content.revisions]));
    expect(text).not.toContain("PROMPT TEXT");
    expect(text).not.toContain("profile-llm");
    expect(text).not.toContain("profile-a");
    expect(text).not.toContain("/home/someone");
    expect(text).not.toContain("alice");
    const document = pack.documents.contents[0]?.document;
    expect(document?.revisions.map((revision) => revision.generation)).toEqual([
      { kind: "pack", originalKind: "asr", originalGeneration: "asr", modelName: "paraformer-v2" },
      { kind: "pack", originalKind: "corrected", originalGeneration: "llm", modelName: "DeepSeek V3" },
      { kind: "pack", originalKind: "translated", originalGeneration: "llm", modelName: "DeepSeek V3" },
      { kind: "pack", originalKind: "imported", originalGeneration: "imported" },
    ]);
    expect(document?.media).toEqual([expect.objectContaining({ kind: "original", displayName: "lecture.mp4", sha256: sha("lecture-bytes") })]);
    expect(document?.speakers.map((speaker) => [speaker.originContentKey, speaker.originSpeakerId, speaker.avatar?.mime])).toEqual([
      [lecture.contentId, "0", "image/webp"],
      [lecture.contentId, "1", undefined],
    ]);
  });
});

describe("content pack engine: import into a fresh library", () => {
  it("reproduces sentences, speakers, lineage, states, notes and figure places exactly", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId, [lecture.asset.id])], collectionIds: [] });
    const { preview: shown, results } = importPack(b, "alice", pack);
    expect(only(shown)).toMatchObject({ match: "new", candidates: [] });
    const result = only(results);
    expect(result).toMatchObject({ status: "imported", added: { revisions: 4, speakers: 2, figures: 2, notes: 1, media: 1 }, placedByTime: 1 });
    const contentId = result.contentId as string;
    const content = b.run((scope) => scope.contents.get("alice", contentId)) as Content;
    expect(content).toMatchObject({ processingStatus: "none", originId: lecture.contentId, title: "讲座" });
    expect(b.run((scope) => scope.tasks.listByContent("alice", contentId))).toEqual([]);

    const local = revisionsByOrigin(b, "alice", contentId);
    for (const original of [lecture.asr, lecture.corrected, lecture.translated, lecture.archived]) {
      expect(readingOf(b, "alice", (local.get(original.id) as TranscriptRevision).id)).toEqual(readingOf(a, "alice", original.id));
    }
    const corrected = local.get(lecture.corrected.id) as TranscriptRevision;
    const asr = local.get(lecture.asr.id) as TranscriptRevision;
    const translated = local.get(lecture.translated.id) as TranscriptRevision;
    expect(corrected).toMatchObject({ kind: "corrected", parentRevisionId: asr.id, generation: { kind: "pack", originalKind: "corrected", modelName: "DeepSeek V3" } });
    expect(translated).toMatchObject({ kind: "translated", parentRevisionId: corrected.id });
    const correctedSegments = b.run((scope) => scope.transcripts.listSegments("alice", corrected.id));
    const asrSegments = b.run((scope) => scope.transcripts.listSegments("alice", asr.id));
    expect(correctedSegments.map((segment) => segment.sourceSegmentIds)).toEqual(asrSegments.map((segment) => [segment.id]));
    expect(content.primaryTranscriptRevisionId).toBe(corrected.id);
    expect(b.run((scope) => scope.translations.getArtifact("alice", contentId, "en"))?.currentRevisionId).toBe(translated.id);
    // Archived and reviewed states travel with the revisions.
    expect(b.run((scope) => scope.transcripts.listArchived("alice", contentId))).toEqual([{ revisionId: (local.get(lecture.archived.id) as TranscriptRevision).id, archivedAt: T0 + 10 }]);
    expect(b.run((scope) => scope.speakerConfirmations.confirmedAt("alice", corrected.id))).toBe(T0 + 11);

    const speakers = b.run((scope) => scope.speakers.list("alice", contentId));
    expect(speakers.map((speaker) => [speaker.name, speaker.ordinal, speaker.nameConfirmedAt, speaker.origin])).toEqual([
      ["甲老师", 1, T0, { contentId: lecture.contentId, speakerId: "0" }],
      ["乙同学", 2, undefined, { contentId: lecture.contentId, speakerId: "1" }],
    ]);
    expect(speakers.map((speaker) => speaker.id)).not.toContain("0");
    expect(b.run((scope) => scope.speakers.getAvatar("alice", contentId, (speakers[0] as { id: string }).id))?.mime).toBe("image/webp");

    const note = only(b.run((scope) => scope.notes.listByContent("alice", contentId)));
    expect(note).toMatchObject({ transcriptRevisionId: corrected.id, startSegmentId: correctedSegments[0]?.id, startOffset: 0, endOffset: 2, quote: "大家", comment: "评论", originId: lecture.noteId });

    const figures = b.run((scope) => scope.figures.listByContent("alice", contentId));
    const anchored = figures.find((figure) => figure.originId === lecture.figures.anchored);
    expect(anchored).toMatchObject({ source: "capture", capturedAtMs: 2100, caption: "图一", anchor: { revisionId: corrected.id, segmentId: correctedSegments[2]?.id, side: "before" } });
    expect(Array.from(b.run((scope) => scope.figures.getImage("alice", anchored?.id as string)) ?? [])).toEqual(Array.from(LOSSY));
    expect(figures.find((figure) => figure.originId === lecture.figures.loose)?.anchor).toBeUndefined();

    const media = only(b.run((scope) => scope.mediaAssets.listByContent("alice", contentId)));
    expect(media).toMatchObject({ kind: "external_local", storageRef: "/imported/media/0/0.mp4", fingerprint: `sha256:${sha("lecture-bytes")}`, retentionPolicy: "never_delete", availability: "available" });
  });

  it("imports a Content without a transcript with no Task, and a platform Content with only its basics", async () => {
    const a = device();
    const b = device("server");
    const lecture = seedLecture(a);
    const platform = addContent(a, "alice", { title: "B 站视频", source: { kind: "bilibili", platformContentId: "BV1xx", platformPartId: "77", sourceUrl: "https://www.bilibili.com/video/BV1xx" } });
    const pack = await exportPack(a, "alice", {
      contents: [
        { contentId: lecture.contentId, revisionIds: [], figures: false, notes: false, mediaAssetIds: [lecture.asset.id] },
        { contentId: platform, revisionIds: [], figures: false, notes: false, mediaAssetIds: [] },
      ],
      collectionIds: [],
    });
    const { results } = importPack(b, "alice", pack);
    expect(results.map((result) => result.status)).toEqual(["imported", "imported"]);
    for (const result of results) {
      const content = b.run((scope) => scope.contents.get("alice", result.contentId as string)) as Content;
      expect(content.processingStatus).toBe("none");
      expect(content.primaryTranscriptRevisionId).toBeUndefined();
      expect(b.run((scope) => scope.tasks.listByContent("alice", content.id))).toEqual([]);
    }
    // Server mode keeps an original as a managed upload.
    expect(b.run((scope) => scope.mediaAssets.listByContent("alice", results[0]?.contentId as string))).toEqual([expect.objectContaining({ kind: "managed_upload", retentionPolicy: "keep" })]);
    expect(b.run((scope) => scope.contents.get("alice", results[1]?.contentId as string))?.source).toEqual({ kind: "bilibili", platformContentId: "BV1xx", platformPartId: "77", sourceUrl: "https://www.bilibili.com/video/BV1xx" });
  });

  it("refuses a translation whose original is neither carried nor here", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [lecture.corrected.id, lecture.translated.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    // Strip the original out of the documents, as a hand-made pack could.
    const content = pack.documents.contents[0] as PackDocuments["contents"][number];
    const stripped: Pack = {
      ...pack,
      documents: {
        ...pack.documents,
        contents: [
          {
            ...content,
            document: { ...content.document, revisions: content.document.revisions.filter((revision) => revision.kind === "translated"), primaryRevisionKey: undefined } as never,
            revisions: new Map([...content.revisions].filter(([, revision]) => revision.key === lecture.translated.id)),
          },
        ],
      },
    };
    delete (stripped.documents.contents[0]?.document as { primaryRevisionKey?: string }).primaryRevisionKey;
    const { preview: shown, results } = importPack(b, "alice", stripped);
    expect(only(only(shown).diff.revisions)).toMatchObject({ kind: "translated", rejected: "translation_without_parent", state: "new" });
    expect(only(results)).toMatchObject({ status: "imported", added: { revisions: 0 } });
    expect(b.run((scope) => scope.transcripts.listRevisions("alice", only(results).contentId as string))).toEqual([]);
  });

  it("keeps another user of the same library apart (owner isolation)", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const first = only(importPack(b, "alice", pack).results);
    const shownToBob = only(preview(b, "bob", pack).contents);
    expect(shownToBob).toMatchObject({ match: "new", candidates: [] });
    const second = only(importPack(b, "bob", pack).results);
    expect(second.contentId).not.toBe(first.contentId);
    expect(b.run((scope) => scope.contents.list("bob")).map((content) => content.id)).toEqual([second.contentId]);
    expect(b.run((scope) => scope.notes.listByContent("bob", first.contentId as string))).toEqual([]);
    // Bob cannot merge into Alice's Content even by naming it.
    const analysed = preview(b, "bob", pack);
    expect(() => b.engine.compare("bob", pack.documents, analysed.state, lecture.contentId, first.contentId as string)).toThrow(expect.objectContaining({ appError: expect.objectContaining({ class: "not_found" }) }));
    expect(() =>
      b.engine.prepareImport("bob", pack.documents, analysed.state, { contents: [{ key: lecture.contentId, action: "merge", targetContentId: first.contentId as string, revisions: true, figures: true, notes: true }], collections: [] }),
    ).toThrow();
    // A preview belongs to its owner.
    expect(() => b.engine.prepareImport("alice", pack.documents, analysed.state, { contents: [], collections: [] })).toThrow(expect.objectContaining({ appError: expect.objectContaining({ class: "not_found" }) }));
  });
});

describe("content pack engine: import into a library that has the Content", () => {
  it("adds nothing when the same pack is imported again", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId, [lecture.asset.id])], collectionIds: [] });
    const first = only(importPack(b, "alice", pack).results);
    const again = importPack(b, "alice", pack);
    const shown = only(again.preview);
    expect(shown).toMatchObject({ match: "same", diff: { targetContentId: first.contentId, platformChapters: "none", overLimit: [] } });
    expect(shown.diff.revisions.map((revision) => revision.state)).toEqual(["existing", "existing", "existing", "existing"]);
    expect(shown.diff.speakers.map((speaker) => speaker.state)).toEqual(["existing", "existing"]);
    expect(shown.diff.notes).toEqual({ new: 0, existing: 1, differs: 0, unplaceable: 0 });
    expect(shown.diff.figures).toEqual({ new: 0, existing: 2, differs: 0, placedByTime: 0, deletedHere: 0 });
    expect(shown.diff.media).toEqual([expect.objectContaining({ state: "existing" })]);
    expect(only(again.results)).toMatchObject({ status: "merged", added: { revisions: 0, speakers: 0, figures: 0, notes: 0, media: 0 }, conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 } });
    expect(countRows(b.db, "content")).toBe(1);
  });

  it("recognises a corrected revision carried alone and back (A → B → A) as already there", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const toB = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [lecture.corrected.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    const shown = only(only(preview(b, "alice", toB).contents).diff.revisions);
    expect(shown).toMatchObject({ kind: "imported", originalKind: "corrected", standalone: true });
    const onB = only(importPack(b, "alice", toB).results).contentId as string;
    const standalone = only(b.run((scope) => scope.transcripts.listRevisions("alice", onB)));
    expect(standalone).toMatchObject({ kind: "imported", originId: lecture.corrected.id, generation: { kind: "pack", originalKind: "corrected" } });
    expect(standalone.parentRevisionId).toBeUndefined();
    expect(readingOf(b, "alice", standalone.id)).toEqual(readingOf(a, "alice", lecture.corrected.id));

    const back = await exportPack(b, "alice", { contents: [all(b, "alice", onB)], collectionIds: [] });
    const onA = only(preview(a, "alice", back).contents);
    expect(onA).toMatchObject({ match: "same", diff: { targetContentId: lecture.contentId } });
    expect(only(onA.diff.revisions)).toMatchObject({ state: "existing" });
    expect(only(importPack(a, "alice", back).results)).toMatchObject({ added: { revisions: 0, speakers: 0 }, conflicts: { revisions: 0 } });
  });

  it("joins a revision edited on B from a standalone copy to A's original with its sentence sources", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const toB = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [lecture.corrected.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    const onB = only(importPack(b, "alice", toB).results).contentId as string;
    const standalone = only(b.run((scope) => scope.transcripts.listRevisions("alice", onB)));
    const standaloneSegments = b.run((scope) => scope.transcripts.listSegments("alice", standalone.id));
    const edited = addRevision(b, "alice", onB, {
      kind: "manual",
      parent: { id: standalone.id, segments: standaloneSegments },
      texts: ["大家好，今天讲检索。", "检索增强生成是什么。", "我们先看一个例子。", "谢谢大家！"],
      generation: { kind: "manual" },
      createdAt: T0 + 50,
    });
    const back = await exportPack(b, "alice", { contents: [{ contentId: onB, revisionIds: [edited.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    const shown = only(only(preview(a, "alice", back).contents).diff.revisions);
    expect(shown).toMatchObject({ kind: "manual", state: "new", standalone: false });
    only(importPack(a, "alice", back).results);
    const arrived = revisionsByOrigin(a, "alice", lecture.contentId).get(edited.id) as TranscriptRevision;
    expect(arrived).toMatchObject({ kind: "manual", parentRevisionId: lecture.corrected.id });
    expect(a.run((scope) => scope.transcripts.listSegments("alice", arrived.id)).map((segment) => segment.sourceSegmentIds)).toEqual(lecture.corrected.segments.map((segment) => [segment.id]));
    // The primary stays where it was unless asked.
    expect(a.run((scope) => scope.contents.get("alice", lecture.contentId))?.primaryTranscriptRevisionId).toBe(lecture.corrected.id);
  });

  it("keeps a revision archived here as it is and reports a changed revision of the same identity as a conflict", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", pack).results).contentId as string;
    const local = revisionsByOrigin(b, "alice", onB);
    b.run((scope) => scope.transcripts.setArchived("alice", (local.get(lecture.archived.id) as TranscriptRevision).id, undefined));
    // A revision of the same identity whose text differs: written on B directly with A's origin.
    const forged = b.newId();
    const segment: TranscriptSegment = { id: b.newId() as SegmentId, revisionId: forged, ordinal: 0, startMs: 0, endMs: 900, text: "别的内容", sourceSegmentIds: [] };
    b.run((scope) => scope.transcripts.insertRevision("alice", { id: forged, contentId: onB, kind: "imported", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: 1, originId: "forged-identity", createdAt: T0 }, [segment]));
    const changed = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    // Rename the archived revision's identity in the pack to collide with the forged one.
    const document = changed.documents.contents[0]?.document as PackDocuments["contents"][number]["document"];
    const archivedEntry = document.revisions.find((revision) => revision.key === lecture.archived.id);
    if (archivedEntry === undefined) throw new Error("no archived revision");
    archivedEntry.key = "forged-identity";
    const revisionDocument = changed.documents.contents[0]?.revisions.get(archivedEntry.entry);
    if (revisionDocument === undefined) throw new Error("no archived document");
    revisionDocument.key = "forged-identity";
    const again = importPack(b, "alice", changed);
    expect(only(again.preview).diff.revisions.find((revision) => revision.key === "forged-identity")).toMatchObject({ state: "differs" });
    expect(only(again.results)).toMatchObject({ added: { revisions: 0 }, conflicts: { revisions: 1 } });
    // The revision restored on B stays restored.
    expect(b.run((scope) => scope.transcripts.listArchived("alice", onB))).toEqual([]);
    expect(b.run((scope) => scope.transcripts.listSegments("alice", forged)).map((item) => item.text)).toEqual(["别的内容"]);
  });

  it("never replaces platform chapters here, never moves the chosen chapters, and adds them where there are none", async () => {
    const a = device();
    const b = device();
    const source = { kind: "bilibili" as const, platformContentId: "BV1ch", platformPartId: "5", sourceUrl: "https://www.bilibili.com/video/BV1ch" };
    const onA = addContent(a, "alice", { title: "章节视频", source });
    a.run((scope) => scope.chapters.insertPlatformRevision("alice", onA, { id: a.newId(), artifactId: a.newId(), chapters: [{ startMs: 0, endMs: 30_000, title: "A 的章节" }, { startMs: 30_000, endMs: 60_000, title: "下半" }], createdAt: T0 }));
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", onA)], collectionIds: [] });
    expect(pack.documents.contents[0]?.document.platformChapters).toHaveLength(2);

    // B has the same video with its own platform chapters.
    const onB = addContent(b, "alice", { source });
    const ownChapters = b.newId();
    b.run((scope) => {
      const { revisionId } = scope.chapters.insertPlatformRevision("alice", onB, { id: ownChapters, artifactId: b.newId(), chapters: [{ startMs: 0, endMs: 60_000, title: "B 的章节" }], createdAt: T0 });
      scope.chapters.setCurrent("alice", onB, revisionId);
    });
    const kept = importPack(b, "alice", pack);
    expect(only(kept.preview)).toMatchObject({ match: "same_media", candidates: [{ contentId: onB, reason: "platform" }], diff: { platformChapters: "keep" } });
    expect(only(kept.results).status).toBe("merged");
    expect(b.run((scope) => scope.chapters.listRevisions("alice", onB)).map((revision) => revision.chapters.map((chapter) => chapter.title))).toEqual([["B 的章节"]]);
    expect(b.run((scope) => scope.chapters.getCurrent("alice", onB))?.id).toBe(ownChapters);
    // The merge is remembered, so the next import knows the Content.
    expect(b.run((scope) => scope.transferOrigins.contentTargets("alice", onA))).toEqual([onB]);
    expect(only(preview(b, "alice", pack).contents)).toMatchObject({ match: "same", candidates: [expect.objectContaining({ contentId: onB, reason: "mapped" })] });

    // A library without platform chapters gets them; a fresh one too.
    const c = device();
    const onC = addContent(c, "alice", { source });
    const added = importPack(c, "alice", pack);
    expect(only(added.preview).diff.platformChapters).toBe("add");
    expect(c.run((scope) => scope.chapters.getCurrent("alice", onC))?.chapters.map((chapter) => chapter.title)).toEqual(["A 的章节", "下半"]);
  });

  it("reports a figure of the same identity with another image as a conflict and never replaces the image", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const onB = addContent(b, "alice", { id: lecture.contentId, title: "同一个" });
    // B already holds A's anchored figure's identity, with another image.
    const local = addFigure(b, "alice", onB, LOSSLESS, { originId: lecture.figures.anchored, caption: "本机" });
    const pack = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [], figures: true, notes: false, mediaAssetIds: [lecture.asset.id] }], collectionIds: [] });
    const result = importPack(b, "alice", pack, () => ({ adoptPack: true }));
    expect(only(result.preview).diff.figures).toMatchObject({ new: 1, differs: 1 });
    expect(only(result.results)).toMatchObject({ added: { figures: 1 }, updated: { figures: 0 }, conflicts: { figures: 1 } });
    expect(Array.from(b.run((scope) => scope.figures.getImage("alice", local)) ?? [])).toEqual(Array.from(LOSSLESS));
    expect(b.run((scope) => scope.figures.get("alice", local))?.caption).toBe("本机");
  });

  it("keeps local notes and figures that differ unless adopted, and refuses an adoption for an item changed since the preview", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const first = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", first).results).contentId as string;
    a.run((scope) => {
      scope.notes.update("alice", lecture.noteId, { comment: "A 改过的评论", color: "green" }, T0 + 100);
      const figure = scope.figures.get("alice", lecture.figures.loose) as ContentFigure;
      scope.figures.update("alice", figure.id, figure.version, { caption: "A 的备注", widthRatio: 0.4 }, T0 + 100);
      const anchored = scope.figures.get("alice", lecture.figures.anchored) as ContentFigure;
      scope.figures.update("alice", anchored.id, anchored.version, { caption: "A 改了图一" }, T0 + 100);
    });
    const second = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });

    // Without adopting: everything stays as B has it.
    const kept = importPack(b, "alice", second);
    expect(only(kept.preview).diff.notes).toMatchObject({ differs: 1 });
    expect(only(kept.preview).diff.figures).toMatchObject({ differs: 2 });
    expect(only(kept.results)).toMatchObject({ updated: { figures: 0, notes: 0 }, conflicts: { notes: 0, figures: 0 } });
    const noteOnB = only(b.run((scope) => scope.notes.listByContent("alice", onB)));
    expect(noteOnB.comment).toBe("评论");

    // Adopting, while the note and one figure are changed on B after the preview.
    const figuresOnB = b.run((scope) => scope.figures.listByContent("alice", onB));
    const anchoredOnB = figuresOnB.find((figure) => figure.originId === lecture.figures.anchored) as ContentFigure;
    const looseOnB = figuresOnB.find((figure) => figure.originId === lecture.figures.loose) as ContentFigure;
    const adopted = importPack(b, "alice", second, () => ({ adoptPack: true }), {
      beforeCommit: () =>
        b.run((scope) => {
          scope.notes.update("alice", noteOnB.id, { comment: "B 在另一个窗口改的" }, T0 + 200);
          scope.figures.update("alice", anchoredOnB.id, anchoredOnB.version, { widthRatio: 1 }, T0 + 200);
        }),
    });
    expect(only(adopted.results)).toMatchObject({ updated: { notes: 0, figures: 1 }, conflicts: { notes: 1, figures: 1 } });
    expect(b.run((scope) => scope.notes.get("alice", noteOnB.id))).toMatchObject({ comment: "B 在另一个窗口改的", color: "yellow" });
    expect(b.run((scope) => scope.figures.get("alice", looseOnB.id))).toMatchObject({ caption: "A 的备注", widthRatio: 0.4 });
    expect(b.run((scope) => scope.figures.get("alice", anchoredOnB.id))).toMatchObject({ caption: "图一", widthRatio: 1 });

    // Adopting with nothing changed in between updates the note too.
    const again = importPack(b, "alice", second, () => ({ adoptPack: true }));
    expect(only(again.results)).toMatchObject({ updated: { notes: 1 } });
    expect(b.run((scope) => scope.notes.get("alice", noteOnB.id))).toMatchObject({ comment: "A 改过的评论", color: "green" });
  });

  it("blocks a category over its limit with the excess named, never cutting it, and imports the rest when it is left out", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", pack, () => ({ notes: false })).results).contentId as string;
    const target = b.run((scope) => scope.transcripts.listRevisions("alice", onB)).find((revision) => revision.originId === lecture.corrected.id) as TranscriptRevision;
    const segments = b.run((scope) => scope.transcripts.listSegments("alice", target.id));
    b.run((scope) => {
      for (let index = 0; index < NOTES_PER_CONTENT_MAX; index += 1) {
        const segment = segments[0] as TranscriptSegment;
        scope.notes.insert({ id: b.newId(), userId: "alice", contentId: onB, transcriptRevisionId: target.id, startSegmentId: segment.id, startOffset: 0, endSegmentId: segment.id, endOffset: 1, quote: "大", mark: "underline", color: "yellow", createdAt: T0, updatedAt: T0 });
      }
    });
    const analysed = preview(b, "alice", pack);
    expect(only(analysed.contents).diff.overLimit).toEqual([{ category: "notes", over: 1, limit: NOTES_PER_CONTENT_MAX }]);
    const decision = { ...defaults(only(analysed.contents)) };
    expect(() => b.engine.prepareImport("alice", pack.documents, analysed.state, { contents: [decision], collections: [] })).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ class: "invalid_request" }) }),
    );
    const result = only(importPack(b, "alice", pack, () => ({ notes: false })).results);
    expect(result).toMatchObject({ status: "merged", added: { notes: 0 } });
    expect(b.run((scope) => scope.notes.countByContent("alice", onB))).toBe(NOTES_PER_CONTENT_MAX);
  });

  it("does not import again a figure deleted here within retention, and lists a purged one as new", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", pack).results).contentId as string;
    const loose = b.run((scope) => scope.figures.listByContent("alice", onB)).find((figure) => figure.originId === lecture.figures.loose) as ContentFigure;
    b.run((scope) => scope.figures.setDeleted("alice", loose.id, T0 + 500, T0 + 500));
    const deleted = importPack(b, "alice", pack);
    expect(only(deleted.preview).diff.figures).toMatchObject({ new: 0, deletedHere: 1 });
    expect(only(deleted.results).added.figures).toBe(0);
    b.run((scope) => scope.figures.purgeDeleted(T0 + 501, 10));
    const purged = importPack(b, "alice", pack);
    expect(only(purged.preview).diff.figures).toMatchObject({ new: 1, deletedHere: 0 });
    expect(only(purged.results).added.figures).toBe(1);
  });

  it("merges into a Content with the same file, tells same-text revisions of another identity, and keeps two speakers 0 apart", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    // B made its own Content of the same file, with its own speaker "0" and a transcript reading exactly like A's ASR.
    const onB = addContent(b, "alice", { title: "B 自己的" });
    b.run((scope) => {
      scope.mediaAssets.insert({ ...lecture.asset, id: b.newId(), contentId: onB, storageRef: "/b/lecture.mp4" });
      scope.speakers.insert("alice", onB, [{ id: "0", name: "B 的发言人" }], T0);
    });
    const own = addRevision(b, "alice", onB, { kind: "imported", texts: ["大家好今天讲检索", "检索增强生成是什么", "我们先看一个例子", "谢谢大家"], speakers: ["0", "0", "0", undefined] });
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId, [lecture.asset.id])], collectionIds: [] });
    const { preview: shown, results } = importPack(b, "alice", pack);
    const content = only(shown);
    expect(content).toMatchObject({ match: "same_media", candidates: [{ contentId: onB, reason: "fingerprint", trashed: false }] });
    expect(content.diff.revisions.find((revision) => revision.key === lecture.asr.id)).toMatchObject({ state: "new", sameTextAs: own.id, sameTextAsRevision: { kind: "imported", language: "zh-CN", createdAt: T0 } });
    expect(content.diff.revisions.find((revision) => revision.key === lecture.asr.id)?.sameTextAsRevision).not.toHaveProperty("modelName");
    expect(content.diff.speakers.map((speaker) => [speaker.state, speaker.sameNameCandidates])).toEqual([
      ["new", []],
      ["new", []],
    ]);
    expect(content.diff.media).toEqual([expect.objectContaining({ state: "existing" })]);
    expect(only(results)).toMatchObject({ status: "merged", added: { revisions: 4, speakers: 2 } });
    // B's speaker 0 is untouched and still owns only B's sentences.
    const speakers = b.run((scope) => scope.speakers.list("alice", onB));
    expect(speakers.find((speaker) => speaker.id === "0")?.name).toBe("B 的发言人");
    expect(readingOf(b, "alice", own.id).map((segment) => segment.speaker)).toEqual(["B 的发言人", "B 的发言人", "B 的发言人", undefined]);
    const asr = revisionsByOrigin(b, "alice", onB).get(lecture.asr.id) as TranscriptRevision;
    expect(readingOf(b, "alice", asr.id).map((segment) => segment.speaker)).toEqual(["甲老师", "乙同学", "甲老师", undefined]);
    // A merge leaves the primary alone unless asked.
    expect(b.run((scope) => scope.contents.get("alice", onB))?.primaryTranscriptRevisionId).toBeUndefined();
  });

  it("merges a speaker into a same-named one only when chosen, and then leaves the review unconfirmed", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const onB = addContent(b, "alice");
    b.run((scope) => {
      scope.mediaAssets.insert({ ...lecture.asset, id: b.newId(), contentId: onB });
      scope.speakers.insert("alice", onB, [{ id: "x", name: "甲老师" }], T0);
    });
    const pack = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [lecture.asr.id, lecture.corrected.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    const { preview: shown, results } = importPack(b, "alice", pack, () => ({ sameSpeakers: [{ speakerKey: "0", localSpeakerId: "x" }] }));
    expect(only(shown).diff.speakers[0]).toMatchObject({ state: "new", sameNameCandidates: [{ speakerId: "x", name: "甲老师" }] });
    expect(only(results)).toMatchObject({ added: { speakers: 1 } });
    const corrected = revisionsByOrigin(b, "alice", onB).get(lecture.corrected.id) as TranscriptRevision;
    expect(b.run((scope) => scope.transcripts.listSegments("alice", corrected.id)).map((segment) => segment.speakerId === "x")).toEqual([true, false, true, false]);
    expect(b.run((scope) => scope.speakerConfirmations.confirmedAt("alice", corrected.id))).toBeUndefined();

    // The same pack again: the merge is recognised from the sentences it wrote, nothing differs.
    const again = importPack(b, "alice", pack);
    expect(only(again.preview).diff.revisions.map((revision) => revision.state)).toEqual(["existing", "existing"]);
    expect(only(again.preview).diff.speakers.map((speaker) => [speaker.state, speaker.localSpeakerId === "x"])).toEqual([
      ["existing", true],
      ["existing", false],
    ]);
    expect(only(again.results)).toMatchObject({ added: { revisions: 0, speakers: 0 }, conflicts: { revisions: 0 } });
    // A later pack of the same Content keeps sending that speaker's sentences to the merged one.
    const later = addRevision(a, "alice", lecture.contentId, { kind: "manual", parent: lecture.corrected, texts: ["一", "二", "三", "四"], speakers: ["0", "1", "0", undefined], generation: { kind: "manual" }, createdAt: T0 + 70 });
    const next = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [lecture.corrected.id, later.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    expect(only(importPack(b, "alice", next).results)).toMatchObject({ added: { revisions: 1, speakers: 0 }, conflicts: { revisions: 0 } });
    const arrived = revisionsByOrigin(b, "alice", onB).get(later.id) as TranscriptRevision;
    expect(b.run((scope) => scope.transcripts.listSegments("alice", arrived.id)).map((segment) => segment.speakerId === "x")).toEqual([true, false, true, false]);
  });

  it("requires a choice when one identity maps to two Contents here", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId, [lecture.asset.id])], collectionIds: [] });
    const own = addContent(b, "alice", { title: "B 的" });
    b.run((scope) => scope.mediaAssets.insert({ ...lecture.asset, id: b.newId(), contentId: own }));
    // First as a new Content although the file is here; then merged into B's own as well.
    const asNew = only(importPack(b, "alice", pack, () => ({ action: "import", targetContentId: undefined })).results);
    expect(asNew.status).toBe("imported");
    only(importPack(b, "alice", pack, () => ({ action: "merge", targetContentId: own })).results);
    const analysed = preview(b, "alice", pack);
    const shown = only(analysed.contents);
    expect(shown.match).toBe("same");
    expect(shown.candidates.map((candidate) => [candidate.contentId, candidate.reason]).sort()).toEqual(
      [
        [asNew.contentId, "origin"],
        [own, "mapped"],
      ].sort(),
    );
    expect(shown.diff.targetContentId).toBeUndefined();
    const decide = (decision: Partial<PackContentDecision>) => () =>
      b.engine.prepareImport("alice", pack.documents, analysed.state, { contents: [{ ...defaults(shown), ...decision }], collections: [] });
    expect(decide({ action: "merge" })).toThrow();
    expect(decide({ action: "import" })).toThrow();
    expect(only(decide({ action: "merge", targetContentId: own })().contents).action).toBe("merge");
    // Comparing with a target the user picks by hand.
    expect(b.engine.compare("alice", pack.documents, analysed.state, shown.key, own).targetContentId).toBe(own);
  });

  it("refuses a match in the trash and a merge target whose primary moved since the preview, writing nothing", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", pack, () => ({ figures: false, notes: false, excludeRevisionKeys: [lecture.archived.id] })).results).contentId as string;

    const before = countRows(b.db, "transcript_revision");
    const asrOnB = (revisionsByOrigin(b, "alice", onB).get(lecture.asr.id) as TranscriptRevision).id;
    const moved = importPack(b, "alice", pack, () => ({ setPrimaryRevisionKey: lecture.asr.id }), {
      beforeCommit: () => b.run((scope) => scope.contents.setPrimaryTranscript("alice", onB, asrOnB, T0 + 300)),
    });
    expect(only(moved.results)).toMatchObject({ status: "failed", error: { code: "conflict.pack_target_changed", details: { contentId: onB } } });
    expect(countRows(b.db, "transcript_revision")).toBe(before);

    b.run((scope) => scope.contents.trash("alice", onB, T0 + 400));
    const trashed = importPack(b, "alice", pack);
    expect(only(trashed.preview)).toMatchObject({ match: "trashed", candidates: [{ contentId: onB, trashed: true }] });
    expect(only(trashed.results)).toMatchObject({ status: "failed", error: { code: "conflict.pack_target_changed" } });
  });

  it("refuses a merge target with an unfinished Task before anything is read", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", pack).results).contentId as string;
    insertRow(b.db, "task", { id: "task-b", user_id: "alice", content_id: onB, kind: "process_content", request_json: "{}", status_projection: "running", created_at: T0 });
    const { prepared } = importPack(b, "alice", pack);
    expect(only(prepared.refused)).toMatchObject({ status: "failed", error: { code: "conflict.pack_content_busy", details: { contentId: onB, taskId: "task-b" } } });
    expect(prepared.contents).toEqual([]);
  });

  it("rolls a failing Content back whole: nothing of it stays", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId, [lecture.asset.id])], collectionIds: [] });
    const tables = ["content", "transcript_revision", "transcript_segment", "content_speaker", "note", "content_figure", "media_asset"];
    const before = tables.map((table) => countRows(b.db, table));
    // The job did not place the media file: the commit fails after writing everything else.
    const { results } = importPack(b, "alice", pack, () => ({}), { place: () => undefined });
    expect(only(results)).toMatchObject({ status: "failed", error: { class: "internal" } });
    expect(tables.map((table) => countRows(b.db, table))).toEqual(before);
    // A retry with the file in place imports it.
    expect(only(importPack(b, "alice", pack).results).status).toBe("imported");
  });
});

describe("content pack engine: collections and media", () => {
  it("carries only the picked members of a collection in its order and lists a preselected collection first", async () => {
    const a = device();
    const [c1, c2, c3] = [1, 2, 3].map((n) => {
      const id = addContent(a, "alice", { title: `第 ${n} 讲` });
      addRevision(a, "alice", id, { kind: "imported", texts: [`内容 ${n}`] });
      return id;
    }) as [string, string, string];
    const other = a.newId();
    const series = a.newId();
    a.run((scope) => {
      scope.collections.insert({ id: series, userId: "alice", name: "系列", description: "说明", createdAt: T0, updatedAt: T0 });
      scope.collections.insert({ id: other, userId: "alice", name: "另一个", createdAt: T0 - 1, updatedAt: T0 });
      [c1, c2, c3].forEach((contentId, position) => scope.collections.addItem("alice", { id: a.newId(), collectionId: series, contentId, position, addedAt: T0 }));
      scope.collections.addItem("alice", { id: a.newId(), collectionId: other, contentId: c3, position: 0, addedAt: T0 });
    });
    const plan = a.engine.exportPlan("alice", { contentIds: [c3, c1], collectionId: series });
    expect(plan.collections.map((collection) => [collection.collectionId, collection.memberCount, collection.contentIds])).toEqual([
      [series, 3, [c1, c3]],
      [other, 1, [c3]],
    ]);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", c3), all(a, "alice", c1)], collectionIds: [series] });
    expect(pack.documents.collections).toEqual({ collections: [{ key: series, name: "系列", description: "说明", contentKeys: [c1, c3] }] });
    const refused = () => a.engine.validateSelection("alice", { contents: [all(a, "alice", c2)], collectionIds: [other] });
    expect(refused).toThrow(expect.objectContaining({ appError: expect.objectContaining({ code: "invalid_request.pack_selection" }) }));
  });

  it("treats a cache name held by another Content as a conflict and fills a registered cache whose file is gone", async () => {
    const a = device();
    const source = { kind: "bilibili" as const, platformContentId: "BV1cache", platformPartId: "9", sourceUrl: "https://www.bilibili.com/video/BV1cache" };
    const onA = addContent(a, "alice", { source });
    const cache: MediaAsset = {
      id: a.newId(),
      userId: "alice",
      contentId: onA,
      kind: "platform_cache",
      storageRef: "media/视频 [720P].mp4",
      mimeType: "video/mp4",
      sizeBytes: 999,
      quality: "720",
      qualityVerified: true,
      fingerprint: `sha256:${sha("cache-bytes")}`,
      availability: "available",
      retentionPolicy: "evictable",
      createdAt: T0,
    };
    a.run((scope) => scope.mediaAssets.insert(cache));
    const pack = await exportPack(a, "alice", { contents: [{ contentId: onA, revisionIds: [], figures: false, notes: false, mediaAssetIds: [cache.id] }], collectionIds: [] });
    expect(pack.documents.contents[0]?.document.media).toEqual([expect.objectContaining({ kind: "cache", cacheFileName: "视频 [720P].mp4", quality: "720", sha256: sha("cache-bytes") })]);

    // The name is taken by another Content (of another user, even): conflict, never overwritten.
    const b = device();
    const holder = addContent(b, "bob", { title: "别人的" });
    b.run((scope) => scope.mediaAssets.insert({ ...cache, id: b.newId(), userId: "bob", contentId: holder }));
    const analysed = preview(b, "alice", pack);
    const shown = only(analysed.contents);
    expect(shown.diff.media).toEqual([expect.objectContaining({ state: "conflict" })]);
    expect(() => b.engine.prepareImport("alice", pack.documents, analysed.state, { contents: [{ ...defaults(shown), mediaKeys: [cache.id] }], collections: [] })).toThrow();
    expect(only(importPack(b, "alice", pack).results)).toMatchObject({ status: "imported", added: { media: 0 }, conflicts: { media: 1 } });

    // The same Content here, its cache registered but evicted: the pack fills it in.
    const c = device();
    const onC = addContent(c, "alice", { source });
    c.run((scope) => scope.mediaAssets.insert({ ...cache, id: "cache-on-c", contentId: onC, availability: "evicted" }));
    const filled = importPack(c, "alice", pack);
    expect(only(filled.preview).diff.media).toEqual([expect.objectContaining({ state: "fill" })]);
    expect(only(filled.prepared.media)).toMatchObject({ assetId: "cache-on-c", fills: true, targetKind: "platform_cache", existingLocation: { storageRef: "media/视频 [720P].mp4" } });
    expect(only(filled.results)).toMatchObject({ status: "merged", added: { media: 1 } });
    expect(c.run((scope) => scope.mediaAssets.get("alice", "cache-on-c"))).toMatchObject({ availability: "available", fingerprint: `sha256:${sha("cache-bytes")}` });
    expect(only(importPack(c, "alice", pack).preview).diff.media).toEqual([expect.objectContaining({ state: "existing" })]);
  });
});

describe("content pack engine: places, anchors and untrusted fields", () => {
  it("leaves a figure's place alone when the pack does not say where it is, adopting only caption and width", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const full = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", full).results).contentId as string;
    const anchoredOnB = b.run((scope) => scope.figures.listByContent("alice", onB)).find((figure) => figure.originId === lecture.figures.anchored) as ContentFigure;
    expect(anchoredOnB.anchor).toBeDefined();

    // Figures without their revisions: the anchor is unknown, which is no difference.
    // A local Content needs something usable besides figures: its file comes along.
    const figuresOnly = { contentId: lecture.contentId, revisionIds: [], figures: true, notes: false, mediaAssetIds: [lecture.asset.id] };
    const bare = await exportPack(a, "alice", { contents: [figuresOnly], collectionIds: [] });
    expect(bare.documents.contents[0]?.document.figures.find((figure) => figure.key === lecture.figures.anchored)?.anchor).toBeUndefined();
    expect(only(preview(b, "alice", bare).contents).diff.figures).toMatchObject({ existing: 2, differs: 0 });

    // A new caption and width on A, still without revisions: adopted, the local anchor and place kept.
    a.run((scope) => {
      const figure = scope.figures.get("alice", lecture.figures.anchored) as ContentFigure;
      scope.figures.update("alice", figure.id, figure.version, { caption: "A 的新备注", widthRatio: 1, displayMs: 9999, sortKey: 7 }, T0 + 100);
    });
    const changed = await exportPack(a, "alice", { contents: [figuresOnly], collectionIds: [] });
    const adopted = importPack(b, "alice", changed, () => ({ adoptPack: true, revisions: false }));
    expect(only(adopted.preview).diff.figures).toMatchObject({ differs: 1 });
    expect(only(adopted.results)).toMatchObject({ updated: { figures: 1 }, conflicts: { figures: 0 } });
    expect(b.run((scope) => scope.figures.get("alice", anchoredOnB.id))).toMatchObject({
      caption: "A 的新备注",
      widthRatio: 1,
      anchor: anchoredOnB.anchor,
      displayMs: anchoredOnB.displayMs,
      sortKey: anchoredOnB.sortKey,
    });
  });

  it("anchors notes and figures on revisions already here when revisions are left out", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", pack, () => ({ notes: false, figures: false })).results).contentId as string;
    const result = only(importPack(b, "alice", pack, () => ({ revisions: false })).results);
    expect(result).toMatchObject({ added: { revisions: 0, notes: 1, figures: 2 }, placedByTime: 1 });
    const corrected = revisionsByOrigin(b, "alice", onB).get(lecture.corrected.id) as TranscriptRevision;
    const segments = b.run((scope) => scope.transcripts.listSegments("alice", corrected.id));
    expect(only(b.run((scope) => scope.notes.listByContent("alice", onB)))).toMatchObject({ transcriptRevisionId: corrected.id, startSegmentId: segments[0]?.id, quote: "大家" });
    const anchored = b.run((scope) => scope.figures.listByContent("alice", onB)).find((figure) => figure.originId === lecture.figures.anchored);
    expect(anchored?.anchor).toEqual({ revisionId: corrected.id, segmentId: segments[2]?.id, side: "before" });
  });

  it("refuses widths below the figure minimum, colours outside the palette and names that normalize to nothing", async () => {
    const a = device();
    const lecture = seedLecture(a);
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const document = JSON.parse(JSON.stringify(pack.build.contents[0]?.document)) as Record<string, unknown> & { figures: Array<Record<string, unknown>>; speakers: Array<Record<string, unknown>> };
    expect(contentDocumentSchema.safeParse(document).success).toBe(true);
    const tweak = (change: (copy: typeof document) => void): boolean => {
      const copy = JSON.parse(JSON.stringify(document)) as typeof document;
      change(copy);
      return contentDocumentSchema.safeParse(copy).success;
    };
    expect(tweak((copy) => ((copy.figures[0] as Record<string, unknown>).widthRatio = 0.2))).toBe(false);
    expect(tweak((copy) => ((copy.figures[0] as Record<string, unknown>).widthRatio = FIGURE_WIDTH_MIN_RATIO))).toBe(true);
    expect(tweak((copy) => ((copy.speakers[0] as Record<string, unknown>).colorIndex = SPEAKER_PALETTE_SIZE))).toBe(false);
    expect(tweak((copy) => ((copy.speakers[0] as Record<string, unknown>).name = " \u0007 "))).toBe(false);
    expect(tweak((copy) => (copy.platformChapters = Array.from({ length: 1001 }, (_, index) => ({ startMs: index, title: "x" }))))).toBe(false);
    expect(tweak((copy) => (copy.description = "x".repeat(CONTENT_DESCRIPTION_MAX_CHARS * 2 + 1)))).toBe(false);
  });

  it("stores carried speaker names and descriptions normalized and capped, and covers only for platform Contents over HTTPS", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    a.run((scope) => scope.contents.setMetadata("alice", lecture.contentId, { coverUrl: "https://example.invalid/local.jpg" }, T0));
    const platform = addContent(a, "alice", { title: "平台", coverUrl: "https://i0.hdslb.example/cover.jpg", source: { kind: "bilibili", platformContentId: "BV1cov", platformPartId: "1", sourceUrl: "https://www.bilibili.com/video/BV1cov" } });
    const plain = addContent(a, "alice", { title: "明文封面", coverUrl: "http://i0.hdslb.example/cover.jpg", source: { kind: "bilibili", platformContentId: "BV1http", platformPartId: "1", sourceUrl: "https://www.bilibili.com/video/BV1http" } });
    const pack = await exportPack(a, "alice", {
      contents: [
        { contentId: lecture.contentId, revisionIds: [lecture.asr.id], figures: false, notes: false, mediaAssetIds: [] },
        { contentId: platform, revisionIds: [], figures: false, notes: false, mediaAssetIds: [] },
        { contentId: plain, revisionIds: [], figures: false, notes: false, mediaAssetIds: [] },
      ],
      collectionIds: [],
    });
    expect(pack.documents.contents[0]?.document.coverUrl).toBeUndefined();
    // A hand-made pack: a cover on a local Content, a speaker name with stray spaces and a long, untidy description.
    const local = pack.documents.contents[0]?.document as PackDocuments["contents"][number]["document"];
    local.coverUrl = "https://example.invalid/local.jpg";
    (local.speakers[0] as { name?: string }).name = "  甲\t老师  ";
    local.description = `第一行   \r\n\r\n\r\n\r\n\r\n${"字".repeat(CONTENT_DESCRIPTION_MAX_CHARS + 50)}`;
    const { results } = importPack(b, "alice", pack);
    const [onB, platformOnB, plainOnB] = results.map((result) => b.run((scope) => scope.contents.get("alice", result.contentId as string)) as Content);
    expect(onB?.coverUrl).toBeUndefined();
    expect(b.run((scope) => scope.speakers.list("alice", onB?.id as string)).map((speaker) => speaker.name)).toEqual(["甲 老师", "乙同学"]);
    expect(onB?.description?.startsWith("第一行\n\n\n字")).toBe(true);
    expect([...(onB?.description ?? "")].length).toBe(CONTENT_DESCRIPTION_MAX_CHARS);
    expect(onB?.descriptionTruncated).toBe(true);
    expect(platformOnB?.coverUrl).toBe("https://i0.hdslb.example/cover.jpg");
    expect(plainOnB?.coverUrl).toBeUndefined();
  });

  it("checks cache names as the cache does: invalid names refuse the pack, another casing is the same file", async () => {
    const a = device();
    const source = { kind: "bilibili" as const, platformContentId: "BV1case", platformPartId: "3", sourceUrl: "https://www.bilibili.com/video/BV1case" };
    const onA = addContent(a, "alice", { source });
    const cache: MediaAsset = {
      id: a.newId(), userId: "alice", contentId: onA, kind: "platform_cache", storageRef: "media/Lecture [720P].mp4", mimeType: "video/mp4", sizeBytes: 10,
      quality: "720", qualityVerified: true, fingerprint: `sha256:${sha("case")}`, availability: "available", retentionPolicy: "evictable", createdAt: T0,
    };
    a.run((scope) => scope.mediaAssets.insert(cache));
    const pack = await exportPack(a, "alice", { contents: [{ contentId: onA, revisionIds: [], figures: false, notes: false, mediaAssetIds: [cache.id] }], collectionIds: [] });
    const b = device();
    const holder = addContent(b, "alice", { title: "另一个" });
    b.run((scope) => scope.mediaAssets.insert({ ...cache, id: b.newId(), contentId: holder, storageRef: "media/lecture [720p].mp4", fingerprint: `sha256:${sha("other")}` }));
    expect(only(preview(b, "alice", pack).contents).diff.media).toEqual([expect.objectContaining({ state: "conflict" })]);

    for (const name of ["../x.mp4", "Lecture.exe", " Lecture.mp4", "a/b.mp4"]) {
      const bad = serialize(pack.build);
      ((bad.documents.contents[0]?.document.media[0]) as { cacheFileName?: string }).cacheFileName = name;
      expect(() => preview(b, "alice", bad)).toThrow(expect.objectContaining({ appError: expect.objectContaining({ code: "backup_invalid.pack_entry" }) }));
    }
  });

  it("never lets two carried Contents merge into the same Content here", async () => {
    const a = device();
    const b = device();
    const first = seedLecture(a);
    const second = addContent(a, "alice", { title: "同一个文件的另一条" });
    a.run((scope) => scope.mediaAssets.insert({ ...first.asset, id: a.newId(), contentId: second }));
    addRevision(a, "alice", second, { kind: "imported", texts: ["另一份"] });
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", first.contentId), all(a, "alice", second)], collectionIds: [] });
    const onB = addContent(b, "alice", { title: "B 的" });
    b.run((scope) => scope.mediaAssets.insert({ ...first.asset, id: b.newId(), contentId: onB }));
    const analysed = preview(b, "alice", pack);
    // Both match B's Content by the file; neither is pointed at it by default.
    expect(analysed.contents.map((content) => [content.match, content.candidates.map((candidate) => candidate.contentId), content.diff.targetContentId])).toEqual([
      ["same_media", [onB], undefined],
      ["same_media", [onB], undefined],
    ]);
    const both = analysed.contents.map((content) => ({ ...defaults(content), action: "merge" as const, targetContentId: onB }));
    expect(() => b.engine.prepareImport("alice", pack.documents, analysed.state, { contents: both, collections: [] })).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ class: "invalid_request" }) }),
    );
    const one = [both[0] as PackContentDecision, { ...defaults(analysed.contents[1] as PackPreviewContent), action: "import" as const }];
    expect(b.engine.prepareImport("alice", pack.documents, analysed.state, { contents: one, collections: [] }).contents.map((item) => item.action)).toEqual(["merge", "import"]);
  });

  it("writes platform chapters without a known duration", async () => {
    const a = device();
    const b = device();
    const source = { kind: "bilibili" as const, platformContentId: "BV1nodur", platformPartId: "1", sourceUrl: "https://www.bilibili.com/video/BV1nodur" };
    const onA = addContent(a, "alice", { source });
    a.run((scope) => scope.chapters.insertPlatformRevision("alice", onA, { id: a.newId(), artifactId: a.newId(), chapters: [{ startMs: 0, endMs: 1000, title: "一" }, { startMs: 1000, endMs: 4000, title: "二" }], createdAt: T0 }));
    const pack = await exportPack(a, "alice", { contents: [all(a, "alice", onA)], collectionIds: [] });
    const document = pack.documents.contents[0]?.document as PackDocuments["contents"][number]["document"];
    delete (document as { durationMs?: number }).durationMs;
    const onB = only(importPack(b, "alice", pack).results).contentId as string;
    expect(b.run((scope) => scope.chapters.getCurrent("alice", onB))?.chapters).toEqual([
      { startMs: 0, endMs: 1000, title: "一" },
      { startMs: 1000, endMs: 4000, title: "二" },
    ]);
  });

  it("keeps a local note's comment when the pack's note has none", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const first = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", first).results).contentId as string;
    // A clears the comment: on its own that is no difference.
    a.run((scope) => scope.notes.update("alice", lecture.noteId, { comment: undefined }, T0 + 100));
    const cleared = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    expect(only(preview(b, "alice", cleared).contents).diff.notes).toMatchObject({ existing: 1, differs: 0 });
    // A also changes the colour: adopting takes the colour and keeps B's comment.
    a.run((scope) => scope.notes.update("alice", lecture.noteId, { color: "blue" }, T0 + 200));
    const recoloured = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    expect(only(importPack(b, "alice", recoloured, () => ({ adoptPack: true })).results)).toMatchObject({ updated: { notes: 1 } });
    expect(only(b.run((scope) => scope.notes.listByContent("alice", onB)))).toMatchObject({ color: "blue", comment: "评论" });
  });

  it("keeps a local figure's caption when the pack's figure has none", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const first = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", first).results).contentId as string;
    const anchoredOnB = () => b.run((scope) => scope.figures.listByContent("alice", onB)).find((figure) => figure.originId === lecture.figures.anchored) as ContentFigure;
    const captionOnB = anchoredOnB().caption;
    expect(captionOnB).toBeDefined();
    // A clears the caption: on its own that is no difference.
    a.run((scope) => {
      const figure = scope.figures.get("alice", lecture.figures.anchored) as ContentFigure;
      scope.figures.update("alice", figure.id, figure.version, { caption: null }, T0 + 100);
    });
    const cleared = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    expect(only(preview(b, "alice", cleared).contents).diff.figures).toMatchObject({ differs: 0 });
    // A also changes the width: adopting takes the width and keeps B's caption.
    a.run((scope) => {
      const figure = scope.figures.get("alice", lecture.figures.anchored) as ContentFigure;
      scope.figures.update("alice", figure.id, figure.version, { widthRatio: 1 }, T0 + 200);
    });
    const widened = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    expect(only(importPack(b, "alice", widened, () => ({ adoptPack: true })).results)).toMatchObject({ updated: { figures: 1 } });
    expect(anchoredOnB()).toMatchObject({ caption: captionOnB, widthRatio: 1 });
  });
});

describe("content pack engine: what the preview shows for reference", () => {
  it("names the local revision a carried one reads like, with the model its label shows", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const onB = addContent(b, "alice");
    b.run((scope) => scope.mediaAssets.insert({ ...lecture.asset, id: b.newId(), contentId: onB }));
    const texts = ["大家好今天讲检索", "检索增强生成是什么", "我们先看一个例子", "谢谢大家"];
    const fromPack = addRevision(b, "alice", onB, { kind: "imported", texts, generation: { kind: "pack", originalKind: "asr", originalGeneration: "asr", modelName: "paraformer-v2" }, createdAt: T0 + 5 });
    const proofread = addRevision(b, "alice", onB, { kind: "imported", texts: texts.map((text) => `${text}。`), generation: LLM_GENERATION, language: "zh-CN", createdAt: T0 + 6 });
    const pack = await exportPack(a, "alice", { contents: [{ contentId: lecture.contentId, revisionIds: [lecture.asr.id, lecture.corrected.id], figures: false, notes: false, mediaAssetIds: [] }], collectionIds: [] });
    const revisions = only(preview(b, "alice", pack).contents).diff.revisions;
    expect(revisions.find((revision) => revision.key === lecture.asr.id)).toMatchObject({
      sameTextAs: fromPack.id,
      sameTextAsRevision: { kind: "imported", language: "zh-CN", createdAt: T0 + 5, modelName: "paraformer-v2" },
    });
    expect(revisions.find((revision) => revision.key === lecture.corrected.id)).toMatchObject({
      sameTextAs: proofread.id,
      sameTextAsRevision: { kind: "imported", language: "zh-CN", createdAt: T0 + 6, modelName: "DeepSeek V3" },
    });
  });

  it("gives the latest change on each side of the notes and figures that differ, leaving image conflicts out", async () => {
    const a = device();
    const b = device();
    const lecture = seedLecture(a);
    const first = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const onB = only(importPack(b, "alice", first).results).contentId as string;
    const same = only(preview(b, "alice", first).contents).diff;
    expect(same.notes).not.toHaveProperty("differsUpdatedAt");
    expect(same.figures).not.toHaveProperty("differsUpdatedAt");

    a.run((scope) => {
      scope.notes.update("alice", lecture.noteId, { color: "green" }, T0 + 300);
      const loose = scope.figures.get("alice", lecture.figures.loose) as ContentFigure;
      scope.figures.update("alice", loose.id, loose.version, { widthRatio: 0.4 }, T0 + 200);
      const anchored = scope.figures.get("alice", lecture.figures.anchored) as ContentFigure;
      scope.figures.update("alice", anchored.id, anchored.version, { caption: "改了" }, T0 + 400);
    });
    b.run((scope) => {
      const note = only(scope.notes.listByContent("alice", onB));
      scope.notes.update("alice", note.id, { comment: "B 的评论" }, T0 + 250);
      // The anchored figure's image differs here: a conflict, so its times are left out.
      const anchored = scope.figures.listByContent("alice", onB).find((figure) => figure.originId === lecture.figures.anchored) as ContentFigure;
      scope.figures.setDeleted("alice", anchored.id, T0 + 260, T0 + 260);
      scope.figures.purgeDeleted(T0 + 261, 10);
    });
    addFigure(b, "alice", onB, LOSSLESS, { originId: lecture.figures.anchored, updatedAt: T0 + 900 });
    const second = await exportPack(a, "alice", { contents: [all(a, "alice", lecture.contentId)], collectionIds: [] });
    const diff = only(preview(b, "alice", second).contents).diff;
    expect(diff.notes).toMatchObject({ differs: 1, differsUpdatedAt: { here: T0 + 250, pack: T0 + 300 } });
    // B still has the loose figure as imported (updated at T0 on A when it was carried).
    expect(diff.figures).toMatchObject({ differs: 2, differsUpdatedAt: { here: T0, pack: T0 + 200 } });
  });
});
