import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NodeProcessRunner } from "../../src/server/adapters/process-runner/node-process-runner.ts";
import type { TranscriptSegment } from "../../src/server/domain/transcript.ts";
import { CachePathLocks } from "../../src/server/pipeline/cache-path-locks.ts";
import { CONTENT_PACK_DOCUMENT_MAX_BYTES, FIGURE_IMAGE_MAX_BYTES, FIGURES_PER_CONTENT_MAX, NOTES_PER_CONTENT_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../src/shared/defaults.ts";
import type { CollectionDetailDto } from "../../src/shared/dto/collection.ts";
import type {
  ContentPackActiveDto,
  ContentPackExportJobDto,
  ContentPackExportPlanDto,
  ContentPackImportJobDto,
  PackCollectionDecision,
  PackContentDecision,
  PackContentDiff,
  PackPreviewCollection,
  PackPreviewContent,
} from "../../src/shared/dto/content-pack.ts";
import type { FigureDto } from "../../src/shared/dto/figure.ts";
import type { NoteDto } from "../../src/shared/dto/note.ts";
import type { SearchResultDto } from "../../src/shared/dto/search.ts";
import type { SpeakerDto } from "../../src/shared/dto/speaker.ts";
import type { NotPromise, RepositoryScope } from "../../src/server/ports/repository.ts";
import { ANIMATED_WEBP, FIGURE_WEBP, rawEntriesOf, rawTar, sampleBuild, type RawEntry } from "../fixtures/content-pack/pack.ts";
import { composeServerStack, STACK_ORIGIN, type ComposedStack } from "../fixtures/server/composed-stack.ts";
import { CONTENT_PACK_FORMAT_VERSION } from "../../src/server/domain/content-pack/document.ts";
import { tempDataDir } from "../tools/sqlite.ts";
import {
  addCache,
  addContent,
  addFigure,
  addNote,
  addOriginal,
  addRevision,
  addUser,
  chaptersOf,
  closeStack,
  closeStacks,
  commitPack,
  contentOf,
  contentsOf,
  contentsWithIdentity,
  dataPath,
  decisionsOf,
  discard,
  everything,
  exportDone,
  exportPack,
  failedPreview,
  FIGURE_CAPTION,
  figureImage,
  figuresOf,
  importJob,
  importPack,
  journalsIn,
  LECTURE_TEXTS,
  lectureRevisions,
  mediaBytes,
  mp4Bytes,
  newId,
  notesOf,
  ok,
  only,
  openStack,
  packOf,
  pick,
  previewPack,
  readingOf,
  refused,
  reopen,
  revisionsByOrigin,
  revisionsOf,
  run,
  SECOND_FIGURE_WEBP,
  seedLecture,
  segmentsOf,
  selection,
  send,
  snapshotDataDir,
  speakersOf,
  startExport,
  swapFigureImage,
  T0,
  until,
  upload,
  webpWithChunk,
  webpWithRiffSize,
  webpWithWidth,
  type Device,
  type Lecture,
} from "./content-pack-acceptance-kit.ts";

/**
 * The content pack acceptance matrix, end to end through the composed server: data is made on
 * one instance (device A), exported through `/api/content-packs/exports` and downloaded as the
 * browser would, uploaded to another instance (device B) as a raw body, previewed, decided on
 * and committed; what arrived is then read back through the API. A fresh user is a fresh
 * library, so most cases share the two instances and differ by user.
 */

let A: ComposedStack;
let B: ComposedStack;

beforeAll(async () => {
  [A, B] = await Promise.all([openStack(), openStack()]);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeStacks();
});

const exporter = () => addUser(A, "alice");
const importer = () => addUser(B, "bob");
const TIMEOUT = 60_000;

/** The plan the export wizard shows for these Contents. */
const planOf = (device: Device, contentIds: string[]) => ok<ContentPackExportPlanDto>(device, { method: "POST", url: "/api/content-packs/export-plan", payload: { contentIds } });

/** The whole lecture with its original. */
const lecturePack = (device: Device, lecture: Lecture) => exportPack(device, selection([everything(device, lecture.contentId, [lecture.original.id])]));

/** The local Content a finished import put the single carried Content in. */
const importedId = (done: ContentPackImportJobDto): string => only(done.result?.contents).contentId as string;

/** A revision's sentence by ordinal, as an anchor names it: the revision's carried identity, the ordinal and the side. */
async function anchorName(device: Device, contentId: string, anchor: { revisionId: string; segmentId: string; side?: string } | null | undefined) {
  if (anchor === null || anchor === undefined) return undefined;
  const origins = new Map([...revisionsByOrigin(device, contentId)].map(([origin, revision]) => [revision.id, origin]));
  const ordinal = (await segmentsOf(device, anchor.revisionId)).findIndex((segment) => segment.id === anchor.segmentId);
  return { revision: origins.get(anchor.revisionId), ordinal, ...(anchor.side === undefined ? {} : { side: anchor.side }) };
}

/** A figure as the reader places it, local ids replaced by what travels. */
async function figureView(device: Device, contentId: string, figure: FigureDto) {
  return {
    source: figure.source,
    capturedAtMs: figure.capturedAtMs,
    caption: figure.caption,
    widthRatio: figure.widthRatio,
    displayMs: figure.placement.displayMs,
    sortKey: figure.placement.sortKey,
    anchor: await anchorName(device, contentId, figure.placement.anchor),
    image: figure.image,
  };
}

/** A note as the reader shows it, local ids replaced by what travels. */
async function noteView(device: Device, contentId: string, note: NoteDto) {
  const start = await anchorName(device, contentId, { revisionId: note.transcriptRevisionId, segmentId: note.startSegmentId });
  const end = await anchorName(device, contentId, { revisionId: note.transcriptRevisionId, segmentId: note.endSegmentId });
  return { start, end, startOffset: note.startOffset, endOffset: note.endOffset, startMs: note.startMs, quote: note.quote, mark: note.mark, color: note.color, comment: note.comment, createdAt: note.createdAt };
}

const speakerView = (speaker: SpeakerDto) => ({ ordinal: speaker.ordinal, name: speaker.name, colorIndex: speaker.colorIndex, nameConfirmed: speaker.nameConfirmed, photo: speaker.avatarVersion !== undefined });

/** The TXT export with speakers: what a reader copies out of a revision. */
async function copyText(device: Device, contentId: string, revisionId: string): Promise<string> {
  const response = await send(device, { method: "POST", url: `/api/contents/${contentId}/export`, payload: { format: "txt", revisionId, includeSpeakers: true } });
  expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
  return response.body;
}

const counts = async (device: Device, contentId: string) => {
  const detail = await contentOf(device, contentId);
  const figures = await figuresOf(device, contentId);
  return {
    revisions: (await revisionsOf(device, contentId)).revisions.length,
    speakers: (await speakersOf(device, contentId)).length,
    notes: (await notesOf(device, contentId)).length,
    figures: figures.items.length,
    media: detail.media.length,
  };
};

const platformSource = (kind: "bilibili" | "youtube", id: string) =>
  kind === "bilibili"
    ? { kind, platformContentId: id, platformPartId: "1", sourceUrl: `https://www.bilibili.com/video/${id}` }
    : { kind, platformContentId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}` };

/** A unique platform id per case: cache names and platform identities are instance-wide. */
const uniqueVideo = (prefix: string): string => `${prefix}${newId().slice(-10)}`;

describe("content pack: export", () => {
  it("exports one and several Contents; none / current / chosen / all revisions, archived ones included and flagged", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const second = addContent(a, { title: "第二讲" });
    const secondRevision = addRevision(a, second, { kind: "imported", texts: ["第二讲的字幕"], createdAt: T0 + 20 });
    const plan = await planOf(a, [lecture.contentId, second]);
    expect(plan.contents.map((content) => content.contentId)).toEqual([lecture.contentId, second]);
    expect(plan.contents[0]?.revisions.map((revision) => [revision.id, revision.kind, revision.primary, revision.archived])).toEqual([
      [lecture.asr.id, "asr", false, false],
      [lecture.corrected.id, "corrected", true, false],
      [lecture.translated.id, "translated", false, false],
      [lecture.archived.id, "imported", false, true],
    ]);

    // What each choice carries, as the importing device's preview lists it.
    const b = await importer();
    const carried = async (revisionIds: string[]) => {
      const job = await previewPack(b, await exportPack(a, selection([pick(lecture.contentId, revisionIds, { media: [lecture.original.id] })])));
      await discard(b, job.jobId);
      return only(job.preview.contents).diff.revisions.map((revision) => [revision.key, revision.archived]);
    };
    expect(await carried([])).toEqual([]);
    expect(await carried([lecture.corrected.id])).toEqual([[lecture.corrected.id, false]]);
    expect(await carried([lecture.asr.id, lecture.archived.id])).toEqual([
      [lecture.asr.id, false],
      [lecture.archived.id, true],
    ]);
    expect(await carried(lectureRevisions(lecture))).toEqual([
      [lecture.asr.id, false],
      [lecture.corrected.id, false],
      [lecture.translated.id, false],
      [lecture.archived.id, true],
    ]);

    // All revisions arrive with the archived one still archived.
    const all = await importPack(b, await exportPack(a, selection([pick(lecture.contentId, lectureRevisions(lecture), { media: [lecture.original.id] })])));
    const revisions = (await revisionsOf(b, importedId(all.done))).revisions;
    expect(revisions.map((revision) => [revision.createdAt, revision.archived, revision.archivedAt])).toEqual([
      [T0 + 1, false, undefined],
      [T0 + 2, false, undefined],
      [T0 + 3, false, undefined],
      [T0 + 4, true, T0 + 10],
    ]);

    // Several Contents in one pack.
    const several = await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id]), pick(second, [secondRevision.id])]));
    const c = await importer();
    const { preview, done } = await importPack(c, several);
    expect(preview.contents.map((item) => [item.key, item.title, item.match])).toEqual([
      [lecture.contentId, "讲座", "new"],
      [second, "第二讲", "new"],
    ]);
    expect(done.result?.contents.map((item) => [item.status, item.added.revisions])).toEqual([
      ["imported", 1],
      ["imported", 1],
    ]);
    expect((await contentsOf(c)).map((content) => content.title).sort()).toEqual(["第二讲", "讲座"]);
  }, TIMEOUT);

  it("a translation brings its original revision; a translation without it is refused (invalid_request.pack_selection)", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const plan = await planOf(a, [lecture.contentId]);
    expect(plan.contents[0]?.revisions.find((revision) => revision.id === lecture.translated.id)).toMatchObject({ kind: "translated", parentRevisionId: lecture.corrected.id, currentTranslation: true });

    const error = await refused(a, { method: "POST", url: "/api/content-packs/exports", payload: { selection: selection([pick(lecture.contentId, [lecture.translated.id])]) } }, 400);
    expect(error).toMatchObject({ class: "invalid_request", code: "invalid_request.pack_selection", details: { reason: "translation_without_parent", contentId: lecture.contentId } });

    const pack = await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id, lecture.translated.id])]));
    const b = await importer();
    const { preview, done } = await importPack(b, pack);
    expect(only(preview.contents).diff.revisions.map((revision) => [revision.key, revision.kind, revision.state, revision.rejected, revision.becomesCurrentTranslation])).toEqual([
      // The proofread's own parent stays behind: it arrives as a standalone revision.
      [lecture.corrected.id, "imported", "new", undefined, false],
      [lecture.translated.id, "translated", "new", undefined, true],
    ]);
    const here = importedId(done);
    const local = revisionsByOrigin(b, here);
    const revisions = (await revisionsOf(b, here)).revisions;
    expect(revisions.find((revision) => revision.id === local.get(lecture.translated.id)?.id)).toMatchObject({ kind: "translated", language: "en", parentRevisionId: local.get(lecture.corrected.id)?.id });
    const translations = await ok<{ items: Array<{ language: string; currentRevisionId?: string }> }>(b, { method: "GET", url: `/api/contents/${here}/translations` });
    expect(JSON.stringify(translations)).toContain(local.get(lecture.translated.id)?.id as string);
  }, TIMEOUT);

  it("only a transcript, only media, only the basics of a platform Content each export; a local Content with neither is refused", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const video = uniqueVideo("yt");
    const platform = addContent(a, { title: "平台视频", source: platformSource("youtube", video) });
    const bare = addContent(a, { title: "什么都没有" });
    const plan = await planOf(a, [lecture.contentId, platform, bare]);
    expect(plan.contents.map((content) => content.blocked)).toEqual([undefined, undefined, "nothing_to_carry"]);
    const error = await refused(a, { method: "POST", url: "/api/content-packs/exports", payload: { selection: selection([pick(bare)]) } }, 400);
    expect(error).toMatchObject({ code: "invalid_request.pack_selection", details: { reason: "nothing_to_carry", contentId: bare } });

    const transcriptOnly = await importPack(await importer(), await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id])])));
    expect(only(transcriptOnly.done.result?.contents)).toMatchObject({ status: "imported", added: { revisions: 1, media: 0 } });

    const mediaOnlyTo = await importer();
    const mediaOnly = await importPack(mediaOnlyTo, await exportPack(a, selection([pick(lecture.contentId, [], { media: [lecture.original.id] })])));
    expect(only(mediaOnly.done.result?.contents)).toMatchObject({ status: "imported", added: { revisions: 0, media: 1 } });
    const media = only((await contentOf(mediaOnlyTo, importedId(mediaOnly.done))).media);
    expect(await mediaBytes(mediaOnlyTo, media.id)).toEqual(lecture.originalBytes);

    const basicsTo = await importer();
    const basics = await importPack(basicsTo, await exportPack(a, selection([pick(platform)])));
    const arrived = await contentOf(basicsTo, importedId(basics.done));
    expect(arrived).toMatchObject({ title: "平台视频", source: platformSource("youtube", video), media: [] });
    expect((await revisionsOf(basicsTo, arrived.id)).revisions).toEqual([]);
  }, TIMEOUT);

  it("a Content with an unfinished Task is refused alone, naming the Task (conflict.pack_content_busy)", async () => {
    const a = await exporter();
    const idle = addContent(a, { title: "空闲" });
    addRevision(a, idle, { kind: "imported", texts: ["空闲的字幕"] });
    const busy = addContent(a, { title: "忙碌" });
    addRevision(a, busy, { kind: "imported", texts: ["忙碌的字幕"] });
    const taskId = newId();
    // No stage runs: the scheduler never picks it up, it simply stays unfinished.
    run(a, (scope) => scope.tasks.insert({ id: taskId, userId: a.id, contentId: busy, kind: "process_content", requestJson: "{}", statusProjection: "running", createdAt: T0 }));
    try {
      const plan = await planOf(a, [idle, busy]);
      expect(plan.contents.map((content) => [content.contentId, content.blocked, content.busyTaskId])).toEqual([
        [idle, undefined, undefined],
        [busy, "busy", taskId],
      ]);
      const idleRevisions = (await revisionsOf(a, idle)).revisions.map((revision) => revision.id);
      const busyRevisions = (await revisionsOf(a, busy)).revisions.map((revision) => revision.id);
      const error = await refused(a, { method: "POST", url: "/api/content-packs/exports", payload: { selection: selection([pick(idle, idleRevisions), pick(busy, busyRevisions)]) } }, 409);
      expect(error).toMatchObject({ code: "conflict.pack_content_busy", details: { contentId: busy, taskId } });
      // The other Content goes on its own.
      const { done } = await importPack(await importer(), await exportPack(a, selection([pick(idle, idleRevisions)])));
      expect(only(done.result?.contents)).toMatchObject({ status: "imported", title: "空闲" });
    } finally {
      run(a, (scope) => scope.tasks.setProjection(a.id, taskId, "cancelled", T0 + 1));
    }
  }, TIMEOUT);

  it("server mode carries a managed_upload original; a missing or discarded original is marked unavailable", async () => {
    const a = await exporter();
    const content = addContent(a, { title: "上传的讲座" });
    const keptBytes = mp4Bytes(6000);
    const kept = addOriginal(a, content, keptBytes, { displayName: "kept.mp4" });
    const missing = addOriginal(a, content, mp4Bytes(100), { displayName: "missing.mp4", availability: "missing" });
    const discarded = addOriginal(a, content, mp4Bytes(100), { displayName: "discarded.mp4", availability: "evicted" });
    const plan = only((await planOf(a, [content])).contents);
    const byId = new Map(plan.media.map((media) => [media.assetId, media]));
    expect(byId.get(kept.id)).toEqual({ assetId: kept.id, kind: "original", displayName: "kept.mp4", mimeType: "video/mp4", sizeBytes: 6000 });
    expect(byId.get(missing.id)).toMatchObject({ kind: "original", unavailable: "missing" });
    expect(byId.get(discarded.id)).toMatchObject({ kind: "original", unavailable: "discarded" });
    for (const unavailable of [missing, discarded]) {
      const error = await refused(a, { method: "POST", url: "/api/content-packs/exports", payload: { selection: selection([pick(content, [], { media: [unavailable.id] })]) } }, 400);
      expect(error).toMatchObject({ code: "invalid_request.pack_selection", details: { reason: "not_carryable", contentId: content } });
    }

    const b = await importer();
    const { preview, done } = await importPack(b, await exportPack(a, selection([pick(content, [], { media: [kept.id] })])));
    expect(only(preview.contents).diff.media).toEqual([{ key: kept.id, kind: "original", displayName: "kept.mp4", sizeBytes: 6000, state: "new" }]);
    const arrived = only((await contentOf(b, importedId(done))).media);
    expect(arrived).toMatchObject({ kind: "managed_upload", displayName: "kept.mp4", sizeBytes: 6000, availability: "available", retentionPolicy: "keep" });
    expect(await mediaBytes(b, arrived.id)).toEqual(keptBytes);
  }, TIMEOUT);

  it("a cache file replaced while it is copied fails that Content (size and SHA-256 rechecked)", async () => {
    const a = await exporter();
    const other = addContent(a, { title: "另一条" });
    const otherRevision = addRevision(a, other, { kind: "imported", texts: ["另一条的字幕"] });
    const platform = addContent(a, { title: "缓存视频", source: platformSource("bilibili", uniqueVideo("BV1")) });
    const original = mp4Bytes(200_000);
    // A cache downloaded without a recorded digest: the export hashes it first, then copies it.
    const unhashed = addCache(a, platform, `缓存 ${newId()} [720P].mp4`, original, {}, { digest: false });
    // One with its digest recorded: only the copy reads it.
    const hashed = addCache(a, platform, `缓存 ${newId()} [1080P].mp4`, mp4Bytes(150_000));

    /** Another writer replaces the file the moment the export's copy is about to take it. */
    const replaceBeforeCopy = (ref: string, copyCall: number, bytes: Buffer) => {
      const withLock = CachePathLocks.prototype.withLock;
      let calls = 0;
      return vi.spyOn(CachePathLocks.prototype, "withLock").mockImplementation(function (this: CachePathLocks, lockedRef: string, work: () => Promise<unknown>) {
        if (lockedRef === ref) {
          calls += 1;
          if (calls === copyCall) writeFileSync(dataPath(A, ref), bytes);
        }
        return withLock.call(this, lockedRef, work);
      } as CachePathLocks["withLock"]);
    };
    const failedExport = async (media: string) => {
      const jobId = await startExport(a, selection([pick(other, [otherRevision.id]), pick(platform, [], { media: [media] })]));
      const job = await exportDone(a, jobId);
      expect((await send(a, { method: "GET", url: `/api/content-packs/exports/${jobId}/file` })).statusCode).toBe(404);
      return job;
    };

    // Same size, other bytes: the SHA-256 tells.
    let spy = replaceBeforeCopy(unhashed.storageRef, 2, mp4Bytes(200_000));
    try {
      const job = await failedExport(unhashed.id);
      expect(job).toMatchObject({ status: "failed", error: { class: "media_changed" }, failedContent: { contentId: platform, title: "缓存视频" } });
    } finally {
      spy.mockRestore();
    }
    // Another size: the size tells.
    spy = replaceBeforeCopy(hashed.storageRef, 1, mp4Bytes(150_001));
    try {
      const job = await failedExport(hashed.id);
      expect(job).toMatchObject({ status: "failed", error: { class: "media_changed" }, failedContent: { contentId: platform } });
    } finally {
      spy.mockRestore();
    }
    // Left alone, the file is copied as it now is.
    const pack = await exportPack(a, selection([pick(other, [otherRevision.id]), pick(platform, [], { media: [unhashed.id] })]));
    const { done } = await importPack(await importer(), pack);
    expect(done.result?.contents.map((item) => [item.status, item.added.media])).toEqual([
      ["imported", 0],
      ["imported", 1],
    ]);
  }, TIMEOUT);

  it("one export or import per user at a time (conflict.pack_job_active)", async () => {
    const a = await exporter();
    const neighbour = await exporter();
    const lecture = seedLecture(a);
    const theirs = addContent(neighbour, { title: "邻居的" });
    const theirRevision = addRevision(neighbour, theirs, { kind: "imported", texts: ["邻居的字幕"] });
    const pack = await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id])]));
    const exportRequest = { method: "POST" as const, url: "/api/content-packs/exports", payload: { selection: selection([pick(lecture.contentId, [lecture.corrected.id])]) } };
    const active = () => ok<ContentPackActiveDto>(a, { method: "GET", url: "/api/content-packs/active" });

    // An import waiting for decisions holds the user's slot.
    const waiting = await previewPack(a, pack);
    expect(await active()).toEqual({ importJobId: waiting.jobId });
    expect(await refused(a, exportRequest, 409)).toMatchObject({ code: "conflict.pack_job_active" });
    const second = await upload(a, pack);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe("conflict.pack_job_active");
    // Another user is not held up.
    await exportPack(neighbour, selection([pick(theirs, [theirRevision.id])]));
    await discard(a, waiting.jobId);

    // A running export holds it too: this one is stopped inside its cache copy.
    const platform = addContent(a, { title: "缓存", source: platformSource("bilibili", uniqueVideo("BV1")) });
    const cache = addCache(a, platform, `排队 ${newId()} [720P].mp4`, mp4Bytes(50_000));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const withLock = CachePathLocks.prototype.withLock;
    const spy = vi.spyOn(CachePathLocks.prototype, "withLock").mockImplementation(function (this: CachePathLocks, ref: string, work: () => Promise<unknown>) {
      if (ref !== cache.storageRef) return withLock.call(this, ref, work);
      return withLock.call(this, ref, async () => {
        holding = true;
        await gate;
        return work();
      });
    } as CachePathLocks["withLock"]);
    try {
      const jobId = await startExport(a, selection([pick(platform, [], { media: [cache.id] })]));
      await until(async () => holding, (value) => value);
      expect(await active()).toEqual({ exportJobId: jobId });
      expect(await refused(a, exportRequest, 409)).toMatchObject({ code: "conflict.pack_job_active" });
      expect((await upload(a, pack)).statusCode).toBe(409);
      release();
      expect((await exportDone(a, jobId)).status).toBe("succeeded");
    } finally {
      release();
      spy.mockRestore();
    }
    expect(await active()).toEqual({});
    await discard(a, (await previewPack(a, pack)).jobId);
  }, TIMEOUT);
});

describe("content pack: import into a fresh library", () => {
  it("reading text, copy text, speakers, figure places and note anchors match the source exactly", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const { preview, done } = await importPack(b, await lecturePack(a, lecture));
    expect(only(preview.contents)).toMatchObject({ match: "new", candidates: [] });
    expect(only(done.result?.contents)).toMatchObject({ status: "imported", added: { revisions: 4, speakers: 2, figures: 2, notes: 1, media: 1 }, placedByTime: 1 });
    const here = importedId(done);
    const local = revisionsByOrigin(b, here);
    for (const revisionId of lectureRevisions(lecture)) {
      const arrived = local.get(revisionId)?.id as string;
      expect(await readingOf(b, here, arrived)).toEqual(await readingOf(a, lecture.contentId, revisionId));
      expect(await copyText(b, here, arrived)).toBe(await copyText(a, lecture.contentId, revisionId));
    }
    expect((await contentOf(b, here)).primaryTranscriptRevisionId).toBe(local.get(lecture.corrected.id)?.id);

    const speakersThere = await speakersOf(a, lecture.contentId);
    const speakersHere = await speakersOf(b, here);
    expect(speakersHere.map(speakerView)).toEqual(speakersThere.map(speakerView));
    expect(speakersHere.map((speaker) => speaker.id)).not.toContain("0");
    const photo = async (device: Device, contentId: string, speakerId: string) => (await send(device, { method: "GET", url: `/api/contents/${contentId}/speakers/${speakerId}/avatar` })).rawPayload;
    expect(await photo(b, here, speakersHere[0]?.id as string)).toEqual(await photo(a, lecture.contentId, "0"));

    const figuresThere = (await figuresOf(a, lecture.contentId)).items;
    const figuresHere = (await figuresOf(b, here)).items;
    expect(figuresHere).toHaveLength(2);
    const byOrigin = new Map(run(b, (scope) => scope.figures.listByContent(b.id, here)).map((figure) => [figure.originId, figure.id]));
    for (const figure of figuresThere) {
      const arrived = figuresHere.find((item) => item.id === byOrigin.get(figure.id)) as FigureDto;
      expect(await figureView(b, here, arrived)).toEqual(await figureView(a, lecture.contentId, figure));
      expect(await figureImage(b, arrived.id)).toEqual(await figureImage(a, figure.id));
    }
    // The anchored figure sits before the third sentence of the proofread on both devices.
    expect((await figureView(b, here, figuresHere.find((item) => item.caption === FIGURE_CAPTION) as FigureDto)).anchor).toEqual({ revision: lecture.corrected.id, ordinal: 2, side: "before" });

    const noteThere = only(await notesOf(a, lecture.contentId));
    const noteHere = only(await notesOf(b, here));
    expect(await noteView(b, here, noteHere)).toEqual(await noteView(a, lecture.contentId, noteThere));
    expect(noteHere).toMatchObject({ quote: "大家", transcriptRevisionId: local.get(lecture.corrected.id)?.id });
  }, TIMEOUT);

  it("a Content without a transcript imports with processingStatus none and no fabricated Task, and can be transcribed later", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const { done } = await importPack(b, await exportPack(a, selection([pick(lecture.contentId, [], { media: [lecture.original.id] })])));
    const here = importedId(done);
    const arrived = await contentOf(b, here);
    expect(arrived).toMatchObject({ processingStatus: "none", media: [expect.objectContaining({ kind: "managed_upload", availability: "available" })] });
    expect(arrived.primaryTranscriptRevisionId).toBeUndefined();
    expect((await revisionsOf(b, here)).revisions).toEqual([]);
    const tasks = () => ok<{ items: Array<{ id: string; kind: string }> }>(b, { method: "GET", url: `/api/tasks?contentId=${here}` });
    expect((await tasks()).items).toEqual([]);
    // The library lists it under its own status.
    expect((await ok<{ items: Array<{ id: string }> }>(b, { method: "GET", url: "/api/contents?status=none" })).items.map((item) => item.id)).toEqual([here]);

    // Transcribing it is the ordinary request; without a model chosen the Task waits for one, so nothing is called.
    const accepted = await ok<{ taskId: string }>(b, { method: "POST", url: `/api/contents/${here}/transcript/retranscribe`, payload: {} }, 202);
    expect((await tasks()).items).toEqual([expect.objectContaining({ id: accepted.taskId, kind: "retranscribe" })]);
    await send(b, { method: "POST", url: `/api/tasks/${accepted.taskId}/cancel`, payload: {} });
  }, TIMEOUT);

  it("a carried platform Content keeps its platform chapters through insertPlatformRevision", async () => {
    const a = await exporter();
    const video = addContent(a, { title: "章节视频", source: platformSource("youtube", uniqueVideo("ch")) });
    run(a, (scope) =>
      scope.chapters.insertPlatformRevision(a.id, video, {
        id: newId(),
        artifactId: newId(),
        chapters: [
          { startMs: 0, endMs: 30_000, title: "开场" },
          { startMs: 30_000, endMs: 60_000, title: "正题" },
        ],
        createdAt: T0,
      }),
    );
    expect(only((await planOf(a, [video])).contents).platformChapters).toBe(true);
    const b = await importer();
    const { preview, done } = await importPack(b, await exportPack(a, selection([pick(video)])));
    expect(only(preview.contents).diff.platformChapters).toBe("add");
    const chapters = await chaptersOf(b, importedId(done));
    expect(chapters.current).toMatchObject({ origin: { kind: "platform" }, stale: false });
    expect(chapters.current?.chapters.map((chapter) => [chapter.startMs, chapter.endMs, chapter.title])).toEqual([
      [0, 30_000, "开场"],
      [30_000, 60_000, "正题"],
    ]);
    expect(chapters.revisions).toHaveLength(1);
  }, TIMEOUT);

  it("another user of the same instance imports the same pack independently and sees nothing of the first (owner isolation)", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const pack = await lecturePack(a, lecture);
    const first = await importer();
    const second = await importer();
    const mine = await importPack(first, pack);
    const firstContent = importedId(mine.done);
    const firstMedia = only((await contentOf(first, firstContent)).media).id;

    const job = await previewPack(second, pack);
    expect(only(job.preview.contents)).toMatchObject({ match: "new", candidates: [] });
    // Nothing of the first user's is reachable, not even by naming it.
    expect((await refused(second, { method: "GET", url: `/api/content-packs/imports/${mine.done.jobId}` }, 404)).class).toBe("not_found");
    expect((await refused(second, { method: "GET", url: `/api/contents/${firstContent}` }, 404)).class).toBe("not_found");
    expect((await refused(second, { method: "GET", url: `/api/media/${firstMedia}` }, 404)).class).toBe("not_found");
    expect((await refused(second, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/compare`, payload: { key: lecture.contentId, targetContentId: firstContent } }, 404)).class).toBe("not_found");
    const forged = decisionsOf(job, () => ({ action: "merge", targetContentId: firstContent }));
    expect((await refused(second, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/commit`, payload: forged }, 400)).class).toBe("invalid_request");
    expect((await refused(first, { method: "GET", url: `/api/content-packs/imports/${job.jobId}` }, 404)).class).toBe("not_found");

    const theirs = await commitPack(second, job);
    expect(theirs.status).toBe("finished");
    const secondContent = importedId(theirs);
    expect(secondContent).not.toBe(firstContent);
    expect((await contentsOf(first)).map((content) => content.id)).toEqual([firstContent]);
    expect((await contentsOf(second)).map((content) => content.id)).toEqual([secondContent]);
    expect(await counts(first, firstContent)).toEqual({ revisions: 4, speakers: 2, notes: 1, figures: 2, media: 1 });
    expect(await counts(second, secondContent)).toEqual({ revisions: 4, speakers: 2, notes: 1, figures: 2, media: 1 });
    const search = await ok<SearchResultDto>(second, { method: "GET", url: `/api/search?q=${encodeURIComponent("架构示意")}` });
    expect(search.figures.map((hit) => hit.contentId)).toEqual([secondContent]);
    // Each user's original lives in that user's own managed storage.
    for (const [device, contentId] of [[first, firstContent], [second, secondContent]] as const) {
      const asset = only(run(device, (scope) => scope.mediaAssets.listByContent(device.id, contentId)));
      expect(asset.storageRef.startsWith(`assets/${device.id}/`)).toBe(true);
    }
  }, TIMEOUT);
});

describe("content pack: import into a library that has the Content", () => {
  /**
   * A decision refused before anything is read: `invalid_request`, its user message naming the
   * decision field at fault (the error carries no other machine field for it).
   */
  const expectRefusedDecision = (error: { class: string; userMessage: string }, field: string) => {
    expect(error.class).toBe("invalid_request");
    expect(error.userMessage).toContain(field);
  };
  /** 「作为新内容导入」 although the same file is here: a new Content with every carried file. */
  const asNewContent = (item: PackPreviewContent) => ({ action: "import" as const, targetContentId: undefined, mediaKeys: item.diff.media.map((media) => media.key) });
  const states = (diff: PackContentDiff) => diff.revisions.map((revision) => revision.state);

  it("importing the same pack twice adds nothing", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const pack = await lecturePack(a, lecture);
    const b = await importer();
    const here = importedId((await importPack(b, pack)).done);
    const before = await counts(b, here);
    expect(before).toEqual({ revisions: 4, speakers: 2, notes: 1, figures: 2, media: 1 });

    const { preview, done } = await importPack(b, pack);
    const again = only(preview.contents);
    expect(again).toMatchObject({ match: "same", candidates: [{ contentId: here, reason: "origin", trashed: false }], diff: { targetContentId: here, platformChapters: "none", overLimit: [] } });
    expect(states(again.diff)).toEqual(["existing", "existing", "existing", "existing"]);
    expect(again.diff.speakers.map((speaker) => speaker.state)).toEqual(["existing", "existing"]);
    expect(again.diff.notes).toEqual({ new: 0, existing: 1, differs: 0, unplaceable: 0 });
    expect(again.diff.figures).toEqual({ new: 0, existing: 2, differs: 0, placedByTime: 0, deletedHere: 0 });
    expect(again.diff.media.map((media) => media.state)).toEqual(["existing"]);
    expect(only(done.result?.contents)).toMatchObject({
      status: "merged",
      contentId: here,
      added: { revisions: 0, speakers: 0, figures: 0, notes: 0, media: 0 },
      updated: { figures: 0, notes: 0 },
      conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 },
    });
    expect(await counts(b, here)).toEqual(before);
    expect(await contentsOf(b)).toHaveLength(1);
  }, TIMEOUT);

  it("re-exporting after edits imports only the increment", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const here = importedId((await importPack(b, await lecturePack(a, lecture))).done);

    // A goes on working: a hand-edited revision, another note, another figure.
    const edited = addRevision(a, lecture.contentId, { kind: "manual", parent: lecture.corrected, texts: ["一。", "二。", "三。", "四。"], speakers: ["0", "1", "0", undefined], generation: { kind: "manual" }, createdAt: T0 + 30 });
    addNote(a, lecture.contentId, lecture.corrected, { startOffset: 2, endOffset: 4, quote: "好今", comment: "第二条", createdAt: T0 + 31, updatedAt: T0 + 31 });
    addFigure(a, lecture.contentId, FIGURE_WEBP, { displayMs: 4500, sortKey: 2, caption: "后来加的图", createdAt: T0 + 32, updatedAt: T0 + 32 });
    const { preview, done } = await importPack(b, await lecturePack(a, lecture));
    const diff = only(preview.contents).diff;
    expect(diff.revisions.map((revision) => [revision.key, revision.state])).toEqual([
      [lecture.asr.id, "existing"],
      [lecture.corrected.id, "existing"],
      [lecture.translated.id, "existing"],
      [lecture.archived.id, "existing"],
      [edited.id, "new"],
    ]);
    expect(diff.notes).toMatchObject({ new: 1, existing: 1, differs: 0 });
    expect(diff.figures).toMatchObject({ new: 1, existing: 2, differs: 0 });
    expect(diff.media.map((media) => media.state)).toEqual(["existing"]);
    expect(only(done.result?.contents)).toMatchObject({ status: "merged", added: { revisions: 1, speakers: 0, figures: 1, notes: 1, media: 0 } });
    expect(await counts(b, here)).toEqual({ revisions: 5, speakers: 2, notes: 2, figures: 3, media: 1 });
    const arrived = revisionsByOrigin(b, here).get(edited.id);
    expect(arrived).toMatchObject({ kind: "manual", parentRevisionId: revisionsByOrigin(b, here).get(lecture.corrected.id)?.id });
  }, TIMEOUT);

  it("a corrected revision carried alone (A → B → A) is recognised as already there, not a conflict", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const toB = await importPack(b, await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id])])));
    expect(only(only(toB.preview.contents).diff.revisions)).toMatchObject({ kind: "imported", originalKind: "corrected", standalone: true });
    const onB = importedId(toB.done);
    const standalone = only((await revisionsOf(b, onB)).revisions);
    expect(standalone).toMatchObject({ kind: "imported", generation: { kind: "pack", originalKind: "corrected", originalGeneration: "llm", modelName: "DeepSeek V3" } });
    expect(standalone.parentRevisionId).toBeUndefined();
    expect(await readingOf(b, onB, standalone.id)).toEqual(await readingOf(a, lecture.contentId, lecture.corrected.id));

    const before = await counts(a, lecture.contentId);
    const back = await importPack(a, await exportPack(b, selection([everything(b, onB)])));
    const onA = only(back.preview.contents);
    expect(onA).toMatchObject({ match: "same", diff: { targetContentId: lecture.contentId } });
    expect(only(onA.diff.revisions)).toMatchObject({ key: lecture.corrected.id, state: "existing" });
    expect(only(back.done.result?.contents)).toMatchObject({ status: "merged", added: { revisions: 0, speakers: 0 }, conflicts: { revisions: 0 } });
    expect(await counts(a, lecture.contentId)).toEqual(before);
  }, TIMEOUT);

  it("a revision edited on B from a standalone carried revision returns to A with its parent and sentence sources joined to A's original", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const onB = importedId((await importPack(b, await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id])])))).done);
    const standalone = only(run(b, (scope) => scope.transcripts.listRevisions(b.id, onB)));
    const standaloneSegments = run(b, (scope) => scope.transcripts.listSegments(b.id, standalone.id));
    const edited = addRevision(b, onB, {
      kind: "manual",
      parent: { id: standalone.id, segments: standaloneSegments },
      texts: ["大家好，今天讲检索。", "检索增强生成是什么。", "我们先看一个例子。", "谢谢大家！"],
      generation: { kind: "manual" },
      createdAt: T0 + 50,
    });
    const back = await importPack(a, await exportPack(b, selection([pick(onB, [edited.id])])));
    expect(only(only(back.preview.contents).diff.revisions)).toMatchObject({ key: edited.id, kind: "manual", state: "new", standalone: false });
    const arrived = revisionsByOrigin(a, lecture.contentId).get(edited.id);
    const listed = (await revisionsOf(a, lecture.contentId)).revisions.find((revision) => revision.id === arrived?.id);
    expect(listed).toMatchObject({ kind: "manual", parentRevisionId: lecture.corrected.id });
    expect((await segmentsOf(a, arrived?.id as string)).map((segment) => segment.sourceSegmentIds)).toEqual(lecture.corrected.segments.map((segment) => [segment.id]));
    // The primary stays where it was.
    expect((await contentOf(a, lecture.contentId)).primaryTranscriptRevisionId).toBe(lecture.corrected.id);
  }, TIMEOUT);

  it("an archived revision stays archived; a revision already here keeps its own archive state", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const here = importedId((await importPack(b, await lecturePack(a, lecture))).done);
    const local = revisionsByOrigin(b, here);
    const archivedHere = local.get(lecture.archived.id)?.id as string;
    const asrHere = local.get(lecture.asr.id)?.id as string;
    const archive = async (device: Device, revisionId: string, archived: boolean) => ok(device, { method: "PUT", url: `/api/transcript/revisions/${revisionId}/archived`, payload: { archived } }, 200);
    const flags = async () => new Map((await revisionsOf(b, here)).revisions.map((revision) => [revision.id, revision.archived]));
    expect((await flags()).get(archivedHere)).toBe(true);

    // B restores the archived one; A archives its ASR transcript. Neither crosses over.
    await archive(b, archivedHere, false);
    await archive(a, lecture.asr.id, true);
    const { preview, done } = await importPack(b, await lecturePack(a, lecture));
    expect(only(preview.contents).diff.revisions.map((revision) => [revision.key, revision.archived, revision.state])).toEqual([
      [lecture.asr.id, true, "existing"],
      [lecture.corrected.id, false, "existing"],
      [lecture.translated.id, false, "existing"],
      [lecture.archived.id, true, "existing"],
    ]);
    expect(only(done.result?.contents).added.revisions).toBe(0);
    const after = await flags();
    expect(after.get(archivedHere)).toBe(false);
    expect(after.get(asrHere)).toBe(false);
  }, TIMEOUT);

  it("platform chapters never replace local ones and never touch AI chapters or the chosen chapter revision", async () => {
    const a = await exporter();
    const source = platformSource("bilibili", uniqueVideo("BV1"));
    const video = addContent(a, { title: "章节视频", source });
    run(a, (scope) =>
      scope.chapters.insertPlatformRevision(a.id, video, {
        id: newId(),
        artifactId: newId(),
        chapters: [
          { startMs: 0, endMs: 30_000, title: "A 的章节" },
          { startMs: 30_000, endMs: 60_000, title: "下半" },
        ],
        createdAt: T0,
      }),
    );
    const pack = await exportPack(a, selection([pick(video)]));

    /** The same video on B with AI chapters chosen, and maybe platform chapters of its own. */
    const sameVideo = async (ownPlatformChapters: boolean) => {
      const b = await importer();
      const here = addContent(b, { title: "B 的同一个视频", source });
      const transcript = addRevision(b, here, { kind: "imported", texts: ["开场白", "正文"] });
      const artifactId = newId();
      const ai = newId();
      run(b, (scope) => {
        if (ownPlatformChapters) scope.chapters.insertPlatformRevision(b.id, here, { id: newId(), artifactId, chapters: [{ startMs: 0, endMs: 60_000, title: "B 的平台章节" }], createdAt: T0 });
        scope.chapters.insertAiRevision(b.id, here, {
          id: ai,
          artifactId,
          transcriptRevisionId: transcript.id,
          chapters: [{ startMs: 0, endMs: 60_000, title: "AI 的章节" }],
          modelRef: { providerProfileId: "profile-llm", modelId: "deepseek-chat", providerNameSnapshot: "中转", modelDisplaySnapshot: "DeepSeek V3" },
          promptRef: { id: "chapters", version: 1 },
          promptSnapshot: "chapters prompt",
          quality: "normal",
          createdAt: T0 + 1,
        });
        scope.chapters.setCurrent(b.id, here, ai);
      });
      return { b, here, ai };
    };
    const view = (chapters: Awaited<ReturnType<typeof chaptersOf>>) => chapters.revisions.map((revision) => [revision.origin.kind, revision.chapters.map((chapter) => chapter.title)]);

    // Without platform chapters here, the carried ones are added beside the AI chapters, which stay chosen.
    const without = await sameVideo(false);
    const added = await importPack(without.b, pack);
    expect(only(added.preview.contents)).toMatchObject({ match: "same_media", candidates: [{ contentId: without.here, reason: "platform" }], diff: { platformChapters: "add" } });
    const afterAdd = await chaptersOf(without.b, without.here);
    expect(afterAdd.current?.id).toBe(without.ai);
    expect(view(afterAdd)).toEqual([
      ["ai", ["AI 的章节"]],
      ["platform", ["A 的章节", "下半"]],
    ]);

    // With platform chapters of its own, nothing changes.
    const withOwn = await sameVideo(true);
    const before = await chaptersOf(withOwn.b, withOwn.here);
    const kept = await importPack(withOwn.b, pack);
    expect(only(kept.preview.contents).diff.platformChapters).toBe("keep");
    expect(only(kept.done.result?.contents).status).toBe("merged");
    expect(await chaptersOf(withOwn.b, withOwn.here)).toEqual(before);
    expect(view(before)).toEqual([
      ["platform", ["B 的平台章节"]],
      ["ai", ["AI 的章节"]],
    ]);
  }, TIMEOUT);

  it("speaker review is carried only when every speaker of the revision maps by identity or is new", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const reviewedOn = async (device: Device, contentId: string) => (await revisionsOf(device, contentId)).revisions.find((revision) => revision.id === revisionsByOrigin(device, contentId).get(lecture.corrected.id)?.id)?.speakersConfirmedAt;
    const both = await exportPack(a, selection([pick(lecture.contentId, [lecture.asr.id, lecture.corrected.id])]));

    // New speakers: the review travels.
    const fresh = await importer();
    const freshContent = importedId((await importPack(fresh, both)).done);
    expect(await reviewedOn(fresh, freshContent)).toBe(T0 + 11);

    // Speakers already here by identity (an earlier pack brought them with the ASR transcript): it travels.
    const earlier = await importer();
    const earlierContent = importedId((await importPack(earlier, await exportPack(a, selection([pick(lecture.contentId, [lecture.asr.id])])))).done);
    const second = await importPack(earlier, both);
    expect(only(second.preview.contents).diff.speakers.map((speaker) => speaker.state)).toEqual(["existing", "existing"]);
    expect(await reviewedOn(earlier, earlierContent)).toBe(T0 + 11);

    // A carried speaker merged into a same-named one here by hand: the revision waits for a review.
    const named = await importer();
    const own = addContent(named, { title: "B 自己的" });
    addOriginal(named, own, lecture.originalBytes);
    run(named, (scope) => scope.speakers.insert(named.id, own, [{ id: "x", name: "甲老师" }], T0));
    const job = await previewPack(named, both);
    const diff = only(job.preview.contents).diff;
    expect(diff.targetContentId).toBe(own);
    const teacher = diff.speakers.find((speaker) => speaker.name === "甲老师");
    expect(teacher).toMatchObject({ state: "new", sameNameCandidates: [{ speakerId: "x", name: "甲老师" }] });
    const done = await commitPack(named, job, () => ({ sameSpeakers: [{ speakerKey: teacher?.key as string, localSpeakerId: "x" }] }));
    expect(only(done.result?.contents)).toMatchObject({ status: "merged", added: { speakers: 1 } });
    expect(await reviewedOn(named, own)).toBeUndefined();
    const corrected = revisionsByOrigin(named, own).get(lecture.corrected.id)?.id as string;
    expect((await segmentsOf(named, corrected)).map((segment) => segment.speakerId === "x")).toEqual([true, false, true, false]);
  }, TIMEOUT);

  it("a note or figure that differs keeps the local one unless the pack's is adopted; adopting updates only comment, mark, colour, caption, width, place", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const here = importedId((await importPack(b, await lecturePack(a, lecture))).done);
    const before = { note: only(await notesOf(b, here)), figures: (await figuresOf(b, here)).items };

    // A changes the note's mark, colour and comment, the loose figure's caption, width and place.
    await ok(a, { method: "PATCH", url: `/api/notes/${lecture.noteId}`, payload: { mark: "background", color: "green", comment: "A 改过的评论" } });
    const looseThere = (await figuresOf(a, lecture.contentId)).items.find((figure) => figure.id === lecture.figures.loose) as FigureDto;
    await ok(a, { method: "PATCH", url: `/api/figures/${looseThere.id}`, payload: { version: looseThere.version, caption: "A 的备注", widthRatio: 0.4, placement: { displayMs: 4200, anchor: null, sortKey: 3 } } });
    const pack = await lecturePack(a, lecture);

    const kept = await importPack(b, pack);
    expect(only(kept.preview.contents).diff.notes).toMatchObject({ differs: 1 });
    expect(only(kept.preview.contents).diff.figures).toMatchObject({ differs: 1 });
    expect(only(kept.preview.contents).diff.notes.differsUpdatedAt?.here).toBe(before.note.updatedAt);
    expect(only(kept.done.result?.contents)).toMatchObject({ updated: { notes: 0, figures: 0 }, conflicts: { notes: 0, figures: 0 } });
    expect(only(await notesOf(b, here))).toEqual(before.note);
    expect((await figuresOf(b, here)).items).toEqual(before.figures);

    const adopted = await importPack(b, pack, () => ({ adoptPack: true }));
    expect(only(adopted.done.result?.contents)).toMatchObject({ updated: { notes: 1, figures: 1 }, conflicts: { notes: 0, figures: 0 }, added: { revisions: 0, notes: 0, figures: 0 } });
    const note = only(await notesOf(b, here));
    const { mark: _mark, color: _color, comment: _comment, updatedAt: _updatedAt, ...noteRest } = note;
    const { mark: _m, color: _c, comment: _k, updatedAt: _u, ...noteBefore } = before.note;
    expect(note).toMatchObject({ mark: "background", color: "green", comment: "A 改过的评论" });
    expect(noteRest).toEqual(noteBefore);
    const looseHere = (await figuresOf(b, here)).items.find((figure) => figure.image.sha256 === looseThere.image.sha256) as FigureDto;
    const looseBefore = before.figures.find((figure) => figure.id === looseHere.id) as FigureDto;
    expect(looseHere).toMatchObject({ caption: "A 的备注", widthRatio: 0.4, placement: { displayMs: 4200, anchor: null, sortKey: 3 } });
    expect({ ...looseHere, caption: undefined, widthRatio: undefined, placement: undefined, version: undefined, updatedAt: undefined }).toEqual({
      ...looseBefore,
      caption: undefined,
      widthRatio: undefined,
      placement: undefined,
      version: undefined,
      updatedAt: undefined,
    });
    expect(await figureImage(b, looseHere.id)).toEqual(Buffer.from(SECOND_FIGURE_WEBP));
    // The other figure did not differ and is untouched.
    const anchoredHere = (await figuresOf(b, here)).items.find((figure) => figure.id !== looseHere.id);
    expect(anchoredHere).toEqual(before.figures.find((figure) => figure.id !== looseHere.id));
  }, TIMEOUT);

  it("a note changed in another window after the preview is reported as a conflict on commit and keeps the change", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const here = importedId((await importPack(b, await lecturePack(a, lecture))).done);
    await ok(a, { method: "PATCH", url: `/api/notes/${lecture.noteId}`, payload: { color: "green", comment: "A 改过的评论" } });
    for (const figure of (await figuresOf(a, lecture.contentId)).items) {
      await ok(a, { method: "PATCH", url: `/api/figures/${figure.id}`, payload: { version: figure.version, caption: `A 改了 ${figure.id.slice(-4)}` } });
    }
    const job = await previewPack(b, await lecturePack(a, lecture));
    expect(only(job.preview.contents).diff.notes).toMatchObject({ differs: 1 });
    expect(only(job.preview.contents).diff.figures).toMatchObject({ differs: 2 });

    // Another window edits the note and one of the figures between the preview and the commit.
    const noteHere = only(await notesOf(b, here));
    await ok(b, { method: "PATCH", url: `/api/notes/${noteHere.id}`, payload: { comment: "B 在另一个窗口改的" } });
    const [touched, untouched] = (await figuresOf(b, here)).items as [FigureDto, FigureDto];
    await ok(b, { method: "PATCH", url: `/api/figures/${touched.id}`, payload: { version: touched.version, widthRatio: 1 } });

    const done = await commitPack(b, job, () => ({ adoptPack: true }));
    expect(only(done.result?.contents)).toMatchObject({ status: "merged", updated: { notes: 0, figures: 1 }, conflicts: { notes: 1, figures: 1 } });
    expect(only(await notesOf(b, here))).toMatchObject({ comment: "B 在另一个窗口改的", color: "yellow" });
    const after = new Map((await figuresOf(b, here)).items.map((figure) => [figure.id, figure]));
    expect(after.get(touched.id)).toMatchObject({ caption: touched.caption, widthRatio: 1 });
    expect(after.get(untouched.id)?.caption).toMatch(/^A 改了 /u);
  }, TIMEOUT);

  it("a figure with the same identity but another image is a conflict and the image is never replaced", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const here = importedId((await importPack(b, await lecturePack(a, lecture), () => ({ figures: false }))).done);
    // B holds A's anchored figure's identity with another image (as a hand-made pack could leave it).
    const local = addFigure(b, here, SECOND_FIGURE_WEBP, { originId: lecture.figures.anchored, caption: "本机" });
    const before = (await figuresOf(b, here)).items.find((figure) => figure.id === local);

    const { preview, done } = await importPack(b, await lecturePack(a, lecture), () => ({ adoptPack: true }));
    expect(only(preview.contents).diff.figures).toMatchObject({ new: 1, differs: 1 });
    // An image conflict cannot be adopted, so it has no times to compare.
    expect(only(preview.contents).diff.figures.differsUpdatedAt).toBeUndefined();
    expect(only(done.result?.contents)).toMatchObject({ added: { figures: 1 }, updated: { figures: 0 }, conflicts: { figures: 1 } });
    expect(await figureImage(b, local)).toEqual(Buffer.from(SECOND_FIGURE_WEBP));
    expect((await figuresOf(b, here)).items.find((figure) => figure.id === local)).toEqual(before);
  }, TIMEOUT);

  it("a category over its limit (notes, figures, speakers) is blocked with the excess named; deselecting it lets the rest import", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const pack = await lecturePack(a, lecture);
    const commitRequest = (job: Awaited<ReturnType<typeof previewPack>>, decide: Parameters<typeof decisionsOf>[1]) => ({
      method: "POST" as const,
      url: `/api/content-packs/imports/${job.jobId}/commit`,
      payload: decisionsOf(job, decide),
    });
    const blocked = async (device: Device, category: "notes" | "figures" | "speakers", limit: number, leaveOut: Parameters<typeof decisionsOf>[1]) => {
      const job = await previewPack(device, pack);
      expect(only(job.preview.contents).diff.overLimit).toEqual([{ category, over: 1, limit }]);
      const error = await refused(device, commitRequest(job, () => ({})), 400);
      expectRefusedDecision(error, "overLimit");
      // The preview stays and the user leaves the category out.
      expect((await importJob(device, job.jobId)).status).toBe("awaiting_decisions");
      const done = await commitPack(device, job, leaveOut);
      expect(done.status).toBe("finished");
      return only(done.result?.contents);
    };

    // Notes: B has the lecture without notes and already NOTES_PER_CONTENT_MAX of its own.
    const notesFull = await importer();
    const noteTarget = importedId((await importPack(notesFull, pack, () => ({ notes: false, figures: false }))).done);
    const correctedHere = { id: revisionsByOrigin(notesFull, noteTarget).get(lecture.corrected.id)?.id as string, segments: [] as TranscriptSegment[] };
    correctedHere.segments = run(notesFull, (scope) => scope.transcripts.listSegments(notesFull.id, correctedHere.id));
    for (let index = 0; index < NOTES_PER_CONTENT_MAX; index += 1) addNote(notesFull, noteTarget, correctedHere, { endOffset: 1, quote: "大", comment: `本机 ${index}` });
    const notes = await blocked(notesFull, "notes", NOTES_PER_CONTENT_MAX, () => ({ notes: false }));
    expect(notes).toMatchObject({ status: "merged", added: { notes: 0, figures: 2 } });
    expect(await notesOf(notesFull, noteTarget)).toHaveLength(NOTES_PER_CONTENT_MAX);

    // Figures: one short of the limit, the pack brings two.
    const figuresFull = await importer();
    const figureTarget = importedId((await importPack(figuresFull, pack, () => ({ notes: false, figures: false }))).done);
    for (let index = 0; index < FIGURES_PER_CONTENT_MAX - 1; index += 1) addFigure(figuresFull, figureTarget, FIGURE_WEBP, { displayMs: index * 10, sortKey: index });
    const figures = await blocked(figuresFull, "figures", FIGURES_PER_CONTENT_MAX, () => ({ figures: false }));
    expect(figures).toMatchObject({ status: "merged", added: { notes: 1, figures: 0 } });
    expect((await figuresOf(figuresFull, figureTarget)).items).toHaveLength(FIGURES_PER_CONTENT_MAX - 1);

    // Speakers: the Content has no transcript yet and one speaker short of the limit; the revisions bring two.
    const speakersFull = await importer();
    const speakerTarget = importedId((await importPack(speakersFull, pack, () => ({ revisions: false, notes: false, figures: false }))).done);
    run(speakersFull, (scope) =>
      scope.speakers.insert(
        speakersFull.id,
        speakerTarget,
        Array.from({ length: SPEAKERS_PER_CONTENT_MAX - 1 }, (_, index) => ({ id: `local-${index}`, name: `本机 ${index}` })),
        T0,
      ),
    );
    const speakers = await blocked(speakersFull, "speakers", SPEAKERS_PER_CONTENT_MAX, () => ({ revisions: false }));
    expect(speakers).toMatchObject({ status: "merged", added: { revisions: 0, speakers: 0, figures: 2 } });
    expect(await speakersOf(speakersFull, speakerTarget)).toHaveLength(SPEAKERS_PER_CONTENT_MAX - 1);
  }, TIMEOUT);

  it("merging into a Content with the same media; a manual target is remembered; several candidates require a choice", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const pack = await lecturePack(a, lecture);

    // Same file here under another identity: offered as the merge target.
    const b = await importer();
    const own = addContent(b, { title: "B 自己的" });
    addOriginal(b, own, lecture.originalBytes);
    const merged = await importPack(b, pack);
    expect(only(merged.preview.contents)).toMatchObject({ match: "same_media", candidates: [{ contentId: own, reason: "fingerprint", trashed: false }], diff: { targetContentId: own } });
    expect(only(merged.preview.contents).diff.media.map((media) => media.state)).toEqual(["existing"]);
    expect(only(merged.done.result?.contents)).toMatchObject({ status: "merged", contentId: own, added: { revisions: 4, media: 0 } });
    expect(await contentsOf(b)).toHaveLength(1);

    // Nothing matches here; the user picks a target by hand, and the next pack knows it.
    const c = await importer();
    const unrelated = addContent(c, { title: "看起来不相关" });
    const job = await previewPack(c, pack);
    expect(only(job.preview.contents)).toMatchObject({ match: "new", candidates: [] });
    const compared = await ok<PackContentDiff>(c, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/compare`, payload: { key: lecture.contentId, targetContentId: unrelated } });
    expect(compared).toMatchObject({ targetContentId: unrelated, revisions: expect.arrayContaining([expect.objectContaining({ state: "new" })]) });
    const byHand = await commitPack(c, job, () => ({ action: "merge", targetContentId: unrelated }));
    expect(only(byHand.result?.contents)).toMatchObject({ status: "merged", contentId: unrelated });
    const next = await previewPack(c, pack);
    expect(only(next.preview.contents)).toMatchObject({ match: "same", candidates: [{ contentId: unrelated, reason: "mapped" }], diff: { targetContentId: unrelated } });
    await discard(c, next.jobId);

    // The identity in two Contents here (imported once as new beside the same file, merged once): a choice is required.
    const d = await importer();
    const dOwn = addContent(d, { title: "D 自己的" });
    addOriginal(d, dOwn, lecture.originalBytes);
    const asNew = importedId((await importPack(d, pack, asNewContent)).done);
    expect(asNew).not.toBe(dOwn);
    await importPack(d, pack, () => ({ action: "merge", targetContentId: dOwn }));
    const several = await previewPack(d, pack);
    const shown = only(several.preview.contents);
    expect(shown.match).toBe("same");
    expect(shown.candidates.map((candidate) => [candidate.contentId, candidate.reason]).sort()).toEqual(
      [
        [asNew, "origin"],
        [dOwn, "mapped"],
      ].sort(),
    );
    expect(shown.diff.targetContentId).toBeUndefined();
    const commitWith = (decision: Partial<PackContentDecision>) => ({
      method: "POST" as const,
      url: `/api/content-packs/imports/${several.jobId}/commit`,
      payload: { contents: [{ key: shown.key, revisions: true, figures: true, notes: true, ...decision }], collections: [] },
    });
    expectRefusedDecision(await refused(d, commitWith({ action: "merge" }), 400), "targetContentId");
    expectRefusedDecision(await refused(d, commitWith({ action: "import" }), 400), "action");
    expect((await commitPack(d, several, () => ({ action: "merge", targetContentId: asNew }))).status).toBe("finished");
    expect(await contentsOf(d)).toHaveLength(2);
  }, TIMEOUT);

  it("the same identity into two different Contents never mixes them", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const d = await importer();
    const dOwn = addContent(d, { title: "D 自己的" });
    addOriginal(d, dOwn, lecture.originalBytes);
    const pack = await lecturePack(a, lecture);
    const asNew = importedId((await importPack(d, pack, asNewContent)).done);
    await importPack(d, pack, () => ({ action: "merge", targetContentId: dOwn }));
    const snapshot = async (contentId: string) => ({
      counts: await counts(d, contentId),
      notes: await notesOf(d, contentId),
      figures: (await figuresOf(d, contentId)).items,
      speakers: await speakersOf(d, contentId),
    });
    const ofAsNew = await snapshot(asNew);
    expect(ofAsNew.counts).toEqual(await counts(d, dOwn));

    // A adds a note; it is merged into one of the two only.
    addNote(a, lecture.contentId, lecture.corrected, { startOffset: 1, endOffset: 3, quote: "家好", comment: "新的" });
    await importPack(d, await lecturePack(a, lecture), (item) => ({ action: "merge", targetContentId: item.candidates.find((candidate) => candidate.contentId === dOwn)?.contentId }));
    expect(await snapshot(asNew)).toEqual(ofAsNew);
    expect((await counts(d, dOwn)).notes).toBe(2);
    // Every row of each Content points at that Content's own revisions, sentences and speakers.
    for (const contentId of [asNew, dOwn]) {
      const revisions = new Set((await revisionsOf(d, contentId)).revisions.map((revision) => revision.id));
      const speakerIds = new Set((await speakersOf(d, contentId)).map((speaker) => speaker.id));
      for (const note of await notesOf(d, contentId)) expect(revisions.has(note.transcriptRevisionId)).toBe(true);
      for (const figure of (await figuresOf(d, contentId)).items) if (figure.placement.anchor !== null) expect(revisions.has(figure.placement.anchor.revisionId)).toBe(true);
      for (const revisionId of revisions) {
        for (const segment of await segmentsOf(d, revisionId)) if (segment.speakerId !== undefined) expect(speakerIds.has(segment.speakerId)).toBe(true);
      }
    }
    const ownSpeakers = new Set((await speakersOf(d, dOwn)).map((speaker) => speaker.id));
    expect((await speakersOf(d, asNew)).filter((speaker) => ownSpeakers.has(speaker.id))).toEqual([]);
  }, TIMEOUT);

  it("a revision with the same text but another identity is reported as the same as a local one and imported separately", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const own = addContent(b, { title: "B 自己的" });
    addOriginal(b, own, lecture.originalBytes);
    // B transcribed the same file itself: the same sentences at the same times.
    const mine = addRevision(b, own, { kind: "imported", texts: LECTURE_TEXTS, createdAt: T0 + 40 });
    const { preview, done } = await importPack(b, await exportPack(a, selection([pick(lecture.contentId, [lecture.asr.id])])));
    expect(only(only(preview.contents).diff.revisions)).toMatchObject({ key: lecture.asr.id, state: "new", sameTextAs: mine.id, sameTextAsRevision: { kind: "imported", language: "zh-CN", createdAt: T0 + 40 } });
    expect(only(done.result?.contents)).toMatchObject({ status: "merged", added: { revisions: 1 }, conflicts: { revisions: 0 } });
    const revisions = (await revisionsOf(b, own)).revisions;
    expect(revisions.map((revision) => revision.kind).sort()).toEqual(["asr", "imported"]);
    expect((await readingOf(b, own, mine.id)).map((segment) => segment.text)).toEqual([...LECTURE_TEXTS]);
  }, TIMEOUT);

  it("speakers with id 0 on both devices are never confused", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const own = addContent(b, { title: "B 自己的" });
    addOriginal(b, own, lecture.originalBytes);
    run(b, (scope) => scope.speakers.insert(b.id, own, [{ id: "0", name: "B 的发言人" }], T0));
    const mine = addRevision(b, own, { kind: "imported", texts: ["B 的第一句", "B 的第二句"], speakers: ["0", "0"] });
    const { preview, done } = await importPack(b, await lecturePack(a, lecture));
    expect(only(preview.contents).diff.speakers.map((speaker) => [speaker.name, speaker.state, speaker.localSpeakerId])).toEqual([
      ["甲老师", "new", undefined],
      ["乙同学", "new", undefined],
    ]);
    expect(only(done.result?.contents)).toMatchObject({ status: "merged", added: { speakers: 2 } });
    const speakers = await speakersOf(b, own);
    expect(speakers.map((speaker) => [speaker.id === "0", speaker.name]).sort()).toEqual([
      [false, "乙同学"],
      [false, "甲老师"],
      [true, "B 的发言人"],
    ]);
    expect((await readingOf(b, own, mine.id)).map((segment) => segment.speaker)).toEqual(["B 的发言人", "B 的发言人"]);
    const asr = revisionsByOrigin(b, own).get(lecture.asr.id)?.id as string;
    expect((await readingOf(b, own, asr)).map((segment) => segment.speaker)).toEqual(["甲老师", "乙同学", "甲老师", undefined]);
  }, TIMEOUT);

  it("the primary transcript changes only when asked, and a target whose primary moved since the preview is a conflict", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const here = importedId((await importPack(b, await lecturePack(a, lecture))).done);
    const local = revisionsByOrigin(b, here);
    const asrHere = local.get(lecture.asr.id)?.id as string;
    const correctedHere = local.get(lecture.corrected.id)?.id as string;
    const setPrimary = (revisionId: string) => ok(b, { method: "PUT", url: `/api/contents/${here}/primary-transcript`, payload: { revisionId } });
    const primary = async () => (await contentOf(b, here)).primaryTranscriptRevisionId;
    await setPrimary(asrHere);

    // Not asked: the pack's primary does not move B's.
    await importPack(b, await lecturePack(a, lecture));
    expect(await primary()).toBe(asrHere);
    // Asked.
    await importPack(b, await lecturePack(a, lecture), () => ({ setPrimaryRevisionKey: lecture.corrected.id }));
    expect(await primary()).toBe(correctedHere);

    // The primary moves in another window after the preview: the commit refuses that Content whole.
    const later = addRevision(a, lecture.contentId, { kind: "manual", parent: lecture.corrected, texts: ["甲", "乙", "丙", "丁"], generation: { kind: "manual" }, createdAt: T0 + 60 });
    const job = await previewPack(b, await lecturePack(a, lecture));
    expect(only(job.preview.contents).diff.targetPrimaryRevisionId).toBe(correctedHere);
    await setPrimary(asrHere);
    const done = await commitPack(b, job, () => ({ setPrimaryRevisionKey: later.id }));
    expect(done.status).toBe("finished");
    expect(only(done.result?.contents)).toMatchObject({ status: "failed", error: { code: "conflict.pack_target_changed", details: { contentId: here } } });
    expect(await primary()).toBe(asrHere);
    expect(revisionsByOrigin(b, here).has(later.id)).toBe(false);
  }, TIMEOUT);

  it("a figure deleted here within retention is not imported again; after purge it is listed as new", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const pack = await lecturePack(a, lecture);
    const here = importedId((await importPack(b, pack)).done);
    const loose = (await figuresOf(b, here)).items.find((figure) => figure.caption === undefined) as FigureDto;
    await ok(b, { method: "DELETE", url: `/api/figures/${loose.id}` });
    expect((await figuresOf(b, here)).recentlyDeleted.map((figure) => figure.id)).toEqual([loose.id]);

    const deleted = await importPack(b, pack);
    expect(only(deleted.preview.contents).diff.figures).toMatchObject({ new: 0, existing: 1, deletedHere: 1 });
    expect(only(deleted.done.result?.contents).added.figures).toBe(0);
    expect((await figuresOf(b, here)).items).toHaveLength(1);

    // Its retention ends and it is purged.
    expect(run(b, (scope) => scope.figures.purgeDeleted(Date.now() + 1, 100)).filter((item) => item.contentId === here).map((item) => item.figureId)).toEqual([loose.id]);
    const purged = await importPack(b, pack);
    expect(only(purged.preview.contents).diff.figures).toMatchObject({ new: 1, existing: 1, deletedHere: 0 });
    expect(only(purged.done.result?.contents).added.figures).toBe(1);
    expect((await figuresOf(b, here)).items).toHaveLength(2);
  }, TIMEOUT);

  it("a match in the trash is blocked with its reason", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const pack = await lecturePack(a, lecture);
    const here = importedId((await importPack(b, pack)).done);
    await ok(b, { method: "DELETE", url: `/api/contents/${here}` }, 204);

    const job = await previewPack(b, pack);
    expect(only(job.preview.contents)).toMatchObject({ match: "trashed", candidates: [{ contentId: here, reason: "origin", trashed: true }] });
    expect(only(job.preview.contents).diff.targetContentId).toBeUndefined();
    const done = await commitPack(b, job);
    expect(only(done.result?.contents)).toMatchObject({ status: "failed", error: { code: "conflict.pack_target_changed", details: { contentId: here } } });
    expect(await contentsOf(b)).toEqual([]);
    expect(contentsWithIdentity(b, lecture.contentId).map((content) => [content.id, content.trashedAt !== undefined])).toEqual([[here, true]]);
  }, TIMEOUT);
});

describe("content pack: collections", () => {
  // Alice exports on one server instance; every case imports into a fresh instance of its own,
  // as another device would.
  const T0 = 1_790_000_000_000;
  const COURSE = "检索增强生成二十讲";
  interface Device {
    stack: ComposedStack;
    id: string;
    cookie: string;
  }
  const devices: ComposedStack[] = [];
  let alice: Device;
  /** Alice's twenty lectures by number, and her collection of all of them in order. */
  const lecture = new Map<number, string>();
  let course: string;
  let picks: string;

  const run = <T>(device: Device, work: (scope: RepositoryScope) => NotPromise<T>): T => device.stack.composition.repository.withTransaction(work);
  const ok = async <T>(device: Device, request: Parameters<ComposedStack["send"]>[0], status = 200): Promise<T> => {
    const response = await device.stack.send(request, device.cookie);
    expect(response.statusCode, response.body).toBe(status);
    return (response.body === "" ? undefined : response.json()) as T;
  };
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 20_000;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      value = await read();
    }
    return value;
  };
  const device = async (username: string): Promise<Device> => {
    const stack = await composeServerStack();
    await stack.composition.startBackground();
    devices.push(stack);
    return { stack, ...(await stack.createUser(username)) };
  };
  const account = () => device("importer");

  beforeAll(async () => {
    alice = await device("alice");
    run(alice, (scope) => {
      for (let n = 1; n <= 20; n += 1) {
        const id = `lecture-${String(n).padStart(2, "0")}-${alice.id}`;
        lecture.set(n, id);
        const vid = `vid${String(n).padStart(8, "0")}`;
        scope.contents.insert({
          id,
          userId: alice.id,
          source: { kind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${vid}`, platformContentId: vid },
          processingStatus: "succeeded",
          title: `第 ${n} 讲`,
          durationMs: 60_000,
          createdAt: T0 + n,
          updatedAt: T0 + n,
        });
      }
    });
    course = (await ok<CollectionDetailDto>(alice, { method: "POST", url: "/api/collections", payload: { name: COURSE, description: "从零讲起" } }, 201)).id;
    for (const contentId of lecture.values()) {
      await ok(alice, { method: "POST", url: `/api/collections/${course}/items`, payload: { contentId } });
    }
    picks = (await ok<CollectionDetailDto>(alice, { method: "POST", url: "/api/collections", payload: { name: "精选" } }, 201)).id;
    for (const n of [12, 5]) await ok(alice, { method: "POST", url: `/api/collections/${picks}/items`, payload: { contentId: lecture.get(n) } });
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const stack of devices.splice(0)) await stack.close();
  });

  /** Alice exports the lectures (only their platform basics) with the given collections; the pack bytes as downloaded. */
  async function exportPack(numbers: readonly number[], collectionIds: readonly string[]): Promise<Buffer> {
    const selection = {
      contents: numbers.map((n) => ({ contentId: lecture.get(n) as string, revisionIds: [], figures: false, notes: false, mediaAssetIds: [] })),
      collectionIds,
    };
    const { jobId } = await ok<{ jobId: string }>(alice, { method: "POST", url: "/api/content-packs/exports", payload: { selection } }, 202);
    const job = await until(
      () => ok<ContentPackExportJobDto>(alice, { method: "GET", url: `/api/content-packs/exports/${jobId}` }),
      (dto) => dto.status !== "running",
    );
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const file = await alice.stack.send({ method: "GET", url: `/api/content-packs/exports/${jobId}/file` }, alice.cookie);
    expect(file.statusCode).toBe(200);
    return file.rawPayload;
  }

  /** Uploads a pack and waits for its preview. */
  async function previewPack(to: Device, pack: Buffer): Promise<ContentPackImportJobDto & { preview: NonNullable<ContentPackImportJobDto["preview"]> }> {
    const response = await to.stack.composition.app.inject({
      method: "POST",
      url: "/api/content-packs/imports/upload",
      headers: { "x-amber-request": "1", origin: "https://amber.example", cookie: to.cookie, "content-type": "application/octet-stream", "x-amber-filename": "course.amberpack" },
      payload: pack,
    });
    expect(response.statusCode, response.body).toBe(202);
    const { jobId } = response.json() as { jobId: string };
    const job = await until(
      () => ok<ContentPackImportJobDto>(to, { method: "GET", url: `/api/content-packs/imports/${jobId}` }),
      (dto) => dto.status !== "receiving" && dto.status !== "previewing",
    );
    expect(job.status, JSON.stringify(job.error)).toBe("awaiting_decisions");
    return job as ContentPackImportJobDto & { preview: NonNullable<ContentPackImportJobDto["preview"]> };
  }

  /** What the import dialog offers by default: Contents new or merged into their single match; collections created or joined. */
  const contentDefault = (item: PackPreviewContent): PackContentDecision => ({
    key: item.key,
    action: item.diff.targetContentId === undefined ? "import" : "merge",
    ...(item.diff.targetContentId === undefined ? {} : { targetContentId: item.diff.targetContentId }),
    revisions: true,
    figures: true,
    notes: true,
  });
  const collectionDefault = (item: PackPreviewCollection): PackCollectionDecision =>
    item.match === "same" ? { key: item.key, action: "join", targetCollectionId: (item.candidates[0] as { collectionId: string }).collectionId } : { key: item.key, action: "create" };

  async function commitPack(
    to: Device,
    job: ContentPackImportJobDto & { preview: NonNullable<ContentPackImportJobDto["preview"]> },
    collections: (item: PackPreviewCollection) => PackCollectionDecision = collectionDefault,
  ): Promise<ContentPackImportJobDto> {
    const decisions = { contents: job.preview.contents.map(contentDefault), collections: job.preview.collections.map(collections) };
    await ok(to, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/commit`, payload: decisions }, 202);
    const done = await until(
      () => ok<ContentPackImportJobDto>(to, { method: "GET", url: `/api/content-packs/imports/${job.jobId}` }),
      (dto) => dto.status !== "importing",
    );
    expect(done.status, JSON.stringify(done.error)).toBe("finished");
    return done;
  }

  async function importPack(to: Device, pack: Buffer, collections?: (item: PackPreviewCollection) => PackCollectionDecision) {
    const job = await previewPack(to, pack);
    return { preview: job.preview, done: await commitPack(to, job, collections) };
  }

  /** The visible members of a collection as alice's lecture numbers (titles travel with the Contents). */
  async function lectures(to: Device, collectionId: string): Promise<number[]> {
    const detail = await ok<CollectionDetailDto>(to, { method: "GET", url: `/api/collections/${collectionId}` });
    return detail.items.map((item) => Number(/第 (\d+) 讲/.exec(item.title ?? "")?.[1]));
  }
  const collectionsOf = async (to: Device) => (await ok<{ items: Array<{ id: string; name: string; itemCount: number }> }>(to, { method: "GET", url: "/api/collections" })).items;
  const contentCount = (to: Device): number => run(to, (scope) => scope.contents.list(to.id).length);

  it("only the picked members of a larger collection travel, in their relative order", async () => {
    const pack = await exportPack([9, 5, 7], [course]);
    const importer = await account();
    const { preview, done } = await importPack(importer, pack);
    expect(preview.collections).toEqual([
      expect.objectContaining({ name: COURSE, description: "从零讲起", match: "new", candidates: [], contentKeys: [5, 7, 9].map((n) => lecture.get(n)) }),
    ]);
    const [result] = done.result?.collections ?? [];
    expect(result).toMatchObject({ name: COURSE, status: "created", added: 3 });
    expect(await lectures(importer, result?.collectionId as string)).toEqual([5, 7, 9]);
    expect(await collectionsOf(importer)).toEqual([expect.objectContaining({ name: COURSE, itemCount: 3 })]);
    // Alice's collection is untouched.
    expect(await lectures(alice, course)).toHaveLength(20);
  }, 60_000);

  it("a Content in two collections offers both; a same-named collection is never merged without the user's choice", async () => {
    const pack = await exportPack([5], [course, picks]);
    const importer = await account();
    const own = (await ok<CollectionDetailDto>(importer, { method: "POST", url: "/api/collections", payload: { name: "精选" } }, 201)).id;
    const job = await previewPack(importer, pack);
    expect(job.preview.collections.map((item) => [item.name, item.match, item.candidates.map((candidate) => candidate.collectionId)])).toEqual([
      [COURSE, "new", []],
      ["精选", "same_name", [own]],
    ]);
    const done = await commitPack(importer, job);
    const results = done.result?.collections ?? [];
    expect(results.map((item) => [item.name, item.status, item.added])).toEqual([[COURSE, "created", 1], ["精选", "created", 1]]);
    expect(results[1]?.collectionId).not.toBe(own);
    for (const item of results) expect(await lectures(importer, item.collectionId as string)).toEqual([5]);
    expect(await lectures(importer, own)).toEqual([]);

    // Joining the same-named one is the user's explicit choice, remembered for the next pack.
    const again = await previewPack(importer, pack);
    const joined = await commitPack(importer, again, (item) =>
      item.name === "精选" ? { key: item.key, action: "join", targetCollectionId: own } : collectionDefault(item),
    );
    expect(joined.result?.collections.map((item) => [item.name, item.status, item.added])).toEqual([[COURSE, "joined", 0], ["精选", "joined", 1]]);
    expect(await lectures(importer, own)).toEqual([5]);
    const third = await previewPack(importer, pack);
    expect(third.preview.collections[1]).toMatchObject({ match: "same" });
    expect(third.preview.collections[1]?.candidates.map((candidate) => candidate.collectionId)).toContain(own);
    await ok(importer, { method: "DELETE", url: `/api/content-packs/imports/${third.jobId}` }, 204);
  }, 60_000);

  it("a second pack joins the collection the first created and inserts members by the placement rule", async () => {
    const importer = await account();
    const first = await importPack(importer, await exportPack([5, 6, 7], [course]));
    const created = first.done.result?.collections[0]?.collectionId as string;
    const { preview, done } = await importPack(importer, await exportPack([4, 7, 8], [course]));
    expect(preview.collections[0]).toMatchObject({ match: "same", candidates: [{ collectionId: created, memberCount: 3 }] });
    expect(done.result?.collections[0]).toMatchObject({ status: "joined", collectionId: created, added: 2 });
    // 4 has nothing here before it in the pack: right before 7, the first member here after it; 8 right after 7.
    expect(await lectures(importer, created)).toEqual([5, 6, 4, 7, 8]);
    expect(await collectionsOf(importer)).toHaveLength(1);
  }, 60_000);

  it("local members keep their relative order, trashed members included", async () => {
    const importer = await account();
    const first = await importPack(importer, await exportPack([1, 2, 3, 4], [course]));
    const id = first.done.result?.collections[0]?.collectionId as string;
    // The importer reverses the order and moves lecture 2 to the trash.
    const detail = await ok<CollectionDetailDto>(importer, { method: "GET", url: `/api/collections/${id}` });
    await ok(importer, { method: "PUT", url: `/api/collections/${id}/items/order`, payload: { itemIds: detail.items.map((item) => item.id).reverse() } });
    const second = detail.items.find((item) => item.title === "第 2 讲")?.contentId as string;
    await ok(importer, { method: "DELETE", url: `/api/contents/${second}` }, 204);
    const allBefore = run(importer, (scope) => scope.collections.listItems(importer.id, id).map((item) => item.contentId));

    await importPack(importer, await exportPack([1, 3, 4, 5, 6], [course]));
    // 5 and 6 follow 4, the nearest earlier pack member here; the reversed order stays.
    expect(await lectures(importer, id)).toEqual([4, 5, 6, 3, 1]);
    const allAfter = run(importer, (scope) => scope.collections.listItems(importer.id, id).map((item) => item.contentId));
    expect(allAfter.filter((contentId) => allBefore.includes(contentId))).toEqual(allBefore);
    expect(allAfter.indexOf(second)).toBe(allAfter.length - 2);
  }, 60_000);

  it("importing again neither creates a second collection, adds duplicates, nor reorders", async () => {
    const pack = await exportPack([3, 4, 5], [course]);
    const importer = await account();
    const first = await importPack(importer, pack);
    const id = first.done.result?.collections[0]?.collectionId as string;
    const detail = await ok<CollectionDetailDto>(importer, { method: "GET", url: `/api/collections/${id}` });
    await ok(importer, { method: "PUT", url: `/api/collections/${id}/items/order`, payload: { itemIds: [detail.items[2], detail.items[0], detail.items[1]].map((item) => item?.id) } });
    const before = await ok<CollectionDetailDto>(importer, { method: "GET", url: `/api/collections/${id}` });

    const { done } = await importPack(importer, pack);
    expect(done.result?.collections).toEqual([expect.objectContaining({ status: "joined", collectionId: id, added: 0 })]);
    expect(await ok<CollectionDetailDto>(importer, { method: "GET", url: `/api/collections/${id}` })).toEqual(before);
    expect(await collectionsOf(importer)).toHaveLength(1);
    expect(contentCount(importer)).toBe(3);
  }, 60_000);

  it("a failed collection is its own result, can be retried alone and never re-imports Contents", async () => {
    const pack = await exportPack([10, 11], [course]);
    const importer = await account();
    // The collection's write fails once, as a disk error would: its transaction rolls back.
    const repository = importer.stack.composition.repository;
    const original = repository.withTransaction.bind(repository);
    let armed = true;
    const spy = vi.spyOn(repository, "withTransaction").mockImplementation((work) =>
      original((scope) => {
        const result = work(scope);
        if (armed && scope.collections.list(importer.id).some((item) => item.name === COURSE)) {
          armed = false;
          throw new Error("disk I/O error");
        }
        return result;
      }),
    );
    try {
      const { done } = await importPack(importer, pack);
      expect(done.result?.contents.map((item) => item.status)).toEqual(["imported", "imported"]);
      expect(done.result?.collections.map((item) => [item.name, item.status])).toEqual([[COURSE, "failed"]]);
      expect(done.result?.collections[0]?.error?.class).toBe("internal");
      expect(await collectionsOf(importer)).toEqual([]);
      const contents = contentCount(importer);

      const retried = await ok<ContentPackImportJobDto>(importer, { method: "POST", url: `/api/content-packs/imports/${done.jobId}/retry-collections` }, 202);
      expect(retried.result?.collections.map((item) => [item.name, item.status, item.added])).toEqual([[COURSE, "created", 2]]);
      expect(retried.result?.contents).toEqual(done.result?.contents);
      expect(contentCount(importer)).toBe(contents);
      expect(await lectures(importer, retried.result?.collections[0]?.collectionId as string)).toEqual([10, 11]);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

describe("content pack: files and failures", () => {
  /** Every file below `dir`, relative, or none when it does not exist. */
  const filesUnder = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)) : [];
  const stagingOf = (stack: ComposedStack, jobId: string) => join(stack.dataDir, "tmp", "content-packs", "imports", jobId);
  const active = (device: Device) => ok<ContentPackActiveDto>(device, { method: "GET", url: "/api/content-packs/active" });

  it("media already here is skipped, a missing file is filled in, another quality is added", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const video = uniqueVideo("BV1");
    const platform = addContent(a, { title: "缓存视频", source: platformSource("bilibili", video) });
    const lowBytes = mp4Bytes(30_000);
    const low = addCache(a, platform, `${video} [720P].mp4`, lowBytes);
    const pack = await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id], { media: [lecture.original.id] }), pick(platform, [], { media: [low.id] })]));
    const b = await importer();
    const first = await importPack(b, pack);
    expect(first.done.result?.contents.map((item) => [item.status, item.added.media])).toEqual([
      ["imported", 1],
      ["imported", 1],
    ]);
    const [lectureHere, platformHere] = first.done.result?.contents.map((item) => item.contentId as string) as [string, string];
    const originalHere = only((await contentOf(b, lectureHere)).media);
    const cacheHere = only((await contentOf(b, platformHere)).media);
    expect(cacheHere).toMatchObject({ kind: "platform_cache", quality: "720", sizeBytes: lowBytes.length, availability: "available" });
    expect(readFileSync(dataPath(B, `media/${video} [720P].mp4`))).toEqual(lowBytes);

    // Already here: skipped.
    const again = await importPack(b, pack);
    expect(again.preview.contents.map((item) => item.diff.media.map((media) => media.state))).toEqual([["existing"], ["existing"]]);
    expect(again.done.result?.contents.map((item) => [item.status, item.added.media])).toEqual([
      ["merged", 0],
      ["merged", 0],
    ]);
    expect((await contentOf(b, lectureHere)).media).toEqual([originalHere]);
    expect((await contentOf(b, platformHere)).media).toEqual([cacheHere]);

    // The original's file is lost here: the pack fills it in under the same row.
    const row = run(b, (scope) => scope.mediaAssets.get(b.id, originalHere.id));
    if (row === undefined) throw new Error("no original row");
    rmSync(dataPath(B, row.storageRef));
    run(b, (scope) => scope.mediaAssets.update(b.id, { ...row, availability: "missing" }));
    const filled = await importPack(b, pack);
    expect(filled.preview.contents.map((item) => item.diff.media.map((media) => media.state))).toEqual([["fill"], ["existing"]]);
    expect(filled.done.result?.contents.map((item) => item.added.media)).toEqual([1, 0]);
    expect(only((await contentOf(b, lectureHere)).media)).toMatchObject({ id: originalHere.id, availability: "available" });
    expect(await mediaBytes(b, originalHere.id)).toEqual(lecture.originalBytes);

    // The cache was evicted here: the pack fills it in under its row and name.
    const cacheRow = run(b, (scope) => scope.mediaAssets.get(b.id, cacheHere.id));
    if (cacheRow === undefined) throw new Error("no cache row");
    rmSync(dataPath(B, cacheRow.storageRef));
    run(b, (scope) => scope.mediaAssets.update(b.id, { ...cacheRow, availability: "evicted" }));
    const refilled = await importPack(b, pack);
    expect(refilled.preview.contents.map((item) => item.diff.media.map((media) => media.state))).toEqual([["existing"], ["fill"]]);
    expect(refilled.done.result?.contents.map((item) => item.added.media)).toEqual([0, 1]);
    expect(only((await contentOf(b, platformHere)).media)).toMatchObject({ id: cacheHere.id, availability: "available" });
    expect(readFileSync(dataPath(B, `media/${video} [720P].mp4`))).toEqual(lowBytes);

    // Another quality of the cache is added beside the first.
    const highBytes = mp4Bytes(40_000);
    const high = addCache(a, platform, `${video} [1080P].mp4`, highBytes);
    const more = await importPack(b, await exportPack(a, selection([pick(platform, [], { media: [low.id, high.id] })])));
    expect(only(more.preview.contents).diff.media.map((media) => [media.quality, media.state])).toEqual([
      ["720", "existing"],
      ["1080", "new"],
    ]);
    expect(only(more.done.result?.contents)).toMatchObject({ status: "merged", added: { media: 1 } });
    expect((await contentOf(b, platformHere)).media.map((media) => media.quality).sort()).toEqual(["1080", "720"]);
    expect(readFileSync(dataPath(B, `media/${video} [1080P].mp4`))).toEqual(highBytes);
    expect(readFileSync(dataPath(B, `media/${video} [720P].mp4`))).toEqual(lowBytes);
  }, TIMEOUT);

  it("a cache name taken by a different file is a conflict and nothing is overwritten", async () => {
    const a = await exporter();
    const video = uniqueVideo("BV1");
    const name = `${video} [720P].mp4`;
    const platform = addContent(a, { title: "缓存视频", source: platformSource("bilibili", video) });
    const cache = addCache(a, platform, name, mp4Bytes(20_000));
    const pack = await exportPack(a, selection([pick(platform, [], { media: [cache.id] })]));

    // Another user's Content on B holds that name with other bytes.
    const holder = await importer();
    const theirs = addContent(holder, { title: "别人的", source: platformSource("bilibili", uniqueVideo("BV1")) });
    const theirBytes = mp4Bytes(25_000);
    addCache(holder, theirs, name, theirBytes);
    const b = await importer();
    const job = await previewPack(b, pack);
    expect(only(job.preview.contents).diff.media).toEqual([expect.objectContaining({ key: cache.id, kind: "cache", state: "conflict" })]);
    const forced = await refused(b, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/commit`, payload: decisionsOf(job, () => ({ mediaKeys: [cache.id] })) }, 400);
    expect(forced.class).toBe("invalid_request");
    expect(forced.userMessage).toContain("mediaKeys");
    const done = await commitPack(b, job);
    expect(only(done.result?.contents)).toMatchObject({ status: "imported", added: { media: 0 }, conflicts: { media: 1 } });
    expect((await contentOf(b, importedId(done))).media).toEqual([]);
    expect(readFileSync(dataPath(B, `media/${name}`))).toEqual(theirBytes);

    // A file nobody registered stands at the name: that Content fails and the file stays as it is.
    const strangerVideo = uniqueVideo("BV1");
    const strangerName = `${strangerVideo} [720P].mp4`;
    const second = addContent(a, { title: "另一个缓存视频", source: platformSource("bilibili", strangerVideo) });
    const secondCache = addCache(a, second, strangerName, mp4Bytes(20_000));
    const stranger = mp4Bytes(22_000);
    writeFileSync(dataPath(B, `media/${strangerName}`), stranger);
    const c = await importer();
    const strangerJob = await previewPack(c, await exportPack(a, selection([pick(second, [], { media: [secondCache.id] })])));
    expect(only(strangerJob.preview.contents).diff.media.map((media) => media.state)).toEqual(["new"]);
    const strangerDone = await commitPack(c, strangerJob);
    expect(only(strangerDone.result?.contents)).toMatchObject({ status: "failed", error: { code: "conflict.cache_file_foreign" } });
    expect(readFileSync(dataPath(B, `media/${strangerName}`))).toEqual(stranger);
    expect(await contentsOf(c)).toEqual([]);
    expect(filesUnder(join(B.dataDir, "media", ".amber-tmp"))).toEqual([]);
  }, TIMEOUT);

  it("a failure on the second Content keeps the first; retrying imports only the second; one Content is never half imported", async () => {
    const a = await exporter();
    const first = seedLecture(a, "第一讲");
    const second = seedLecture(a, "第二讲");
    const pack = await exportPack(a, selection([everything(a, first.contentId, [first.original.id]), everything(a, second.contentId, [second.original.id])]));
    const b = await importer();
    // The second Content's transaction fails at its end, as a disk error would: it rolls back whole.
    const repository = B.composition.repository;
    const original = repository.withTransaction.bind(repository);
    let armed = true;
    const spy = vi.spyOn(repository, "withTransaction").mockImplementation(<T,>(work: (scope: RepositoryScope) => NotPromise<T>): T =>
      original((scope) => {
        const result = work(scope);
        if (armed && scope.transferOrigins.contentsByIdentity(b.id, second.contentId).length > 0) {
          armed = false;
          throw new Error("disk I/O error");
        }
        return result;
      }),
    );
    let done: ContentPackImportJobDto;
    try {
      done = (await importPack(b, pack)).done;
    } finally {
      spy.mockRestore();
    }
    expect(done.result?.contents.map((item) => [item.title, item.status, item.error?.class])).toEqual([
      ["第一讲", "imported", undefined],
      ["第二讲", "failed", "internal"],
    ]);
    const firstHere = done.result?.contents[0]?.contentId as string;
    expect(await counts(b, firstHere)).toEqual({ revisions: 4, speakers: 2, notes: 1, figures: 2, media: 1 });
    // Nothing of the second: no Content, no rows, no file in managed storage, nothing staged.
    expect(contentsWithIdentity(b, second.contentId)).toEqual([]);
    expect((await contentsOf(b)).map((content) => content.id)).toEqual([firstHere]);
    expect(filesUnder(dataPath(B, `assets/${b.id}`))).toEqual([join(firstHere, only((await contentOf(b, firstHere)).media).id)]);

    const retried = await importPack(b, pack);
    expect(retried.preview.contents.map((item) => item.match)).toEqual(["same", "new"]);
    expect(retried.done.result?.contents.map((item) => [item.title, item.status, item.added])).toEqual([
      ["第一讲", "merged", { revisions: 0, speakers: 0, figures: 0, notes: 0, media: 0 }],
      ["第二讲", "imported", { revisions: 4, speakers: 2, figures: 2, notes: 1, media: 1 }],
    ]);
    expect(await contentsOf(b)).toHaveLength(2);
  }, TIMEOUT);

  it("a crash after files are placed and before the commit is finished or rolled back at start-up, idempotently", async () => {
    const origin = await openStack();
    const user = await addUser(origin, "crash");
    const dir = tempDataDir("amber-crash-pack-");
    const { build, media } = sampleBuild(dir, { count: 2, mediaBytes: 300_000 });
    const pack = await packOf(build, dir);
    const job = await previewPack(user, pack);

    // The import runs to its end; on the way, the data directory is copied twice as a kill
    // would leave it: with the first Content's file placed and its commit not yet made, and
    // with that commit made but its journal not yet updated.
    const repository = origin.composition.repository;
    const transaction = repository.withTransaction.bind(repository);
    let beforeCommit: string | undefined;
    let afterCommit: string | undefined;
    const placedJournal = () => journalsIn(origin.dataDir).find((journal) => Object.values(journal.contents).includes("placed"));
    const committed = (journal: NonNullable<ReturnType<typeof placedJournal>>) =>
      journal.files.some((file) => journal.contents[file.contentKey] === "placed" && transaction((scope) => scope.mediaAssets.get(journal.owner, file.assetId)) !== undefined);
    const spy = vi.spyOn(repository, "withTransaction").mockImplementation(<T,>(work: (scope: RepositoryScope) => NotPromise<T>): T => {
      const journal = afterCommit === undefined ? placedJournal() : undefined;
      if (journal !== undefined && beforeCommit === undefined && !committed(journal)) beforeCommit = snapshotDataDir(origin);
      const result = transaction(work);
      if (journal !== undefined && afterCommit === undefined && committed(journal)) afterCommit = snapshotDataDir(origin);
      return result;
    });
    try {
      const done = await commitPack(user, job);
      expect(done.result?.contents.map((item) => item.status)).toEqual(["imported", "imported"]);
    } finally {
      spy.mockRestore();
    }
    await closeStack(origin);
    if (beforeCommit === undefined || afterCommit === undefined) throw new Error("the crash states were not captured");
    const dataDir = origin.dataDir;
    const assets = join(dataDir, "assets", user.id);

    /** Puts a crashed copy where the server's data directory is (journal paths are absolute) and starts the server on it. */
    const restartFrom = async (snapshot: string) => {
      rmSync(dataDir, { recursive: true, force: true });
      renameSync(snapshot, dataDir);
      return restart();
    };
    const restart = async () => {
      const server = await reopen(dataDir);
      await server.stack.composition.startBackground();
      const device: Device = { stack: server.stack, id: user.id, username: user.username, cookie: await server.login(user.username) };
      return device;
    };

    // Before the commit: the placed file is the job's alone and is taken away.
    const crashed = only(journalsIn(beforeCommit));
    const placedKey = Object.entries(crashed.contents).find(([, phase]) => phase === "placed")?.[0] as string;
    const placed = only(crashed.files.filter((file) => file.contentKey === placedKey));
    expect(existsSync(join(beforeCommit, placed.finalPath.slice(dataDir.length)))).toBe(true);
    const journalCopy = readFileSync(join(beforeCommit, "tmp", "content-packs", "journal", `${crashed.jobId}.json`));
    let device = await restartFrom(beforeCommit);
    const rolledBack = async () => {
      expect(journalsIn(dataDir)).toEqual([]);
      expect(existsSync(join(dataDir, "tmp", "content-packs", "imports"))).toBe(false);
      expect(filesUnder(assets)).toEqual([]);
      expect(await contentsOf(device)).toEqual([]);
      expect(run(device, (scope) => scope.mediaAssets.get(user.id, placed.assetId))).toBeUndefined();
    };
    await rolledBack();
    // Starting again changes nothing, and neither does settling the same journal a second time
    // (as after a crash during the first settlement).
    await closeStack(device.stack);
    device = await restart();
    await rolledBack();
    await closeStack(device.stack);
    mkdirSync(join(dataDir, "tmp", "content-packs", "journal"), { recursive: true });
    writeFileSync(join(dataDir, "tmp", "content-packs", "journal", `${crashed.jobId}.json`), journalCopy);
    device = await restart();
    await rolledBack();
    await closeStack(device.stack);

    // After the commit: the Content is the library's, its file stays; the unplaced second leaves nothing.
    const settledJournal = only(journalsIn(afterCommit));
    const keptKey = Object.entries(settledJournal.contents).find(([, phase]) => phase === "placed")?.[0] as string;
    const kept = only(settledJournal.files.filter((file) => file.contentKey === keptKey));
    const keptMedia = media.find((item) => item.key === `${keptKey}-media`);
    device = await restartFrom(afterCommit);
    const finished = async () => {
      expect(journalsIn(dataDir)).toEqual([]);
      const contents = await contentsOf(device);
      expect(contents.map((content) => content.title)).toEqual([keptKey === "origin-1" ? "内容 1" : "内容 2"]);
      expect(filesUnder(assets)).toEqual([kept.finalPath.slice(assets.length + 1)]);
      expect(await mediaBytes(device, kept.assetId)).toEqual(readFileSync(keptMedia?.path as string));
    };
    await finished();
    await closeStack(device.stack);
    device = await restart();
    await finished();
    await closeStack(device.stack);
    mkdirSync(join(dataDir, "tmp", "content-packs", "journal"), { recursive: true });
    writeFileSync(join(dataDir, "tmp", "content-packs", "journal", `${settledJournal.jobId}.json`), JSON.stringify(settledJournal));
    device = await restart();
    await finished();
  }, 120_000);

  /**
   * After a crash between moving a carried cache file into the cache directory and committing
   * its Content, the start-up recovery takes the file (and its replacement record) away again,
   * as it does for managed originals, and the same pack imports again. The journal leaves
   * cache files to the cache replacement recovery, so server mode must run that recovery too.
   */
  it("a crash after a cache file is placed and before the commit is rolled back at start-up in server mode too, and the pack imports again", async () => {
    const a = await exporter();
    const video = uniqueVideo("BV1");
    const name = `${video} [720P].mp4`;
    const platform = addContent(a, { title: "缓存视频", source: platformSource("bilibili", video) });
    const cacheBytes = mp4Bytes(120_000);
    const cache = addCache(a, platform, name, cacheBytes);
    const pack = await exportPack(a, selection([pick(platform, [], { media: [cache.id] })]));
    const origin = await openStack();
    const user = await addUser(origin, "crash");
    const job = await previewPack(user, pack);

    // The import runs to its end; the data directory is copied as a kill would leave it right
    // after the cache file was moved into the cache directory and before its Content commits.
    const repository = origin.composition.repository;
    const transaction = repository.withTransaction.bind(repository);
    let beforeCommit: string | undefined;
    const spy = vi.spyOn(repository, "withTransaction").mockImplementation(<T,>(work: (scope: RepositoryScope) => NotPromise<T>): T => {
      if (beforeCommit === undefined && journalsIn(origin.dataDir).some((journal) => Object.values(journal.contents).includes("placed"))) beforeCommit = snapshotDataDir(origin);
      return transaction(work);
    });
    try {
      expect(only((await commitPack(user, job)).result?.contents).status).toBe("imported");
    } finally {
      spy.mockRestore();
    }
    await closeStack(origin);
    if (beforeCommit === undefined) throw new Error("the crash state was not captured");
    expect(readFileSync(join(beforeCommit, "media", name))).toEqual(cacheBytes);
    const dataDir = origin.dataDir;
    rmSync(dataDir, { recursive: true, force: true });
    renameSync(beforeCommit, dataDir);

    const server = await reopen(dataDir);
    await server.stack.composition.startBackground();
    const device: Device = { stack: server.stack, id: user.id, username: user.username, cookie: await server.login(user.username) };
    // Nothing was committed, so the file the job placed is not the library's: it goes, and
    // nothing of the job is left in the cache directory.
    expect(journalsIn(dataDir)).toEqual([]);
    expect(await contentsOf(device)).toEqual([]);
    expect(existsSync(join(dataDir, "media", name))).toBe(false);
    expect(readdirSync(join(dataDir, "media")).filter((entry) => entry !== ".amber-tmp")).toEqual([]);
    // The same pack imports again, cache and all.
    const again = await importPack(device, pack);
    expect(only(again.done.result?.contents)).toMatchObject({ status: "imported", added: { media: 1 } });
    expect(readFileSync(join(dataDir, "media", name))).toEqual(cacheBytes);
  }, 120_000);

  it("a pack replaced after the preview is refused before anything is written (backup_invalid.pack_changed)", async () => {
    const dir = tempDataDir("amber-replaced-pack-");
    const b = await importer();
    const job = await previewPack(b, await packOf(sampleBuild(dir, { count: 2 }).build, dir));
    // The staged upload is swapped for another valid pack, as a file picked on the client could be.
    writeFileSync(join(stagingOf(B, job.jobId), "upload.bin"), await packOf(sampleBuild(dir, { count: 2 }).build, dir));
    const done = await commitPack(b, job);
    expect(done).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_changed" } });
    expect(done.result).toBeUndefined();
    expect(await contentsOf(b)).toEqual([]);
    expect(filesUnder(dataPath(B, `assets/${b.id}`))).toEqual([]);
    expect(journalsIn(B.dataDir).filter((journal) => journal.jobId === job.jobId)).toEqual([]);
    expect(existsSync(stagingOf(B, job.jobId))).toBe(false);
    expect(await active(b)).toEqual({});
  }, TIMEOUT);

  it("tampered hashes, path traversal, links, duplicate entries, oversized documents, a newer format, an interrupted upload, cancel, low disk and quota are each refused cleanly", async () => {
    const dir = tempDataDir("amber-bad-packs-");
    const b = await importer();
    const sample = () => sampleBuild(join(dir), { count: 1 });
    const raw = (edit: (entries: RawEntry[]) => void): Buffer => {
      const { build, media } = sample();
      const entries = rawEntriesOf(build, media);
      edit(entries);
      return rawTar(entries);
    };
    const json = (entry: RawEntry | undefined) => JSON.parse(Buffer.from(entry?.bytes ?? []).toString()) as Record<string, unknown> & { entries: Array<{ name: string; size: number; sha256?: string }> };
    /** The upload is taken, its preview fails, and nothing of the job is left. */
    const refusedPack = async (bytes: Buffer) => {
      const job = await failedPreview(b, bytes);
      expect(existsSync(stagingOf(B, job.jobId))).toBe(false);
      expect(await active(b)).toEqual({});
      return job.error;
    };

    const tampered = raw((entries) => {
      const manifest = json(entries.at(-1));
      (manifest.entries[1] as { sha256: string }).sha256 = "0".repeat(64);
      entries[entries.length - 1] = { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) };
    });
    expect(await refusedPack(tampered)).toMatchObject({ code: "backup_invalid.pack_entry", details: { reason: "digest", entry: "contents/1/content.json" } });
    // Media bytes swapped while every digest stayed: the preview reads no media, the single read finds it before anything is written.
    const swapped = raw((entries) => {
      const at = entries.findIndex((entry) => entry.name.startsWith("media/"));
      entries[at] = { name: (entries[at] as RawEntry).name, bytes: mp4Bytes((entries[at] as RawEntry).bytes.length) };
    });
    const swappedJob = await previewPack(b, swapped);
    // The pack is damaged, not replaced: picking it again would not help, so it is not called changed.
    expect(await commitPack(b, swappedJob)).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_entry", details: { reason: "digest" } } });
    expect(await contentsOf(b)).toEqual([]);
    expect(filesUnder(dataPath(B, `assets/${b.id}`))).toEqual([]);
    expect(existsSync(stagingOf(B, swappedJob.jobId))).toBe(false);
    expect(await refusedPack(raw((entries) => entries.splice(1, 0, { name: "../evil.json", bytes: Buffer.from("{}") })))).toMatchObject({ code: "backup_invalid.pack_entry", details: { reason: "traversal" } });
    expect(await refusedPack(raw((entries) => entries.splice(1, 0, { name: "/etc/passwd", bytes: Buffer.from("{}") })))).toMatchObject({ details: { reason: "traversal" } });
    for (const type of ["2", "1"]) {
      expect(await refusedPack(raw((entries) => (entries[1] = { ...(entries[1] as RawEntry), type })))).toMatchObject({ code: "backup_invalid.pack_entry", details: { reason: "link" } });
    }
    expect(await refusedPack(raw((entries) => entries.splice(2, 0, entries[1] as RawEntry)))).toMatchObject({ details: { reason: "duplicate", entry: "collections.json" } });
    const oversized = raw((entries) => {
      const header = json(entries[0]);
      (header.entries[0] as { size: number }).size = CONTENT_PACK_DOCUMENT_MAX_BYTES + 1;
      entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify(header)) };
    });
    expect(await refusedPack(oversized)).toMatchObject({ details: { reason: "too_large", entry: "collections.json" } });
    const newer = raw((entries) => {
      entries[0] = { name: "header.json", bytes: Buffer.from(JSON.stringify({ ...json(entries[0]), formatVersion: CONTENT_PACK_FORMAT_VERSION + 1, futureField: true })) };
    });
    expect(await refusedPack(newer)).toMatchObject({ class: "invalid_request", code: "invalid_request.pack_newer", details: { formatVersion: CONTENT_PACK_FORMAT_VERSION + 1, supportedVersion: CONTENT_PACK_FORMAT_VERSION } });

    // Cancel while waiting for decisions, and while importing.
    const waiting = await previewPack(b, await packOf(sample().build, dir));
    expect(await ok<ContentPackImportJobDto>(b, { method: "POST", url: `/api/content-packs/imports/${waiting.jobId}/cancel` })).toMatchObject({ status: "cancelled" });
    expect(existsSync(stagingOf(B, waiting.jobId))).toBe(false);
    expect(await active(b)).toEqual({});
    const large = await previewPack(b, await packOf(sampleBuild(dir, { count: 1, mediaBytes: 64 * 1024 * 1024 }).build, dir));
    await ok(b, { method: "POST", url: `/api/content-packs/imports/${large.jobId}/commit`, payload: decisionsOf(large) }, 202);
    const cancelled = await ok<ContentPackImportJobDto>(b, { method: "POST", url: `/api/content-packs/imports/${large.jobId}/cancel` });
    expect(cancelled.status).toBe("cancelled");
    expect(await contentsOf(b)).toEqual([]);
    expect(filesUnder(dataPath(B, `assets/${b.id}`))).toEqual([]);
    expect(journalsIn(B.dataDir).filter((journal) => journal.jobId === large.jobId)).toEqual([]);
    expect(existsSync(stagingOf(B, large.jobId))).toBe(false);
    expect(await active(b)).toEqual({});

    // An interrupted upload, low disk and the storage limit, on an instance of their own.
    const x = await openStack();
    const user = await addUser(x, "limits");
    const pack = await packOf(sampleBuild(dir, { count: 1, mediaBytes: 3 * 1024 * 1024 }).build, dir);
    await x.composition.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (x.composition.app.server.address() as AddressInfo).port;
    const hangUp = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/content-packs/imports/upload",
        headers: { "x-amber-request": "1", origin: STACK_ORIGIN, cookie: user.cookie, "content-type": "application/octet-stream" },
      });
      request.on("error", () => resolve("closed"));
      request.on("response", () => reject(new Error("the server answered a cut upload")));
      request.write(pack.subarray(0, 1024 * 1024));
      setTimeout(() => {
        request.destroy();
        resolve("closed");
      }, 100);
    });
    expect(hangUp).toBe("closed");
    await until(() => active(user), (value) => value.importJobId === undefined);
    await until(async () => filesUnder(join(x.dataDir, "tmp", "content-packs", "imports")), (files) => files.length === 0);
    expect(await active(user)).toEqual({});
    expect(filesUnder(join(x.dataDir, "tmp", "content-packs", "imports"))).toEqual([]);

    const admin = (request: Parameters<ComposedStack["send"]>[0]) => x.send(request, x.adminCookie);
    const settings = (maxDataGB: number) => admin({ method: "PATCH", url: "/api/instance-settings", payload: { maxDataGB } });
    const limit = (storageLimitGB: number | null) => admin({ method: "PATCH", url: `/api/admin/users/${user.id}`, payload: { storageLimitGB } });
    const tiny = 1 / 1024 / 1024;
    const previous = (await admin({ method: "GET", url: "/api/instance-settings" })).json() as { maxDataGB: number };

    // Low disk: the upload is refused at its start; a commit is refused and its preview stays.
    expect((await settings(tiny)).statusCode).toBe(200);
    const lowUpload = await upload(user, pack);
    expect(lowUpload.statusCode).toBe(507);
    expect((lowUpload.json() as { error: { class: string } }).error.class).toBe("disk_low");
    expect(filesUnder(join(x.dataDir, "tmp", "content-packs", "imports"))).toEqual([]);
    expect((await settings(previous.maxDataGB)).statusCode).toBe(200);
    const lowJob = await previewPack(user, pack);
    expect((await settings(tiny)).statusCode).toBe(200);
    expect((await refused(user, { method: "POST", url: `/api/content-packs/imports/${lowJob.jobId}/commit`, payload: decisionsOf(lowJob) }, 507)).class).toBe("disk_low");
    expect((await importJob(user, lowJob.jobId)).status).toBe("awaiting_decisions");
    expect((await settings(previous.maxDataGB)).statusCode).toBe(200);
    await discard(user, lowJob.jobId);

    // The storage limit: an upload past it stops; originals past it are refused at the commit.
    expect((await limit(tiny)).statusCode).toBe(200);
    const overUpload = await upload(user, pack);
    expect(overUpload.statusCode).toBe(507);
    expect((overUpload.json() as { error: { class: string } }).error.class).toBe("storage_quota_exceeded");
    expect(filesUnder(join(x.dataDir, "tmp", "content-packs", "imports"))).toEqual([]);
    expect(await active(user)).toEqual({});
    expect((await limit(null)).statusCode).toBe(200);
    const quotaJob = await previewPack(user, pack);
    expect((await limit(tiny)).statusCode).toBe(200);
    expect((await refused(user, { method: "POST", url: `/api/content-packs/imports/${quotaJob.jobId}/commit`, payload: decisionsOf(quotaJob) }, 507)).class).toBe("storage_quota_exceeded");
    expect((await importJob(user, quotaJob.jobId)).status).toBe("awaiting_decisions");
    expect((await limit(null)).statusCode).toBe(200);
    const finished = await commitPack(user, quotaJob);
    expect(only(finished.result?.contents).status).toBe("imported");
  }, 120_000);

  it("pack images that are animated, carry metadata chunks, have wrong lengths or exceed the limits are refused without decoding", async () => {
    const dir = tempDataDir("amber-bad-images-");
    const b = await importer();
    const before = await contentsOf(b);
    const tools = vi.spyOn(NodeProcessRunner.prototype, "run");
    const bad: Array<[string, Uint8Array]> = [
      ["animated", ANIMATED_WEBP],
      ["EXIF chunk", webpWithChunk(FIGURE_WEBP, "EXIF", Buffer.from("Exif\0\0meta"))],
      ["XMP chunk", webpWithChunk(FIGURE_WEBP, "XMP ", Buffer.from("<x:xmpmeta/>"))],
      ["colour profile", webpWithChunk(FIGURE_WEBP, "ICCP", Buffer.alloc(16))],
      ["RIFF length too long", webpWithRiffSize(FIGURE_WEBP, 2)],
      ["RIFF length too short", webpWithRiffSize(FIGURE_WEBP, -2)],
      ["bytes after the image", Buffer.concat([Buffer.from(FIGURE_WEBP), Buffer.alloc(6)])],
      ["wider than allowed", webpWithWidth(FIGURE_WEBP, 3000)],
      ["larger than allowed", Buffer.concat([Buffer.from(FIGURE_WEBP), Buffer.alloc(FIGURE_IMAGE_MAX_BYTES)])],
    ];
    try {
      for (const [label, bytes] of bad) {
        const { build } = sampleBuild(dir, { count: 1 });
        const entry = swapFigureImage(build, bytes);
        const job = await previewPack(b, await packOf(build, dir));
        const done = await commitPack(b, job);
        expect(done, label).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_image", details: { entry } } });
        expect(existsSync(stagingOf(B, job.jobId)), label).toBe(false);
      }
      // A speaker photo goes through the same structural check.
      const { build } = sampleBuild(dir, { count: 1 });
      const content = build.contents[0] as (typeof build.contents)[number];
      const avatar = content.document.speakers[0]?.avatar?.entry as string;
      content.images = content.images.map((image) => (image.entry === avatar ? { entry: avatar, bytes: webpWithChunk(image.bytes, "EXIF", Buffer.from("Exif\0\0meta")) } : image));
      const photoJob = await previewPack(b, await packOf(build, dir));
      expect(await commitPack(b, photoJob)).toMatchObject({ status: "failed", error: { code: "backup_invalid.pack_image", details: { entry: avatar } } });
      expect(tools).not.toHaveBeenCalled();
    } finally {
      tools.mockRestore();
    }
    expect(await contentsOf(b)).toEqual(before);
    expect(filesUnder(dataPath(B, `assets/${b.id}`))).toEqual([]);
    // The server goes on: the same pack with its own image imports.
    const { build } = sampleBuild(dir, { count: 1 });
    expect(only((await importPack(b, await packOf(build, dir))).done.result?.contents).status).toBe("imported");
  }, TIMEOUT);

  it("figures carried in import with their images, captions, places and search rows", async () => {
    const a = await exporter();
    const lecture = seedLecture(a);
    const b = await importer();
    const { done } = await importPack(b, await exportPack(a, selection([pick(lecture.contentId, [lecture.corrected.id], { figures: true, media: [lecture.original.id] })])));
    const here = importedId(done);
    expect(only(done.result?.contents)).toMatchObject({ added: { figures: 2 }, placedByTime: 1 });
    const figures = (await figuresOf(b, here)).items;
    const anchored = figures.find((figure) => figure.caption === FIGURE_CAPTION) as FigureDto;
    const loose = figures.find((figure) => figure.caption === undefined) as FigureDto;
    const corrected = revisionsByOrigin(b, here).get(lecture.corrected.id)?.id as string;
    expect(anchored).toMatchObject({ source: "capture", capturedAtMs: 2100, widthRatio: 0.7, placement: { displayMs: 2100, sortKey: 0, anchor: { revisionId: corrected, side: "before" } } });
    expect(anchored.placement.anchor?.segmentId).toBe((await segmentsOf(b, corrected))[2]?.id);
    expect(loose).toMatchObject({ source: "upload", placement: { displayMs: 3500, sortKey: 1, anchor: null } });
    expect(await figureImage(b, anchored.id)).toEqual(Buffer.from(FIGURE_WEBP));
    expect(await figureImage(b, loose.id)).toEqual(Buffer.from(SECOND_FIGURE_WEBP));

    const search = await ok<SearchResultDto>(b, { method: "GET", url: `/api/search?q=${encodeURIComponent("架构示意")}` });
    expect(search.figures).toEqual([expect.objectContaining({ contentId: here, figureId: anchored.id, ordinal: 1, capturedAtMs: 2100 })]);
    const scoped = await ok<SearchResultDto>(b, { method: "GET", url: `/api/search?q=${encodeURIComponent("架构示意")}&scope=library` });
    expect(scoped.figures.map((hit) => hit.figureId)).toEqual([anchored.id]);
  }, TIMEOUT);

  it("other requests stay responsive while a large pack imports", async () => {
    /**
     * A pack big enough that hashing and copying it takes far longer than any single request.
     * Kept moderate so the case stays quick; what matters is that the import yields between
     * chunks and documents, which a few dozen megabytes already show.
     */
    const LARGE_PACK_MEDIA_BYTES = 64 * 1024 * 1024;
    /**
     * The longest a light request may wait while the pack streams. An import that held the
     * event loop for a whole hashing or copying pass would keep it waiting for seconds at this
     * size; one that yields between 1 MiB chunks and between documents lets it through in a few
     * milliseconds. 500 ms leaves room for a loaded CI runner and still catches a blocked loop.
     */
    const RESPONSIVE_LATENCY_MAX_MS = 500;
    /** Samples taken while the import itself runs, so the bound is measured where it matters. */
    const MIN_SAMPLES_WHILE_IMPORTING = 3;
    const dir = tempDataDir("amber-large-pack-");
    const b = await importer();
    const pack = await packOf(sampleBuild(dir, { count: 1, mediaBytes: LARGE_PACK_MEDIA_BYTES }).build, dir);

    const timed = async <T,>(request: () => Promise<T>): Promise<{ value: T; ms: number }> => {
      const started = performance.now();
      const value = await request();
      return { value, ms: performance.now() - started };
    };
    // During the upload and preview: the light list of the user's running jobs.
    let uploading = true;
    const duringUpload: number[] = [];
    const uploadProbe = (async () => {
      while (uploading) {
        duringUpload.push((await timed(() => active(b))).ms);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    let job: Awaited<ReturnType<typeof previewPack>>;
    try {
      job = await previewPack(b, pack);
    } finally {
      uploading = false;
      await uploadProbe;
    }
    // During the import: the job's own status, which also tells when the import runs.
    await ok(b, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/commit`, payload: decisionsOf(job) }, 202);
    const duringImport: number[] = [];
    let last: ContentPackImportJobDto;
    for (;;) {
      const sample = await timed(() => importJob(b, job.jobId));
      last = sample.value;
      if (last.status !== "importing") break;
      duringImport.push(sample.ms);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(last.status, JSON.stringify(last.error)).toBe("finished");
    expect(only(last.result?.contents)).toMatchObject({ status: "imported", added: { media: 1 } });
    expect(duringImport.length).toBeGreaterThanOrEqual(MIN_SAMPLES_WHILE_IMPORTING);
    expect(Math.max(...duringImport, ...duringUpload)).toBeLessThan(RESPONSIVE_LATENCY_MAX_MS);
  }, TIMEOUT);
});
